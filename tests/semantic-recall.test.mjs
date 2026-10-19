import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRecallDocument,
  buildRecallQuery,
  buildRecallSummaryQuery,
  callOpenAiCompatibleEmbeddings,
  cosineSimilarity,
  embeddingsEndpointForChatEndpoint,
  formatRecallPrompt,
  fitRecall,
  rankRecallMemories,
  SemanticRecallService,
} from '../core/semantic-recall.js';
import { createMemoryStorage } from '../core/storage.js';
import { keywordRecall } from '../core/keyword-recall.js';

test('embedding endpoint is derived from chat completions and responses URLs', () => {
  assert.equal(embeddingsEndpointForChatEndpoint('https://example.test/v1/chat/completions'), 'https://example.test/v1/embeddings');
  assert.equal(embeddingsEndpointForChatEndpoint('https://example.test/v1/responses'), 'https://example.test/v1/embeddings');
});

test('embedding requests contain summaries and never require older raw floor text', async () => {
  const document = buildRecallDocument({
    floorIndex: 1,
    isUser: true,
    summary: '玩家当时决定留在旧宅。',
    timeline: ['暮春傍晚'],
    characters: [], relationships: [], clues: [],
  });
  assert.match(document, /玩家当时决定留在旧宅/);
  assert.doesNotMatch(document, /OLD_RAW_SECRET/);
  let body;
  await callOpenAiCompatibleEmbeddings({
    endpoint: 'https://example.test/v1/chat/completions',
    apiKey: 'test-key',
    model: 'embed-model',
    input: [document],
    fetchImpl: async (url, init) => {
      body = JSON.parse(init.body);
      return { ok: true, json: async () => ({ data: [{ index: 0, embedding: [1, 0] }] }) };
    },
  });
  assert.deepEqual(body.input, [document]);
  assert.equal(JSON.stringify(body).includes('OLD_RAW_SECRET'), false);
});

test('recall query uses no more than the latest five raw floors', () => {
  const chat = Array.from({ length: 9 }, (_, index) => ({ mes: `RAW_${index + 1}`, is_user: index % 2 === 0 }));
  const query = buildRecallQuery(chat, 8, 5);
  assert.doesNotMatch(query, /RAW_[1-4](?:\D|$)/);
  for (let floor = 5; floor <= 9; floor += 1) assert.match(query, new RegExp(`RAW_${floor}`));
});

test('zero raw-floor mode builds the recall query from summaries only', () => {
  const query = buildRecallQuery([{ mes: 'PRIVATE_RAW' }], 0, 0);
  assert.equal(query, '');
  const summaryQuery = buildRecallSummaryQuery([
    { floorIndex: 0, status: 'ready', summary: '允许发送的摘要', timeline: [], characters: [], relationships: [], clues: [] },
  ], 0);
  assert.match(summaryQuery, /允许发送的摘要/);
  assert.doesNotMatch(summaryQuery, /PRIVATE_RAW/);
});

test('semantic ranking excludes the latest five floors and adds no player weighting', () => {
  const records = [
    { floorIndex: 0, isUser: false, embedding: [1, 0] },
    { floorIndex: 1, isUser: true, embedding: [0.8, 0.2] },
    { floorIndex: 2, isUser: false, embedding: [0.9, 0.1] },
    { floorIndex: 5, isUser: true, embedding: [1, 0] },
  ];
  const ranked = rankRecallMemories(records, [1, 0], { latestFloorIndex: 9, topK: 2, threshold: 0 });
  assert.deepEqual(ranked.map((row) => row.floorIndex), [0, 2]);
  assert.equal(ranked.some((row) => row.floorIndex === 5), false);
  assert.ok(cosineSimilarity([1, 0], [1, 0]) > cosineSimilarity([0.8, 0.2], [1, 0]));
});

test('top semantic results are placed back in chronological order', () => {
  const ranked = rankRecallMemories([
    { floorIndex: 1, embedding: [0.8, 0.2] },
    { floorIndex: 2, embedding: [1, 0] },
    { floorIndex: 3, embedding: [0.9, 0.1] },
  ], [1, 0], { latestFloorIndex: 20, topK: 2, threshold: 0 });
  assert.deepEqual(ranked.map((row) => row.floorIndex), [2, 3]);
});

test('recall uses speaker names and sends chronological facts without internal instructions', () => {
  const prompt = formatRecallPrompt([
    { floorIndex: 3, isUser: true, speakerName: '阿青', summary: '允许短暂追逐。' },
    { floorIndex: 2, isUser: true, speakerName: '林青', summary: '当时拒绝进入庭院。', timeline: ['傍晚'] },
  ]);
  assert.equal(prompt, '【相关往事】\n\n【林青】当时拒绝进入庭院。\n时间线：傍晚\n\n【阿青】允许短暂追逐。');
  assert.doesNotMatch(prompt, /玩家|第 \d+ 楼|永久命令|明确表态作为当前状态|历史摘要/);
  assert.equal(buildRecallQuery([{ name: '林青', is_user: true, mes: '原文里的玩家不应被替换。' }], 0), '林青：原文里的玩家不应被替换。');
  assert.equal(buildRecallDocument({ isUser: true, summary: '留下。' }), '【User】留下。');
  assert.equal(buildRecallDocument({ summary: '天色渐暗。' }), '【旁白】天色渐暗。');
});

test('keyword recall renders latest summary facts and names rather than the cache envelope', () => {
  const records = keywordRecall([
    { floorIndex: 1, isUser: true, speakerName: '林青', summary: '林青把铜钥匙借给沈砚。', timeline: ['晚七点'] },
  ], { query: '铜钥匙', names: ['铜钥匙'], latestFloorIndex: 20 });
  assert.equal(formatRecallPrompt(records), '【相关往事】\n\n【林青】林青把铜钥匙借给沈砚。\n时间线：晚七点');
  const prompt = formatRecallPrompt(records);
  const fitted = fitRecall(records, { budget: prompt.length, estimate: text => text.length });
  assert.equal(fitted.prompt, prompt);
  assert.equal(fitted.usedTokens, prompt.length);
  assert.equal(fitRecall(records, { budget: prompt.length - 1, estimate: text => text.length }).prompt, '');
});

test('existing vector cache gains named outgoing facts without reembedding', async () => {
  const storage = createMemoryStorage();
  const credentials = { endpoint: 'https://example.test/v1/chat/completions', embeddingModel: 'test-embedding', profileId: 'test' };
  const sourceText = '第 2 楼 · 玩家明确表态\n摘要：林青把铜钥匙借给沈砚。\n时间线：晚七点';
  let hash = 0x811c9dc5;
  for (let index = 0; index < sourceText.length; index += 1) hash = Math.imul(hash ^ sourceText.charCodeAt(index), 0x01000193);
  const cache = { key: 'chat::vector::floor::1', chatKey: 'chat', floorIndex: 1, sourceText,
    documentFingerprint: (hash >>> 0).toString(16).padStart(8, '0'), messageFingerprint: 'unchanged',
    model: credentials.embeddingModel, endpoint: 'https://example.test/v1/embeddings', profileId: 'test', isUser: true, embedding: [1, 0] };
  await storage.putVector(cache);
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error('unexpected embedding request'); };
  try {
    const service = new SemanticRecallService({ storage, getCredentials: () => credentials });
    const records = await service.sync('chat', [{ floorIndex: 1, status: 'ready', messageFingerprint: 'unchanged',
      isUser: true, speakerName: '林青', summary: '林青把铜钥匙借给沈砚。', timeline: ['晚七点'] }]);
    assert.equal(calls, 0);
    assert.equal(formatRecallPrompt(records), '【相关往事】\n\n【林青】林青把铜钥匙借给沈砚。\n时间线：晚七点');
    assert.deepEqual((await storage.listVectors('chat'))[0], cache);
    assert.doesNotMatch(formatRecallPrompt([cache]), /第 2 楼|玩家明确表态|摘要：/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('memory storage can replace and clear vector rows by chat', async () => {
  const storage = createMemoryStorage();
  await storage.putVector({ key: 'a::1', chatKey: 'a', floorIndex: 1, embedding: [1] });
  await storage.putVector({ key: 'b::1', chatKey: 'b', floorIndex: 1, embedding: [2] });
  assert.equal((await storage.listVectors('a')).length, 1);
  await storage.clearVectors('a');
  assert.equal((await storage.listVectors('a')).length, 0);
  assert.equal((await storage.listVectors('b')).length, 1);
});
