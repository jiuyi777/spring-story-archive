import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildStoryContext, createStoryRequest, injectStoryContext, STORY_PROMPT_ID } from '../core/story-context.js';
import { fingerprintMessage, fingerprintSummaries } from '../core/privacy-payload.js';
import vm from 'node:vm';

function fixture() {
  const sourceChat = Array.from({ length: 9 }, (_, i) => ({ is_user: i % 2 === 0, name: '人物', mes: `原文${i}` }));
  const promptChat = sourceChat.map((message, index) => ({ ...message, index }));
  const summaries = sourceChat.map((message, floorIndex) => ({ floorIndex, messageFingerprint: fingerprintMessage(message, floorIndex), status: 'ready', inputComplete: true, summary: `摘要${floorIndex}` }));
  return { sourceChat, promptChat, summaries, checkpoints: [], contextSize: 32000, type: 'normal' };
}

test('normal generation injects summary even without semantic recall; filters only outgoing old rows', async () => {
  const data = fixture();
  const original = structuredClone(data.sourceChat);
  const prompts = new Map();
  const context = { chat: data.sourceChat, stopGeneration() {}, eventTypes: { GENERATE_AFTER_DATA: 'generate_after_data' }, setExtensionPrompt: (key, text) => prompts.set(key, text) };
  const status = await injectStoryContext({ context, storage: { listSummaries: async () => data.summaries, listCheckpoints: async () => [] }, chatKey: 'A', promptChat: data.promptChat, contextSize: 32000, enabled: true, filter: true, isCurrent: () => true });
  assert.match(prompts.get(STORY_PROMPT_ID), /摘要0/);
  assert.deepEqual(data.promptChat.map(row => row.index), [4, 5, 6, 7, 8]);
  assert.deepEqual(data.sourceChat, original);
  assert.match(status, /过滤 4 楼/);
});

test('missing, failed and edited floors remain as raw messages', () => {
  const data = fixture();
  data.summaries[0].status = 'missing';
  data.summaries[1].status = 'failed';
  data.sourceChat[2].mes = '已编辑';
  const plan = buildStoryContext(data);
  assert.deepEqual(plan.removeIndexes, [3]);
  assert.doesNotMatch(plan.prompt, /摘要[012]/);
});

test('unaffordable summary blocks keep their original floors', () => {
  const data = fixture();
  data.summaries[0].summary = '长'.repeat(7000);
  assert.ok(!buildStoryContext(data).removeIndexes.includes(0));
  data.contextSize = 100;
  assert.equal(buildStoryContext(data).prompt, '');
  assert.deepEqual(buildStoryContext(data).removeIndexes, []);
});

test('swipe excludes the replaced reply from the summary; continue retains one extra recent row', () => {
  const data = fixture();
  data.promptChat.pop();
  data.type = 'swipe';
  assert.doesNotMatch(buildStoryContext(data).prompt, /摘要8/);
  const next = fixture();
  next.type = 'continue';
  assert.deepEqual(buildStoryContext(next).removeIndexes, [0, 1, 2]);
});

test('system floors do not shift the native prompt index mapping', () => {
  const data = fixture();
  data.sourceChat.unshift({ is_system: true, mes: '系统消息' });
  data.summaries = data.sourceChat.map((message, floorIndex) => ({ floorIndex, messageFingerprint: fingerprintMessage(message, floorIndex), status: 'ready', inputComplete: true, summary: `摘要${floorIndex}` }));
  const plan = buildStoryContext(data);
  assert.doesNotMatch(plan.prompt, /第 1 楼/);
  assert.deepEqual(plan.removeIndexes, [0, 1, 2, 3]);
});

test('checkpoint is used only with matching current source; edits invalidate it', () => {
  const data = fixture();
  data.checkpoints = [{ status: 'ready', formatVersion: 5, throughFloor: 3, sourceFingerprint: fingerprintSummaries(data.summaries.slice(0, 4)), summary: '压缩档案' }];
  assert.match(buildStoryContext(data).prompt, /压缩档案/);
  data.sourceChat[0].mes = '换了一条剧情';
  const plan = buildStoryContext(data);
  assert.doesNotMatch(plan.prompt, /压缩档案/);
  assert.ok(!plan.removeIndexes.includes(0));
});

test('attachments and tool histories retain original prompt rows', () => {
  const data = fixture();
  data.promptChat[0].extra = { file: { url: '/attachment' } };
  assert.deepEqual(buildStoryContext(data).removeIndexes, [1, 2, 3]);
  data.sourceChat[1].extra = { tool_invocations: [] };
  assert.deepEqual(buildStoryContext(data).removeIndexes, []);
});

test('disabled, quiet, stale and unsupported contexts keep all raw history', async () => {
  for (const variation of [{ enabled: false }, { type: 'quiet' }, { isCurrent: () => false }, { unsupported: true }]) {
    const data = fixture();
    const context = { chat: data.sourceChat, ...(variation.unsupported ? {} : { setExtensionPrompt() {} }) };
    await injectStoryContext({ context, storage: { listSummaries: async () => data.summaries, listCheckpoints: async () => [] }, chatKey: 'A', promptChat: data.promptChat, contextSize: 32000, enabled: true, filter: true, isCurrent: () => true, ...variation });
    assert.equal(data.promptChat.length, 9);
  }
});

test('standalone regex is prompt-only, covers both speakers and starts beyond five recent floors', async () => {
  const rule = JSON.parse(await readFile(new URL('../regex/旧楼层不发送-手动备用.json', import.meta.url), 'utf8'));
  assert.deepEqual(rule.placement, [1, 2]);
  assert.equal(rule.promptOnly, true);
  assert.equal(rule.markdownOnly, false);
  assert.equal(rule.minDepth, 5);
  assert.equal(rule.disabled, true);
  assert.equal('旧剧情\n第二行'.replace(new RegExp(rule.findRegex.slice(1, -2), 'g'), rule.replaceString), '');
});

test('real interceptor restores raw history and aborts if summary is disabled during semantic lookup', async () => {
  const data = fixture();
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  const functions = source.slice(source.indexOf('function clearStoryPrompt('), source.indexOf('function showStoryContextStatus(')) + source.slice(source.indexOf('async function semanticRecallInterceptor('), source.indexOf('\nfunction scheduleReconcile('));
  const settings = { summaryContextEnabled: true, filterArchivedFloors: true, semanticRecallEnabled: true, recallDepth: 4 };
  const prompts = new Map();
  const context = { chat: data.sourceChat, stopGeneration() {}, eventTypes: { GENERATE_AFTER_DATA: 'generate_after_data' }, setExtensionPrompt: (key, text) => prompts.set(key, text) };
  let release;
  let started;
  const reachedRecall = new Promise(resolve => { started = resolve; });
  const sandbox = { storyRequest: null, createStoryRequest,
    getContext: () => context, currentChatKey: () => 'A', getSettings: () => settings,
    fingerprintMessage, injectStoryContext, STORY_PROMPT_ID, RECALL_PROMPT_ID: 'recall',
    engine: { chatKey: 'A', storage: { listSummaries: async () => data.summaries, listCheckpoints: async () => [] } },
    clearStoryPrompt: () => prompts.set(STORY_PROMPT_ID, ''), clearRecallPrompt: () => prompts.set('recall', ''),
    showStoryContextStatus() {}, renderRecallState() {}, root: {}, recallState: {},
    recallForCurrentContext: async () => { started(); return new Promise(resolve => { release = resolve; }); },
  };
  vm.createContext(sandbox);
  vm.runInContext(functions, sandbox);
  let aborted = false;
  const request = sandbox.semanticRecallInterceptor(data.promptChat, 32000, () => { aborted = true; }, 'normal');
  await reachedRecall;
  assert.equal(data.promptChat.length, 5);
  settings.summaryContextEnabled = false;
  release({ prompt: '回忆', records: [] });
  await request;
  assert.equal(aborted, true);
  assert.equal(data.promptChat.length, 9);
  assert.equal(prompts.get(STORY_PROMPT_ID), '');
});

test('real interceptor injects normal summary when semantic recall is off', async () => {
  const data = fixture();
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  const functions = source.slice(source.indexOf('function clearStoryPrompt('), source.indexOf('function showStoryContextStatus(')) + source.slice(source.indexOf('async function semanticRecallInterceptor('), source.indexOf('\nfunction scheduleReconcile('));
  const prompts = new Map();
  const context = { chat: data.sourceChat, stopGeneration() {}, eventTypes: { GENERATE_AFTER_DATA: 'generate_after_data' }, setExtensionPrompt: (key, text) => prompts.set(key, text) };
  const sandbox = { storyRequest: null, createStoryRequest,
    getContext: () => context, currentChatKey: () => 'A', getSettings: () => ({ summaryContextEnabled: true, filterArchivedFloors: true, semanticRecallEnabled: false }),
    fingerprintMessage, injectStoryContext, STORY_PROMPT_ID,
    engine: { chatKey: 'A', storage: { listSummaries: async () => data.summaries, listCheckpoints: async () => [] } },
    clearStoryPrompt: () => prompts.set(STORY_PROMPT_ID, ''), clearRecallPrompt() {},
    showStoryContextStatus() {}, renderRecallState() {}, root: {}, recallState: {},
  };
  vm.createContext(sandbox);
  vm.runInContext(functions, sandbox);
  await sandbox.semanticRecallInterceptor(data.promptChat, 32000, () => assert.fail('unexpected abort'), 'normal');
  assert.match(prompts.get(STORY_PROMPT_ID), /剧情总摘要/);
  assert.equal(data.promptChat.length, 5);
});
