export const RAW_FLOOR_LIMIT = 5;

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

export function buildPrivacyPayload({ chat, targetFloorIndex, rollingSummary = '' }) {
  const safeChat = Array.isArray(chat) ? chat : [];
  const boundedTarget = Math.max(0, Math.min(Number(targetFloorIndex) || 0, Math.max(0, safeChat.length - 1)));
  const start = Math.max(0, boundedTarget - RAW_FLOOR_LIMIT + 1);
  const recentFloors = safeChat.slice(start, boundedTarget + 1).map((message, offset) => ({
    floor: start + offset + 1,
    speaker: message?.is_user ? 'player' : (normalizeText(message?.name) || 'character'),
    kind: message?.is_system ? 'system' : (message?.is_user ? 'user' : 'assistant'),
    importance: message?.is_user ? 'player-statement' : 'normal',
    text: normalizeText(message?.mes),
  }));

  return {
    policy: {
      rawFloorLimit: RAW_FLOOR_LIMIT,
      olderRawFloorsIncluded: false,
    },
    targetFloor: boundedTarget + 1,
    rollingSummary: normalizeText(rollingSummary),
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
