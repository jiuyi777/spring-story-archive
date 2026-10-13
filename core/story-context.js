import { estimateTokens, fingerprintMessage, fingerprintSummaries, validSummaries } from './privacy-payload.js?v=0.7.2';
import { formatCheckpoint, formatFloorRecord } from './summary-engine.js?v=0.7.2';
import { buildMemoryDatabase, selectMemoryDatabase, applyNarrativeEdits } from './memory-database.js?v=0.7.2';

export const STORY_PROMPT_ID = 'spring-story-archive:story-summary';
export const OLD_FLOOR_PATTERN = /[\s\S]+/g;
const HEADER = '【春序档案 · 剧情总摘要】\n以下是本聊天已经发生的剧情。按楼层顺序理解，以较新的明确事实和玩家当前发言为准，不把历史表态当作永久命令。';

// ST 1.14.0 passes a prompt-only copy whose index refers to non-system chat rows.
// Never change the stored chat. Keep tool histories and attachments intact.
// memoryBudget is the player's ceiling for everything 春序 adds (memory,
// summaries and recall together). It is used as set: long-context models can
// take far more than older defaults assumed.
export const DEFAULT_MEMORY_BUDGET = 20000;
export const MAX_MEMORY_BUDGET = 1000000;
export function memoryBudgetFor(contextSize, memoryBudget = DEFAULT_MEMORY_BUDGET) {
  void contextSize;
  return Math.max(0, Math.min(MAX_MEMORY_BUDGET, Math.round(Number(memoryBudget) || DEFAULT_MEMORY_BUDGET)));
}

export function buildStoryContext({ sourceChat, promptChat, summaries, checkpoints, contextSize, type, memoryEdits = [], memoryBudget = DEFAULT_MEMORY_BUDGET }) {
  const budget = memoryBudgetFor(contextSize, memoryBudget);
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
  const selectedMemory = selectMemoryDatabase(memory, { budget: Math.floor(budget / 2), query: sourceChat.slice(0, excludedFloor === undefined ? undefined : excludedFloor).slice(-5).map((row) => row.mes).join('\n') });
  // The player's own words go first under their own heading so the model treats
  // them as the player's standing wishes, not as story facts.
  const playerLines = selectedMemory.records.filter((row) => row.table === 'player').map((row) => row.line);
  const stateLines = selectedMemory.records.filter((row) => row.table !== 'player').map((row) => row.line);
  const playerAdded = playerLines.length > 0 && add(`【玩家本人说过的话】\n以下是玩家明确表达过的喜好、雷点和要求，持续有效，除非玩家后来改口。\n${playerLines.join('\n')}`, []);
  const memoryText = stateLines.join('\n');
  const memoryAdded = memoryText && add(`【当前剧情状态】\n${memoryText}`, []);
  if (checkpoint) add(formatCheckpoint(checkpoint), ready.filter((row) => row.floorIndex <= checkpoint.throughFloor));
  // The newest floors always keep their raw text (see the depth check below),
  // so sending their summaries too would only repeat the same content.
  const rawThreshold = sourceRows.length - (type === 'swipe' ? 1 : 0) - (type === 'continue' ? 2 : 1) - 5;
  // A summary the player corrected by hand is still sent: it may fix how the raw text was read.
  const corrected = new Set(memoryEdits.filter((edit) => edit.table === 'events' && edit.operation !== 'delete').map((edit) => Number(String(edit.id).replace('floor:', ''))));
  const alwaysRaw = new Set(sourceRows.filter((_, index) => index > rawThreshold).map((row) => row.floorIndex).filter((floor) => !corrected.has(floor)));
  // Complete blocks only: a floor can be filtered only when its full summary fits.
  const recentBlocks = [];
  for (const record of [...ready].reverse()) {
    if (included.has(record.floorIndex) || alwaysRaw.has(record.floorIndex)) continue;
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
    memories: selectedMemory.records.filter((row) => (row.table === 'player' ? playerAdded : memoryAdded)),
    coveredFloors: [...covered].sort((a, b) => a - b),
    includedFloors: [...included].sort((a, b) => a - b),
    removeIndexes,
    usedTokens: blocks.length ? used : 0,
    budget,
  };
}

export async function injectStoryContext({ context, storage, chatKey, promptChat, contextSize, type, enabled, filter, isCurrent, onPlan = () => {}, memoryBudget = DEFAULT_MEMORY_BUDGET }) {
  context.setExtensionPrompt?.(STORY_PROMPT_ID, '', 1, 0, false, 0);
  if (!enabled || type === 'quiet' || !chatKey) return '剧情总摘要发送已关闭或本轮无需发送';
  if (typeof context.setExtensionPrompt !== 'function') return '当前酒馆不支持摘要注入，保留全部原文';
  const sourceChat = context.chat.map((message) => ({ ...message }));
  const signature = sourceChat.map(fingerprintMessage).join('|');
  const [summaries, checkpoints, edits] = await Promise.all([storage.listSummaries(chatKey), storage.listCheckpoints(chatKey), storage.getProfile?.(`${chatKey}::memory-edits`)]);
  if (!isCurrent() || signature !== context.chat.map(fingerprintMessage).join('|')) return '聊天已变化，本轮保留原文';
  const plan = buildStoryContext({ sourceChat, promptChat, summaries, checkpoints, contextSize, type, memoryEdits: edits?.edits ?? [], memoryBudget });
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
