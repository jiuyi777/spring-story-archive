import { estimateTokens, fingerprintMessage, fingerprintSummaries, validSummaries } from './privacy-payload.js?v=0.7.1';
import { formatCheckpoint, formatFloorRecord } from './summary-engine.js?v=0.7.1';
import { buildMemoryDatabase, selectMemoryDatabase, applyNarrativeEdits } from './memory-database.js?v=0.7.1';

export const STORY_PROMPT_ID = 'spring-story-archive:story-summary';
export const OLD_FLOOR_PATTERN = /[\s\S]+/g;
const HEADER = '【春序档案 · 剧情总摘要】\n以下是本聊天已经发生的剧情。按楼层顺序理解，以较新的明确事实和玩家当前发言为准，不把历史表态当作永久命令。';

// ST 1.14.0 passes a prompt-only copy whose index refers to non-system chat rows.
// Never change the stored chat. Keep tool histories and attachments intact.
export function buildStoryContext({ sourceChat, promptChat, summaries, checkpoints, contextSize, type, memoryEdits = [] }) {
  const budget = Math.max(0, Math.min(6000, Math.floor((Number(contextSize) || 0) / 4)));
  const includesTools = promptChat.some((message) => message.is_system && Array.isArray(message.extra?.tool_invocations));
  const sourceRows = sourceChat.map((message, floorIndex) => ({ message, floorIndex }))
    .filter(({ message }) => !message.is_system || (includesTools && Array.isArray(message.extra?.tool_invocations)));
  const excludedFloor = type === 'swipe' ? sourceRows.at(-1)?.floorIndex : undefined;
  const current = applyNarrativeEdits(validSummaries(summaries, sourceChat), memoryEdits, excludedFloor === undefined ? Infinity : excludedFloor - 1);
  const ready = current.filter((record) => record.floorIndex !== excludedFloor && !sourceChat[record.floorIndex].is_system);
  const checkpoint = [...checkpoints].filter((item) => item.status === 'ready' && item.formatVersion === 5
    && item.summary?.trim()
    && (excludedFloor === undefined || item.throughFloor < excludedFloor)
    && item.sourceFingerprint === fingerprintSummaries(current.filter((row) => row.floorIndex <= item.throughFloor)))
    .sort((a, b) => b.throughFloor - a.throughFloor)[0];
  const blocks = [];
  const included = new Set();
  const covered = new Set();
  let used = estimateTokens(HEADER);
  const add = (text, records) => {
    const cost = estimateTokens(`\n\n${text}`);
    if (used + cost > budget) return false;
    blocks.push(text);
    records.forEach((record) => {
      included.add(record.floorIndex);
      if (record.inputComplete === true) covered.add(record.floorIndex);
    });
    used += cost;
    return true;
  };
  const memory = buildMemoryDatabase(summaries, sourceChat, memoryEdits, { throughFloor: excludedFloor === undefined ? Infinity : excludedFloor - 1 });
  const selectedMemory = selectMemoryDatabase(memory, { budget: Math.min(1800, Math.floor(budget / 2)), query: sourceChat.slice(0, excludedFloor === undefined ? undefined : excludedFloor).slice(-5).map((row) => row.mes).join('\n') });
  const memoryText = selectedMemory.text;
  const memoryAdded = memoryText && add(`【当前剧情状态】\n${memoryText}`, []);
  if (checkpoint) add(formatCheckpoint(checkpoint), ready.filter((row) => row.floorIndex <= checkpoint.throughFloor));
  // Complete blocks only: a floor can be filtered only when its full summary fits.
  const recentBlocks = [];
  for (const record of [...ready].reverse()) {
    if (included.has(record.floorIndex)) continue;
    const before = blocks.length;
    if (add(formatFloorRecord(record), [record])) recentBlocks.unshift(blocks.splice(before, 1)[0]);
  }
  blocks.push(...recentBlocks);
  const toolHistory = sourceChat.some((message) => Array.isArray(message.extra?.tool_invocations));
  const removeIndexes = [];
  if (!toolHistory) {
    promptChat.forEach((message, index) => {
      const depth = sourceRows.length - (type === 'swipe' ? 1 : 0) - message.index - (type === 'continue' ? 2 : 1);
      const original = sourceRows[message.index];
      if (depth < 5 || !original || !covered.has(original.floorIndex) || message.is_system) return;
      if (message.is_user !== original.message.is_user || message.name !== original.message.name) return;
      if ([message, original.message].some((row) => row.extra?.media?.length || row.extra?.image || row.extra?.file || row.extra?.files?.length)) return;
      if (String(message.mes ?? '').replace(OLD_FLOOR_PATTERN, '') === '') removeIndexes.push(index);
    });
  }
  return {
    prompt: blocks.length ? `${HEADER}\n\n${blocks.join('\n\n')}` : '',
    memories: memoryAdded ? selectedMemory.records : [],
    coveredFloors: [...covered].sort((a, b) => a - b),
    includedFloors: [...included].sort((a, b) => a - b),
    removeIndexes,
  };
}

export async function injectStoryContext({ context, storage, chatKey, promptChat, contextSize, type, enabled, filter, isCurrent, onPlan = () => {} }) {
  context.setExtensionPrompt?.(STORY_PROMPT_ID, '', 1, 0, false, 0);
  if (!enabled || type === 'quiet' || !chatKey) return '剧情总摘要发送已关闭或本轮无需发送';
  if (typeof context.setExtensionPrompt !== 'function') return '当前酒馆不支持摘要注入，保留全部原文';
  const sourceChat = context.chat.map((message) => ({ ...message }));
  const signature = sourceChat.map(fingerprintMessage).join('|');
  const [summaries, checkpoints, edits] = await Promise.all([storage.listSummaries(chatKey), storage.listCheckpoints(chatKey), storage.getProfile?.(`${chatKey}::memory-edits`)]);
  if (!isCurrent() || signature !== context.chat.map(fingerprintMessage).join('|')) return '聊天已变化，本轮保留原文';
  const plan = buildStoryContext({ sourceChat, promptChat, summaries, checkpoints, contextSize, type, memoryEdits: edits?.edits ?? [] });
  if (!plan.prompt) return '本轮没有可带入的有效摘要，保留全部原文；旧楼层可先补全摘要';
  context.setExtensionPrompt(STORY_PROMPT_ID, plan.prompt, 1, 0, false, 0);
  onPlan(plan);
  const removed = filter ? plan.removeIndexes.length : 0;
  if (filter) for (const index of [...plan.removeIndexes].reverse()) promptChat.splice(index, 1);
  const floors = plan.includedFloors;
  return `已准备 ${floors.length} 楼摘要，待核对最终提示词；过滤 ${removed} 楼旧原文，最近 5 楼及覆盖未确认楼层保留`;
}

// The host may copy promptChat again after the interceptor. Cancellation must also
// stop the host request; restoring this array alone is too late for those copies.
export function createStoryRequest({ context, promptChat, abort, isCurrent, onStatus, onEvidence = () => {} }) {
  const original = [...promptChat];
  let active = true;
  let expected = '';
  let recallExpected = '';
  const normalize = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
  const promptText = (value) => Array.isArray(value) ? value.map(promptText).join('\n')
    : typeof value === 'string' ? value : promptText(value?.content ?? value?.text ?? '');
  const request = {
    plan(plan) { expected = context.substituteParams?.(plan.prompt) ?? plan.prompt; },
    recallPlan(text) { recallExpected = context.substituteParams?.(text) ?? text; },
    cancel() {
      if (!active) return;
      active = false;
      onEvidence({ status: 'cancelled', reason: '请求已停止，未确认完整发送。' });
      promptChat.splice(0, promptChat.length, ...original);
      abort(true);
      context.stopGeneration?.();
    },
    finish() { active = false; },
    verify(data, dryRun) {
      if (!active || dryRun || (!expected && !recallExpected)) return;
      if (!isCurrent() || [expected, recallExpected].filter(Boolean).some((text) => !normalize(promptText(data.prompt ?? data.input)).includes(normalize(text)))) {
        request.cancel();
        onStatus('本轮总摘要未完整进入最终提示词，已停止发送并保留原文');
        return;
      }
      onEvidence({ status: 'verified' });
      onStatus('已在本轮待发提示词中核对总摘要；模型接收仍以实际请求为准');
    },
  };
  return request;
}
