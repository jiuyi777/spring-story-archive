import test from 'node:test';
import assert from 'node:assert/strict';
import { SummaryEngine } from '../core/summary-engine.js';
import { fingerprintMessage } from '../core/privacy-payload.js';
import { createMemoryStorage } from '../core/storage.js';

function makeHarness({ chat, generateRaw, settings = {}, requestDelayMs = 0, wait }) {
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
    requestDelayMs,
    ...(wait ? { wait } : {}),
  });
  engine.setChat('chat-a');
  return { engine, storage, context };
}

function readBatchPayload({ prompt }) {
  return JSON.parse(String(prompt ?? '').replace(/^user:\s*/i, ''));
}

function batchResponse(request, { omitFloors = [], prefix = '摘要' } = {}) {
  const payload = readBatchPayload(request);
  return JSON.stringify({
    floors: payload.targetFloors
      .filter(({ floor }) => !omitFloors.includes(floor))
      .map(({ floor }) => ({
        floor,
        summary: `${prefix}${floor}`,
        characters: [],
        relationships: [],
        clues: [],
        timeline: [],
      })),
  });
}

test('a failed floor keeps its record and can be regenerated', async () => {
  let calls = 0;
  const { engine } = makeHarness({
    chat: [{ is_user: false, name: '角色', mes: '雨落在窗沿。', swipe_id: 0 }],
    generateRaw: async (request) => {
      calls += 1;
      if (calls === 1) throw new Error('temporary failure');
      return batchResponse(request, { prefix: '窗外开始落雨。' });
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
  assert.equal(snapshot.summaries[0].summary, '窗外开始落雨。1');
});

test('player output is stored locally as a complete chronological floor record', async () => {
  const { engine } = makeHarness({
    chat: [{ is_user: true, name: '玩家', mes: '我拒绝离开，并决定亲自查看西廊。', swipe_id: 0 }],
    generateRaw: async (request) => batchResponse(request),
  });
  await engine.reconcile();
  const snapshot = await engine.getSnapshot();
  assert.equal(snapshot.summaries[0].isUser, true);
  assert.equal(snapshot.summaries[0].priority, 'player-statement');
  assert.equal(snapshot.summaries[0].userText, '我拒绝离开，并决定亲自查看西廊。');
});

test('a new player floor and character reply share one API request', async () => {
  let calls = 0;
  let sentFloors = [];
  const { engine } = makeHarness({
    chat: [
      { is_user: true, name: '玩家', mes: '我选择留下。', swipe_id: 0 },
      { is_user: false, name: '角色', mes: '角色推开了西廊的门。', swipe_id: 0 },
    ],
    generateRaw: async (request) => {
      calls += 1;
      sentFloors = readBatchPayload(request).targetFloors;
      return batchResponse(request);
    },
  });
  await engine.reconcile({ queueMissing: true });
  await engine.waitForIdle();
  const snapshot = await engine.getSnapshot();
  assert.equal(calls, 1);
  assert.deepEqual(sentFloors.map(({ floor, kind }) => [floor, kind]), [[1, 'user'], [2, 'assistant']]);
  assert.deepEqual(snapshot.summaries.map((record) => record.status), ['ready', 'ready']);
  assert.equal(snapshot.summaries[0].priority, 'player-statement');
});

test('backfill handles only the selected batch and the next click continues', async () => {
  let calls = 0;
  const { engine } = makeHarness({
    chat: Array.from({ length: 45 }, (_, index) => ({ mes: `第 ${index + 1} 楼` })),
    settings: { backfillBatchSize: 20 },
    generateRaw: async (request) => {
      calls += 1;
      return batchResponse(request, { prefix: `第${calls}批-` });
    },
  });
  await engine.reconcile({ queueMissing: false });

  const first = await engine.backfill(20);
  assert.deepEqual(first, { busy: false, queuedCount: 20, remainingCount: 25, totalMissing: 45 });
  assert.equal((await engine.backfill(20)).busy, true);
  await engine.waitForIdle();
  assert.equal(calls, 1);

  const second = await engine.backfill(20);
  assert.deepEqual(second, { busy: false, queuedCount: 20, remainingCount: 5, totalMissing: 25 });
  await engine.waitForIdle();
  assert.equal(calls, 2);
});

test('ten or twenty short floors each use one API request', async (t) => {
  for (const count of [10, 20]) {
    await t.test(`${count} floors`, async () => {
      let calls = 0;
      const { engine } = makeHarness({
        chat: Array.from({ length: count }, (_, index) => ({ mes: `短楼层 ${index + 1}` })),
        settings: { backfillBatchSize: count },
        generateRaw: async (request) => {
          calls += 1;
          return batchResponse(request);
        },
      });
      await engine.reconcile({ queueMissing: true });
      await engine.waitForIdle();
      assert.equal(calls, 1);
      assert.deepEqual((await engine.getSnapshot()).summaries.map((record) => record.status), Array(count).fill('ready'));
    });
  }
});

test('oversized floor content is split across multiple API requests', async () => {
  let calls = 0;
  const { engine } = makeHarness({
    chat: Array.from({ length: 3 }, (_, index) => ({ mes: `第${index + 1}楼${'长'.repeat(2500)}` })),
    settings: { backfillBatchSize: 20 },
    generateRaw: async (request) => {
      calls += 1;
      return batchResponse(request);
    },
  });
  await engine.reconcile({ queueMissing: true });
  await engine.waitForIdle();
  assert.equal(calls, 3);
});

test('one omitted model row fails without discarding the other floor summaries', async () => {
  const { engine } = makeHarness({
    chat: [{ mes: '一' }, { mes: '二' }, { mes: '三' }],
    generateRaw: async (request) => batchResponse(request, { omitFloors: [2] }),
  });
  await engine.reconcile({ queueMissing: true });
  await engine.waitForIdle();
  const snapshot = await engine.getSnapshot();
  assert.deepEqual(snapshot.summaries.map((record) => record.status), ['ready', 'failed', 'ready']);
  assert.match(snapshot.summaries[1].error, /漏掉/);
});

test('regenerating one floor requests only that floor', async () => {
  const batches = [];
  const { engine } = makeHarness({
    chat: [{ mes: '一' }, { mes: '二' }],
    generateRaw: async (request) => {
      const payload = readBatchPayload(request);
      batches.push(payload.targetFloors.map(({ floor }) => floor));
      return batchResponse(request);
    },
  });
  await engine.reconcile({ queueMissing: true });
  await engine.waitForIdle();
  await engine.regenerate(1);
  await engine.waitForIdle();
  assert.deepEqual(batches, [[1, 2], [2]]);
});

test('summary queue waits between requests', async () => {
  const delays = [];
  const { engine } = makeHarness({
    chat: [{ mes: '一' }, { mes: '二' }, { mes: '三' }],
    settings: { backfillBatchSize: 1 },
    requestDelayMs: 1800,
    wait: async (delay) => delays.push(delay),
    generateRaw: async (request) => batchResponse(request),
  });
  await engine.reconcile({ queueMissing: false });
  await engine.backfill(3);
  await engine.waitForIdle();
  assert.deepEqual(delays, [1800, 1800]);
});

test('a 429 stops the current batch and leaves later floors pending', async () => {
  let calls = 0;
  const { engine } = makeHarness({
    chat: [{ mes: '一' }, { mes: '二' }, { mes: '三' }],
    settings: { backfillBatchSize: 1 },
    generateRaw: async () => {
      calls += 1;
      throw new Error('Custom OpenAI endpoint failed with status 429: rate limit exceeded');
    },
  });
  await engine.reconcile({ queueMissing: false });
  await engine.backfill(3);
  await engine.waitForIdle();
  const snapshot = await engine.getSnapshot();
  assert.equal(calls, 1);
  assert.deepEqual(snapshot.summaries.map((record) => record.status), ['failed', 'missing', 'missing']);
});

test('the 100th summarized floor creates a compression checkpoint', async () => {
  let compressionCalls = 0;
  const { engine, storage, context } = makeHarness({
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
      inputComplete: true, messageFingerprint: fingerprintMessage(context.chat[floorIndex], floorIndex),
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
  assert.equal(snapshot.checkpoints[0].formatVersion, 5);
});

test('the configured token ceiling also creates a compression checkpoint', async () => {
  let compressionCalls = 0;
  const { engine, storage, context } = makeHarness({
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
      chatKey: 'chat-a', floorIndex, inputComplete: true, messageFingerprint: fingerprintMessage(context.chat[floorIndex], floorIndex),
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
