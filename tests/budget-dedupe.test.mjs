import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryBudgetFor, buildStoryContext } from '../core/story-context.js';
import { fitRecall } from '../core/semantic-recall.js';
import { fingerprintMessage } from '../core/privacy-payload.js';
import { MEMORY_VERSION } from '../core/memory-database.js';

test('the player sets the ceiling and it is used as set, up to a million', () => {
  assert.equal(memoryBudgetFor(32000, 3000), 3000);
  assert.equal(memoryBudgetFor(4000, 200000), 200000);
  assert.equal(memoryBudgetFor(1000000, undefined), 20000);
  assert.equal(memoryBudgetFor(0, 5000000), 1000000);
});

test('a smaller ceiling sends fewer summaries and reports what it used', () => {
  const chat = Array.from({ length: 40 }, (_, i) => ({ mes: `第${i + 1}楼。`.repeat(10), is_user: i % 2 === 0 }));
  const summaries = chat.map((m, i) => ({ floorIndex: i, status: 'ready', inputComplete: true, memoryVersion: MEMORY_VERSION, messageFingerprint: fingerprintMessage(m, i), summary: `这是第${i + 1}楼发生的事情的小结，内容足够长以便占用一些额度。`, memoryChanges: [] }));
  const promptChat = chat.map((m, i) => ({ ...m, index: i }));
  const wide = buildStoryContext({ sourceChat: chat, promptChat, summaries, checkpoints: [], contextSize: 32000, type: 'normal', memoryBudget: 6000 });
  const narrow = buildStoryContext({ sourceChat: chat, promptChat, summaries, checkpoints: [], contextSize: 32000, type: 'normal', memoryBudget: 300 });
  assert.ok(narrow.includedFloors.length < wide.includedFloors.length);
  assert.ok(narrow.usedTokens <= 300);
  assert.equal(narrow.budget, 300);
});

test('recall skips floors already in the prompt and keeps the best matches that fit', () => {
  const records = [
    { floorIndex: 2, sourceText: '甲'.repeat(40), similarity: 0.9 },
    { floorIndex: 5, sourceText: '乙'.repeat(40), similarity: 0.8 },
    { floorIndex: 7, sourceText: '丙'.repeat(40), similarity: 0.95 },
    { floorIndex: 9, sourceText: '丁'.repeat(40), similarity: 0.7 },
  ];
  const result = fitRecall(records, { skipFloors: new Set([7]), budget: 120 });
  assert.deepEqual(result.records.map((row) => row.floorIndex), [2, 5]);
  assert.equal(result.dropped.duplicate, 1);
  assert.equal(result.dropped.budget, 1);
  assert.doesNotMatch(result.prompt, /第 8 楼/);
});
