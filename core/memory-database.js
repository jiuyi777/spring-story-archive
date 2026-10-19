import { estimateTokens, validSummaries, resolveUserName } from './privacy-payload.js?v=0.7.3';

export const MEMORY_VERSION = 2;
// v1 records stay valid: they are migrated when the database is rebuilt, so an
// upgrade never forces every old floor back through the summary API.
export const COMPATIBLE_MEMORY_VERSIONS = [1, 2];
export const isCompatibleMemoryVersion = (version) => COMPATIBLE_MEMORY_VERSIONS.includes(version);
export const MEMORY_TABLES = {
  // The player's own words, kept apart from the story: what they like, refuse,
  // ask for and decide. Always sent first and never dropped for budget.
  player: { label: '玩家', fields: { topic: '主题', kind: '类别', content: '内容', previous: '之前的说法' } },
  scene: { label: '时间地点', fields: { time: '时间', location: '地点', situation: '当前情境' } },
  characters: { label: '人物档案', fields: { name: '姓名', aliases: '别名与称谓', appearance: '外貌', background: '经历', state: '当前状态', location: '所在地点', goal: '当前目标', knowledge: '已知信息与知情范围' } },
  relationships: { label: '人物关系', fields: { from: '人物', to: '关联人物', relation: '关系', state: '当前变化', cause: '变化原因' } },
  inventory: { label: '物品资源', fields: { name: '物品', owner: '所有者', holder: '当前持有者', quantity: '数量', state: '状态或用途', place: '存放地点' } },
  skills: { label: '能力技能', fields: { name: '技能', owner: '拥有者', level: '程度', description: '能力与限制', available: '当前是否可用' } },
  tasks: { label: '任务约定', fields: { name: '任务或约定', owner: '负责人', participants: '参与者', deadline: '期限', state: '进度', next: '下一步' } },
  clues: { label: '线索往事', fields: { name: '线索或往事', detail: '内容', people: '相关人物', basis: '依据', knownBy: '知情者', state: '当前状态' } },
  events: { label: '剧情记录', fields: { summary: '发生的事' } },
};

// Hints guide the summary model and the editor; they never enter injected text.
export const MEMORY_FIELD_HINTS = {
  player: { topic: '例如：恋爱节奏、对林素的态度、战斗描写', kind: '喜欢／讨厌／雷点／要求／决定', content: '按你的原意写', previous: '改口时自动记下旧说法' },
  scene: { time: '当前实际时刻；到点或时间推进时更新，沿用明确日期；约定时间写 tasks.deadline', location: '当前实际所在地点；抵达或换场时更新；计划地点与远处背景不改变当前场景', situation: '现场局势与环境；人物用品、数量及约定详情由对应表记录' },
  characters: { state: '个人身体、情绪及正在做的事；物品持有与约定详情由对应表记录', location: '此人实际所在地点；实际移动才更新，未移动者保持原位置' },
  inventory: { owner: '真正归谁所有；借出、保管不改变', holder: '此刻在谁手上', quantity: '当前剩余数量', place: '物品此刻的存放位置', state: '物品本身的状况与用途；归属、持有者、数量、位置分别填写专用字段' },
  skills: { available: '可用／暂不可用及原因' },
  tasks: { state: '进行中／已完成／已取消', deadline: '约定或任务期限，不代表当前已到该时刻' },
  clues: { basis: '已证实／某人说法／猜测／计划', knownBy: '哪些人知道', state: '未解决／已解决' },
  relationships: { cause: '因为哪件事发生变化' },
};

const splitNames = (value) => (value || '').split(/[、,，;；\n]/).map((name) => name.trim()).filter(Boolean);
const CLOSED_STATE = /已完成|已取消|已结束|已解决|已失效/;
const OBSERVATION_FIELDS = {
  'characters.state': '状态',
  'scene.situation': '情境',
  'inventory.state': '状况',
};

function fieldLabel(table, field, row, fallback, tables) {
  const label = OBSERVATION_FIELDS[`${table}.${field}`];
  if (!label) return fallback;
  const source = row.fieldSources?.[field] ?? row.floorIndex;
  const newer = (entry, fields) => fields.some((key) => Object.hasOwn(entry.values, key) && (entry.fieldSources?.[key] ?? entry.floorIndex) > source);
  // Keep provenance local. When a later concrete fact supersedes a related
  // observation, express the observation as history instead of a current fact.
  const older = table === 'inventory'
    ? newer(row, ['owner', 'holder', 'quantity', 'place'])
    : newer(row, table === 'scene' ? ['time', 'location'] : ['location'])
      || ['inventory', 'tasks'].some((key) => (tables[key] ?? []).some((entry) => entry.values.name
      && row.values[field].includes(entry.values.name)
      && newer(entry, key === 'inventory' ? ['owner', 'holder', 'quantity', 'place'] : ['state', 'next', 'deadline'])));
  return older ? `此前${label}` : label;
}

// v1 had a single inventory "owner" field labelled 持有者 (current holder).
// v2 separates ownership from possession, so the old value becomes holder.
export function migrateMemoryChange(change, version) {
  if (version !== 1 || change?.table !== 'inventory' || !change.values || !Object.hasOwn(change.values, 'owner')) return change;
  const { owner, ...rest } = change.values;
  return { ...change, values: { ...rest, holder: rest.holder ?? owner } };
}

export function validateMemoryChanges(changes, { manual = false } = {}) {
  if (!Array.isArray(changes) || changes.length > 80) throw new Error('记忆更新条目格式不完整。');
  return changes.map((change) => {
    const schema = MEMORY_TABLES[change?.table];
    if (!schema || (!manual && change.table === 'events')) throw new Error('记忆更新包含未知表格。');
    if (typeof change.id !== 'string' || !change.id.trim() || change.id.length > 120 || ['__proto__', 'constructor', 'prototype'].includes(change.id)) throw new Error('记忆条目缺少有效标识。');
    const operation = change.operation ?? 'upsert';
    if (!['upsert', 'delete'].includes(operation)) throw new Error('记忆更新操作无效。');
    const values = {};
    if (operation === 'upsert') {
      if (!change.values || typeof change.values !== 'object' || Array.isArray(change.values)) throw new Error('记忆条目缺少字段。');
      for (const [field, value] of Object.entries(change.values)) {
        if (!Object.hasOwn(schema.fields, field) || typeof value !== 'string' || value.length > 2400) throw new Error('记忆字段格式无效。');
        values[field] = value.trim();
      }
      if (!Object.keys(values).length) throw new Error('记忆更新没有可保存的字段。');
    }
    return { table: change.table, id: change.table === 'scene' ? 'current' : change.id.trim(), operation, values };
  });
}

// Tables are projections of floor-owned facts. Editing/swiping/deleting a source
// invalidates its facts without deleting the original archive or manual edits.
export function buildMemoryDatabase(records, chat, edits = [], { throughFloor = Infinity } = {}) {
  const tables = Object.fromEntries(Object.keys(MEMORY_TABLES).map((key) => [key, new Map()]));
  const ready = validSummaries(records, chat).filter((record) => record.floorIndex <= throughFloor && !chat[record.floorIndex]?.is_system);
  const changes = [];
  for (const record of ready) {
    changes.push({ floorIndex: record.floorIndex, order: 0, change: { table: 'events', id: `floor:${record.floorIndex}`, values: { summary: record.summary } } });
    if (!isCompatibleMemoryVersion(record.memoryVersion)) continue;
    for (const change of record.memoryChanges ?? []) changes.push({ floorIndex: record.floorIndex, order: 0, change: migrateMemoryChange(change, record.memoryVersion) });
  }
  for (const edit of edits) {
    // Edits saved before v2 carry no schemaVersion and use the v1 field meaning.
    if (edit.floorIndex <= throughFloor) changes.push({ floorIndex: edit.floorIndex, order: 1, change: migrateMemoryChange(edit, edit.schemaVersion ?? 1) });
  }
  changes.sort((a, b) => a.floorIndex - b.floorIndex || a.order - b.order);
  for (const { floorIndex, change } of changes) {
    const rows = tables[change.table];
    if (!rows) continue;
    if (change.operation === 'delete') { rows.delete(change.id); continue; }
    const old = rows.get(change.id);
    rows.set(change.id, {
      id: change.id,
      values: { ...(old?.values ?? {}), ...change.values },
      fieldSources: { ...(old?.fieldSources ?? {}), ...Object.fromEntries(Object.keys(change.values ?? {}).map(field => [field, floorIndex])) },
      floorIndex,
    });
  }
  return {
    version: MEMORY_VERSION,
    tables: Object.fromEntries(Object.entries(tables).map(([key, rows]) => [key, [...rows.values()]])),
    updatedFloors: ready.filter((record) => isCompatibleMemoryVersion(record.memoryVersion)).length,
    pendingFloors: ready.filter((record) => !isCompatibleMemoryVersion(record.memoryVersion)).length,
  };
}

export function selectMemoryDatabase(database, { budget = 1600, query = '', includeEvents = false, includeIds = false, all = false, userName = '' } = {}) {
  const tables = database?.tables ?? {};
  const location = tables.scene?.[0]?.values.location;
  const named = (row) => [row.id, row.values.name, ...(row.values.aliases || '').split(/[、,，;；\n]/)].filter((name) => name?.trim().length >= 2);
  const mentioned = (row) => named(row).some((name) => query.includes(name.trim()));
  const people = (tables.characters ?? []).filter((row) => mentioned(row) || (location && row.values.location === location));
  const names = new Set(people.flatMap(named));
  const associated = (...values) => values.some((value) => value && [...names].some((name) => value === name || splitNames(value).includes(name)));
  const inventoryByName = new Map();
  for (const row of tables.inventory ?? []) {
    const name = row.values.name?.trim();
    if (name) inventoryByName.set(name, [...(inventoryByName.get(name) ?? []), row]);
  }
  const explicitlyNamed = (value) => typeof value === 'string' && value.trim().length >= 2 && query.includes(value.trim());
  const qualifiedInventoryId = (row) => row.id !== row.values.name?.trim() && explicitlyNamed(row.id);
  const relatedInventory = (row) => qualifiedInventoryId(row)
    || associated(row.values.holder, row.values.owner)
    || [row.values.holder, row.values.owner].flatMap(value => splitNames(value)).some(explicitlyNamed)
    || (row.values.place && (row.values.place === location || explicitlyNamed(row.values.place)));
  const inventoryMention = (row) => {
    if (!mentioned(row)) return '';
    const sameName = inventoryByName.get(row.values.name?.trim()) ?? [];
    if (sameName.length < 2 || qualifiedInventoryId(row)) return '近期正文明确提及';
    const related = sameName.filter(relatedInventory);
    if (related.length) return related.includes(row) ? '同名物品按人物或地点匹配' : '';
    // With no entity evidence, retain the bounded alternatives without claiming
    // that a shared name identifies one particular owner's item.
    return '同名物品，指代待确认';
  };
  const latestFloor = Math.max(-1, ...Object.values(tables).flat().map((row) => row.floorIndex));
  const candidates = [];
  for (const [table, schema] of Object.entries(MEMORY_TABLES)) {
    if (table === 'events' && !includeEvents) continue;
    for (const row of tables[table] ?? []) {
      let reason = '', priority = 0;
      const directMention = table === 'inventory' ? inventoryMention(row) : mentioned(row) ? '近期正文明确提及' : '';
      if (all) { reason = '已有状态参考'; priority = 1; }
      if (table === 'player') { reason = '玩家说过的话'; priority = 1000; }
      else if (table === 'scene') { reason = '当前场景'; priority = 100; }
      else if (directMention) { reason = directMention; priority = directMention === '同名物品，指代待确认' ? 55 : 90; }
      else if (table === 'characters' && people.includes(row)) { reason = '当前地点的人物'; priority = 80; }
      else if (table === 'relationships' && (associated(row.values.from) || associated(row.values.to))) { reason = '相关人物的关系'; priority = 65; }
      else if (table === 'inventory' && associated(row.values.holder, row.values.owner)) { reason = '相关人物持有或拥有'; priority = 70; }
      else if (table === 'skills' && associated(row.values.owner)) { reason = '相关人物的能力'; priority = 70; }
      else if (table === 'tasks' && associated(row.values.owner, row.values.participants)) { reason = '相关人物参与的任务或约定'; priority = 70; }
      else if (table === 'clues' && associated(row.values.people, row.values.knownBy)) { reason = '与相关人物有关的线索'; priority = 62; }
      else if (['clues', 'events', 'tasks'].includes(table) && [...names, location].filter(Boolean).some((name) => Object.values(row.values).some((value) => value.includes(name)))) { reason = '与当前人物或地点有关'; priority = 60; }
      if (!reason && ['tasks', 'clues'].includes(table) && row.floorIndex >= latestFloor - 2) { reason = '近期剧情更新的任务或线索'; priority = 50; }
      if (!reason) continue;
      // Finished or cancelled items stay in the database but yield to open ones.
      if (['tasks', 'clues'].includes(table) && CLOSED_STATE.test(row.values.state || '')) priority -= 30;
      // Free-text observations retain their own source even when another field
      // was updated later. Current structured facts remain separately readable.
      const facts = Object.entries(row.values).filter(([, value]) => value).map(([field, value]) => `${fieldLabel(table, field, row, schema.fields[field], tables)}：${value}`).join('；');
      if (!facts) continue;
      const label = table === 'player' ? resolveUserName(userName) : schema.label;
      candidates.push({ table, id: row.id, label: schema.label, text: facts, reason, priority, floorIndex: row.floorIndex,
        line: `【${label}${includeIds ? ` / ${row.id}` : ''}】${facts}` });
    }
  }
  const blocks = [];
  const records = [];
  let used = 0;
  for (const row of candidates.sort((a, b) => b.priority - a.priority || b.floorIndex - a.floorIndex)) {
      const cost = estimateTokens(row.line + '\n');
      if (used + cost > budget && row.table !== 'player') continue;
      blocks.push(row.line);
      records.push(row);
      used += cost;
  }
  return { text: blocks.join('\n'), records };
}

export function formatMemoryDatabase(database, options = {}) {
  return selectMemoryDatabase(database, { ...options, all: options.all ?? Boolean(options.includeIds) }).text;
}

export function memorySchemaForPrompt() {
  return Object.fromEntries(Object.entries(MEMORY_TABLES).filter(([table]) => table !== 'events').map(([table, schema]) => [table,
    Object.fromEntries(Object.entries(schema.fields).map(([field, label]) => [field, MEMORY_FIELD_HINTS[table]?.[field] ? `${label}（${MEMORY_FIELD_HINTS[table][field]}）` : label]))]));
}

export function applyNarrativeEdits(records, edits = [], throughFloor = Infinity) {
  const rows = new Map(records.map((record) => [`floor:${record.floorIndex}`, { ...record }]));
  for (const edit of [...edits].sort((a, b) => a.floorIndex - b.floorIndex)) {
    if (edit.table !== 'events' || edit.floorIndex > throughFloor) continue;
    const record = rows.get(edit.id);
    if (!record) continue;
    if (edit.operation === 'delete') rows.delete(edit.id);
    else if (edit.values?.summary?.trim()) {
      record.summary = edit.values.summary.trim();
      // The replacement is authoritative; stale derived prose must not re-enter recall.
      for (const field of ['timeline', 'characters', 'relationships', 'clues']) record[field] = [];
    }
  }
  return [...rows.values()];
}
