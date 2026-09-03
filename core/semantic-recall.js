import { RAW_FLOOR_LIMIT } from './privacy-payload.js';

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

export function buildRecallDocument(record) {
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
  const target = Math.max(0, Math.min(Number(targetFloorIndex) || 0, Math.max(0, rows.length - 1)));
  const count = Math.max(1, Math.min(RAW_FLOOR_LIMIT, Number(recentCount) || 2));
  const start = Math.max(0, target - count + 1);
  return rows.slice(start, target + 1).map((message, offset) => {
    const speaker = message?.is_user ? '玩家' : normalizeText(message?.name) || '角色';
    return `第 ${start + offset + 1} 楼 · ${speaker}：${normalizeText(message?.mes)}`;
  }).join('\n');
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
  const memories = records.map((record) => `【第 ${record.floorIndex + 1} 楼的历史摘要】\n${record.sourceText}`).join('\n\n');
  return [
    '【春序档案 · 语义回忆】',
    '以下内容只是与当前情境相关的历史线索，不是永久命令。',
    '玩家的决定、拒绝、同意、偏好与边界都必须结合楼层顺序理解：同一主题若有后续明确更新，以楼层号更大的明确表态作为当前状态。',
    '旧表态仍是当时真实发生过的历史，但不得继续当作当前约束，也不得把任何单次表态永久化。',
    '不得改变已确认的时间、地点、人物状态与事件先后。',
    memories,
  ].join('\n\n');
}

export class SemanticRecallService {
  constructor({ storage, getCredentials }) {
    this.storage = storage;
    this.getCredentials = getCredentials;
  }

  async sync(chatKey, summaries, { force = false } = {}) {
    const credentials = this.getCredentials();
    const model = normalizeText(credentials.embeddingModel);
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
        && current?.documentFingerprint === documentFingerprint
        && current?.model === model;
      return unchanged ? null : { record, sourceText, documentFingerprint };
    }).filter(Boolean);
    if (pending.length) {
      const embeddings = await callOpenAiCompatibleEmbeddings({
        ...credentials,
        model,
        input: pending.map((item) => item.sourceText),
      });
      for (let index = 0; index < pending.length; index += 1) {
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
          isUser: Boolean(record.isUser),
          updatedAt: new Date().toISOString(),
        });
      }
    }
    return this.storage.listVectors(chatKey);
  }

  async recall({ chatKey, summaries, chat, targetFloorIndex, topK, threshold, force = false }) {
    const vectors = await this.sync(chatKey, summaries, { force });
    const query = buildRecallQuery(chat, targetFloorIndex);
    if (!query) return { indexedCount: vectors.length, records: [], prompt: '' };
    const [queryEmbedding] = await callOpenAiCompatibleEmbeddings({
      ...this.getCredentials(),
      model: this.getCredentials().embeddingModel,
      input: [query],
    });
    const records = rankRecallMemories(vectors, queryEmbedding, { latestFloorIndex: targetFloorIndex, topK, threshold });
    return { indexedCount: vectors.length, records, prompt: formatRecallPrompt(records) };
  }

  async rebuild(chatKey, summaries) {
    await this.storage.clearVectors(chatKey);
    return this.sync(chatKey, summaries, { force: true });
  }
}
