import test from 'node:test';
import assert from 'node:assert/strict';
import { compileRules, scanCliches, cleanLocally, sentencesToRewrite, applyRewrites, parseCustomRules } from '../core/cliche-filter.js';

const rules = compileRules();
const sample = '说实话，他下意识地后退了半步。命运的齿轮开始转动。她扯出一个比哭还难看的笑。窗外下着雨。';

test('fixed clichés are detected with their rule', () => {
  const labels = scanCliches(sample, rules).map((hit) => hit.rule);
  assert.ok(labels.includes('fate-gear'));
  assert.ok(labels.includes('worse-than-cry'));
  assert.ok(labels.includes('filler-honest'));
});

test('filler is removed locally and the sentence still reads', () => {
  const { text, removed } = cleanLocally(sample, rules);
  assert.equal(removed, 2);
  assert.ok(text.startsWith('他后退了半步。'));
});

test('only sentences that need rewording are sent, plain ones are left alone', () => {
  const picked = sentencesToRewrite(sample, rules);
  assert.deepEqual(picked, ['命运的齿轮开始转动。', '她扯出一个比哭还难看的笑。']);
});

test('density rules wait until a reply leans on the habit', () => {
  assert.equal(scanCliches('一丝光。一缕风。', rules).length, 0);
  assert.equal(scanCliches('一丝光。一缕风。一抹红。', rules).filter((hit) => hit.rule === 'measure-words').length, 3);
});

test('ordinary words are not caught on their own', () => {
  assert.equal(scanCliches('他似乎累了。今天三十度。他说不是这个，而是那个。', rules).length, 0);
});

test('rewrites apply only to text still present and stay close in length', () => {
  const { text, applied } = applyRewrites('A。命运的齿轮开始转动。B。', [
    { from: '命运的齿轮开始转动。', to: '事情变了。' },
    { from: '早被改掉的句子。', to: 'x' },
    { from: 'A。', to: '这句被改写得远远超出了原句长度太多太多太多太多太多太多太多太多太多' },
  ]);
  assert.equal(text, 'A。事情变了。B。');
  assert.equal(applied, 1);
});

test('custom rules: prefixes choose the action, slashes mean regex, bad regex is skipped', () => {
  const custom = parseCustomRules('删:总而言之\n改:/眸[光色]/\n标:叹了口气\n/[/');
  assert.deepEqual(custom.map((rule) => rule.action), ['delete', 'rewrite', 'mark']);
  const own = compileRules('删:总而言之');
  assert.equal(cleanLocally('总而言之，他走了。', own).text, '他走了。');
});

import { SummaryEngine } from '../core/summary-engine.js';
import { createMemoryStorage } from '../core/storage.js';
import { fingerprintMessage } from '../core/privacy-payload.js';

import { textHash, splitOptionsBlock } from '../core/cliche-filter.js';
import { storyOnly, mapStory } from '../core/story-segments.js';
import fs from 'node:fs';
import vm from 'node:vm';

test('rewrites ride the organizing call, update the reply and its fingerprint, and do not re-queue the floor', async () => {
  const storage = createMemoryStorage();
  const chat = [{ mes: '他推开门。命运的齿轮开始转动。', name: '叙述者' }];
  let seenPayload = null;
  const context = { chat, generateRaw: async (request) => {
    seenPayload = JSON.parse(request.prompt.replace(/^user:\s*/, ''));
    return JSON.stringify({ floors: [{ floor: 1, summary: '他推门进屋。', characters: [], relationships: [], clues: [], timeline: [], changes: [],
      rewrites: [{ from: '命运的齿轮开始转动。', to: '屋里的人都抬起了头。' }] }] });
  } };
  const engine = new SummaryEngine({
    storage, getContext: () => context, getExtraCredentials: () => ({}), requestDelayMs: 0,
    getSettings: () => ({ summarySource: 'current', rollupTokenLimit: 30000 }),
    clicheSentencesFor: (message) => sentencesToRewrite(message.mes, rules),
    applyFloorRewrites: async (index, rewrites) => {
      const { text, applied } = applyRewrites(chat[index].mes, rewrites);
      if (!applied) return null;
      chat[index].mes = text;
      return fingerprintMessage(chat[index], index);
    },
  });
  engine.setChat('A');
  await engine.reconcile({ queueMissing: true });
  await engine.waitForIdle();
  assert.deepEqual(seenPayload.clicheRewrite, [{ floor: 1, sentences: ['命运的齿轮开始转动。'] }]);
  assert.equal(chat[0].mes, '他推开门。屋里的人都抬起了头。');
  const [record] = await storage.listSummaries('A');
  assert.equal(record.status, 'ready');
  assert.equal(record.messageFingerprint, fingerprintMessage(chat[0], 0));
  await engine.reconcile({ queueMissing: true });
  assert.equal(engine.queue.length, 0);
});

test('the options block is split off and never cleaned', () => {
  const reply = '说实话，他走了。\n\n<chunxu-options>\n<co>【行动】说实话，我也走</co>\n</chunxu-options>';
  const { story, block } = splitOptionsBlock(reply);
  assert.equal(story, '说实话，他走了。');
  assert.match(block, /说实话，我也走/);
});

function replyHarness(chat) {
  const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const cut = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
  const sandbox = {
    getSettings: () => ({ clicheEnabled: true, clicheMode: 'auto' }),
    getContext: () => ({ chat, saveChatDebounced() {} }),
    clicheRules: () => rules, textHash, splitOptionsBlock, storyOnly, mapStory, cleanLocally, applyRewrites, sentencesToRewrite,
    fingerprintMessage, scheduleReconcile() {}, setStatus() {}, root: {}, clicheNotes: null,
  };
  vm.createContext(sandbox);
  vm.runInContext(cut('function clicheActive(message) {', '\nfunction describeReply'), sandbox);
  vm.runInContext(cut('function undoClicheCleanup(index) {', '\n// The reply carries its own options block'), sandbox);
  return sandbox;
}

test('cleaning writes into the chat, keeps the original, and undo/redo swap them', () => {
  const original = '说实话，他走了。\n\n<chunxu-options>\n<co>【行动】说实话，我也走</co>\n</chunxu-options>';
  const chat = [{ mes: original, swipes: [original], swipe_id: 0 }];
  const h = replyHarness(chat);
  h.cleanReceivedReply(0);
  assert.equal(chat[0].mes, '他走了。\n\n<chunxu-options>\n<co>【行动】说实话，我也走</co>\n</chunxu-options>');
  assert.equal(chat[0].swipes[0], chat[0].mes);
  h.undoClicheCleanup(0);
  assert.equal(chat[0].mes, original);
  h.cleanReceivedReply(0);
  assert.equal(chat[0].mes, original, 'a reply the player restored is not cleaned again');
  h.redoClicheCleanup(0);
  assert.match(chat[0].mes, /^他走了。/);
});

test('each swipe keeps its own backup', () => {
  const first = '说实话，他走了。';
  const second = '说真的，她留下了。';
  const chat = [{ mes: first, swipes: [first, second], swipe_id: 0 }];
  const h = replyHarness(chat);
  h.cleanReceivedReply(0);
  chat[0].swipe_id = 1; chat[0].mes = second;
  h.cleanReceivedReply(0);
  assert.equal(chat[0].mes, '她留下了。');
  h.undoClicheCleanup(0);
  assert.equal(chat[0].mes, second);
  chat[0].swipe_id = 0; chat[0].mes = chat[0].swipes[0];
  assert.equal(chat[0].mes, '他走了。');
  h.undoClicheCleanup(0);
  assert.equal(chat[0].mes, first);
});

test('a rewrite from organizing moves the backup along and returns the new fingerprint', async () => {
  const original = '说实话，命运的齿轮开始转动。';
  const chat = [{ mes: original }];
  const h = replyHarness(chat);
  h.cleanReceivedReply(0);
  const fingerprint = await h.applyFloorRewrites(0, [{ from: '命运的齿轮开始转动。', to: '屋里的人都抬起了头。' }]);
  assert.equal(chat[0].mes, '屋里的人都抬起了头。');
  assert.equal(fingerprint, fingerprintMessage(chat[0], 0));
  h.undoClicheCleanup(0);
  assert.equal(chat[0].mes, original);
});
