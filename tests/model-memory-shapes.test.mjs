import test from 'node:test';
import assert from 'node:assert/strict';
import { requestFloorSummaries } from '../core/api-client.js';
import { memorySchemaForPrompt, validateMemoryChanges } from '../core/memory-database.js';

const payload = { targetFloors: [{ floor: 1, text: '林青把铜钥匙借给沈砚，约定今晚八点归还。' }], memorySchema: memorySchemaForPrompt() };
const response = (changes) => ({ floors: [{ floor: 1, summary: '林青借出铜钥匙，沈砚持有并约定归还。', changes }] });
const change = (table, values) => ({ table, id: table, values });

test('real DeepSeek quantity and participant shapes normalize without another request or changing ownership', async () => {
  // These field shapes caused the two observed failures on 2026-10-15.
  const raw = response([
    change('inventory', { name: '铜钥匙', owner: '林青', holder: '沈砚', quantity: 1, place: '沈砚口袋' }),
    change('tasks', { name: '归还铜钥匙', owner: '沈砚', participants: ['林青', '沈砚'], deadline: '今晚八点', state: '进行中' }),
  ]);
  const original = structuredClone(raw);
  let calls = 0;
  const [floor] = await requestFloorSummaries(async (request) => {
    calls += 1;
    assert.match(request.messages[0].content, /每个字段都必须是字符串/);
    assert.match(request.messages[0].content, /quantity 写成 "1"/);
    return raw;
  }, payload);
  assert.equal(calls, 1);
  assert.deepEqual(raw, original, 'normalization must preserve the captured model response');
  assert.deepEqual(floor.memoryChanges[0].values, { name: '铜钥匙', owner: '林青', holder: '沈砚', quantity: '1', place: '沈砚口袋' });
  assert.equal(floor.memoryChanges[1].values.participants, '林青、沈砚');
  assert.equal(floor.memoryChanges[1].values.state, '进行中');
  assert.doesNotThrow(() => validateMemoryChanges(floor.memoryChanges));
  assert.throws(() => validateMemoryChanges(raw.floors[0].changes), /字段/, 'storage continues to reject model field types');
});

test('name lists and finite quantities retain their contents while valid strings stay unchanged', async () => {
  const [floor] = await requestFloorSummaries(async () => response([
    change('characters', { name: '沈砚', aliases: ['沈先生', '阿砚'] }),
    change('clues', { name: '归还说法', people: ['林青', '沈砚'], knownBy: ['林青'], basis: '某人说法' }),
    { table: 'inventory', id: 'empty', values: { quantity: 0 } },
    { table: 'inventory', id: 'fraction', values: { quantity: 0.5 } },
    { table: 'inventory', id: 'text', values: { quantity: '约两袋' } },
  ]), payload);
  assert.equal(floor.memoryChanges[0].values.aliases, '沈先生、阿砚');
  assert.deepEqual(floor.memoryChanges[1].values, { name: '归还说法', people: '林青、沈砚', knownBy: '林青', basis: '某人说法' });
  assert.deepEqual(floor.memoryChanges.slice(2).map((row) => row.values.quantity), ['0', '0.5', '约两袋']);
});

test('ambiguous objects, mixed lists, unknown fields and other non-string values still fail after one repair', async () => {
  const invalid = [
    change('inventory', { quantity: { amount: 1 } }),
    change('inventory', { quantity: [1] }),
    change('inventory', { quantity: true }),
    change('inventory', { quantity: null }),
    change('inventory', { quantity: Infinity }),
    change('inventory', { quantity: NaN }),
    change('inventory', { holder: ['林青', '沈砚'] }),
    change('tasks', { participants: ['林青', { name: '沈砚' }] }),
    change('tasks', { participants: ['林青', 1] }),
    change('tasks', { participants: { name: '林青' } }),
    change('characters', { name: 1 }),
    change('characters', { aliases: ['沈先生', null] }),
    change('clues', { unknown: ['林青'] }),
    change('clues', { unknown: '林青' }),
  ];
  for (const row of invalid) {
    let calls = 0;
    await assert.rejects(requestFloorSummaries(async (request) => {
      calls += 1;
      if (calls === 2) {
        assert.match(request.messages[0].content, /上一响应未通过结构校验/);
        assert.match(request.messages[0].content.split('上一响应未通过结构校验')[1], /每个字段都必须是字符串/);
      }
      return response([row]);
    }, payload), /记忆整理结果仍不完整/);
    assert.equal(calls, 2);
  }
});
