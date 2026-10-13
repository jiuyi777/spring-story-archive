import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const cut = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));

function harness({ batches, current = () => true, enabled = true }) {
  const calls = [];
  const statuses = [];
  const sandbox = {
    getSettings: () => ({ autoBackfill: enabled, autoSummarize: true, backfillBatchSize: 10 }),
    engine: { chatKey: 'A', waitForIdle: async () => {}, backfill: async () => { calls.push(1); return batches.shift() ?? { queuedCount: 0, remainingCount: 0 }; } },
    captureChatTask: () => ({ isCurrent: current }),
    setStatus: (root, text) => statuses.push(text), root: {}, setTimeout,
  };
  vm.createContext(sandbox);
  vm.runInContext(cut('let autoBackfillRunning = false;', '\nfunction recallOn()'), sandbox);
  return { sandbox, calls, statuses };
}

test('old floors are organized batch after batch with no button', async () => {
  const h = harness({ batches: [{ queuedCount: 10, remainingCount: 15 }, { queuedCount: 10, remainingCount: 5 }, { queuedCount: 5, remainingCount: 0 }] });
  await h.sandbox.runAutoBackfill();
  assert.equal(h.calls.length, 3);
  assert.equal(h.statuses.at(-1), '旧楼层已全部整理');
});

test('it stops when the chat changes or the setting is off', async () => {
  let checks = 0;
  const changed = harness({ batches: [{ queuedCount: 10, remainingCount: 30 }, { queuedCount: 10, remainingCount: 20 }], current: () => (checks += 1) < 2 });
  await changed.sandbox.runAutoBackfill();
  assert.equal(changed.calls.length, 1);
  const off = harness({ batches: [{ queuedCount: 10, remainingCount: 30 }], enabled: false });
  await off.sandbox.runAutoBackfill();
  assert.equal(off.calls.length, 0);
});
