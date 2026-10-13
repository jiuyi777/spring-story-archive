// Home page: the exact request the host sent to the model, message by message,
// like a prompt inspector. Each message is labelled with where it came from;
// 春序's own blocks open their memory records for editing, and chat floors
// can be edited in place (an explicit edit by the player).
import { buildMemoryEntry } from './memory-view.js?v=0.7.2';

const ROLE = { system: '系统', user: '用户', assistant: '助手', tool: '工具', developer: '开发者', prompt: '整段提示词' };
const MARK = {
  story: ['【春序档案 · 剧情总摘要】', '春序 · 记忆与小结'],
  recall: ['【春序档案 · 语义回忆】', '春序 · 向量回忆'],
  options: ['【剧情选项】', '春序 · 剧情选项'],
  advance: ['【剧情推进】', '春序 · 自主推进'],
};

let view = { recordKey: '', query: '', open: new Set() };
const tokenCache = new Map();

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const squash = (text) => String(text ?? '').replace(/\s+/g, '');

export function selectRecord(key) { view = { ...view, recordKey: key, open: new Set() }; }
export function setPromptQuery(query) { view = { ...view, query: String(query ?? '') }; }

// Which chat floor a message carries: the first 24 visible characters of the
// floor's text (after the player's regex) appear in the message content.
export function locateFloors(messages, floorTexts) {
  const keys = floorTexts.map((text, floorIndex) => ({ floorIndex, key: squash(text).slice(0, 24) })).filter((item) => item.key.length >= 6);
  return messages.map((message) => {
    const content = squash(message.content);
    for (let index = keys.length - 1; index >= 0; index -= 1) if (content.includes(keys[index].key)) return keys[index].floorIndex;
    return null;
  });
}

export function sourceOf(message, floorIndex) {
  const tags = Object.entries(MARK).filter(([, [marker]]) => message.content.includes(marker)).map(([kind, [, label]]) => ({ kind, label }));
  if (tags.length) return tags;
  if (Number.isInteger(floorIndex)) return [{ kind: 'floor', label: `聊天第 ${floorIndex + 1} 楼` }];
  return [{ kind: 'host', label: message.role === 'system' ? '预设 / 角色卡 / 世界书' : '其他' }];
}

function tokensOf(text, countTokens) {
  const key = `${text.length}:${text.slice(0, 40)}:${text.slice(-40)}`;
  if (!tokenCache.has(key)) tokenCache.set(key, Promise.resolve(countTokens(text)));
  return tokenCache.get(key);
}

// Hide rows that do not contain the query, without rebuilding the list.
export function filterPromptRows(root, query) {
  view = { ...view, query: String(query ?? '') };
  const needle = view.query.trim();
  for (const row of root.querySelectorAll('[data-role="prompt-viewer"] .ssa-prompt-list > li')) {
    row.hidden = Boolean(needle) && !row.querySelector('.ssa-prompt-text')?.textContent.includes(needle);
  }
}

function floorEditor(floorIndex, chatText) {
  const box = el('div', 'ssa-floor-editor');
  box.append(el('span', 'ssa-floor-editor-label', `第 ${floorIndex + 1} 楼原文（修改会写入聊天记录，并重新整理这一楼）`));
  const input = document.createElement('textarea');
  input.rows = Math.min(10, Math.max(3, Math.ceil(chatText.length / 24)));
  input.value = chatText;
  const save = el('button', 'ssa-secondary-button', '保存原文');
  save.type = 'button';
  save.dataset.action = 'save-floor-text';
  save.dataset.floor = String(floorIndex);
  box.append(input, save);
  return box;
}

export function renderPromptViewer(root, { records = [], chat = [], floorTexts = [], database = null, countTokens }) {
  const host = root.querySelector('[data-role="prompt-viewer"]');
  if (!host) return;
  if (host.contains(document.activeElement) && document.activeElement.tagName === 'TEXTAREA') return;
  const withPrompt = [...records].filter((record) => Array.isArray(record.finalPrompt)).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const record = withPrompt.find((item) => item.key === view.recordKey) ?? withPrompt[0];
  for (const details of host.querySelectorAll('.ssa-prompt-msg[open]')) view.open.add(details.dataset.position);
  host.replaceChildren();

  const head = el('div', 'ssa-prompt-head');
  head.append(el('h3', 'ssa-round-title', '实际发出的提示词'));
  if (withPrompt.length > 1) {
    const picker = document.createElement('select');
    picker.dataset.role = 'prompt-record';
    picker.setAttribute('aria-label', '选择一次发送');
    for (const item of withPrompt) {
      const when = new Date(item.startedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      picker.append(new Option(`第 ${item.targetFloor} 楼${item.type === 'swipe' ? '（重新生成）' : ''} · ${when}`, item.key));
    }
    picker.value = record.key;
    head.append(picker);
  }
  host.append(head);

  if (!record) {
    host.append(el('p', 'ssa-memory-empty', '还没有记录到发出的请求。下次生成回复后，这里会逐条显示酒馆真正交给模型的全部内容。'));
    return;
  }

  const messages = record.finalPrompt;
  const floors = locateFloors(messages, floorTexts);
  const summary = el('p', 'ssa-round-summary');
  const totalNode = el('span', '', '…');
  summary.append(`共 ${messages.length} 条消息，合计 `, totalNode, ' token');
  if (record.budget) summary.append(`；春序带入 ${(record.budget.story + record.budget.recall).toLocaleString()} / 上限 ${record.budget.limit.toLocaleString()}`);
  if (record.budget?.dropped?.duplicate) summary.append(`，跳过 ${record.budget.dropped.duplicate} 段重复回忆`);
  if (record.budget?.dropped?.budget) summary.append(`，${record.budget.dropped.budget} 段回忆因额度没带`);
  host.append(summary);

  const search = document.createElement('input');
  search.type = 'search';
  search.placeholder = '在这次请求里查找';
  search.value = view.query;
  search.dataset.role = 'prompt-search';
  const searchBox = el('label', 'ssa-search');
  searchBox.append(el('span', 'ssa-visually-hidden', '查找'), search);
  host.append(searchBox);

  const list = el('ol', 'ssa-prompt-list');
  messages.forEach((message, position) => {
    const item = el('li');
    const details = el('details', 'ssa-prompt-msg');
    details.dataset.position = String(position);
    details.open = view.open.has(String(position));
    const tags = sourceOf(message, floors[position]);
    if (tags.some((tag) => tag.kind !== 'host' && tag.kind !== 'floor')) details.classList.add('is-chunxu');
    const summaryRow = el('summary', 'ssa-prompt-row');
    summaryRow.append(el('span', 'ssa-prompt-index', String(position + 1)), el('span', 'ssa-prompt-role', ROLE[message.role] ?? message.role));
    const tagBox = el('span', 'ssa-prompt-tags');
    for (const tag of tags) tagBox.append(el('span', `ssa-prompt-tag is-${tag.kind}`, tag.label));
    const tokens = el('span', 'ssa-prompt-tokens', '…');
    summaryRow.append(tagBox, tokens, el('span', 'ssa-prompt-preview', message.content.replace(/\s+/g, ' ').slice(0, 80)));
    details.append(summaryRow);
    const body = el('div', 'ssa-prompt-body');
    body.append(el('pre', 'ssa-prompt-text', message.content || '（空消息）'));
    if (tags.some((tag) => tag.kind === 'story') && record.memories?.length) {
      body.append(el('p', 'ssa-floor-editor-label', '这次带入的资料，改动保存后从下一轮生效：'));
      for (const memory of record.memories) {
        const row = database?.tables?.[memory.table]?.find((entry) => entry.id === memory.id);
        if (row) body.append(buildMemoryEntry(memory.table, row, database));
      }
    }
    if (Number.isInteger(floors[position]) && chat[floors[position]]) body.append(floorEditor(floors[position], String(chat[floors[position]].mes ?? '')));
    details.append(body);
    item.append(details);
    list.append(item);
    void tokensOf(message.content, countTokens).then(({ value, exact }) => { tokens.textContent = `${exact ? '' : '约 '}${value.toLocaleString()}`; });
  });
  host.append(list);
  filterPromptRows(root, view.query);
  void Promise.all(messages.map((message) => tokensOf(message.content, countTokens))).then((values) => {
    const total = values.reduce((sum, item) => sum + item.value, 0);
    totalNode.textContent = `${values.every((item) => item.exact) ? '' : '约 '}${total.toLocaleString()}`;
  });
}
