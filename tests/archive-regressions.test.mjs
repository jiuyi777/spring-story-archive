import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { SummaryEngine } from '../core/summary-engine.js';
import { createMemoryStorage } from '../core/storage.js';
import { buildStoryContext, createStoryRequest, injectStoryContext, STORY_PROMPT_ID } from '../core/story-context.js';
import { buildSummaryBatchPayload, buildPrivacyPayload, estimateTokens, fingerprintMessage, fingerprintSummaries } from '../core/privacy-payload.js';
import { requestCompression, requestFloorSummaries } from '../core/api-client.js';
import { SemanticRecallService } from '../core/semantic-recall.js';

const indexSource = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const section = (start, end) => indexSource.slice(indexSource.indexOf(start), indexSource.indexOf(end, indexSource.indexOf(start)));
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
function fixture() {
  const sourceChat = Array.from({ length: 9 }, (_, index) => ({ name: '角色', is_user: index % 2 === 1, mes: `原文${index}` }));
  const summaries = sourceChat.map((message, floorIndex) => ({
    key: `A::floor::${floorIndex}`, chatKey: 'A', floorIndex,
    isUser: message.is_user, priority: message.is_user ? 'player-statement' : 'normal', speakerName: message.name, userText: message.is_user ? message.mes : '',
    messageFingerprint: fingerprintMessage(message, floorIndex), status: 'ready', inputComplete: true, summary: `摘要${floorIndex}`,
  }));
  return { sourceChat, promptChat: sourceChat.map((message, index) => ({ ...message, index })), summaries, checkpoints: [], contextSize: 32000, type: 'normal' };
}
function harness(chat, generateRaw, settings = {}) {
  const storage = createMemoryStorage();
  const context = { chat, generateRaw };
  const engine = new SummaryEngine({
    storage, getContext: () => context, getSettings: () => ({ summarySource: 'current', rollupTokenLimit: 6000, ...settings }),
    getExtraCredentials: () => ({}), requestDelayMs: 0,
  });
  engine.setChat('A');
  return { storage, context, engine };
}
const payloadOf = ({ prompt }) => JSON.parse(prompt.replace(/^user:\s*/, ''));
const responseFor = (payload) => JSON.stringify({ floors: payload.targetFloors.map(({ floor }) => ({ floor, summary: `完整输入的摘要${floor}` })) });

test('uneven floor lengths share the budget and preserve the middle fact', () => {
  const text = 'a'.repeat(5500) + 'MIDDLE_FACT' + 'b'.repeat(5500);
  const payload = buildSummaryBatchPayload({ chat: [{ mes: text }, { mes: 'ok' }], floorIndexes: [0, 1] });
  assert.equal(payload.targetFloors[0].text, text);
  assert.ok(estimateTokens(JSON.stringify(payload, null, 2)) <= 6500);
});

test('summary API rejects oversized externally supplied payloads before a model call', async () => {
  let calls = 0;
  await assert.rejects(requestFloorSummaries(async () => { calls += 1; }, { targetFloors: [{ floor: 1, text: 'x'.repeat(100000) }] }), /完整读取预算/);
  assert.equal(calls, 0);
});

test('reopening storage preserves verified coverage and resets interrupted floor work without API calls', async () => {
  const f = fixture();
  let calls = 0;
  const { engine, storage } = harness(f.sourceChat, async () => { calls += 1; throw new Error('unexpected model'); });
  for (const record of f.summaries) await storage.putSummary(record);
  await storage.putSummary({ ...f.summaries[1], status: 'processing', inputComplete: false });
  await engine.reconcile({ queueMissing: false });
  const snapshot = await engine.getSnapshot();
  assert.equal(calls, 0);
  assert.equal(snapshot.summaries[1].status, 'missing');
  const plan = buildStoryContext({ ...f, ...snapshot });
  assert.ok(plan.removeIndexes.includes(0));
  assert.ok(!plan.removeIndexes.includes(1));
});

test('oversized floor is read in full across parts before it becomes filterable', async () => {
  const f = fixture();
  f.sourceChat[0].mes = 'a'.repeat(23000) + 'MIDDLE_FACT' + 'b'.repeat(23000);
  f.promptChat[0].mes = f.sourceChat[0].mes;
  const parts = [];
  const { storage, engine } = harness(f.sourceChat, async (request) => {
    const payload = payloadOf(request);
    assert.ok(estimateTokens(request.prompt) <= 6500);
    parts.push(payload.targetFloors[0].text);
    return responseFor(payload);
  });
  await engine.summarizeFloor(0);
  assert.ok(parts.length > 1);
  assert.equal(parts.join(''), f.sourceChat[0].mes);
  const records = await storage.listSummaries('A');
  assert.equal(records[0].inputComplete, true);
  assert.ok(buildStoryContext({ ...f, summaries: records }).removeIndexes.includes(0));
});

test('failed segment leaves raw floor available and never claims full coverage', async () => {
  const f = fixture();
  f.sourceChat[0].mes = 'x'.repeat(40000);
  let calls = 0;
  const { storage, engine } = harness(f.sourceChat, async (request) => {
    if (++calls === 2) throw new Error('segment failed');
    return responseFor(payloadOf(request));
  });
  await engine.summarizeFloor(0);
  const records = await storage.listSummaries('A');
  assert.equal(records[0].status, 'failed');
  assert.equal(buildStoryContext({ ...f, summaries: records }).removeIndexes.length, 0);
});

test('legacy summaries stay readable and keep raw text until explicit backfill', async () => {
  const f = fixture();
  delete f.summaries[0].inputComplete;
  const plan = buildStoryContext(f);
  assert.match(plan.prompt, /摘要0/);
  assert.ok(!plan.removeIndexes.includes(0));
  const { storage, engine } = harness(f.sourceChat, async (request) => responseFor(payloadOf(request)));
  for (const record of f.summaries) await storage.putSummary(record);
  const result = await engine.backfill(10);
  assert.equal(result.queuedCount, 1);
  await engine.waitForIdle();
  assert.equal((await storage.listSummaries('A'))[0].inputComplete, true);
});

test('native extra.files attachment remains even with a complete text summary', () => {
  const f = fixture();
  f.sourceChat[0].extra = { files: [{ url: '/attachment', text: 'ATTACHMENT_FACT' }] };
  f.promptChat[0].extra = f.sourceChat[0].extra;
  f.promptChat[0].mes = 'ATTACHMENT_FACT\n' + f.sourceChat[0].mes;
  assert.deepEqual(buildStoryContext(f).removeIndexes, [1, 2, 3]);
});

test('checkpoint validity uses all current source records including system and previously moved rows', () => {
  const f = fixture();
  f.sourceChat.push({ is_system: true, mes: 'system' });
  f.summaries.push({ floorIndex: 9, status: 'ready', inputComplete: true, summary: '系统摘要', messageFingerprint: fingerprintMessage(f.sourceChat[9], 9) });
  f.checkpoints = [{ status: 'ready', formatVersion: 5, throughFloor: 9, sourceFingerprint: fingerprintSummaries(f.summaries), summary: 'VALID_CHECKPOINT' }];
  f.promptChat.splice(0, 1);
  assert.match(buildStoryContext(f).prompt, /VALID_CHECKPOINT/);
  f.sourceChat[0].mes = 'edited';
  assert.doesNotMatch(buildStoryContext(f).prompt, /VALID_CHECKPOINT/);
});

test('legacy truncated checkpoints are ignored and swipe excludes the replaced reply', () => {
  const f = fixture();
  f.checkpoints = [{ status: 'ready', formatVersion: 4, throughFloor: 8, sourceFingerprint: fingerprintSummaries(f.summaries), summary: 'OLD_CHECKPOINT' }];
  assert.doesNotMatch(buildStoryContext(f).prompt, /OLD_CHECKPOINT/);
  f.checkpoints[0].formatVersion = 5;
  f.type = 'swipe';
  f.promptChat.pop();
  const plan = buildStoryContext(f);
  assert.doesNotMatch(plan.prompt, /OLD_CHECKPOINT|摘要8/);
});

test('compression reads every source character before merging smaller checkpoints', async () => {
  const text = 'a'.repeat(48000) + 'MIDDLE_FACT' + 'b'.repeat(48000);
  const inputs = [];
  await requestCompression(async ({ messages }) => {
    const payload = JSON.parse(messages[1].content);
    assert.ok(estimateTokens(messages[1].content) <= 6500);
    inputs.push(payload.rollingSummary);
    return JSON.stringify({ summary: 'compressed complete part' });
  }, text, 100);
  assert.ok(inputs.length > 2);
  assert.equal(inputs.slice(0, -1).join(''), text);
  assert.match(inputs.at(-1), /compressed complete part/);
});

test('compression 429 stops the queue while keeping already completed floor summaries', async () => {
  const calls = [];
  const { engine, storage } = harness([{ mes: '一' }, { mes: '二' }], async (request) => {
    const payload = payloadOf(request);
    if (!payload.targetFloors) { calls.push('429'); throw new Error('429 Too Many Requests'); }
    calls.push(`floor${payload.targetFloors[0].floor}`);
    return responseFor(payload);
  }, { backfillBatchSize: 1, rollupTokenLimit: 1 });
  await engine.reconcile();
  engine.enqueueBatch([0, 1]);
  await engine.waitForIdle();
  assert.deepEqual(calls, ['floor1', '429']);
  assert.deepEqual((await storage.listSummaries('A')).map((row) => row.status), ['ready', 'missing']);
});

test('compression finishing after A to B to A cannot publish a stale checkpoint', async () => {
  const started = deferred();
  const finish = deferred();
  const f = fixture();
  const { storage, engine } = harness(f.sourceChat, async () => { started.resolve(); return finish.promise; });
  for (const record of f.summaries) await storage.putSummary(record);
  const work = engine.compressNow();
  await started.promise;
  engine.setChat('B');
  engine.setChat('A');
  finish.resolve(JSON.stringify({ summary: 'obsolete result' }));
  await work;
  assert.equal((await storage.listCheckpoints('B')).length, 0);
  assert.equal((await storage.listCheckpoints('A')).some((row) => row.status === 'ready'), false);
});

test('editing a source while compressing rejects the stale result', async () => {
  const started = deferred();
  const finish = deferred();
  const f = fixture();
  const { storage, engine } = harness(f.sourceChat, async () => { started.resolve(); return finish.promise; });
  for (const record of f.summaries) await storage.putSummary(record);
  const work = engine.compressNow();
  await started.promise;
  f.sourceChat[0].mes = 'new fact';
  finish.resolve(JSON.stringify({ summary: 'old fact' }));
  await work;
  assert.equal((await storage.listCheckpoints('A')).some((row) => row.status === 'ready'), false);
});

test('recall rejects the same stale records as story summary without network access', async () => {
  const f = fixture();
  f.summaries[0].summary = 'STALE_FACT';
  f.sourceChat[0].mes = 'NEW_FACT';
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    const payload = JSON.parse(options.body);
    assert.ok(!payload.input.join('').includes('STALE_FACT'));
    return { ok: true, json: async () => ({ data: payload.input.map((_, index) => ({ index, embedding: [1, 0] })) }) };
  };
  try {
    const recall = new SemanticRecallService({ storage: createMemoryStorage(), getCredentials: () => ({ endpoint: 'https://offline.invalid/v1', embeddingModel: 'mock' }) });
    const result = await recall.recall({ chatKey: 'A', summaries: f.summaries, chat: f.sourceChat, targetFloorIndex: 8, topK: 9, threshold: 0, recentRawFloorLimit: 0 });
    assert.doesNotMatch(result.prompt, /STALE_FACT/);
  } finally { globalThis.fetch = oldFetch; }
});

function indexHarness(context, settings, engine) {
  const sandbox = {
    getContext: () => context, currentChatKey: () => engine.chatKey, getSettings: () => settings,
    engine, fingerprintMessage, createStoryRequest, storyRequest: null, advanceEpoch: 0, autoAdvanceRemaining: 1,
    advancing: false, root: {}, document: { querySelector: () => ({ value: '' }) }, window: { setTimeout() {} },
    getPlayerPreferenceProfile: async () => ({ summary: 'profile' }), setStatus() {}, saveSettings() {}, syncSettings() {}, getApiKey: () => '',
    showStoryContextStatus() {}, clearRecallPrompt() {}, refreshView: async () => {}, buildPrivacyPayload,
    addSemanticRecall: async (value) => value, createProvider: () => ({}), getExtraCredentials: () => ({}), profileKey: (a, b) => `${a}::${b}`, STORY_PROMPT_ID,
  };
  vm.createContext(sandbox);
  vm.runInContext(section('function clearStoryPrompt(', '\nfunction showStoryContextStatus')
    + section('async function handleSettingChange(', '\nfunction bindUi'), sandbox);
  return sandbox;
}

test('disabling advance while the director is in flight stops the next normal generation', async () => {
  const started = deferred();
  const finish = deferred();
  let generations = 0;
  const context = { chat: [{ mes: 'reply', is_user: false }], generate: async () => { generations += 1; } };
  const engine = { chatKey: 'A', chatRevision: 0, storage: createMemoryStorage(), waitForIdle: async () => {} };
  const sandbox = indexHarness(context, { autoAdvanceEnabled: true, advanceSource: 'current' }, engine);
  sandbox.requestAdvanceDirective = async () => { started.resolve(); return finish.promise; };
  vm.runInContext(section('async function runAutoAdvance(', '\nasync function generateOptions'), sandbox);
  const work = sandbox.runAutoAdvance();
  await started.promise;
  await sandbox.handleSettingChange({ dataset: { setting: 'autoAdvanceEnabled' }, type: 'checkbox', checked: false });
  finish.resolve({ directive: 'continue' });
  await work;
  assert.equal(generations, 0);
});

test('NPC result after chat switch is discarded instead of saving into the new chat', async () => {
  const started = deferred();
  const finish = deferred();
  const engine = { chatKey: 'A', chatRevision: 0, storage: createMemoryStorage(), waitForIdle: async () => {} };
  const sandbox = indexHarness({ chat: [{ mes: 'A story' }] }, { npcSource: 'current' }, engine);
  sandbox.requestNpcProfile = async () => { started.resolve(); return finish.promise; };
  vm.runInContext(section('async function generateNpc(', '\nasync function saveNpcEdits'), sandbox);
  const work = sandbox.generateNpc();
  await started.promise;
  engine.chatKey = 'B';
  engine.chatRevision += 1;
  finish.resolve({ name: 'NPC from A' });
  await work;
  assert.deepEqual(await engine.storage.listNpcs('B'), []);
});

test('late setting toggle restores the generation copy and cancels already copied host requests', async () => {
  const f = fixture();
  let stops = 0;
  let aborts = 0;
  const prompts = new Map();
  const context = { chat: f.sourceChat, stopGeneration: () => { stops += 1; }, setExtensionPrompt: (key, text) => prompts.set(key, text) };
  const sandbox = indexHarness(context, { summaryContextEnabled: true, filterArchivedFloors: true }, { chatKey: 'A', chatRevision: 0 });
  sandbox.storyRequest = createStoryRequest({ context, promptChat: f.promptChat, abort: () => { aborts += 1; }, isCurrent: () => true, onStatus() {} });
  await injectStoryContext({ context, storage: { listSummaries: async () => f.summaries, listCheckpoints: async () => [] },
    chatKey: 'A', promptChat: f.promptChat, contextSize: 32000, enabled: true, filter: true, isCurrent: () => true, onPlan: sandbox.storyRequest.plan });
  assert.equal(f.promptChat.length, 5);
  await sandbox.handleSettingChange({ dataset: { setting: 'summaryContextEnabled' }, type: 'checkbox', checked: false });
  assert.equal(stops, 1);
  assert.equal(aborts, 1);
  assert.equal(f.promptChat.length, 9);
  assert.equal(prompts.get(STORY_PROMPT_ID), '');
});

test('final outgoing data must contain the whole summary before generation continues', () => {
  for (const type of ['text', 'chat']) {
    const f = fixture();
    let stops = 0;
    const request = createStoryRequest({ context: { stopGeneration() { stops += 1; } }, promptChat: f.promptChat, abort() {}, isCurrent: () => true, onStatus() {} });
    request.plan({ prompt: 'BEGIN\nCOMPLETE_SUMMARY\nEND' });
    request.verify({ prompt: type === 'text' ? 'BEGIN\nCOMPLETE_SUMMARY\nEND' : [{ role: 'system', content: 'BEGIN\nCOMPLETE_SUMMARY\nEND' }] }, false);
    assert.equal(stops, 0);
    request.verify({ prompt: 'BEGIN\nTRUNCATED' }, false);
    assert.equal(stops, 1);
  }
});
