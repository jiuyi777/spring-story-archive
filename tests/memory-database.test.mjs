import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { SummaryEngine } from '../core/summary-engine.js';
import { createMemoryStorage } from '../core/storage.js';
import { buildStoryContext } from '../core/story-context.js';
import { buildMemoryDatabase, formatMemoryDatabase, memorySchemaForPrompt, validateMemoryChanges } from '../core/memory-database.js';
import { fingerprintMessage, isControlMessage, validSummaries, truncateToTokenBudget, estimateTokens } from '../core/privacy-payload.js';
import { requestFloorSummaries, requestStoryOptions, requestAdvanceDirective } from '../core/api-client.js';

const change = (table, id, values) => ({ table, id, values });
const row = (floor, summary, changes = []) => ({ floor, summary, changes });
function harness(chat, responses) {
  const storage = createMemoryStorage();
  const calls = [];
  const context = { chat, generateRaw: async (request) => {
    const payload = JSON.parse(request.prompt.replace(/^user:\s*/, ''));
    calls.push({ request, payload });
    const response = await responses(payload, calls.length);
    return typeof response === 'string' ? response : JSON.stringify(response);
  } };
  const engine = new SummaryEngine({ storage, getContext: () => context, getSettings: () => ({ summarySource: 'current', rollupTokenLimit: 30000 }), getExtraCredentials: () => ({}), requestDelayMs: 0 });
  engine.setChat('A');
  return { storage, engine, context, calls };
}
const sceneA = change('scene', 'current', { time: '傍晚', location: '书房' });
const personA = change('characters', '沈砚', { name: '沈砚', background: '曾在书院教书', state: '等待出发', location: '书房' });
const itemA = change('inventory', '玩家:钥匙', { name: '钥匙', owner: '玩家', quantity: '2' });
const taskA = change('tasks', '寻找家书', { name: '寻找家书', state: '进行中' });

test('two rounds update shared state, preserve unchanged facts, and feed the next continuation', async () => {
  const h = harness([{ mes: '沈砚在书房交给玩家两把钥匙，约好去找家书。' }], (payload) => ({ floors: payload.targetFloors.map(({ floor }) => floor === 1
    ? row(1, '沈砚交给玩家两把钥匙，约定寻找家书。', [sceneA, personA, itemA, taskA])
    : row(floor, '两人抵达西廊，消耗一把钥匙找到家书。', [change('scene', 'current', { location: '西廊' }), change('characters', '沈砚', { location: '西廊' }), change('inventory', '玩家:钥匙', { quantity: '1' }), change('tasks', '寻找家书', { state: '已完成' })])) }));
  await h.engine.reconcile({ queueMissing: true }); await h.engine.waitForIdle();
  h.context.chat.push({ mes: '继续', is_user: true }, { mes: '抵达西廊，使用一把钥匙，找到了家书。' });
  await h.engine.reconcile({ queueMissing: true }); await h.engine.waitForIdle();
  assert.deepEqual(h.calls[1].payload.targetFloors.map((floor) => floor.floor), [3]);
  assert.match(h.calls[1].payload.currentMemory, /玩家:钥匙/);
  const snapshot = await h.engine.getSnapshot();
  assert.equal(snapshot.memory.tables.scene[0].values.location, '西廊');
  assert.equal(snapshot.memory.tables.scene[0].values.time, '傍晚');
  assert.equal(snapshot.memory.tables.characters[0].values.background, '曾在书院教书');
  assert.equal(snapshot.memory.tables.inventory[0].values.quantity, '1');
  assert.equal(snapshot.memory.tables.tasks[0].values.state, '已完成');
  assert.equal(snapshot.summaries[1].status, 'skipped');
  const plan = buildStoryContext({ sourceChat: h.context.chat, promptChat: h.context.chat.map((message, index) => ({ ...message, index })), ...snapshot, contextSize: 32000, type: 'normal' });
  assert.match(plan.prompt, /当前剧情状态/); assert.match(plan.prompt, /数量：1/); assert.match(plan.prompt, /进度：已完成/);
  assert.doesNotMatch(plan.prompt, /玩家发出|未展开|继续/);
});

test('control-only messages call no model and old verbose control summaries leave all consumers', async () => {
  const h = harness([{ mes: '继续。', is_user: true }], () => { throw new Error('must not call'); });
  await h.storage.putSummary({ key: 'A::floor::0', chatKey: 'A', floorIndex: 0, status: 'ready', summary: '玩家发出继续指令，本楼未展开。', messageFingerprint: fingerprintMessage(h.context.chat[0], 0) });
  assert.equal(validSummaries(await h.storage.listSummaries('A'), h.context.chat).length, 0);
  await h.engine.reconcile({ queueMissing: true }); await h.engine.waitForIdle();
  await h.engine.regenerate(0); await h.engine.waitForIdle();
  assert.equal(h.calls.length, 0);
  assert.equal((await h.engine.getSnapshot()).rollup.text, '');
  assert.equal(isControlMessage({ is_user: true, mes: '继续沿着西廊走，取出钥匙。' }), false);
  assert.equal(isControlMessage({ is_user: false, mes: '继续' }), false);
});

test('editing, swiping or deleting a floor removes only its facts and restores prior state', () => {
  const chat = [{ mes: 'two keys' }, { mes: 'one key', swipe_id: 0 }];
  const records = chat.map((message, floorIndex) => ({ floorIndex, status: 'ready', inputComplete: true, memoryVersion: 1, messageFingerprint: fingerprintMessage(message, floorIndex), summary: message.mes, memoryChanges: [change('inventory', 'keys', { name: '钥匙', quantity: String(2 - floorIndex) })] }));
  assert.equal(buildMemoryDatabase(records, chat).tables.inventory[0].values.quantity, '1');
  for (const changedChat of [[chat[0], { mes: 'no key spent' }], [chat[0], { ...chat[1], swipe_id: 1 }], [chat[0]]]) {
    assert.equal(buildMemoryDatabase(records, changedChat).tables.inventory[0].values.quantity, '2');
  }
});

test('manual edits persist across reconstruction, remain chat scoped, and later explicit facts can update them', async () => {
  const h = harness([{ mes: 'in study' }], () => ({ floors: [row(1, '人在书房。', [sceneA])] }));
  await h.engine.reconcile({ queueMissing: true }); await h.engine.waitForIdle();
  await h.engine.editMemory(change('scene', 'current', { location: '花园' }));
  const profile = await h.storage.getProfile('A::memory-edits');
  const records = await h.storage.listSummaries('A');
  assert.equal(buildMemoryDatabase(records, h.context.chat, structuredClone(profile.edits)).tables.scene[0].values.location, '花园');
  h.context.chat.push({ mes: 'arrives at station' });
  await h.storage.putSummary({ key: 'A::floor::1', chatKey: 'A', floorIndex: 1, status: 'ready', summary: '到了车站。', memoryVersion: 1, messageFingerprint: fingerprintMessage(h.context.chat[1], 1), memoryChanges: [change('scene', 'current', { location: '车站' })] });
  assert.equal((await h.engine.getMemory()).tables.scene[0].values.location, '车站');
  h.engine.setChat('B');
  assert.equal((await h.engine.getMemory()).tables.scene.length, 0);
});

test('malformed memory output is repaired once; permanent failure retains prior valid state', async () => {
  let bad = false;
  const h = harness([{ mes: 'story' }], (_payload, calls) => bad || calls === 1 ? '我来总结一下剧情' : { floors: [row(1, '人物在书房。', [sceneA])] });
  await h.engine.reconcile({ queueMissing: true }); await h.engine.waitForIdle();
  assert.equal(h.calls.length, 2);
  assert.equal((await h.engine.getMemory()).tables.scene[0].values.location, '书房');
  bad = true;
  await h.engine.regenerate(0); await h.engine.waitForIdle();
  assert.equal(h.calls.length, 4);
  const snapshot = await h.engine.getSnapshot();
  assert.equal(snapshot.summaries[0].status, 'failed');
  assert.match(snapshot.summaries[0].error, /已保留原文与上一份有效档案/);
  assert.equal(snapshot.memory.tables.scene[0].values.location, '书房');
});

test('structured response accepts fenced objects and single floor envelopes but rejects unknown fields', async () => {
  const payload = { memorySchema: memorySchemaForPrompt(), targetFloors: [{ floor: 3, text: 'scene' }] };
  const rows = await requestFloorSummaries(async () => '<think>reasoning</think>\n```json\n' + JSON.stringify(row(3, '到了书房。', [sceneA])) + '\n```', payload);
  assert.equal(rows[0].memoryVersion, 1);
  assert.throws(() => validateMemoryChanges([change('scene', 'current', { guessed: 'wrong' })]), /字段/);
  assert.throws(() => validateMemoryChanges([change('unknown', 'x', { name: 'wrong' })]), /表格/);
  assert.throws(() => validateMemoryChanges([change('scene', '__proto__', { location: 'wrong' })]), /标识/);
});

test('normal swipe generation excludes the replaced reply state as well as its narrative', async () => {
  const h = harness([{ mes: 'book room' }, { mes: 'station' }], (payload) => ({ floors: payload.targetFloors.map(({ floor }) => row(floor, floor === 1 ? '在书房。' : '到了车站。', [change('scene', 'current', { location: floor === 1 ? '书房' : '车站' })])) }));
  await h.engine.reconcile({ queueMissing: true }); await h.engine.waitForIdle();
  const snapshot = await h.engine.getSnapshot();
  const plan = buildStoryContext({ ...snapshot, sourceChat: h.context.chat, promptChat: h.context.chat.map((message, index) => ({ ...message, index })), type: 'swipe', contextSize: 32000 });
  assert.match(plan.prompt, /书房/); assert.doesNotMatch(plan.prompt, /车站/);
});

test('real assistance assembly waits for memory and passes current tables to options and director requests', async () => {
  const h = harness([{ mes: 'new scene' }], () => ({ floors: [row(1, '在书房。', [sceneA, taskA])] }));
  await h.engine.reconcile({ queueMissing: true });
  const source = await fs.readFile(new URL('../index.js', import.meta.url), 'utf8');
  const section = source.slice(source.indexOf('async function addSemanticRecall('), source.indexOf('\nasync function semanticRecallInterceptor('));
  const sandbox = { engine: h.engine, captureChatTask: () => ({ isCurrent: () => true }), queuePendingSummaries() {},
    getContext: () => h.context, getSettings: () => ({ semanticRecallEnabled: false }), validSummaries, isControlMessage, truncateToTokenBudget, formatMemoryDatabase };
  vm.createContext(sandbox); vm.runInContext(section, sandbox);
  const payload = await sandbox.addSemanticRecall({ rollingSummary: 'STALE_TEXT', recentFloors: [] });
  assert.match(payload.currentMemory, /书房/); assert.doesNotMatch(payload.rollingSummary, /STALE_TEXT/);
  const calls = [];
  await requestStoryOptions(async (request) => { calls.push(request); return JSON.stringify({ options: ['查书桌', '问沈砚', '看钥匙', '查走廊'] }); }, payload, { count: 4 });
  await requestAdvanceDirective(async (request) => { calls.push(request); return JSON.stringify({ directive: '让沈砚说明家书线索', continuityCheck: '仍在书房' }); }, payload);
  for (const request of calls) assert.match(request.messages[1].content, /书房.*|寻找家书/);
});

test('automatic scheduling obeys thresholds and a forced consumer flush includes the pending floors', async () => {
  const source = await fs.readFile(new URL('../index.js', import.meta.url), 'utf8');
  const section = source.slice(source.indexOf('function queuePendingSummaries('), source.indexOf('\nfunction onGenerationEnded('));
  const queue = [], pending = new Set([0, 1]);
  const settings = { autoSummarize: true, memoryUpdateEvery: 2, memoryMinTokens: 0 };
  const sandbox = { engine: { enqueueBatch: (batch) => queue.push([...batch]) }, pendingSummaryFloors: pending,
    getSettings: () => settings, getContext: () => ({ chat: [{ mes: '继续', is_user: true }, { mes: '一个剧情回复' }] }), isControlMessage, estimateTokens };
  vm.createContext(sandbox); vm.runInContext(section, sandbox);
  sandbox.queuePendingSummaries(); assert.equal(queue.length, 0);
  sandbox.queuePendingSummaries({ force: true }); assert.deepEqual(queue[0], [0, 1]); assert.equal(pending.size, 0);
});


test('manual narrative corrections reach both normal prompts and semantic recall input', async () => {
  const h = harness([{ mes: 'book room' }], () => ({ floors: [row(1, '错误地点旧塔。', [sceneA])] }));
  await h.engine.reconcile({ queueMissing: true }); await h.engine.waitForIdle();
  await h.engine.editMemory(change('events', 'floor:0', { summary: '已核对：人物仍在书房。' }));
  const snapshot = await h.engine.getSnapshot();
  assert.equal(snapshot.memoryEdits[0].values.summary, '已核对：人物仍在书房。');
  const plan = buildStoryContext({ ...snapshot, sourceChat: h.context.chat, promptChat: h.context.chat.map((message, index) => ({ ...message, index })), contextSize: 32000 });
  assert.match(plan.prompt, /已核对/); assert.doesNotMatch(plan.prompt, /错误地点旧塔/);
  const source = await fs.readFile(new URL('../index.js', import.meta.url), 'utf8');
  assert.match(source, /summaries: applyNarrativeEdits\(snapshot.summaries, snapshot.memoryEdits, targetFloorIndex\)/);
});
