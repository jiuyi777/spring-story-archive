import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryBudgetFor, buildStoryContext } from '../core/story-context.js';
import { fitRecall, formatRecallPrompt } from '../core/semantic-recall.js';
import { fingerprintMessage, estimateTokens } from '../core/privacy-payload.js';
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
  const budget = formatRecallPrompt([records[0], records[1]]).length;
  const result = fitRecall(records, { skipFloors: new Set([7]), budget });
  assert.deepEqual(result.records.map((row) => row.floorIndex), [2, 5]);
  assert.equal(result.dropped.duplicate, 1);
  assert.equal(result.dropped.budget, 1);
  assert.doesNotMatch(result.prompt, /第 8 楼/);
  assert.ok(result.usedTokens <= budget);
});

test('recall budget includes its complete instructions and every selected floor', () => {
  const records = [
    { floorIndex: 0, sourceText: '已发生的旧剧情。', similarity: 0.9 },
    { floorIndex: 3, sourceText: '另一段历史。', similarity: 0.8 },
  ];
  const firstCost = estimateTokens(formatRecallPrompt([records[0]]));
  for (const budget of [0, Math.floor(firstCost / 2), firstCost - 1]) {
    const result = fitRecall(records.slice(0, 1), { budget, estimate: estimateTokens });
    assert.equal(result.prompt, '');
    assert.equal(result.usedTokens, 0);
    assert.equal(result.dropped.budget, 1);
  }
  for (const budget of [firstCost, 1000]) {
    const result = fitRecall(records, { budget, estimate: estimateTokens });
    assert.ok(result.records.length > 0);
    assert.equal(result.usedTokens, estimateTokens(result.prompt));
    assert.ok(result.usedTokens <= budget);
  }
});

test('raw recent floors are not part of the memory budget, and their count follows the setting', async () => {
  const { buildStoryContext } = await import('../core/story-context.js');
  const { fingerprintMessage, estimateTokens } = await import('../core/privacy-payload.js');
  const long = '很长的原文。'.repeat(400);
  const sourceChat = Array.from({ length: 12 }, (_, index) => ({ mes: `${long}${index}`, is_user: index % 2 === 1, name: index % 2 ? '猫头鹰' : '林栀' }));
  const summaries = sourceChat.map((message, floorIndex) => ({ floorIndex, status: 'ready', summary: `第${floorIndex}件事。`, messageFingerprint: fingerprintMessage(message, floorIndex), inputComplete: true }));
  const promptChat = sourceChat.map((message, index) => ({ ...message, index }));
  const run = (recentRaw) => buildStoryContext({ sourceChat, promptChat: promptChat.map((row) => ({ ...row })), summaries, checkpoints: [], contextSize: 1000000, type: 'normal', memoryBudget: 2000, recentRaw });
  const five = run(5);
  const three = run(3);
  // The raw floors are each ~1,200 tokens: if they counted, a 2,000 budget could not hold anything.
  assert.ok(estimateTokens(sourceChat.slice(-5).map((row) => row.mes).join('')) > 2000);
  assert.ok(five.usedTokens <= 2000 && five.includedFloors.length > 0);
  assert.ok(three.includedFloors.length > five.includedFloors.length, 'a smaller raw window summarizes more floors');
  assert.ok(three.removeIndexes.length > five.removeIndexes.length, 'and drops more old raw floors');
  assert.ok(!five.includedFloors.some((floor) => floor >= 7), 'the newest floors stay raw, not summarized');
});
