import test from 'node:test';
import assert from 'node:assert/strict';
import { fingerprintMessage } from '../core/privacy-payload.js';
import { buildMemoryDatabase, selectMemoryDatabase, MEMORY_VERSION } from '../core/memory-database.js';
import { requestFloorSummaries } from '../core/api-client.js';
import { memorySchemaForPrompt } from '../core/memory-database.js';

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
