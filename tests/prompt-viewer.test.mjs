import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { normalizeFinalPrompt, pruneFinalPrompts } from '../core/send-history.js';
import { locateFloors, renderPromptViewer, sourceOf } from '../ui/prompt-view.js';
import { createMemoryStorage } from '../core/storage.js';
import { estimateTokens } from '../core/privacy-payload.js';

function promptDom(t) {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const descendants = (node) => node.children.flatMap((child) => typeof child === 'string' ? [] : [child, ...descendants(child)]);
  const element = (tag) => {
    const node = {
      tagName: tag.toUpperCase(), className: '', textContent: '', children: [], dataset: {},
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children; },
      contains() { return false; },
      querySelectorAll() { return descendants(this).filter((item) => item.className.split(' ').includes('ssa-prompt-msg') && item.open); },
      querySelector(selector) { return descendants(this).find((item) => item.className.split(' ').includes(selector.slice(1))); },
    };
    node.classList = { add: (name) => { node.className += ` ${name}`; } };
    return node;
  };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { activeElement: null, createElement: element } });
  t.after(() => {
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
    else delete globalThis.document;
  });
  const host = element('div');
  const root = {
    querySelector: () => host,
    querySelectorAll: () => descendants(host).filter((item) => item.tagName === 'LI'),
  };
  const text = (node) => typeof node === 'string' ? node : node.textContent + node.children.map(text).join('');
  return { root, text: () => text(host), byClass: (name) => descendants(host).filter((node) => node.className.split(' ').includes(name)) };
}

test('host tokenizer counts remain estimates and unavailable counts fall back safely', async () => {
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  const count = source.slice(source.indexOf('async function countTokens('), source.indexOf('\nfunction showRound('));
  const cases = [
    { hostCounter: async () => 17, source: 'host', value: 17 },
    { hostCounter: async () => Number.NaN, source: 'fallback' },
    { hostCounter: async () => { throw new Error('unavailable'); }, source: 'fallback' },
    { hostCounter: undefined, source: 'fallback' },
  ];
  for (const scenario of cases) {
    const { hostCounter } = scenario;
    const sandbox = { getContext: () => ({ getTokenCountAsync: hostCounter }), estimateTokens };
    vm.createContext(sandbox);
    vm.runInContext(count, sandbox);
    const result = await sandbox.countTokens('这一段正文');
    assert.equal(result.exact, false);
    assert.equal(result.source, scenario.source);
    assert.equal(result.value, scenario.value ?? estimateTokens('这一段正文'));
  }
});

test('rendered counts are approximate and cache full text only within one render', async (t) => {
  const dom = promptDom(t);
  const first = `${'前'.repeat(40)}中段甲${'后'.repeat(40)}`;
  const second = `${'前'.repeat(40)}中段乙${'后'.repeat(40)}`;
  const records = [{ key: 'token-test', startedAt: '2026-10-15T00:00:00Z', finalPrompt: [first, second, first].map((content) => ({ role: 'user', content })) }];
  const calls = [];
  let multiplier = 1;
  const countTokens = async (text) => {
    calls.push(text);
    return { value: (text === first ? 111 : 222) * multiplier, exact: true, source: 'host' };
  };
  const render = async (counter = countTokens) => {
    renderPromptViewer(dom.root, { records, countTokens: counter });
    await new Promise((resolve) => setImmediate(resolve));
  };
  await render();
  assert.deepEqual(calls, [first, second]);
  assert.match(dom.text(), /正文约 444 token/);
  assert.match(dom.text(), /按酒馆估算，实际用量以 API 为准/);
  assert.deepEqual(dom.byClass('ssa-prompt-tokens').map((node) => node.textContent), ['约 111', '约 222', '约 111']);

  multiplier = 2;
  await render();
  assert.equal(calls.length, 4);
  assert.match(dom.text(), /正文约 888 token/);

  await render(async () => ({ value: 3, exact: false, source: 'fallback' }));
  assert.match(dom.text(), /正文约 9 token/);
  assert.match(dom.text(), /粗略估算，实际用量以 API 为准/);
});

test('chat-completion and text-completion prompts are both captured as messages', () => {
  assert.deepEqual(normalizeFinalPrompt([{ role: 'system', content: 'a' }, { role: 'user', content: [{ type: 'text', text: 'b' }, { type: 'image_url' }] }]),
    [{ role: 'system', name: undefined, content: 'a' }, { role: 'user', name: undefined, content: 'b\n[图片]' }]);
  assert.deepEqual(normalizeFinalPrompt('整段文本'), [{ role: 'prompt', content: '整段文本' }]);
  assert.equal(normalizeFinalPrompt(undefined), null);
});

test('each message is labelled with where it came from', () => {
  const messages = [
    { role: 'system', content: '你是林素。' },
    { role: 'system', content: '【春序档案 · 剧情总摘要】\n……' },
    { role: 'user', content: '玩家: 问她登记簿里少了哪一页。' },
    { role: 'system', content: '【剧情选项】\n每次写完正文后……' },
  ];
  const floors = locateFloors(messages, ['推门进了旧宅。', '林素抬头。', '问她登记簿里少了哪一页。']);
  assert.deepEqual(floors, [null, null, 2, null]);
  assert.deepEqual(messages.map((message, i) => sourceOf(message, floors[i])[0].kind), ['host', 'story', 'floor', 'options']);
  assert.equal(sourceOf({ content: '【剧情记忆】\n已有事实。' }, null)[0].kind, 'story');
  assert.equal(sourceOf({ content: '【相关往事】\n曾经发生。' }, null)[0].kind, 'recall');
});

test('only the newest sends keep their full prompt', async () => {
  const storage = createMemoryStorage();
  for (let i = 0; i < 12; i += 1) await storage.putSendRecord({ key: `A::send:${i}`, chatKey: 'A', startedAt: `2026-10-13T10:${String(i).padStart(2, '0')}:00Z`, finalPrompt: [{ role: 'user', content: String(i) }] });
  await pruneFinalPrompts(storage, 'A', 10);
  const records = await storage.listSendRecords('A');
  assert.equal(records.filter((record) => record.finalPrompt).length, 10);
  assert.ok(records.find((record) => record.key === 'A::send:0').finalPromptPruned);
});
