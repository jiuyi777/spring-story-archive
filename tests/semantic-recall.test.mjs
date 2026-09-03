import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRecallDocument,
  buildRecallQuery,
  callOpenAiCompatibleEmbeddings,
  cosineSimilarity,
  embeddingsEndpointForChatEndpoint,
  formatRecallPrompt,
  rankRecallMemories,
} from '../core/semantic-recall.js';
import { createMemoryStorage } from '../core/storage.js';

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

test('recall prompt makes later explicit statements current without erasing history', () => {
  const prompt = formatRecallPrompt([{ floorIndex: 2, sourceText: '玩家当时拒绝进入庭院。' }]);
  assert.match(prompt, /以楼层号更大的明确表态作为当前状态/);
  assert.match(prompt, /旧表态仍是当时真实发生过的历史/);
  assert.match(prompt, /不得把任何单次表态永久化/);
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
