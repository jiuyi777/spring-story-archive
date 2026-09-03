export const RAW_FLOOR_LIMIT = 5;
export const DEFAULT_RAW_FLOOR_LIMIT = 0;
export const REMOTE_INPUT_TOKEN_LIMIT = 6500;

function normalizeText(value) {
  return String(value ?? '').replace(/\u0000/g, '').trim();
}

export function fingerprintMessage(message, floorIndex) {
  const source = JSON.stringify({
    floorIndex,
    text: normalizeText(message?.mes),
    isUser: Boolean(message?.is_user),
    isSystem: Boolean(message?.is_system),
    name: normalizeText(message?.name),
    swipeId: Number.isInteger(message?.swipe_id) ? message.swipe_id : 0,
  });
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function safeRawFloorLimit(value) {
  const numeric = Math.floor(Number(value));
  return Number.isFinite(numeric) ? Math.max(0, Math.min(RAW_FLOOR_LIMIT, numeric)) : DEFAULT_RAW_FLOOR_LIMIT;
}

export function truncateToTokenBudget(value, maxTokens) {
  const text = normalizeText(value);
  const budget = Math.max(0, Math.floor(Number(maxTokens) || 0));
  if (!text || !budget || estimateTokens(text) <= budget) return budget ? text : '';
  let low = 0;
  let high = text.length;
  const marker = '\n…（已按远端 token 上限省略中段）…\n';
  while (low < high) {
    const keep = Math.ceil((low + high) / 2);
    const head = Math.ceil(keep * 0.45);
    const tail = Math.floor(keep * 0.55);
    const candidate = `${text.slice(0, head)}${marker}${text.slice(text.length - tail)}`;
    if (estimateTokens(candidate) <= budget) low = keep;
    else high = keep - 1;
  }
  const head = Math.ceil(low * 0.45);
  const tail = Math.floor(low * 0.55);
  return `${text.slice(0, head)}${marker}${text.slice(text.length - tail)}`.trim();
}

export function buildPrivacyPayload({
  chat,
  targetFloorIndex,
  rollingSummary = '',
  rawFloorLimit = DEFAULT_RAW_FLOOR_LIMIT,
  includeTargetFloor = false,
  inputTokenLimit = REMOTE_INPUT_TOKEN_LIMIT,
}) {
  const safeChat = Array.isArray(chat) ? chat : [];
  const boundedTarget = Math.max(0, Math.min(Number(targetFloorIndex) || 0, Math.max(0, safeChat.length - 1)));
  const requestedLimit = safeRawFloorLimit(rawFloorLimit);
  const effectiveLimit = includeTargetFloor && safeChat.length ? Math.max(1, requestedLimit) : requestedLimit;
  const start = Math.max(0, boundedTarget - effectiveLimit + 1);
  const selectedFloors = effectiveLimit > 0 ? safeChat.slice(start, boundedTarget + 1) : [];
  const totalBudget = Math.max(1000, Math.min(REMOTE_INPUT_TOKEN_LIMIT, Number(inputTokenLimit) || REMOTE_INPUT_TOKEN_LIMIT));
  const rawBudget = selectedFloors.length ? Math.min(2500, Math.max(800, Math.floor(totalBudget * 0.4))) : 0;
  const perFloorBudget = selectedFloors.length ? Math.max(160, Math.floor(rawBudget / selectedFloors.length)) : 0;
  let contentTruncated = false;
  const recentFloors = selectedFloors.map((message, offset) => {
    const sourceText = normalizeText(message?.mes);
    const text = truncateToTokenBudget(sourceText, perFloorBudget);
    if (text !== sourceText) contentTruncated = true;
    return {
    floor: start + offset + 1,
    speaker: message?.is_user ? 'player' : (normalizeText(message?.name) || 'character'),
    kind: message?.is_system ? 'system' : (message?.is_user ? 'user' : 'assistant'),
    importance: message?.is_user ? 'player-statement' : 'normal',
      text,
    };
  });
  const usedRawTokens = recentFloors.reduce((total, floor) => total + estimateTokens(floor.text), 0);
  const summarySource = normalizeText(rollingSummary);
  const safeRollingSummary = truncateToTokenBudget(summarySource, Math.max(0, totalBudget - usedRawTokens));
  if (safeRollingSummary !== summarySource) contentTruncated = true;

  return {
    policy: {
      rawFloorLimit: requestedLimit,
      olderRawFloorsIncluded: false,
      targetFloorIncludedForSummary: Boolean(includeTargetFloor && safeChat.length),
      maxInputTokens: totalBudget,
      contentTruncated,
    },
    targetFloor: boundedTarget + 1,
    rollingSummary: safeRollingSummary,
    recentFloors,
  };
}

export function estimateTokens(text) {
  const value = normalizeText(text);
  if (!value) return 0;
  const cjk = (value.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length;
  const other = Math.max(0, value.length - cjk);
  return Math.ceil(cjk * 1.15 + other / 4);
}

export function fingerprintSummaries(records) {
  const source = records
    .map((record) => JSON.stringify({
      floorIndex: record.floorIndex,
      messageFingerprint: record.messageFingerprint,
      priority: record.priority,
      summary: normalizeText(record.summary),
      timeline: Array.isArray(record.timeline) ? record.timeline.map(normalizeText) : [],
      characters: Array.isArray(record.characters) ? record.characters.map(normalizeText) : [],
      relationships: Array.isArray(record.relationships) ? record.relationships.map(normalizeText) : [],
      clues: Array.isArray(record.clues) ? record.clues.map(normalizeText) : [],
    }))
    .join('|');
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
