import { estimateTokens, validSummaries } from './privacy-payload.js?v=0.7.1';

export const MEMORY_VERSION = 1;
export const MEMORY_TABLES = {
  scene: { label: '时间地点', fields: { time: '时间', location: '地点', situation: '当前情境' } },
  characters: { label: '人物档案', fields: { name: '姓名', aliases: '别名与称谓', appearance: '外貌', background: '经历', state: '当前状态', location: '所在地点', goal: '当前目标', knowledge: '已知信息与知情范围' } },
  relationships: { label: '人物关系', fields: { from: '人物', to: '关联人物', relation: '关系', state: '当前变化' } },
  inventory: { label: '物品资源', fields: { name: '物品', owner: '持有者', quantity: '数量', state: '状态或用途' } },
  skills: { label: '能力技能', fields: { name: '技能', owner: '拥有者', level: '程度', description: '能力与限制' } },
  tasks: { label: '任务进度', fields: { name: '任务', owner: '执行者', state: '进度', next: '下一步' } },
  clues: { label: '线索约定', fields: { name: '线索或约定', detail: '内容', state: '当前状态' } },
  events: { label: '剧情记录', fields: { summary: '发生的事' } },
};

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
    if (record.memoryVersion !== MEMORY_VERSION) continue;
    for (const change of record.memoryChanges ?? []) changes.push({ floorIndex: record.floorIndex, order: 0, change });
  }
  for (const edit of edits) {
    if (edit.floorIndex <= throughFloor) changes.push({ floorIndex: edit.floorIndex, order: 1, change: edit });
  }
  changes.sort((a, b) => a.floorIndex - b.floorIndex || a.order - b.order);
  for (const { floorIndex, change } of changes) {
    const rows = tables[change.table];
    if (!rows) continue;
    if (change.operation === 'delete') { rows.delete(change.id); continue; }
    const old = rows.get(change.id);
    rows.set(change.id, { id: change.id, values: { ...(old?.values ?? {}), ...change.values }, floorIndex });
  }
  return {
    version: MEMORY_VERSION,
    tables: Object.fromEntries(Object.entries(tables).map(([key, rows]) => [key, [...rows.values()]])),
    updatedFloors: ready.filter((record) => record.memoryVersion === MEMORY_VERSION).length,
    pendingFloors: ready.filter((record) => record.memoryVersion !== MEMORY_VERSION).length,
  };
}

export function selectMemoryDatabase(database, { budget = 1600, query = '', includeEvents = false, includeIds = false, all = false } = {}) {
  const tables = database?.tables ?? {};
  const location = tables.scene?.[0]?.values.location;
  const named = (row) => [row.id, row.values.name, ...(row.values.aliases || '').split(/[、,，;；\n]/)].filter((name) => name?.trim().length >= 2);
  const mentioned = (row) => named(row).some((name) => query.includes(name.trim()));
  const people = (tables.characters ?? []).filter((row) => mentioned(row) || (location && row.values.location === location));
  const names = new Set(people.flatMap(named));
  const associated = (value) => value && [...names].some((name) => value === name || value.split(/[、,，;；]/).includes(name));
  const latestFloor = Math.max(-1, ...Object.values(tables).flat().map((row) => row.floorIndex));
  const candidates = [];
  for (const [table, schema] of Object.entries(MEMORY_TABLES)) {
    if (table === 'events' && !includeEvents) continue;
    for (const row of tables[table] ?? []) {
      let reason = '', priority = 0;
      if (all) { reason = '已有状态参考'; priority = 1; }
      if (table === 'scene') { reason = '当前场景'; priority = 100; }
      else if (mentioned(row)) { reason = '近期正文明确提及'; priority = 90; }
      else if (table === 'characters' && people.includes(row)) { reason = '当前地点的人物'; priority = 80; }
      else if (table === 'relationships' && (associated(row.values.from) || associated(row.values.to))) { reason = '相关人物的关系'; priority = 65; }
      else if (['inventory', 'skills', 'tasks'].includes(table) && associated(row.values.owner)) { reason = '相关人物持有或负责'; priority = 70; }
      else if (['clues', 'events', 'tasks'].includes(table) && [...names, location].filter(Boolean).some((name) => Object.values(row.values).some((value) => value.includes(name)))) { reason = '与当前人物或地点有关'; priority = 60; }
      if (!reason && ['tasks', 'clues'].includes(table) && row.floorIndex >= latestFloor - 2) { reason = '近期剧情更新的任务或线索'; priority = 50; }
      if (!reason) continue;
      const facts = Object.entries(row.values).filter(([, value]) => value).map(([field, value]) => `${schema.fields[field]}：${value}`).join('；');
      if (!facts) continue;
      candidates.push({ table, id: row.id, label: schema.label, text: facts, reason, priority, floorIndex: row.floorIndex,
        line: `【${schema.label}${includeIds ? ` / ${row.id}` : ''}】${facts}` });
    }
  }
  const blocks = [];
  const records = [];
  let used = 0;
  for (const row of candidates.sort((a, b) => b.priority - a.priority || b.floorIndex - a.floorIndex)) {
      const cost = estimateTokens(row.line + '\n');
      if (used + cost > budget) continue;
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
  return Object.fromEntries(Object.entries(MEMORY_TABLES).filter(([table]) => table !== 'events').map(([table, schema]) => [table, schema.fields]));
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
