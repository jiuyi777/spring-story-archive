import { MEMORY_TABLES } from '../core/memory-database.js?v=0.7.1';

export function renderMemoryDatabase(root, database, { force = false, add = false } = {}) {
  const list = root.querySelector('[data-role="memory-rows"]');
  const selector = root.querySelector('[data-role="memory-table-select"]');
  if (!list || !selector) return;
  if (!force && list.contains(document.activeElement)) return;
  if (!selector.options.length) {
    for (const [id, schema] of Object.entries(MEMORY_TABLES)) selector.append(new Option(schema.label, id));
    selector.value = 'characters';
  }
  const table = selector.value || 'scene';
  const schema = MEMORY_TABLES[table];
  const addButton = root.querySelector('[data-action="add-memory-row"]');
  if (addButton) addButton.hidden = table === 'events';
  const query = root.querySelector('[data-role="memory-search"]')?.value.trim().toLocaleLowerCase() || '';
  const rows = [...(database?.tables?.[table] ?? [])].filter((row) => !query || Object.values(row.values).join(' ').toLocaleLowerCase().includes(query));
  const openIds = new Set([...list.querySelectorAll('[data-memory-row][open]')].map((row) => row.dataset.memoryRow));
  if (add) rows.push({ id: '', values: {}, floorIndex: -1 });
  list.replaceChildren();
  root.querySelector('[data-role="memory-status"]').textContent = `本表 ${rows.length} 条 · 已整理 ${database?.updatedFloors ?? 0} 楼${database?.pendingFloors ? ` · ${database.pendingFloors} 楼旧摘要可补全为表格记忆` : ''}`;
  if (!rows.length) {
    const empty = document.createElement('p');
    empty.className = 'ssa-muted';
    empty.textContent = '暂未记录这类事实。新剧情入档后自动更新，也可以手动添加。';
    list.append(empty);
  }
  for (const row of rows) {
    const entry = document.createElement('details');
    entry.className = 'ssa-memory-row';
    entry.dataset.memoryRow = row.id;
    entry.dataset.memoryTable = table;
    entry.open = !row.id || openIds.has(row.id);
    const title = document.createElement('summary');
    title.textContent = row.values.name || (table === 'scene' ? row.values.location || '当前情境' : table === 'relationships' ? `${row.values.from ?? ''} → ${row.values.to ?? ''}` : row.values.summary?.slice(0, 45)) || row.id || '新增条目';
    const source = document.createElement('small');
    source.textContent = row.floorIndex >= 0 ? `来源：第 ${row.floorIndex + 1} 楼及已保存的修订` : '保存后加入当前聊天记忆';
    entry.append(title, source);
    const facts = document.createElement('div'); facts.className = 'ssa-memory-facts';
    facts.textContent = Object.entries(row.values).filter(([,value]) => value).map(([key,value]) => `${schema.fields[key]}：${value}`).join('\n');
    if (table === 'characters') {
      const owned = (database?.tables?.inventory ?? []).filter((item) => [row.id, row.values.name].includes(item.values.owner));
      const related = (database?.tables?.relationships ?? []).filter((item) => [item.values.from, item.values.to].some((name) => [row.id, row.values.name].includes(name)));
      if (owned.length) facts.textContent += '\n持有物品：' + owned.map((item) => `${item.values.name} ${item.values.quantity || ''}`).join('、');
      if (related.length) facts.textContent += '\n关联关系：' + related.map((item) => `${item.values.from} → ${item.values.to}：${item.values.relation || item.values.state || ''}`).join('；');
    }
    entry.append(facts);
    const editor = document.createElement('details'); editor.className = 'ssa-memory-editor'; editor.open = !row.id;
    const editTitle = document.createElement('summary'); editTitle.textContent = '编辑这条记忆'; editor.append(editTitle); entry.append(editor);
    for (const [field, label] of Object.entries(schema.fields)) {
      const wrap = document.createElement('label');
      wrap.textContent = label;
      const input = document.createElement('textarea');
      input.dataset.memoryField = field;
      input.rows = 2;
      input.maxLength = 2400;
      input.value = row.values[field] ?? '';
      wrap.append(input);
      editor.append(wrap);
    }
    const actions = document.createElement('div');
    actions.className = 'ssa-api-profile-actions';
    for (const [action, label] of [['save-memory-row', '保存记忆'], ...(row.id ? [['remove-memory-row', '移除此条']] : [])]) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'ssa-secondary-button';
      button.dataset.action = action; button.textContent = label;
      actions.append(button);
    }
    editor.append(actions); list.append(entry);
    if (!row.id) entry.querySelector('textarea')?.focus();
  }
}

export function collectMemoryEdit(entry) {
  if (!entry) throw new Error('没有找到要保存的记忆条目。');
  const values = Object.fromEntries([...entry.querySelectorAll('[data-memory-field]')].map((input) => [input.dataset.memoryField, input.value.trim()]));
  if (!Object.values(values).some(Boolean)) throw new Error('请先填写至少一项事实。');
  const table = entry.dataset.memoryTable;
  const id = entry.dataset.memoryRow || (table === 'scene' ? 'current' : [values.owner, values.name || values.from, values.to].filter(Boolean).join(':') || `manual:${crypto.randomUUID()}`);
  return { table, id, operation: 'upsert', values };
}
