import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { requestCompression, requestFloorSummaries } from '../core/api-client.js';
import { buildMemoryDatabase, memorySchemaForPrompt, MEMORY_VERSION } from '../core/memory-database.js';
import { fingerprintMessage } from '../core/privacy-payload.js';
import { formatFloorRecord } from '../core/summary-engine.js';

// Only fictional story text and parsed model output are retained from the host capture.
const captured = JSON.parse(fs.readFileSync(new URL('./fixtures/deepseek-return-summary.json', import.meta.url), 'utf8'));
const payload = { targetFloors: captured.targetFloors, memorySchema: memorySchemaForPrompt() };
const up = (table, id, values) => ({ table, id, values });
const ready = (chat, row) => ({ ...row, status: 'ready', inputComplete: true,
  messageFingerprint: fingerprintMessage(chat[row.floorIndex], row.floorIndex) });
const archive = (chat, floor) => ready(chat, { ...floor, floorIndex: floor.floor - 1 });
const baseline = () => captured.baselineRecords.map(row => ready(captured.chat, row));

test('real DeepSeek character objects remain readable in stored and formatted floor summaries', async () => {
  const raw = structuredClone(captured.reply);
  let calls = 0;
  const result = await requestFloorSummaries(async () => { calls += 1; return raw; }, payload);
  assert.equal(calls, 1);
  assert.deepEqual(raw, captured.reply, 'the captured response remains unchanged');
  assert.deepEqual(result[0].characters, ['沈砚：已把借来的铜钥匙交回林青，归还完成', '林青：已从沈砚处收回铜钥匙并收进腰包']);
  assert.deepEqual(result[1].characters, ['沈砚：已归还铜钥匙', '林青：已收回铜钥匙并收进腰包']);
  assert.doesNotMatch(result.map(row => formatFloorRecord(archive(captured.chat, row))).join('\n'), /\[object Object\]/);
  const memory = buildMemoryDatabase([...baseline(), ...result.map(row => archive(captured.chat, row))], captured.chat);
  assert.equal(memory.tables.inventory[0].values.owner, '林青');
  assert.equal(memory.tables.inventory[0].values.holder, '林青');
  assert.equal(memory.tables.tasks[0].values.state, '已完成');
  assert.equal(memory.tables.player[0].values.content, '偏好安静调查，不要安排追逐');
});

test('unknown list objects use the one repair attempt instead of silently entering the archive', async () => {
  const invalid = [
    ['characters', [{ name: '沈砚', state: '归还', hidden: '额外内容' }]],
    ['characters', [{ name: '沈砚' }]],
    ['characters', [{ name: '沈砚', state: { text: '归还' } }]],
    ['characters', [null]],
    ['characters', [7]],
    ['relationships', [{ from: '林青', to: '沈砚' }]],
    ['clues', [{ name: '铜钥匙' }]],
    ['timeline', [{ time: '八点' }]],
    ['timeline', [['八点']]],
    ['timeline', '八点'],
  ];
  for (const [field, value] of invalid) {
    let calls = 0;
    const result = await requestFloorSummaries(async ({ messages }) => {
      calls += 1;
      assert.match(messages[0].content, /characters、relationships、clues、timeline 均为字符串数组/);
      if (calls === 2) assert.match(messages[0].content.split('上一响应未通过结构校验')[1], /均为字符串数组/);
      return calls === 1 ? { floors: [{ floor: 6, summary: '归还完成', changes: [], [field]: value }] } : captured.reply;
    }, payload);
    assert.equal(calls, 2, `${field}: invalid shape must be repaired`);
    assert.doesNotMatch(JSON.stringify(result), /\[object Object\]/);
  }
  let calls = 0;
  await assert.rejects(requestFloorSummaries(async () => {
    calls += 1;
    return { floors: [{ floor: 6, summary: '归还完成', characters: [{ unknown: '沈砚' }], changes: [] }] };
  }, payload), /记忆整理结果仍不完整/);
  assert.equal(calls, 2);
});

test('summary compression uses the same safe list boundary', async () => {
  const compressed = await requestCompression(async ({ messages }) => {
    assert.match(messages[0].content, /均为字符串数组/);
    return { summary: '归还完成', characters: captured.reply.floors[1].characters, timeline: ['八点归还'] };
  }, '铜钥匙归还完成', 7);
  assert.deepEqual(compressed.characters, ['沈砚：已归还铜钥匙', '林青：已收回铜钥匙并收进腰包']);
  await assert.rejects(requestCompression(async () => ({ summary: '归还完成', timeline: [{ time: '八点' }] }), '归还完成', 7), /无法确认含义/);
});

test('initial and repair instructions require actual scene changes while keeping plans separate', async () => {
  const prompts = [];
  await requestFloorSummaries(async ({ messages }) => {
    prompts.push(messages[0].content);
    return prompts.length === 1 ? 'invalid JSON' : captured.reply;
  }, payload);
  for (const prompt of prompts) {
    assert.match(prompt, /现在八点到了.*必须在该楼 changes 更新 scene\/current 的 time/);
    assert.match(prompt, /必须更新 scene\/current 的 location，并更新实际移动人物的 characters.location/);
    assert.match(prompt, /仅写在 summary 或 timeline 里不足以更新当前场景/);
    assert.match(prompt, /本批较早楼层已经产生的状态/);
    assert.match(prompt, /约定“今晚八点归还”只更新 tasks.deadline/);
    assert.match(prompt, /计划“准备去东廊”不改变 scene.location/);
    assert.match(prompt, /未变字段继续保留，每楼无需重抄整库/);
  }
  const schema = memorySchemaForPrompt();
  assert.match(schema.scene.time, /当前实际时刻.*约定时间写 tasks.deadline/);
  assert.match(schema.scene.location, /抵达或换场时更新.*计划地点/);
  assert.match(schema.characters.location, /实际移动才更新，未移动者保持原位置/);
  assert.match(schema.tasks.deadline, /不代表当前已到该时刻/);
});

test('the captured scene omission stays observable instead of guessing a time from prose', async () => {
  const result = await requestFloorSummaries(async () => captured.reply, payload);
  assert.match(result[0].timeline.join(''), /晚八点/);
  assert.ok(!result.some(row => row.memoryChanges.some(change => change.table === 'scene')));
  const memory = buildMemoryDatabase([...baseline(), ...result.map(row => archive(captured.chat, row))], captured.chat);
  assert.equal(memory.tables.scene[0].values.time, '10月15日傍晚');
  assert.equal(memory.tables.scene[0].values.location, '旧书房');
});

test('an explicit time delta updates the scene without rewriting unchanged locations', async () => {
  const reply = structuredClone(captured.reply);
  reply.floors[0].changes.push(up('scene', 'current', { time: '10月15日晚八点' }));
  const result = await requestFloorSummaries(async () => reply, payload);
  const memory = buildMemoryDatabase([...baseline(), ...result.map(row => archive(captured.chat, row))], captured.chat);
  assert.equal(memory.tables.scene[0].values.time, '10月15日晚八点');
  assert.equal(memory.tables.scene[0].values.location, '旧书房');
  assert.equal(memory.tables.scene[0].fieldSources.time, 5);
  assert.equal(memory.tables.scene[0].fieldSources.location, 0);
  assert.ok(memory.tables.characters.every(row => row.values.location === '旧书房'));
});

test('deadline and destination plans preserve current scene; actual arrival moves only its participant', async () => {
  const chat = captured.chat.slice(0, 5);
  chat.push({ mes: '约定今晚八点归还钥匙。沈砚准备去东廊，林青留在旧书房。' }, { mes: '沈砚已抵达东廊，林青仍留在旧书房。' });
  const reply = { floors: [
    { floor: 6, summary: chat[5].mes, changes: [up('tasks', '归还铜钥匙', { deadline: '今晚八点' }), up('characters', '沈砚', { goal: '去东廊' })] },
    { floor: 7, summary: chat[6].mes, changes: [up('scene', 'current', { location: '东廊' }), up('characters', '沈砚', { location: '东廊' })] },
  ] };
  const result = await requestFloorSummaries(async () => reply, { memorySchema: memorySchemaForPrompt(), targetFloors: [{ floor: 6, text: chat[5].mes }, { floor: 7, text: chat[6].mes }] });
  const records = [...baseline(), ...result.map(row => archive(chat, row))];
  const planned = buildMemoryDatabase(records, chat, [], { throughFloor: 5 });
  assert.equal(planned.tables.scene[0].values.time, '10月15日傍晚');
  assert.equal(planned.tables.scene[0].values.location, '旧书房');
  assert.ok(planned.tables.characters.every(row => row.values.location === '旧书房'));
  const arrived = buildMemoryDatabase(records, chat);
  assert.equal(arrived.tables.scene[0].values.time, '10月15日傍晚');
  assert.equal(arrived.tables.scene[0].values.location, '东廊');
  assert.equal(arrived.tables.characters.find(row => row.id === '沈砚').values.location, '东廊');
  assert.equal(arrived.tables.characters.find(row => row.id === '林青').values.location, '旧书房');
  assert.equal(arrived.version, MEMORY_VERSION);
});
