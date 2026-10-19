import { RAW_FLOOR_LIMIT, validSummaries, storyText, messageStoryText } from './privacy-payload.js?v=0.7.3';

function normalizeText(value) {
  return String(value ?? '').replace(/\u0000/g, '').trim();
}

function fingerprintText(value) {
  let hash = 0x811c9dc5;
  const text = normalizeText(value);
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function ensureEndpoint(endpoint) {
  const value = normalizeText(endpoint);
  if (!value) throw new Error('请先填写额外 API 地址。');
  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol)) throw new Error('额外 API 仅支持 http 或 https 地址。');
  return url;
}

export function embeddingsEndpointForChatEndpoint(endpoint) {
  const url = ensureEndpoint(endpoint);
  const path = url.pathname.replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(path)) url.pathname = path.replace(/\/chat\/completions$/i, '/embeddings');
  else if (/\/responses$/i.test(path)) url.pathname = path.replace(/\/responses$/i, '/embeddings');
  else url.pathname = `${path}/embeddings`.replace(/\/{2,}/g, '/');
  url.search = '';
  url.hash = '';
  return url.href;
}

export async function callOpenAiCompatibleEmbeddings({ endpoint, apiKey, model, input, signal, fetchImpl = fetch }) {
  const inputs = Array.isArray(input) ? input.map(normalizeText) : [normalizeText(input)];
  if (!normalizeText(model)) throw new Error('请选择嵌入模型。');
  if (!inputs.length || inputs.some((item) => !item)) throw new Error('没有可向量化的摘要。');
  const response = await fetchImpl(embeddingsEndpointForChatEndpoint(endpoint), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(normalizeText(apiKey) ? { Authorization: `Bearer ${normalizeText(apiKey)}` } : {}),
    },
    body: JSON.stringify({ model: normalizeText(model), input: inputs }),
    signal,
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(`嵌入接口返回 ${response.status}${detail ? `：${detail}` : ''}`);
  }
  const payload = await response.json();
  const rows = Array.isArray(payload?.data) ? [...payload.data].sort((a, b) => Number(a.index) - Number(b.index)) : [];
  const embeddings = rows.map((row) => row?.embedding).filter((row) => Array.isArray(row) && row.length);
  if (embeddings.length !== inputs.length) throw new Error('嵌入接口返回的向量数量不完整。');
  return embeddings;
}

function factLine(label, items) {
  const values = Array.isArray(items) ? items.map(normalizeText).filter(Boolean) : [];
  return values.length ? `${label}：${values.join('；')}` : '';
}

function recallSpeaker(record) {
  return normalizeText(record.speakerName) || (record.isUser ? 'User' : '旁白');
}

export function buildRecallDocument(record) {
  return [
    `【${recallSpeaker(record)}】${normalizeText(record.summary)}`,
    factLine('时间线', record.timeline),
    factLine('人物状态', record.characters),
    factLine('人物关系', record.relationships),
    factLine('线索', record.clues),
  ].filter(Boolean).join('\n');
}

// Recognize existing vector fingerprints without paying to rebuild them for a
// presentation-only change. This legacy format never becomes outgoing context.
function legacyIndexDocument(record) {
  return [
    `第 ${Number(record.floorIndex) + 1} 楼${record.isUser ? ' · 玩家明确表态' : ''}`,
    `摘要：${normalizeText(record.summary)}`,
    factLine('时间线', record.timeline),
    factLine('人物状态', record.characters),
    factLine('人物关系', record.relationships),
    factLine('线索', record.clues),
  ].filter(Boolean).join('\n');
}

export function buildRecallQuery(chat, targetFloorIndex, recentCount = 2) {
  const rows = Array.isArray(chat) ? chat : [];
  const requestedCount = Math.floor(Number(recentCount));
  if (!rows.length || !Number.isFinite(requestedCount) || requestedCount <= 0) return '';
  const target = Math.max(0, Math.min(Number(targetFloorIndex) || 0, Math.max(0, rows.length - 1)));
  const count = Math.min(RAW_FLOOR_LIMIT, requestedCount);
  const start = Math.max(0, target - count + 1);
  return rows.slice(start, target + 1).map((message) => {
    const speaker = normalizeText(message?.name) || (message?.is_user ? 'User' : '旁白');
    return `${speaker}：${messageStoryText(message)}`;
  }).join('\n');
}

export function buildRecallSummaryQuery(summaries, targetFloorIndex, recentCount = 2) {
  const target = Number(targetFloorIndex);
  const count = Math.max(1, Math.min(5, Math.floor(Number(recentCount) || 2)));
  return (summaries ?? [])
    .filter((record) => record.status === 'ready' && Number(record.floorIndex) <= target)
    .sort((left, right) => left.floorIndex - right.floorIndex)
    .slice(-count)
    .map(buildRecallDocument)
    .join('\n\n');
}

export function cosineSimilarity(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || !left.length || left.length !== right.length) return -1;
  let dot = 0;
  let leftSize = 0;
  let rightSize = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = Number(left[index]);
    const b = Number(right[index]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return -1;
    dot += a * b;
    leftSize += a * a;
    rightSize += b * b;
  }
  if (!leftSize || !rightSize) return -1;
  return dot / (Math.sqrt(leftSize) * Math.sqrt(rightSize));
}

export function rankRecallMemories(records, queryEmbedding, {
  latestFloorIndex,
  topK = 4,
  threshold = 0.3,
  recentFloorLimit = RAW_FLOOR_LIMIT,
} = {}) {
  const latest = Number(latestFloorIndex);
  const firstExcluded = latest - Math.max(1, Number(recentFloorLimit) || RAW_FLOOR_LIMIT) + 1;
  return (records ?? [])
    .filter((record) => Number(record.floorIndex) < firstExcluded)
    .map((record) => ({ ...record, similarity: cosineSimilarity(record.embedding, queryEmbedding) }))
    .filter((record) => record.similarity >= Number(threshold))
    .sort((left, right) => right.similarity - left.similarity || right.floorIndex - left.floorIndex)
    .slice(0, Math.max(1, Number(topK) || 4))
    .sort((left, right) => left.floorIndex - right.floorIndex);
}

export function formatRecallPrompt(records) {
  if (!records?.length) return '';
  const memories = [...records].sort((left, right) => left.floorIndex - right.floorIndex).map((record) => {
    if (normalizeText(record.summary)) return buildRecallDocument(record);
    // Bare cache rows may still reach a preview. Remove only our old envelope;
    // the archived story text, including literal uses of 玩家, stays intact.
    const source = normalizeText(record.sourceText)
      .replace(/^第 \d+ 楼(?: · 玩家明确表态)?\r?\n摘要：/, '');
    return source ? `【${recallSpeaker(record)}】${source}` : '';
  }).filter(Boolean);
  return memories.length ? `【相关往事】\n\n${memories.join('\n\n')}` : '';
}

export class SemanticRecallService {
  constructor({ storage, getCredentials }) {
    this.storage = storage;
    this.getCredentials = getCredentials;
  }

  assertCurrent(credentials) {
    const current = this.getCredentials();
    if (['profileId', 'endpoint', 'apiKey', 'embeddingModel'].some((key) => current[key] !== credentials[key])) {
      throw new Error('API 配置已变化，请重新执行语义回忆。');
    }
  }

  async sync(chatKey, summaries, { force = false, credentials = this.getCredentials() } = {}) {
    const model = normalizeText(credentials.embeddingModel);
    const endpoint = embeddingsEndpointForChatEndpoint(credentials.endpoint);
    const profileId = credentials.profileId ?? '';
    if (!model) throw new Error('请选择嵌入模型。');
    const ready = (summaries ?? []).filter((record) => record.status === 'ready' && normalizeText(record.summary));
    const existing = await this.storage.listVectors(chatKey);
    const byFloor = new Map(existing.map((record) => [record.floorIndex, record]));
    const validFloors = new Set(ready.map((record) => record.floorIndex));
    for (const vector of existing) {
      if (!validFloors.has(vector.floorIndex)) await this.storage.deleteVector(vector.key);
    }
    const pending = ready.map((record) => {
      const sourceText = buildRecallDocument(record);
      const documentFingerprint = fingerprintText(sourceText);
      const current = byFloor.get(record.floorIndex);
      const unchanged = !force
        && current?.messageFingerprint === record.messageFingerprint
        && [documentFingerprint, fingerprintText(legacyIndexDocument(record))].includes(current?.documentFingerprint)
        && current?.model === model && current?.endpoint === endpoint && current?.profileId === profileId;
      return unchanged ? null : { record, sourceText, documentFingerprint };
    }).filter(Boolean);
    if (pending.length) {
      const embeddings = await callOpenAiCompatibleEmbeddings({
        ...credentials,
        model,
        input: pending.map((item) => item.sourceText),
      });
      this.assertCurrent(credentials);
      for (let index = 0; index < pending.length; index += 1) {
        this.assertCurrent(credentials);
        const { record, sourceText, documentFingerprint } = pending[index];
        await this.storage.putVector({
          key: `${chatKey}::vector::floor::${record.floorIndex}`,
          chatKey,
          floorIndex: record.floorIndex,
          messageFingerprint: record.messageFingerprint,
          documentFingerprint,
          sourceText,
          embedding: embeddings[index],
          model,
          endpoint,
          profileId,
          isUser: Boolean(record.isUser),
          updatedAt: new Date().toISOString(),
        });
      }
    }
    this.assertCurrent(credentials);
    const summariesByFloor = new Map(ready.map((record) => [record.floorIndex, record]));
    return (await this.storage.listVectors(chatKey))
      .filter((row) => summariesByFloor.has(row.floorIndex) && row.model === model && row.endpoint === endpoint && row.profileId === profileId)
      .map((row) => {
        const summary = summariesByFloor.get(row.floorIndex);
        return { ...row, summary: summary.summary, speakerName: summary.speakerName,
          isUser: Boolean(summary.isUser), timeline: summary.timeline, characters: summary.characters,
          relationships: summary.relationships, clues: summary.clues };
      });
  }

  async recall({ chatKey, summaries, chat, targetFloorIndex, topK, threshold, recentRawFloorLimit = RAW_FLOOR_LIMIT, force = false }) {
    const credentials = { ...this.getCredentials() };
    summaries = validSummaries(summaries, chat).filter((record) => record.floorIndex <= targetFloorIndex);
    const vectors = await this.sync(chatKey, summaries, { force, credentials });
    this.assertCurrent(credentials);
    const rawLimit = Math.max(0, Math.min(100, Math.floor(Number(recentRawFloorLimit) || 0)));
    const query = rawLimit > 0
      ? buildRecallQuery(chat, targetFloorIndex, rawLimit)
      : buildRecallSummaryQuery(summaries, targetFloorIndex, 2);
    if (!query) return { indexedCount: vectors.length, records: [], prompt: '' };
    const [queryEmbedding] = await callOpenAiCompatibleEmbeddings({
      ...credentials,
      model: credentials.embeddingModel,
      input: [query],
    });
    this.assertCurrent(credentials);
    const records = rankRecallMemories(vectors, queryEmbedding, {
      latestFloorIndex: targetFloorIndex,
      topK,
      threshold,
      recentFloorLimit: rawLimit || 2,
    });
    return { indexedCount: vectors.length, records, prompt: formatRecallPrompt(records) };
  }

  async rebuild(chatKey, summaries) {
    await this.storage.clearVectors(chatKey);
    return this.sync(chatKey, summaries, { force: true });
  }
}

// Recall only adds what the prompt does not already carry: a floor whose
// summary is in the story block, or whose raw text is still in the chat
// history, is skipped. What is left is cut to the remaining budget, whole
// records only, best matches first.
export function fitRecall(records, { skipFloors = new Set(), budget = Infinity, estimate = (text) => String(text ?? '').length } = {}) {
  const kept = [];
  const dropped = { duplicate: 0, budget: 0 };
  const byMatch = [...(records ?? [])].sort((left, right) => (right.similarity ?? 0) - (left.similarity ?? 0));
  for (const record of byMatch) {
    if (skipFloors.has(record.floorIndex)) { dropped.duplicate += 1; continue; }
    const candidate = [...kept, record].sort((left, right) => left.floorIndex - right.floorIndex);
    if (estimate(formatRecallPrompt(candidate)) > budget) { dropped.budget += 1; continue; }
    kept.push(record);
  }
  kept.sort((left, right) => left.floorIndex - right.floorIndex);
  return { records: kept, prompt: kept.length ? formatRecallPrompt(kept) : '', usedTokens: kept.length ? estimate(formatRecallPrompt(kept)) : 0, dropped };
}
