import test from 'node:test';
import assert from 'node:assert/strict';
import { SummaryEngine } from '../core/summary-engine.js';
import { createMemoryStorage } from '../core/storage.js';
import { fingerprintMessage, fingerprintSummaries, estimateTokens } from '../core/privacy-payload.js';
import { buildStoryContext } from '../core/story-context.js';
import { selectChapters, formatChapter } from '../core/chapters.js';

function setup({ floors = 6, limit = 60 } = {}) {
  const storage = createMemoryStorage();
  const chat = Array.from({ length: floors }, (_, index) => ({ mes: `原文${index}`, is_user: index % 2 === 1, name: index % 2 ? '猫头鹰' : '林栀' }));
  const requests = [];
  let n = 0;
  const context = { chat, generateRaw: async ({ prompt, systemPrompt }) => {
    const payload = JSON.parse(prompt.replace(/^user:\s*/, ''));
    requests.push({ systemPrompt, payload });
    n += 1;
    const volume = systemPrompt.includes('合并成一卷');
    return JSON.stringify({ title: volume ? `卷${n}` : `章${n}`, synopsis: `简介${n}`, summary: `正文${n}：${payload.source.slice(0, 40)}`, keyQuotes: ['林栀：“别走。”'], turningPoints: ['转折'] });
  } };
  const settings = { summarySource: 'current', rollupTokenLimit: limit };
  const engine = new SummaryEngine({ storage, getContext: () => context, getSettings: () => settings, getExtraCredentials: () => ({}), requestDelayMs: 0 });
  engine.setChat('A');
  const put = async (index, summary = `第${index}件事：林栀说了一句很重要的话，猫头鹰回应。`) => storage.putSummary({
    key: `A::floor::${index}`, chatKey: 'A', floorIndex: index, inputComplete: true, status: 'ready', summary,
    messageFingerprint: fingerprintMessage(chat[index], index), characters: [], relationships: [], clues: [], timeline: [], updatedAt: new Date().toISOString(),
  });
  return { storage, engine, chat, requests, put, settings };
}

test('a second chapter is written from the new floors only; the first chapter is never rewritten', async () => {
  const { storage, engine, requests, put } = setup({ floors: 12, limit: 150 });
  for (let i = 0; i < 6; i += 1) await put(i);
  await engine.refreshRollup({ allowCompression: true });
  const first = (await storage.listCheckpoints('A')).find((row) => row.status === 'ready');
  assert.equal(first.fromFloor, 0);
  for (let i = 6; i < 12; i += 1) await put(i);
  await engine.refreshRollup({ allowCompression: true });
  const ready = (await storage.listCheckpoints('A')).filter((row) => row.status === 'ready').sort((a, b) => a.fromFloor - b.fromFloor);
  assert.ok(ready.length >= 2);
  assert.equal(ready[0].summary, first.summary, 'chapter one unchanged');
  const second = requests.at(-1).payload;
  assert.doesNotMatch(second.source, /第0件事/, 'old floors are not fed again');
  assert.match(second.previousChapter, /简介/, 'only the short form of the previous chapter, for continuity');
});

test('a changed floor rebuilds only the chapter that contains it', async () => {
  const { storage, engine, requests, put } = setup({ floors: 12, limit: 150 });
  for (let i = 0; i < 6; i += 1) await put(i);
  await engine.refreshRollup({ allowCompression: true });
  for (let i = 6; i < 12; i += 1) await put(i);
  await engine.refreshRollup({ allowCompression: true });
  const before = requests.length;
  const chapters = (await storage.listCheckpoints('A')).filter((row) => row.status === 'ready').sort((a, b) => a.fromFloor - b.fromFloor);
  await put(1, '第1件事被改写了：林栀其实没有说那句话。');
  await engine.refreshRollup({ allowCompression: true });
  const rebuilt = requests.slice(before);
  assert.equal(rebuilt.length, 1);
  assert.match(rebuilt[0].payload.source, /被改写了/);
  assert.doesNotMatch(rebuilt[0].payload.source, /第7件事/);
  const after = (await storage.listCheckpoints('A')).filter((row) => row.status === 'ready');
  assert.ok(after.some((row) => row.summary === chapters.at(-1).summary), 'later chapter kept');
});

test('when chapters pile up, the oldest ones merge into a volume', async () => {
  const { storage, engine, requests, put, settings } = setup({ floors: 40, limit: 60 });
  for (let i = 0; i < 40; i += 1) { await put(i); await engine.refreshRollup({ allowCompression: true }); }
  settings.rollupTokenLimit = 60;
  await engine.refreshRollup({ allowCompression: true });
  const rows = await storage.listCheckpoints('A');
  assert.ok(rows.some((row) => row.kind === 'volume' && row.status === 'ready'), 'a volume exists');
  assert.ok(requests.some((request) => request.systemPrompt.includes('合并成一卷')));
});

test('injection: newest chapters in full, older ones in short form when room is tight', () => {
  const chat = Array.from({ length: 25 }, (_, index) => ({ mes: `原文${index}`, is_user: false, name: '林栀' }));
  const summaries = chat.map((message, floorIndex) => ({ floorIndex, status: 'ready', summary: `事${floorIndex}`, inputComplete: true, messageFingerprint: fingerprintMessage(message, floorIndex) }));
  const chapter = (from, through, n) => ({ key: `c${n}`, chatKey: 'A', status: 'ready', kind: 'chapter', formatVersion: 6, fromFloor: from, throughFloor: through,
    title: `第${n}章`, synopsis: `简介${n}`, summary: `很长的正文${n}。`.repeat(60), keyQuotes: [], sourceFingerprint: fingerprintSummaries(summaries.filter((row) => row.floorIndex >= from && row.floorIndex <= through)) });
  const checkpoints = [chapter(0, 9, 1), chapter(10, 19, 2)];
  assert.equal(selectChapters(checkpoints, summaries).length, 2);
  const promptChat = chat.map((message, index) => ({ ...message, index }));
  const roomy = buildStoryContext({ sourceChat: chat, promptChat, summaries, checkpoints, contextSize: 1e6, type: 'normal', memoryBudget: 20000 });
  assert.match(roomy.prompt, /很长的正文1。很长的正文1。/);
  const budget = estimateTokens(`【剧情记忆】\n\n${formatChapter(checkpoints[1])}\n\n${formatChapter(checkpoints[0], { brief: true })}`) + 20;
  assert.ok(budget < estimateTokens(formatChapter(checkpoints[0])) + estimateTokens(formatChapter(checkpoints[1])));
  const tight = buildStoryContext({ sourceChat: chat, promptChat, summaries, checkpoints, contextSize: 1e6, type: 'normal', memoryBudget: budget });
  assert.match(tight.prompt, /【章·第2章】很长的正文2/, 'newest chapter in full');
  assert.match(tight.prompt, /【章·第1章】简介1/, 'older chapter as short form');
  assert.ok(tight.prompt.indexOf('第1章') < tight.prompt.indexOf('第2章'), 'story order');
});

test('a big summary from before chapters is read as the first chapter', () => {
  const chat = Array.from({ length: 8 }, (_, index) => ({ mes: `原文${index}`, name: '林栀' }));
  const summaries = chat.map((message, floorIndex) => ({ floorIndex, status: 'ready', summary: `事${floorIndex}`, inputComplete: true, messageFingerprint: fingerprintMessage(message, floorIndex) }));
  const legacy = { key: 'old', status: 'ready', formatVersion: 5, throughFloor: 3, summary: '旧版大总结', sourceFingerprint: fingerprintSummaries(summaries.slice(0, 4)) };
  const chosen = selectChapters([legacy], summaries);
  assert.equal(chosen.length, 1);
  assert.match(formatChapter(chosen[0]), /【往事】旧版大总结/);
});
