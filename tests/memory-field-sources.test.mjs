import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMemoryDatabase, formatMemoryDatabase, memorySchemaForPrompt, selectMemoryDatabase, MEMORY_VERSION } from '../core/memory-database.js';
import { buildStoryContext } from '../core/story-context.js';
import { fingerprintMessage } from '../core/privacy-payload.js';
import { requestFloorSummaries } from '../core/api-client.js';

const up = (table, id, values) => ({ table, id, values });
const record = (chat, floorIndex, memoryChanges) => ({ floorIndex, status: 'ready', inputComplete: true, memoryVersion: MEMORY_VERSION,
  messageFingerprint: fingerprintMessage(chat[floorIndex], floorIndex), summary: chat[floorIndex].mes, memoryChanges });

function loanFixture() {
  const chat = [
    { name: '旁白', mes: '林青与沈砚在旧书房，铜钥匙在林青腰包中。' },
    { name: '玩家', is_user: true, mes: '林青把铜钥匙借给沈砚。' },
    { name: '旁白', mes: '林青取出铜钥匙交到沈砚手里。' },
    { name: '旁白', mes: '林青又名阿青，仍与沈砚在旧书房。' },
  ];
  // Matches the host's first organizing response: the old character prose
  // duplicates inventory, while the later transfer changes inventory only.
  const records = [
    record(chat, 0, [
      up('scene', 'current', { location: '旧书房', situation: '林青随身带着铜钥匙' }),
      up('characters', '林青', { name: '林青', location: '旧书房', appearance: '穿灰衣', state: '身上带着一把铜钥匙，放在腰包中' }),
      up('characters', '沈砚', { name: '沈砚', location: '旧书房' }),
      up('inventory', '铜钥匙', { name: '铜钥匙', owner: '林青', holder: '林青', quantity: '1', place: '林青腰包' }),
    ]),
    record(chat, 1, [up('inventory', '铜钥匙', { holder: '沈砚', place: '沈砚衣袋' }), up('characters', '沈砚', { state: '从林青处借得铜钥匙' })]),
    record(chat, 2, []),
    record(chat, 3, [up('characters', '林青', { name: '林青', aliases: '阿青' })]),
  ];
  return { chat, records };
}

test('outgoing memory separates earlier observations from current ownership without internal metadata', () => {
  const { chat, records } = loanFixture();
  const original = structuredClone(records);
  const memory = buildMemoryDatabase(records, chat);
  const lin = memory.tables.characters.find(row => row.id === '林青');
  assert.equal(lin.floorIndex, 3);
  assert.equal(lin.fieldSources.name, 3);
  assert.equal(lin.fieldSources.state, 0, 'a later name update must not make the old state look freshly confirmed');
  assert.equal(lin.fieldSources.appearance, 0);
  assert.equal(memory.tables.inventory[0].fieldSources.owner, 0);
  assert.equal(memory.tables.inventory[0].fieldSources.holder, 1);
  const plan = buildStoryContext({ sourceChat: chat, promptChat: chat.map((row, index) => ({ ...row, index })), summaries: records, checkpoints: [], contextSize: 32000, memoryBudget: 4000, type: 'normal' });
  assert.match(plan.prompt, /所有者：林青；当前持有者：沈砚/);
  assert.match(plan.prompt, /此前状态：身上带着一把铜钥匙，放在腰包中/);
  assert.match(plan.prompt, /此前情境：林青随身带着铜钥匙/);
  assert.doesNotMatch(plan.prompt, /当前状态：身上带着一把铜钥匙/);
  assert.doesNotMatch(plan.prompt, /起记录|专表|第\s*\d+\s*楼/);
  assert.match(formatMemoryDatabase(memory, { budget: 4000, includeIds: true }), /此前状态：身上带着一把铜钥匙/);
  assert.deepEqual(records, original, 'projection and formatting preserve the archived model output');
});

test('explicitly clearing duplicated prose retains unrelated fields and survives later name updates', () => {
  const { chat, records } = loanFixture();
  chat.push({ name: '旁白', mes: '人物用品以物品记录为准。' }, { name: '旁白', mes: '林青穿着灰衣。' });
  records.push(record(chat, 4, [up('characters', '林青', { state: '' }), up('scene', 'current', { situation: '' })]), record(chat, 5, [up('characters', '林青', { name: '林青' })]));
  const memory = buildMemoryDatabase(records, chat);
  const lin = memory.tables.characters.find(row => row.id === '林青');
  assert.equal(lin.values.state, '');
  assert.equal(lin.fieldSources.state, 4);
  assert.equal(lin.fieldSources.name, 5);
  assert.equal(lin.values.appearance, '穿灰衣');
  assert.equal(memory.tables.inventory[0].values.holder, '沈砚');
  const selected = selectMemoryDatabase(memory, { query: '林青沈砚铜钥匙', budget: 4000 });
  assert.doesNotMatch(selected.text, /身上带着一把铜钥匙|情境记录/);
  assert.match(selected.text, /外貌：穿灰衣/);
});

test('manual injuries retain their own source and stay in memory until explicitly updated', () => {
  const { chat, records } = loanFixture();
  const edits = [{ ...up('characters', '林青', { state: '左臂包扎，行动不便' }), schemaVersion: MEMORY_VERSION, floorIndex: 2 }];
  const memory = buildMemoryDatabase(records, chat, edits);
  const lin = memory.tables.characters.find(row => row.id === '林青');
  assert.equal(lin.fieldSources.state, 2);
  assert.equal(lin.fieldSources.name, 3);
  assert.equal(lin.values.state, '左臂包扎，行动不便');
  assert.match(selectMemoryDatabase(memory, { query: '林青', budget: 4000 }).text, /；状态：左臂包扎，行动不便/);
  assert.doesNotMatch(formatMemoryDatabase(memory, { budget: 4000, all: true }), /已失效|已过期/);
  const earlier = buildMemoryDatabase(records, chat, edits, { throughFloor: 1 });
  assert.equal(earlier.tables.characters.find(row => row.id === '林青').fieldSources.state, 0);
});

test('editing or deleting source floors replays values and field sources together', () => {
  const { chat, records } = loanFixture();
  chat.push({ name: '旁白', mes: '林青收回钥匙，不再等待归还。' });
  records.push(record(chat, 4, [up('characters', '林青', { state: '' }), up('inventory', '铜钥匙', { holder: '林青' })]));
  assert.equal(buildMemoryDatabase(records, chat).tables.characters.find(row => row.id === '林青').fieldSources.state, 4);
  for (const changedChat of [chat.slice(0, -1), [...chat.slice(0, -1), { name: '旁白', mes: '沈砚仍然持有铜钥匙。' }]]) {
    const memory = buildMemoryDatabase(records, changedChat);
    assert.equal(memory.tables.characters.find(row => row.id === '林青').fieldSources.state, 0);
    assert.equal(memory.tables.inventory[0].values.holder, '沈砚');
    assert.equal(memory.tables.inventory[0].fieldSources.holder, 1);
  }
});

test('old quantity descriptions keep their source when quantity is updated independently', () => {
  const chat = [{ mes: '林青有三粒药丸。' }, { mes: '林青吃下一粒，还剩两粒。' }];
  const memory = buildMemoryDatabase([
    record(chat, 0, [up('inventory', '药丸', { name: '药丸', owner: '林青', quantity: '3', state: '剩余三粒，暂时未用' })]),
    record(chat, 1, [up('inventory', '药丸', { quantity: '2' })]),
  ], chat);
  const text = selectMemoryDatabase(memory, { query: '药丸', budget: 1000 }).text;
  assert.match(text, /数量：2/);
  assert.match(text, /此前状况：剩余三粒，暂时未用/);
  assert.equal(memory.tables.inventory[0].fieldSources.quantity, 1);
  assert.equal(memory.tables.inventory[0].fieldSources.state, 0);
});

test('summary instructions and field hints keep changing facts in their authoritative fields', async () => {
  const schema = memorySchemaForPrompt();
  assert.match(schema.characters.state, /个人身体、情绪及正在做的事/);
  assert.match(schema.scene.situation, /现场局势与环境/);
  assert.match(schema.inventory.state, /归属、持有者、数量、位置分别填写专用字段/);
  let prompt;
  await requestFloorSummaries(async ({ messages }) => {
    prompt = messages[0].content;
    return { floors: [{ floor: 1, summary: '林青把钥匙借给沈砚。', changes: [] }] };
  }, { targetFloors: [{ floor: 1, text: '林青把钥匙借给沈砚。' }], memorySchema: schema });
  assert.match(prompt, /每项可变事实只在对应专用字段保存一份/);
  assert.match(prompt, /从该楼起持续有效，直到有明确更新/);
  assert.match(prompt, /同一事实冲突时，以对应专用字段及较新楼层为准/);
  assert.match(prompt, /同批按原楼号依次检查变更/);
  assert.match(prompt, /空字符串明确清空该字段，保留其他个人状态/);
  assert.match(prompt, /省略字段表示保留/);
  assert.match(prompt, /在 inventory 中，借出/);
});

test('a later scene change keeps old location descriptions in the past', () => {
  const chat = [{ mes: '林青在庭院等候开门。' }, { mes: '八点到了，林青走进旧书房。' }];
  const memory = buildMemoryDatabase([
    record(chat, 0, [
      up('scene', 'current', { time: '傍晚', location: '庭院', situation: '众人仍在庭院等候' }),
      up('characters', '林青', { name: '林青', location: '庭院', state: '在庭院等候开门' }),
    ]),
    record(chat, 1, [up('scene', 'current', { time: '晚八点', location: '旧书房' }), up('characters', '林青', { location: '旧书房' })]),
  ], chat);
  const text = formatMemoryDatabase(memory, { query: '林青', budget: 1000 });
  assert.match(text, /时间：晚八点；地点：旧书房；此前情境：众人仍在庭院等候/);
  assert.match(text, /所在地点：旧书房；此前状态：在庭院等候开门/);
  assert.doesNotMatch(text, /起记录|专表|第\s*\d+\s*楼/);
});
