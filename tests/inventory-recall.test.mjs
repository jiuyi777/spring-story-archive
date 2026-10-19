import test from 'node:test';
import assert from 'node:assert/strict';
import { selectMemoryDatabase, formatMemoryDatabase } from '../core/memory-database.js';

const row = (id, values, floorIndex = 1) => ({ id, values, floorIndex });
const inventoryIds = (database, query) => selectMemoryDatabase(database, { query, budget: 4000 }).records.filter(item => item.table === 'inventory').map(item => item.id);
const fixture = () => ({ tables: {
  scene: [row('current', { location: '花园' })],
  characters: [row('许舟', { name: '许舟', location: '花园' }), row('唐遥', { name: '唐遥', location: '远塔' })],
  inventory: [
    row('许舟:铜钥匙', { name: '铜钥匙', owner: '许舟', holder: '许舟', place: '许舟衣袋' }),
    row('唐遥:铜钥匙', { name: '铜钥匙', owner: '唐遥', holder: '唐遥', place: '唐遥衣袋' }),
    row('远塔:晶石', { name: '碎星晶石', owner: '唐遥', holder: '唐遥', place: '远塔' }),
  ],
} });

test('shared inventory names resolve through current people instead of depending on a model-added name suffix', () => {
  const db = fixture();
  assert.deepEqual(inventoryIds(db, '许舟检查手里的铜钥匙。'), ['许舟:铜钥匙']);
  assert.equal(selectMemoryDatabase(db, { query: '铜钥匙', budget: 4000 }).records.find(item => item.id === '许舟:铜钥匙').reason, '同名物品按人物或地点匹配');
  db.tables.inventory[1].values.name = '唐遥的铜钥匙';
  assert.deepEqual(inventoryIds(db, '许舟检查手里的铜钥匙。'), ['许舟:铜钥匙'], 'qualified and unqualified model naming should produce the same relevant entity');
});

test('an explicitly named remote owner or qualified item id remains retrievable', () => {
  const db = fixture();
  assert.ok(inventoryIds(db, '唐遥的铜钥匙还在他手上吗？').includes('唐遥:铜钥匙'));
  assert.ok(inventoryIds(db, '查找条目 唐遥:铜钥匙').includes('唐遥:铜钥匙'));
  assert.ok(inventoryIds(db, '找到碎星晶石的记录。').includes('远塔:晶石'), 'a unique item name is enough to recall it remotely');
});

test('borrowed shared-name items follow their current holder even when the owner is away', () => {
  const db = fixture();
  db.tables.inventory[1].values.holder = '许舟';
  const ids = inventoryIds(db, '检查许舟身上的铜钥匙。');
  assert.ok(ids.includes('许舟:铜钥匙'));
  assert.ok(ids.includes('唐遥:铜钥匙'));
});

test('place and directly referenced owners can disambiguate without character rows', () => {
  const db = fixture();
  db.tables.characters = [];
  assert.deepEqual(inventoryIds(db, '检查唐遥的铜钥匙。'), ['唐遥:铜钥匙']);
  db.tables.inventory[0].values.place = '花园';
  assert.deepEqual(inventoryIds(db, '检查这里的铜钥匙。'), ['许舟:铜钥匙']);
});

test('unresolved shared names retain alternatives with an honest reason and complete extraction still sees all records', () => {
  const db = fixture();
  db.tables.scene = [];
  db.tables.characters = [];
  const selected = selectMemoryDatabase(db, { query: '铜钥匙在哪里？', budget: 4000 }).records.filter(item => item.table === 'inventory');
  assert.deepEqual(selected.map(item => item.id).sort(), ['唐遥:铜钥匙', '许舟:铜钥匙']);
  assert.ok(selected.every(item => item.reason === '同名物品，指代待确认'));
  const complete = formatMemoryDatabase(fixture(), { query: '许舟的铜钥匙', includeIds: true, budget: 4000 });
  assert.match(complete, /唐遥:铜钥匙/);
  assert.match(complete, /远塔:晶石/);
});
