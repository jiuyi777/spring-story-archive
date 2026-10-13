import test from 'node:test';
import assert from 'node:assert/strict';
import { requestFloorSummaries } from '../core/api-client.js';
import { memorySchemaForPrompt } from '../core/memory-database.js';
import { openApiProfiles } from '../core/api-profiles.js';

const payload = (extra = {}) => ({ memorySchema: memorySchemaForPrompt(), targetFloors: [{ floor: 2, text: '陌生商人敲门。' }], ...extra });

test('NPC judgment rides in the same organizing request and is stored per floor', async () => {
  let system = '';
  const rows = await requestFloorSummaries(async (request) => {
    system = request.messages[0].content;
    return JSON.stringify({ floors: [{ floor: 2, summary: '商人来访。', characters: [], relationships: [], clues: [], timeline: [], changes: [], npc: { needed: true, reason: '缺少外来信息来源' } }] });
  }, payload({ npcWatch: { existingNpcs: ['林素'] } }));
  assert.match(system, /判断 NPC/);
  assert.match(system, /林素/);
  assert.deepEqual(rows[0].npcSignal, { needed: true, reason: '缺少外来信息来源' });
});

test('without NPC watching the request carries no NPC instruction', async () => {
  let system = '';
  const rows = await requestFloorSummaries(async (request) => {
    system = request.messages[0].content;
    return JSON.stringify({ floors: [{ floor: 2, summary: '商人来访。', characters: [], relationships: [], clues: [], timeline: [], changes: [] }] });
  }, payload());
  assert.doesNotMatch(system, /判断 NPC/);
  assert.equal(rows[0].npcSignal, undefined);
});

test('profiles can be looked up by id for the two slots', () => {
  const store = new Map();
  const storage = { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) };
  let n = 0;
  const profiles = openApiProfiles({ storage, createId: () => `p${++n}` });
  profiles.add();
  profiles.update({ endpoint: 'https://vec/v1/chat/completions', embeddingModel: 'emb' });
  assert.equal(profiles.get('p2').embeddingModel, 'emb');
  assert.equal(profiles.get('p1').embeddingModel, '');
  assert.equal(profiles.get('missing'), null);
});

import { requestNpcProfile } from '../core/api-client.js';

test('NPC design asks for experience, opinions, a surprise and difference from existing NPCs', async () => {
  let system = '';
  const npc = await requestNpcProfile(async (request) => {
    system = request.messages[0].content;
    return JSON.stringify({ name: '老周', plotFunction: '外来信息来源', biography: ['二十年前在码头替人顶过罪，出狱后改行修钟'], opinions: ['觉得林素太相信账本'], surprise: '修钟的手艺是在牢里学的' });
  }, { rollingSummary: '' }, { existingNpcs: [{ name: '林素' }] });
  assert.match(system, /2 到 4 段具体经历/);
  assert.match(system, /至少三项明显不同/);
  assert.match(system, /让人意外但合理/);
  assert.deepEqual(npc.opinions, ['觉得林素太相信账本']);
  assert.equal(npc.surprise, '修钟的手艺是在牢里学的');
});
