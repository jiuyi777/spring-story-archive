import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { buildStoryContext, createStoryRequest, injectStoryContext } from '../core/story-context.js';
import { fingerprintMessage } from '../core/privacy-payload.js';

// Executes matching local host functions with inert dependencies and a fake sender.
// No browser installation or real API requests. Portable checkouts explicitly skip this gate.
const hostRoot = new URL('../../SillyTavern/', import.meta.url);
const available = fs.existsSync(new URL('public/script.js', hostRoot));
const read = (name) => fs.readFileSync(new URL(name, hostRoot), 'utf8');
const extract = (source, start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))).replace(/^export /, '');
function hostHarness() {
  const host = read('public/script.js');
  const oai = read('public/scripts/openai.js');
  const chats = read('public/scripts/chats.js');
  const s = {
    extension_prompts: {}, extension_prompt_types: { IN_PROMPT: 0, IN_CHAT: 1 }, extension_prompt_roles: { SYSTEM: 0, USER: 1, ASSISTANT: 2 },
    system_message_types: { NARRATOR: 'narrator' }, name1: '玩家', name2: '角色', getExtensionPromptMaxDepth: () => 4, substituteParams: (x) => x,
    main_api: 'openai', abortController: new AbortController(), streamingProcessor: null, hideStopButton() {}, event_types: { GENERATION_STOPPED: 'stop' },
    eventSource: { emit() {} }, sent: [],
  };
  s.sendOpenAIRequest = async (type, prompt, signal) => {
    signal.throwIfAborted();
    s.sent.push({ type, prompt });
    return { ok: true };
  };
  vm.createContext(s);
  const functions = [
    extract(host, 'export function setExtensionPrompt(', '\n/**'),
    extract(host, 'export async function getExtensionPrompt(', '\nexport function baseChatReplace'),
    extract(host, 'async function doChatInject(', '\nfunction flushWIInjections'),
    extract(host, 'export function stopGeneration(', '\n/**'),
    extract(host, 'export async function sendGenerationRequest(', '\n/**'),
    extract(host, 'export async function sendStreamingRequest(', '\n/**'),
    extract(oai, 'async function populationInjectionPrompts(', '\n/**'),
    extract(chats, 'export async function appendFileContent(', '\n/**'),
  ];
  vm.runInContext(functions.join('\n'), s);
  return s;
}

test('target host consumers carry complete summaries for normal, swipe and continue', { skip: !available }, async () => {
  for (const type of ['normal', 'swipe', 'continue']) {
    const s = hostHarness();
    const sourceChat = [{ is_system: true, mes: 'system' }, ...Array.from({ length: 9 }, (_, i) => ({ name: '角色', is_user: i % 2 === 1, mes: `RAW_${i}` }))];
    const original = structuredClone(sourceChat);
    const promptChat = sourceChat.filter((row) => !row.is_system).map((row, index) => ({ ...row, index }));
    if (type === 'swipe') promptChat.pop();
    const summaries = sourceChat.map((message, floorIndex) => ({ floorIndex, status: 'ready', inputComplete: true, summary: `SUMMARY_${floorIndex}`, messageFingerprint: fingerprintMessage(message, floorIndex) }));
    const context = { chat: sourceChat, setExtensionPrompt: s.setExtensionPrompt, stopGeneration: s.stopGeneration };
    const request = createStoryRequest({ context, promptChat, abort() {}, isCurrent: () => true, onStatus() {} });
    await injectStoryContext({ context, storage: { listSummaries: async () => summaries, listCheckpoints: async () => [] },
      chatKey: 'A', promptChat, contextSize: 32000, type, enabled: true, filter: true, isCurrent: () => true, onPlan: request.plan });
    assert.equal(promptChat.length, type === 'continue' ? 6 : 5);
    const chatPrompt = await s.populationInjectionPrompts([], promptChat.map((row) => ({ role: row.is_user ? 'user' : 'assistant', content: row.mes })).reverse());
    const textPrompt = structuredClone(promptChat);
    await s.doChatInject(textPrompt, type === 'continue');
    for (const data of [{ prompt: chatPrompt }, { prompt: textPrompt.map((row) => row.mes).join('\n') }]) {
      request.verify(data, false);
      assert.equal(s.abortController.signal.aborted, false);
      assert.ok(JSON.stringify(data).includes('SUMMARY_1'));
      if (type === 'swipe') assert.ok(!JSON.stringify(data).includes('SUMMARY_9'));
    }
    await s.sendGenerationRequest(type, { prompt: chatPrompt });
    assert.equal(s.sent.length, 1);
    assert.deepEqual(sourceChat, original);
  }
});

test('target host stop function blocks streaming and non-streaming send after a missing summary', { skip: !available }, async () => {
  const s = hostHarness();
  const request = createStoryRequest({ context: { stopGeneration: s.stopGeneration }, promptChat: [], abort() {}, isCurrent: () => true, onStatus() {} });
  request.plan({ prompt: 'COMPLETE_ARCHIVE' });
  request.verify({ prompt: [{ role: 'user', content: 'raw only' }] }, false);
  assert.equal(s.abortController.signal.aborted, true);
  await assert.rejects(s.sendGenerationRequest('normal', { prompt: [] }));
  await assert.rejects(s.sendStreamingRequest('normal', { prompt: [] }));
  assert.equal(s.sent.length, 0);
});

test('target host text attachment shape is protected after native file expansion', { skip: !available }, async () => {
  const s = hostHarness();
  const sourceChat = Array.from({ length: 7 }, (_, index) => ({ name: '角色', is_user: false, mes: `RAW_${index}` }));
  sourceChat[0].extra = { files: [{ url: '/local-placeholder', text: 'FILE_FACT' }] };
  const promptChat = sourceChat.map((row, index) => ({ ...row, index }));
  promptChat[0].mes = await s.appendFileContent(sourceChat[0], sourceChat[0].mes);
  const summaries = sourceChat.map((message, floorIndex) => ({ floorIndex, status: 'ready', inputComplete: true, summary: 'text only', messageFingerprint: fingerprintMessage(message, floorIndex) }));
  const plan = buildStoryContext({ sourceChat, promptChat, summaries, checkpoints: [], contextSize: 32000 });
  assert.match(promptChat[0].mes, /FILE_FACT/);
  assert.ok(!plan.removeIndexes.includes(0));
});

test('target regex engine accepts empty replacements and preserves disabled/display/recent cases', { skip: !available }, () => {
  const source = read('public/scripts/extensions/regex/engine.js');
  const utils = read('public/scripts/utils.js');
  const rule = JSON.parse(fs.readFileSync(new URL('../regex/旧楼层不发送-手动备用.json', import.meta.url), 'utf8'));
  const s = { rule, extension_settings: { disabledExtensions: [] }, getRegexScripts: () => [s.rule], substitute_find_regex: { NONE: 0, RAW: 1, ESCAPED: 2 }, substituteParams: (x) => x, console: { debug() {}, warn() {} } };
  vm.createContext(s);
  vm.runInContext(extract(utils, 'export function regexFromString(', '\nexport class Stopwatch')
    + extract(source, 'export function getRegexedString(', '\n/**') + extract(source, 'export function runRegexScript(', '\n/**'), s);
  const cases = [
    [1, { isPrompt: true, depth: 9 }, true, 'raw'], [1, { isPrompt: true, depth: 5 }, false, ''],
    [2, { isPrompt: true, depth: 5 }, false, ''], [1, { isPrompt: true, depth: 4 }, false, 'raw'],
    [2, { isPrompt: true, depth: 4 }, false, 'raw'], [2, { isMarkdown: true, depth: 8 }, false, 'raw'],
    [5, { isPrompt: true, depth: 8 }, false, 'raw'], [2, { depth: 8 }, false, 'raw'],
  ];
  for (const [placement, options, disabled, expected] of cases) {
    s.rule.disabled = disabled;
    assert.equal(s.getRegexedString('raw', placement, options), expected);
  }
});
