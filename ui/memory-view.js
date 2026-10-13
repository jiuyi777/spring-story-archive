import { MEMORY_TABLES, MEMORY_FIELD_HINTS } from '../core/memory-database.js?v=0.7.2';

// One short line under each entry title, so a list can be scanned without opening rows.
const SUBTITLE = {
  player: (v) => [v.kind, v.content].filter(Boolean).join('：'),
  scene: (v) => v.time,
  characters: (v) => [v.location, v.state].filter(Boolean).join('，'),
  relationships: (v) => v.relation || v.state,
  inventory: (v) => v.holder && v.owner && v.holder !== v.owner ? `在${v.holder}手上，归${v.owner}` : v.holder ? `在${v.holder}手上` : v.place,
  skills: (v) => [v.owner, v.available].filter(Boolean).join('，'),
  tasks: (v) => [v.state, v.deadline].filter(Boolean).join('，'),
  clues: (v) => [v.basis, v.state].filter(Boolean).join('，'),
  events: () => '',
};

// 人物 and 玩家 have their own pages, so the database page leaves them out.
const OWN_PAGES = new Set(['characters', 'player']);
const DATABASE_TABLES = Object.keys(MEMORY_TABLES).filter((id) => !OWN_PAGES.has(id));

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const titleOf = (table, row) => (table === 'player' ? row.values.topic : '') || row.values.name
  || (table === 'scene' ? row.values.location || '当前情境'
    : table === 'relationships' ? `${row.values.from ?? ''} 与 ${row.values.to ?? ''}`
      : row.values.summary?.slice(0, 45))
  || row.id || '新条目';

const growTextarea = (input) => { input.style.height = 'auto'; input.style.height = `${input.scrollHeight}px`; };

function renderChips(root, selector, database) {
  let chips = root.querySelector('[data-role="memory-table-chips"]');
  if (!chips) {
    chips = el('div', 'ssa-table-chips');
    chips.dataset.role = 'memory-table-chips';
    chips.setAttribute('role', 'tablist');
    chips.setAttribute('aria-label', '记忆分类');
    const label = selector.closest('label');
    label.classList.add('ssa-visually-hidden');
    label.before(chips);
    chips.addEventListener('click', (event) => {
      const chip = event.target.closest('[data-table]');
      if (!chip || selector.value === chip.dataset.table) return;
      selector.value = chip.dataset.table;
      chip.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
      selector.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }
  chips.replaceChildren();
  for (const id of DATABASE_TABLES) {
    const schema = MEMORY_TABLES[id];
    const chip = el('button', 'ssa-table-chip');
    chip.type = 'button';
    chip.dataset.table = id;
    chip.setAttribute('role', 'tab');
    chip.setAttribute('aria-selected', String(selector.value === id));
    chip.append(el('span', '', schema.label), el('span', 'ssa-chip-count', String(database?.tables?.[id]?.length ?? 0)));
    chips.append(chip);
  }
}

function factGrid(pairs) {
  const grid = el('dl', 'ssa-fact-grid');
  for (const [label, value] of pairs) grid.append(el('dt', '', label), el('dd', '', value));
  return grid;
}

export function renderMemoryDatabase(root, database, { force = false, add = false } = {}) {
  const list = root.querySelector('[data-role="memory-rows"]');
  const selector = root.querySelector('[data-role="memory-table-select"]');
  if (!list || !selector) return;
  if (!force && list.contains(document.activeElement)) return;
  if (!selector.options.length) {
    for (const id of DATABASE_TABLES) selector.append(new Option(MEMORY_TABLES[id].label, id));
    selector.value = 'scene';
  }
  renderChips(root, selector, database);
  const table = selector.value || 'scene';
  const schema = MEMORY_TABLES[table];
  const addButton = root.querySelector('[data-action="add-memory-row"]');
  if (addButton) { addButton.hidden = table === 'events'; addButton.textContent = `添加${schema.label.slice(-2)}`; }
  const query = root.querySelector('[data-role="memory-search"]')?.value.trim().toLocaleLowerCase() || '';
  const rows = [...(database?.tables?.[table] ?? [])].filter((row) => !query || Object.values(row.values).join(' ').toLocaleLowerCase().includes(query));
  const openIds = new Set([...list.querySelectorAll('[data-memory-row][open]')].map((row) => row.dataset.memoryRow));
  if (add) rows.push({ id: '', values: {}, floorIndex: -1 });
  list.replaceChildren();
  root.querySelector('[data-role="memory-status"]').textContent = `${query ? `找到 ${rows.length} 条` : `共 ${rows.length} 条`}，已整理到第 ${database?.updatedFloors ?? 0} 楼${database?.pendingFloors ? `，另有 ${database.pendingFloors} 楼可补全` : ''}`;
  if (!rows.length) {
    list.append(el('p', 'ssa-memory-empty', query ? '没有符合搜索的条目。' : '还没有这类记录。新剧情整理后会自动出现，也可以手动添加。'));
  }
  for (const row of rows) {
    const entry = buildMemoryEntry(table, row, database, { open: !row.id || openIds.has(row.id) });
    list.append(entry);
    if (!row.id) entry.querySelector('textarea')?.focus();
  }
}

// One editable record card. Used by the database page and by the home page,
// so an entry is edited the same way wherever it shows up.
export function buildMemoryEntry(table, row, database, { open = false } = {}) {
  const schema = MEMORY_TABLES[table];
  const entry = el('details', 'ssa-memory-row');
  entry.dataset.memoryRow = row.id;
  entry.dataset.memoryTable = table;
  entry.open = open;

  const head = el('summary', 'ssa-memory-head');
  const titleBox = el('span', 'ssa-memory-title');
  titleBox.append(el('strong', '', titleOf(table, row)));
  const subtitle = row.id ? SUBTITLE[table]?.(row.values) : '';
  if (subtitle) titleBox.append(el('small', '', subtitle));
  head.append(titleBox, el('span', 'ssa-source-tag', row.floorIndex >= 0 ? `${row.floorIndex + 1} 楼` : '新'));
  head.title = row.floorIndex >= 0 ? `来源：第 ${row.floorIndex + 1} 楼及之后保存的修改` : '保存后加入当前聊天';
  entry.append(head);

  const pairs = Object.entries(row.values).filter(([field, value]) => value && field !== 'name').map(([field, value]) => [schema.fields[field], value]);
  if (table === 'characters') {
    const names = [row.id, row.values.name];
    const owned = (database?.tables?.inventory ?? []).filter((item) => names.includes(item.values.holder) || names.includes(item.values.owner));
    const related = (database?.tables?.relationships ?? []).filter((item) => [item.values.from, item.values.to].some((name) => names.includes(name)));
    if (owned.length) pairs.push(['相关物品', owned.map((item) => {
      const held = names.includes(item.values.holder), own = names.includes(item.values.owner);
      const note = held && own ? '' : held ? `（借自${item.values.owner || '他人'}）` : `（现在在${item.values.holder || '别处'}）`;
      return `${item.values.name}${item.values.quantity ? ' ×' + item.values.quantity : ''}${note}`;
    }).join('、')]);
    if (related.length) pairs.push(['关系', related.map((item) => {
      const other = names.includes(item.values.from) ? item.values.to : item.values.from;
      return `${other}：${item.values.relation || item.values.state || '有关联'}`;
    }).join('；')]);
  }
  if (pairs.length) entry.append(factGrid(pairs));

  const editor = el('details', 'ssa-memory-editor');
  editor.open = !row.id;
  editor.append(el('summary', 'ssa-edit-toggle', row.id ? '修改' : '填写内容'));
  const fields = el('div', 'ssa-editor-fields');
  for (const [field, label] of Object.entries(schema.fields)) {
    const wrap = el('label', '', label);
    const input = document.createElement('textarea');
    input.dataset.memoryField = field;
    input.rows = 1;
    input.maxLength = 2400;
    input.value = row.values[field] ?? '';
    if (MEMORY_FIELD_HINTS[table]?.[field]) input.placeholder = MEMORY_FIELD_HINTS[table][field];
    input.addEventListener('input', () => growTextarea(input));
    wrap.append(input);
    fields.append(wrap);
  }
  editor.addEventListener('toggle', () => { if (editor.open) fields.querySelectorAll('textarea').forEach(growTextarea); });
  const actions = el('div', 'ssa-editor-actions');
  for (const [action, label, kind] of [['save-memory-row', '保存', 'ssa-primary-button'], ...(row.id ? [['remove-memory-row', '删除这条', 'ssa-text-button is-danger']] : [])]) {
    const button = el('button', kind, label);
    button.type = 'button';
    button.dataset.action = action;
    actions.append(button);
  }
  fields.append(actions);
  editor.append(fields);
  entry.append(editor);
  return entry;
}

// The 人物 and 玩家 pages: one table each, with search and an add button.
export function renderTablePages(root, database, { add = '' } = {}) {
  for (const list of root.querySelectorAll('[data-role="table-rows"]')) {
    const table = list.dataset.table;
    if (!add && list.contains(document.activeElement)) continue;
    const query = root.querySelector(`[data-role="table-search"][data-table="${table}"]`)?.value.trim().toLocaleLowerCase() || '';
    const rows = (database?.tables?.[table] ?? []).filter((row) => !query || Object.values(row.values).join(' ').toLocaleLowerCase().includes(query));
    const openIds = new Set([...list.querySelectorAll('[data-memory-row][open]')].map((row) => row.dataset.memoryRow));
    list.replaceChildren();
    const status = root.querySelector(`[data-role="table-status"][data-table="${table}"]`);
    if (status) status.textContent = query ? `找到 ${rows.length} 条` : `共 ${rows.length} 条`;
    if (add === table) {
      const entry = buildMemoryEntry(table, { id: '', values: {}, floorIndex: -1 }, database, { open: true });
      list.append(entry);
      entry.querySelector('textarea')?.focus();
    }
    if (!rows.length && add !== table) {
      list.append(el('p', 'ssa-memory-empty', query ? '没有符合搜索的条目。'
        : table === 'player' ? '还没有记录。你在聊天里说出喜欢什么、讨厌什么、想要怎样写，整理后会出现在这里，也可以手动添加。'
          : '还没有人物。新剧情整理后会自动出现，也可以手动添加。'));
    }
    for (const row of [...rows].reverse()) list.append(buildMemoryEntry(table, row, database, { open: openIds.has(row.id) }));
  }
}

export function collectMemoryEdit(entry) {
  if (!entry) throw new Error('没有找到要保存的记忆条目。');
  const values = Object.fromEntries([...entry.querySelectorAll('[data-memory-field]')].map((input) => [input.dataset.memoryField, input.value.trim()]));
  if (!Object.values(values).some(Boolean)) throw new Error('请先填写至少一项事实。');
  const table = entry.dataset.memoryTable;
  const id = entry.dataset.memoryRow || (table === 'scene' ? 'current' : table === 'player' ? values.topic : [values.owner, values.name || values.from, values.to].filter(Boolean).join(':')) || `manual:${crypto.randomUUID()}`;
  return { table, id, operation: 'upsert', values };
}
