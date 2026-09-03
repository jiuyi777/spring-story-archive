import test from 'node:test';
import assert from 'node:assert/strict';
import { SummaryEngine } from '../core/summary-engine.js';
import { createMemoryStorage } from '../core/storage.js';

function makeHarness({ chat, generateRaw, settings = {} }) {
  const storage = createMemoryStorage();
  const context = { chat, generateRaw };
  const mergedSettings = {
    summarySource: 'current',
    rollupTokenLimit: 6000,
    ...settings,
  };
  const engine = new SummaryEngine({
    storage,
    getContext: () => context,
    getSettings: () => mergedSettings,
    getExtraCredentials: () => ({}),
  });
  engine.setChat('chat-a');
  return { engine, storage, context };
}

test('a failed floor keeps its record and can be regenerated', async () => {
  let calls = 0;
  const { engine } = makeHarness({
    chat: [{ is_user: false, name: '角色', mes: '雨落在窗沿。', swipe_id: 0 }],
    generateRaw: async () => {
      calls += 1;
      if (calls === 1) throw new Error('temporary failure');
      return JSON.stringify({ summary: '窗外开始落雨。', characters: [], relationships: [], clues: [], timeline: ['傍晚'] });
    },
  });
  await engine.reconcile();
  engine.enqueue(0);
  await engine.waitForIdle();
  let snapshot = await engine.getSnapshot();
  assert.equal(snapshot.summaries[0].status, 'failed');
  assert.match(snapshot.summaries[0].error, /temporary failure/);

  await engine.regenerate(0);
  await engine.waitForIdle();
  snapshot = await engine.getSnapshot();
  assert.equal(snapshot.summaries[0].status, 'ready');
  assert.equal(snapshot.summaries[0].summary, '窗外开始落雨。');
});

test('player output is stored locally as a complete chronological floor record', async () => {
  const { engine } = makeHarness({
    chat: [{ is_user: true, name: '玩家', mes: '我拒绝离开，并决定亲自查看西廊。', swipe_id: 0 }],
    generateRaw: async () => JSON.stringify({ summary: '玩家拒绝离开并选择查看西廊。' }),
  });
  await engine.reconcile();
  const snapshot = await engine.getSnapshot();
  assert.equal(snapshot.summaries[0].isUser, true);
  assert.equal(snapshot.summaries[0].priority, 'player-statement');
  assert.equal(snapshot.summaries[0].userText, '我拒绝离开，并决定亲自查看西廊。');
});

test('queueMissing automatically summarizes every detected floor', async () => {
  let calls = 0;
  const { engine } = makeHarness({
    chat: [
      { is_user: true, name: '玩家', mes: '我选择留下。', swipe_id: 0 },
      { is_user: false, name: '角色', mes: '角色推开了西廊的门。', swipe_id: 0 },
    ],
    generateRaw: async () => {
      calls += 1;
      return JSON.stringify({ summary: `摘要${calls}`, characters: [], relationships: [], clues: [], timeline: [] });
    },
  });
  await engine.reconcile({ queueMissing: true });
  await engine.waitForIdle();
  const snapshot = await engine.getSnapshot();
  assert.equal(calls, 2);
  assert.deepEqual(snapshot.summaries.map((record) => record.status), ['ready', 'ready']);
  assert.equal(snapshot.summaries[0].priority, 'player-statement');
});

test('the 100th summarized floor creates a compression checkpoint', async () => {
  let compressionCalls = 0;
  const { engine, storage } = makeHarness({
    chat: Array.from({ length: 100 }, (_, index) => ({ mes: `原文${index + 1}` })),
    settings: { rollupTokenLimit: 30000 },
    generateRaw: async ({ systemPrompt }) => {
      if (systemPrompt.includes('总档案员')) {
        compressionCalls += 1;
        return JSON.stringify({ summary: '一百楼压缩总摘要。', timeline: ['第1至100楼：时间顺序保留'], continuityRules: ['不得倒退时间'] });
      }
      throw new Error('unexpected floor summary request');
    },
  });
  for (let floorIndex = 0; floorIndex < 100; floorIndex += 1) {
    await storage.putSummary({
      key: `chat-a::floor::${floorIndex}`,
      chatKey: 'chat-a',
      floorIndex,
      messageFingerprint: `fp-${floorIndex}`,
      status: 'ready',
      summary: `第${floorIndex + 1}楼摘要`,
      characters: [], relationships: [], clues: [], timeline: [], error: '', updatedAt: new Date().toISOString(),
    });
  }
  await engine.refreshRollup({ allowCompression: true });
  const snapshot = await engine.getSnapshot();
  assert.equal(compressionCalls, 1);
  assert.equal(snapshot.checkpoints[0].throughFloor, 99);
  assert.equal(snapshot.checkpoints[0].status, 'ready');
  assert.match(snapshot.rollup.text, /一百楼压缩总摘要/);
  assert.match(snapshot.rollup.text, /固定时间线.*第1至100楼/s);
  assert.equal(snapshot.checkpoints[0].formatVersion, 4);
});

test('the configured token ceiling also creates a compression checkpoint', async () => {
  let compressionCalls = 0;
  const { engine, storage } = makeHarness({
    chat: [{ mes: '一' }, { mes: '二' }],
    settings: { rollupTokenLimit: 10 },
    generateRaw: async ({ systemPrompt }) => {
      assert.match(systemPrompt, /总档案员/);
      compressionCalls += 1;
      return JSON.stringify({ summary: '压缩摘要。' });
    },
  });
  for (let floorIndex = 0; floorIndex < 2; floorIndex += 1) {
    await storage.putSummary({
      key: `chat-a::floor::${floorIndex}`,
      chatKey: 'chat-a', floorIndex, messageFingerprint: `fp-${floorIndex}`,
      status: 'ready', summary: '这是一段足够长的楼层摘要，用于触发容量压缩。',
      characters: [], relationships: [], clues: [], timeline: [], error: '', updatedAt: new Date().toISOString(),
    });
  }
  await engine.refreshRollup({ allowCompression: true });
  const snapshot = await engine.getSnapshot();
  assert.equal(compressionCalls, 1);
  assert.equal(snapshot.checkpoints[0].throughFloor, 1);
  assert.match(snapshot.rollup.text, /压缩摘要。/);
});
