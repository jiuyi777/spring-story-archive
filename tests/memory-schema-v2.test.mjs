import test from 'node:test';
import assert from 'node:assert/strict';
import { fingerprintMessage } from '../core/privacy-payload.js';
import { buildMemoryDatabase, selectMemoryDatabase, migrateMemoryChange, memorySchemaForPrompt, validateMemoryChanges, MEMORY_VERSION } from '../core/memory-database.js';

const chatOf = (...texts) => texts.map((mes) => ({ mes }));
const record = (chat, floorIndex, memoryVersion, memoryChanges) => ({
  floorIndex, status: 'ready', inputComplete: true, memoryVersion,
  messageFingerprint: fingerprintMessage(chat[floorIndex], floorIndex), summary: chat[floorIndex].mes, memoryChanges,
});
const up = (table, id, values) => ({ table, id, operation: 'upsert', values });
const item = (db, id) => db.tables.inventory.find((row) => row.id === id)?.values;

test('lending a key changes the holder but keeps the owner', () => {
  const chat = chatOf('沈砚取出自己的钥匙。', '沈砚把钥匙借给阿青。');
  const db = buildMemoryDatabase([
    record(chat, 0, MEMORY_VERSION, [up('inventory', '沈砚:钥匙', { name: '钥匙', owner: '沈砚', holder: '沈砚', quantity: '1' })]),
    record(chat, 1, MEMORY_VERSION, [up('inventory', '沈砚:钥匙', { holder: '阿青' })]),
  ], chat);
  assert.deepEqual(item(db, '沈砚:钥匙'), { name: '钥匙', owner: '沈砚', holder: '阿青', quantity: '1' });
});

test('v1 floors stay current and their single owner field becomes the holder', () => {
  const chat = chatOf('玩家拿到两把钥匙。');
  const db = buildMemoryDatabase([record(chat, 0, 1, [up('inventory', '玩家:钥匙', { name: '钥匙', owner: '玩家', quantity: '2' })])], chat);
  assert.equal(db.pendingFloors, 0, 'old floors must not be queued for re-summarizing');
  assert.equal(db.updatedFloors, 1);
  assert.deepEqual(item(db, '玩家:钥匙'), { name: '钥匙', holder: '玩家', quantity: '2' });
});

test('manual edits saved before v2 are migrated; new edits keep both fields', () => {
  const chat = chatOf('开始。');
  const base = [record(chat, 0, MEMORY_VERSION, [up('inventory', 'k', { name: '钥匙', owner: '沈砚', holder: '沈砚' })])];
  const oldEdit = { ...up('inventory', 'k', { owner: '阿青' }), floorIndex: 0 };
  assert.deepEqual(item(buildMemoryDatabase(base, chat, [oldEdit]), 'k'), { name: '钥匙', owner: '沈砚', holder: '阿青' });
  const newEdit = { ...oldEdit, schemaVersion: MEMORY_VERSION };
  assert.deepEqual(item(buildMemoryDatabase(base, chat, [newEdit]), 'k'), { name: '钥匙', owner: '阿青', holder: '沈砚' });
});

test('migration only touches v1 inventory owner values', () => {
  const skill = up('skills', 's', { owner: '沈砚' });
  assert.equal(migrateMemoryChange(skill, 1), skill);
  const v2 = up('inventory', 'k', { owner: '沈砚' });
  assert.equal(migrateMemoryChange(v2, 2), v2);
});

test('new fields validate and hints reach the summary schema but not injected text', () => {
  assert.doesNotThrow(() => validateMemoryChanges([up('clues', '传闻', { basis: '某人说法', knownBy: '阿青', people: '沈砚' })]));
  assert.match(memorySchemaForPrompt().inventory.holder, /此刻在谁手上/);
  const chat = chatOf('沈砚出场。');
  const db = buildMemoryDatabase([record(chat, 0, MEMORY_VERSION, [up('tasks', '送信', { name: '送信', participants: '沈砚', state: '进行中' })])], chat);
  const { text } = selectMemoryDatabase(db, { query: '沈砚', all: true });
  assert.match(text, /进度：进行中/);
  assert.doesNotMatch(text, /已完成／已取消/);
});

test('borrowed items, participant tasks and related clues follow the people in scene; closed tasks yield', () => {
  const chat = chatOf('沈砚在西廊。');
  const db = buildMemoryDatabase([record(chat, 0, MEMORY_VERSION, [
    up('characters', '沈砚', { name: '沈砚', location: '西廊' }),
    up('inventory', '阿青:钥匙', { name: '钥匙', owner: '阿青', holder: '沈砚' }),
    up('tasks', '旧约', { name: '旧约', participants: '沈砚、阿青', state: '已完成' }),
    up('tasks', '新约', { name: '新约', participants: '沈砚', state: '进行中' }),
    up('clues', '传闻', { name: '传闻', people: '沈砚', basis: '猜测' }),
  ])], chat);
  const { records } = selectMemoryDatabase(db, { query: '沈砚' });
  const ids = records.map((row) => row.id);
  assert.ok(ids.includes('阿青:钥匙'));
  assert.ok(ids.includes('传闻'));
  assert.ok(ids.indexOf('新约') < ids.indexOf('旧约'), 'open agreements outrank finished ones');
});
