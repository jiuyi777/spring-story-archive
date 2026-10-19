import test from 'node:test';
import assert from 'node:assert/strict';
import { fingerprintMessage } from '../core/privacy-payload.js';
import { buildMemoryDatabase, selectMemoryDatabase, MEMORY_VERSION } from '../core/memory-database.js';
import { requestFloorSummaries } from '../core/api-client.js';
import { memorySchemaForPrompt } from '../core/memory-database.js';
import { buildStoryContext } from '../core/story-context.js';

const record = (chat, floorIndex, memoryChanges) => ({ floorIndex, status: 'ready', inputComplete: true, memoryVersion: MEMORY_VERSION,
  messageFingerprint: fingerprintMessage(chat[floorIndex], floorIndex), summary: chat[floorIndex].mes, memoryChanges });
const up = (table, id, values) => ({ table, id, operation: 'upsert', values });

test('a change of mind replaces the current wish and keeps the old one as history', () => {
  const chat = [{ mes: '我喜欢慢热。', is_user: true }, { mes: '好。' }, { mes: '算了，节奏快一点吧。', is_user: true }];
  const db = buildMemoryDatabase([
    record(chat, 0, [up('player', '节奏', { topic: '节奏', kind: '喜欢', content: '慢热' })]),
    record(chat, 2, [up('player', '节奏', { content: '节奏快一点', previous: '慢热' })]),
  ], chat);
  assert.deepEqual(db.tables.player[0].values, { topic: '节奏', kind: '喜欢', content: '节奏快一点', previous: '慢热' });
});

test('player rows are sent first and survive a tiny budget', () => {
  const chat = [{ mes: '别替我做决定。', is_user: true }, { mes: '林素在档案室。' }];
  const db = buildMemoryDatabase([
    record(chat, 0, [up('player', '决定权', { topic: '决定权', kind: '要求', content: '不要替我做决定' })]),
    record(chat, 1, [up('scene', 'current', { location: '档案室' }), up('characters', '林素', { name: '林素', location: '档案室' })]),
  ], chat);
  const { records } = selectMemoryDatabase(db, { budget: 1, query: '林素' });
  assert.equal(records[0].table, 'player');
  assert.equal(records.filter((row) => row.table !== 'player').length, 0);
});

test('the organizing prompt separates the player from characters and keeps wishes until changed', async () => {
  let system = '';
  await requestFloorSummaries(async (request) => {
    system = request.messages[0].content;
    return JSON.stringify({ floors: [{ floor: 1, summary: '玩家提出要求。', characters: [], relationships: [], clues: [], timeline: [], changes: [] }] });
  }, { memorySchema: memorySchemaForPrompt(), targetFloors: [{ floor: 1, speaker: 'player', text: '我讨厌虐。' }] });
  assert.match(system, /player 表单独整理玩家/);
  assert.match(system, /角色在剧情里的台词和动作不算玩家本人的话/);
  assert.match(system, /不因时间久远失效/);
});

test('player-only requirements remain required table updates in initial and repair prompts', async () => {
  const prompts = [];
  await requestFloorSummaries(async ({ messages }) => {
    prompts.push(messages[0].content);
    if (prompts.length === 1) return 'invalid JSON';
    return { floors: [{ floor: 4, summary: '玩家要求安静调查。', changes: [up('player', '剧情节奏', { topic: '剧情节奏', kind: '要求', content: '不要安排追逐，偏好安静调查' })] }] };
  }, {
    memorySchema: memorySchemaForPrompt(),
    targetFloors: [{ floor: 4, speaker: 'player', kind: 'user', text: '我的剧情节奏要求：不要安排追逐，我偏好安静调查。' }],
  });
  assert.equal(prompts.length, 2);
  for (const prompt of prompts) {
    assert.ok(prompt.indexOf('先逐楼检查玩家本人要求') < prompt.indexOf('记录真实剧情事实'), 'player requirements must be handled before the story-only rules');
    assert.match(prompt, /即使没有剧情状态变化，也必须在该楼 changes 中返回 table="player"/);
    assert.match(prompt, /既无剧情状态变化，也无玩家持续偏好、跨轮要求或持续决定更新时，changes=\[\]/);
    assert.match(prompt, /仅“继续”“接着写”等无实质内容的纯控制命令可忽略/);
    assert.match(prompt, /扮演动作、角色台词及下一步行动打算照常整理为剧情，不据此推断玩家偏好/);
    assert.doesNotMatch(prompt, /略过[^。]*用户指令|没有状态变化时 changes=\[\]/);
    const examples = [...prompt.matchAll(/\{"table":"player","id":"剧情节奏","values":\{[^{}]*\}\}/g)].map(match => JSON.parse(match[0]));
    assert.equal(examples.length, 2);
    assert.equal(examples[0].id, examples[1].id);
    assert.equal(examples[1].values.previous, examples[0].values.content);
    assert.notEqual(examples[1].values.content, examples[0].values.content);
  }
});

test('mixed persistent preferences and one-reply instructions keep only persistent words in standing memory', async () => {
  // Mirrors the host's floor 6: the model previously promoted the final sentence
  // into a permanent player row named 归还铜钥匙写法.
  const chat = [
    { is_user: true, mes: '我的剧情写法要求：偏好安静调查，不要安排追逐。只简短写这次归还。' },
    { is_user: true, mes: '本条回复只写两句。' },
    { is_user: true, mes: '以后回复都简短些。' },
    { is_user: true, mes: '允许短暂追逐，但不要长时间逃亡。' },
  ];
  const output = { floors: [
    { floor: 1, summary: chat[0].mes, changes: [up('player', '剧情节奏', { topic: '剧情节奏', kind: '要求', content: '偏好安静调查，不要安排追逐' })] },
    { floor: 2, summary: '玩家要求本条回复只写两句。', changes: [] },
    { floor: 3, summary: '玩家要求以后回复都简短些。', changes: [up('player', '回复篇幅', { topic: '回复篇幅', kind: '要求', content: '以后回复都简短些' })] },
    { floor: 4, summary: chat[3].mes, changes: [up('player', '剧情节奏', { content: '允许短暂追逐，但不要长时间逃亡', previous: '偏好安静调查，不要安排追逐' })] },
  ] };
  let calls = 0;
  const summaries = await requestFloorSummaries(async ({ messages }) => {
    calls += 1;
    assert.match(messages[0].content, /先按原话判断适用范围/);
    assert.match(messages[0].content, /临时要求，只保留在该楼 summary，不写入常驻 player 表/);
    assert.match(messages[0].content, /同一发言混有持续偏好与临时要求时分别处理/);
    assert.match(messages[0].content, /“以后回复都简短些”是跨轮要求，需要写入 player/);
    return calls === 1 ? 'invalid JSON' : output;
  }, { memorySchema: memorySchemaForPrompt(), targetFloors: chat.map((row, index) => ({ floor: index + 1, speaker: 'player', text: row.mes })) });
  assert.equal(calls, 2, 'both initial and repair prompts preserve scope instructions');
  const records = summaries.map(row => ({ ...record(chat, row.floor - 1, row.memoryChanges), ...row }));
  assert.match(records[0].summary, /只简短写这次归还/);
  assert.match(records[1].summary, /本条回复只写两句/);
  const initial = buildMemoryDatabase(records, chat, [], { throughFloor: 1 });
  assert.equal(initial.tables.player.length, 1);
  assert.equal(initial.tables.player[0].values.content, '偏好安静调查，不要安排追逐');
  const current = buildMemoryDatabase(records, chat);
  assert.equal(current.tables.player.length, 2);
  assert.equal(current.tables.player.find(row => row.id === '剧情节奏').values.content, '允许短暂追逐，但不要长时间逃亡');
  assert.equal(current.tables.player.find(row => row.id === '回复篇幅').values.content, '以后回复都简短些');
  const plan = buildStoryContext({ sourceChat: chat, promptChat: chat.map((row, index) => ({ ...row, index })), summaries: records, checkpoints: [], contextSize: 32000, memoryBudget: 4000, type: 'normal' });
  const standing = plan.prompt.split('【User的偏好与要求】')[1].split(/\n\n|【当前剧情状态】/)[0];
  assert.match(standing, /允许短暂追逐/);
  assert.match(standing, /以后回复都简短些/);
  assert.doesNotMatch(standing, /只简短写这次归还|本条回复只写两句|归还铜钥匙写法/);
});
