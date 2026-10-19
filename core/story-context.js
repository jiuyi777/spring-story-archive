import { estimateTokens, fingerprintMessage, fingerprintSummaries, validSummaries, resolveUserName } from './privacy-payload.js?v=0.7.3';
import { formatFloorRecord } from './summary-engine.js?v=0.7.3';
import { selectChapters, chapterRange, chapterSource, formatChapter } from './chapters.js?v=0.7.3';
import { buildMemoryDatabase, selectMemoryDatabase, applyNarrativeEdits } from './memory-database.js?v=0.7.3';

export const STORY_PROMPT_ID = 'spring-story-archive:story-summary';
export const OLD_FLOOR_PATTERN = /[\s\S]+/g;
const HEADER = '【剧情记忆】';

// ST 1.14.0 passes a prompt-only copy whose index refers to non-system chat rows.
// Never change the stored chat. Keep tool histories and attachments intact.
// memoryBudget is the player's ceiling for everything 喵喵 adds (memory,
// summaries and recall together). It is used as set: long-context models can
// take far more than older defaults assumed.
export const DEFAULT_MEMORY_BUDGET = 20000;
export const MAX_MEMORY_BUDGET = 1000000;
export function memoryBudgetFor(contextSize, memoryBudget = DEFAULT_MEMORY_BUDGET) {
  void contextSize;
  return Math.max(0, Math.min(MAX_MEMORY_BUDGET, Math.round(Number(memoryBudget) || DEFAULT_MEMORY_BUDGET)));
}

// recentRaw: how many newest floors always go as raw chat (sent by
// SillyTavern as history; not part of the memory budget).
export function recentRawCount(value) {
  return Math.max(1, Math.min(100, Math.round(Number(value) || 5)));
}

export function buildStoryContext({ sourceChat, promptChat, summaries, checkpoints, contextSize, type, userName = '', memoryEdits = [], memoryBudget = DEFAULT_MEMORY_BUDGET, recentRaw = 5 }) {
  const keepRaw = recentRawCount(recentRaw);
  userName = resolveUserName(userName, sourceChat);
  const budget = memoryBudgetFor(contextSize, memoryBudget);
  const includesTools = promptChat.some((message) => message.is_system && Array.isArray(message.extra?.tool_invocations));
  const sourceRows = sourceChat.map((message, floorIndex) => ({ message, floorIndex }))
    .filter(({ message }) => !message.is_system || (includesTools && Array.isArray(message.extra?.tool_invocations)));
  const excludedFloor = type === 'swipe' ? sourceRows.at(-1)?.floorIndex : undefined;
  const current = applyNarrativeEdits(validSummaries(summaries, sourceChat), memoryEdits, excludedFloor === undefined ? Infinity : excludedFloor - 1);
  const ready = current.filter((record) => record.floorIndex !== excludedFloor && !sourceChat[record.floorIndex].is_system);
  // Big-summary chapters in force (a swipe ignores any that reach the floor being redone).
  const chapters = selectChapters(checkpoints, current)
    .filter((chapter) => excludedFloor === undefined || chapterRange(chapter).through < excludedFloor);
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
  const selectedMemory = selectMemoryDatabase(memory, { userName, budget: Math.floor(budget / 2), query: sourceChat.slice(0, excludedFloor === undefined ? undefined : excludedFloor).slice(-5).map((row) => row.mes).join('\n') });
  // The player's own words go first under their own heading so the model treats
  // them as the player's standing wishes, not as story facts.
  const playerLines = selectedMemory.records.filter((row) => row.table === 'player').map((row) => row.line);
  const stateLines = selectedMemory.records.filter((row) => row.table !== 'player').map((row) => row.line);
  const playerAdded = playerLines.length > 0 && add(`【${userName}的偏好与要求】\n${playerLines.join('\n')}`, []);
  const memoryText = stateLines.join('\n');
  const memoryAdded = memoryText && add(`【当前剧情状态】\n${memoryText}`, []);
  // The newest floors always keep their raw text (see the depth check below),
  // so sending their summaries too would only repeat the same content.
  const rawThreshold = sourceRows.length - (type === 'swipe' ? 1 : 0) - (type === 'continue' ? 2 : 1) - keepRaw;
  // A summary the player corrected by hand is still sent: it may fix how the raw text was read.
  const corrected = new Set(memoryEdits.filter((edit) => edit.table === 'events' && edit.operation !== 'delete').map((edit) => Number(String(edit.id).replace('floor:', ''))));
  const alwaysRaw = new Set(sourceRows.filter((_, index) => index > rawThreshold).map((row) => row.floorIndex).filter((floor) => !corrected.has(floor)));
  const mark = (records) => records.forEach((record) => {
    included.add(record.floorIndex);
    if (record.inputComplete === true) covered.add(record.floorIndex);
  });
  // Every chapter gets at least its short form, so that much is set aside first.
  const chapterFloors = new Set(chapters.flatMap((chapter) => chapterSource(ready, chapter).map((record) => record.floorIndex)));
  const briefCosts = chapters.map((chapter) => estimateTokens(`\n\n${formatChapter(chapter, { brief: true })}`));
  let reserve = briefCosts.reduce((sum, cost) => sum + cost, 0);
  // Floor summaries after the chapters come next, newest first. Complete
  // blocks only: a floor can be filtered only when its full summary fits.
  const floorBlocks = [];
  for (const record of [...ready].reverse()) {
    if (chapterFloors.has(record.floorIndex) || included.has(record.floorIndex) || alwaysRaw.has(record.floorIndex)) continue;
    const message = sourceChat[record.floorIndex];
    const text = formatFloorRecord({ ...record, isUser: Boolean(message.is_user), speakerName: message.name || record.speakerName });
    const cost = estimateTokens(`\n\n${text}`);
    if (used + cost + reserve > budget) continue;
    floorBlocks.unshift(text);
    mark([record]);
    used += cost;
  }
  // Chapters, newest first: in full while there is room, otherwise the short form.
  const chapterBlocks = [];
  for (let index = chapters.length - 1; index >= 0; index -= 1) {
    reserve -= briefCosts[index];
    const full = formatChapter(chapters[index]);
    const fullCost = estimateTokens(`\n\n${full}`);
    const records = chapterSource(ready, chapters[index]);
    if (used + fullCost + reserve <= budget) { chapterBlocks.unshift(full); used += fullCost; mark(records); }
    else if (used + briefCosts[index] + reserve <= budget) { chapterBlocks.unshift(formatChapter(chapters[index], { brief: true })); used += briefCosts[index]; mark(records); }
  }
  blocks.push(...chapterBlocks, ...floorBlocks);
  const toolHistory = sourceChat.some((message) => Array.isArray(message.extra?.tool_invocations));
  const removeIndexes = [];
  if (!toolHistory) {
    promptChat.forEach((message, index) => {
      const depth = sourceRows.length - (type === 'swipe' ? 1 : 0) - message.index - (type === 'continue' ? 2 : 1);
      const original = sourceRows[message.index];
      if (depth < keepRaw || !original || !covered.has(original.floorIndex) || message.is_system) return;
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

export async function injectStoryContext({ context, storage, chatKey, promptChat, contextSize, type, enabled, filter, isCurrent, onPlan = () => {}, memoryBudget = DEFAULT_MEMORY_BUDGET, recentRaw = 5 }) {
  context.setExtensionPrompt?.(STORY_PROMPT_ID, '', 1, 0, false, 0);
  if (!enabled || type === 'quiet' || !chatKey) return '剧情总摘要发送已关闭或本轮无需发送';
  if (typeof context.setExtensionPrompt !== 'function') return '当前酒馆不支持摘要注入，保留全部原文';
  const sourceChat = context.chat.map((message) => ({ ...message }));
  const signature = sourceChat.map(fingerprintMessage).join('|');
  const [summaries, checkpoints, edits] = await Promise.all([storage.listSummaries(chatKey), storage.listCheckpoints(chatKey), storage.getProfile?.(`${chatKey}::memory-edits`)]);
  if (!isCurrent() || signature !== context.chat.map(fingerprintMessage).join('|')) return '聊天已变化，本轮保留原文';
  const plan = buildStoryContext({ sourceChat, promptChat, summaries, checkpoints, contextSize, type, userName: context.name1, memoryEdits: edits?.edits ?? [], memoryBudget, recentRaw });
  if (!plan.prompt) return '本轮没有可带入的有效摘要，保留全部原文；旧楼层可先补全摘要';
  context.setExtensionPrompt(STORY_PROMPT_ID, plan.prompt, 1, 0, false, 0);
  onPlan(plan);
  const removed = filter ? plan.removeIndexes.length : 0;
  if (filter) for (const index of [...plan.removeIndexes].reverse()) promptChat.splice(index, 1);
  const floors = plan.includedFloors;
  return `已准备 ${floors.length} 楼摘要，待核对最终提示词；过滤 ${removed} 楼旧原文，最近 ${recentRawCount(recentRaw)} 楼原文照常发送`;
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
        const message = '这次没有发出去：酒馆把喵喵的记忆挤出了提示词，通常是上下文长度放不下。把酒馆的上下文长度调大，或在喵喵设置里调小“每轮最多带入”，然后重新发送。';
        onStatus(message);
        globalThis.toastr?.warning?.(message, '喵喵数据库', { timeOut: 12000 });
        return;
      }
      onEvidence({ status: 'verified' });
      onStatus('已在本轮待发提示词中核对总摘要；模型接收仍以实际请求为准');
    },
  };
  return request;
}
