import test from 'node:test';
import assert from 'node:assert/strict';
import { keywordRecall, archiveNames } from '../core/keyword-recall.js';

const summaries = [
  { floorIndex: 0, summary: '玩家推门进了旧宅，林素在档案室整理登记簿。' },
  { floorIndex: 1, summary: '林素说登记簿缺了一页，三年前就被撕掉了。' },
  { floorIndex: 2, summary: '沈砚把西廊钥匙借给了林素。' },
  { floorIndex: 3, summary: '两人在厨房煮茶，聊起天气。' },
  { floorIndex: 4, summary: '雨停了。' },
  { floorIndex: 20, summary: '最近的一楼。' },
];
const database = { tables: { characters: [{ values: { name: '沈砚', aliases: '沈先生' } }, { values: { name: '林素' } }], inventory: [{ values: { name: '西廊钥匙' } }], clues: [{ values: { name: '缺页' } }] } };

test('names from the archive find the old floors that mention them; rare names weigh more', () => {
  const found = keywordRecall(summaries, { query: '沈砚问起那把西廊钥匙的下落', names: archiveNames(database), latestFloorIndex: 20, topK: 2 });
  assert.equal(found[0].floorIndex, 2);
  assert.deepEqual(found[0].matched.sort(), ['沈砚', '西廊钥匙'].sort());
});

test('phrase overlap still works when the archive is thin', () => {
  const found = keywordRecall(summaries, { query: '再去翻一翻登记簿', names: [], latestFloorIndex: 20, topK: 3 });
  assert.ok(found.some((row) => row.floorIndex === 1 || row.floorIndex === 0));
  assert.ok(!found.some((row) => row.floorIndex === 3));
});

test('nothing related means nothing recalled; recent floors are left to raw text', () => {
  assert.deepEqual(keywordRecall(summaries, { query: '今天吃什么', names: archiveNames(database), latestFloorIndex: 20 }), []);
  assert.ok(!keywordRecall(summaries, { query: '最近的一楼', names: [], latestFloorIndex: 20 }).some((row) => row.floorIndex === 20));
});
