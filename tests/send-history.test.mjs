import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../core/storage.js';
import { createSendHistory } from '../core/send-history.js';
import { createStoryRequest } from '../core/story-context.js';
import { selectMemoryDatabase } from '../core/memory-database.js';
import { requestStoryOptions } from '../core/api-client.js';

test('request history preserves independent attempts, evidence, raw ranges, and chat isolation', async () => {
  const storage = createMemoryStorage();
  const errors = [];
  const chat = [{ mes: 'old text' }, { mes: 'new text', is_user: true }];
  const start = (chatKey = 'A', type = 'normal') => createSendHistory({ storage, chatKey, chat, promptChat: chat.map((row, index) => ({ ...row, index })), type, onChange: error => { if (error) errors.push(error); } });
  const first = start();
  first.plan({ prompt: 'MEMORY', includedFloors: [0], removeIndexes: [0], memories: [{ text: 'fact', reason: 'current' }] }, true);
  const guard = createStoryRequest({ context: {}, promptChat: [], abort() {}, isCurrent: () => true, onStatus() {}, onEvidence: first.evidence });
  guard.plan({ prompt: 'MEMORY' }); guard.verify({ prompt: 'MEMORY' }, true);
  await first.idle(); assert.equal((await storage.listSendRecords('A'))[0].verified, false);
  guard.verify({ prompt: 'complete MEMORY' }, false);
  first.recall('RECALL', [{ floorIndex: 0 }]);
  await first.finish('received', 2);
  const second = start('A', 'swipe'); await second.finish('stopped');
  const other = start('B'); await other.finish('ended');
  const records = await storage.listSendRecords('A');
  assert.equal(records.length, 2); assert.notEqual(records[0].key, records[1].key);
  assert.equal(records[0].verified, true); assert.equal(records[0].targetFloor, 3);
  assert.deepEqual(records[0].rawFloors.map(row => row.text), ['new text']);
  assert.deepEqual(records[0].removedFloors, [0]); assert.equal(records[0].recallPrompt, 'RECALL');
  assert.equal(records[1].status, 'stopped'); assert.equal((await storage.listSendRecords('B')).length, 1);
  assert.deepEqual(errors, []);
  records[0].rawFloors[0].text = 'mutated';
  assert.equal((await storage.listSendRecords('A'))[0].rawFloors[0].text, 'new text');
});

test('failed final-prompt validation is recorded as stopped instead of verified', async () => {
  const storage = createMemoryStorage();
  const ledger = createSendHistory({ storage, chatKey: 'A', chat: [], promptChat: [] });
  const guard = createStoryRequest({ context: {}, promptChat: [], abort() {}, isCurrent: () => true, onStatus() {}, onEvidence: ledger.evidence });
  guard.plan({ prompt: 'REQUIRED_MEMORY' }); guard.recallPlan('REQUIRED_RECALL'); guard.verify({ prompt: 'REQUIRED_MEMORY' }, false);
  await ledger.finish('received', 0);
  const record = (await storage.listSendRecords('A'))[0];
  assert.equal(record.status, 'stopped'); assert.equal(record.verified, false);
});

test('send history keeps original floor numbers when the current model includes or omits old tool history', async () => {
  const chat = [
    { is_system: true, mes: 'system note' },
    { name: '角色', mes: 'first story' },
    { is_system: true, mes: 'old tool call', extra: { tool_invocations: [] } },
    { name: '玩家', is_user: true, mes: 'player story' },
    { is_system: true, mes: 'another old tool call', extra: { tool_invocations: [] } },
    { name: '角色', mes: 'latest story' },
  ];
  for (const includesTools of [false, true]) {
    const storage = createMemoryStorage();
    const sourceRows = chat.map((message, floorIndex) => ({ message, floorIndex }))
      .filter(({ message }) => !message.is_system || (includesTools && Array.isArray(message.extra?.tool_invocations)));
    const promptChat = sourceRows.map(({ message }, index) => ({ ...message, index }));
    const ledger = createSendHistory({ storage, chatKey: 'A', chat, promptChat });
    await ledger.idle();
    const [prepared] = await storage.listSendRecords('A');
    assert.deepEqual(prepared.rawFloors.map(row => row.floorIndex), sourceRows.map(row => row.floorIndex));
    ledger.plan({ prompt: 'summary', includedFloors: [1], removeIndexes: [0] }, true);
    await ledger.finish();
    const [finished] = await storage.listSendRecords('A');
    assert.deepEqual(finished.removedFloors, [1]);
    assert.deepEqual(finished.rawFloors.map(row => row.floorIndex), sourceRows.slice(1).map(row => row.floorIndex));
    assert.deepEqual(finished.rawFloors.map(row => row.text), sourceRows.slice(1).map(row => row.message.mes));
  }
});

test('context selection follows aliases, current location, owners and relationships, excluding unrelated inventory', () => {
  const row = (id, values, floorIndex = 10) => ({ id, values, floorIndex });
  const database = { tables: {
    scene: [row('current', { location: '药铺' })],
    characters: [row('lin', { name: '林素', aliases: '林小姐', location: '药铺' }), row('chen', { name: '陈先生', location: '远方' })],
    inventory: [row('book', { name: '登记簿', owner: '林素' }), row('boat', { name: '帆船', owner: '陈先生' })],
    relationships: [row('debt', { from: '林素', to: '玩家', relation: '借用未归还' })],
    tasks: [row('old', { name: '旧案', state: '已完成' }, 1)],
  } };
  const result = selectMemoryDatabase(database, { query: '把东西还给林小姐', budget: 1000 });
  assert.match(result.text, /登记簿/); assert.match(result.text, /借用未归还/);
  assert.doesNotMatch(result.text, /帆船|陈先生|旧案/);
  assert.equal(result.records.find(row => row.id === 'book').reason, '相关人物持有或拥有');
  assert.equal(selectMemoryDatabase(database, { query: '林小姐', budget: 1 }).records.length, 0);
});

test('option writing requirements reach the actual model request', async () => {
  let payload;
  await requestStoryOptions(async request => { payload = JSON.parse(request.messages[1].content); return JSON.stringify({ options: ['甲', '乙', '丙', '丁'] }); }, { currentMemory: '林素持有登记簿' }, { count: 4, writingNotes: '选项保持简短' });
  assert.equal(payload.optionWritingRequirements, '选项保持简短');
  assert.equal(payload.currentMemory, '林素持有登记簿');
});
