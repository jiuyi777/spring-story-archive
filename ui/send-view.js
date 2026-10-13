import { buildMemoryEntry } from './memory-view.js?v=0.7.2';
const STATUS = { prepared: '正在准备', verified: '等待回复', received: '已收到回复', stopped: '已停止', ended: '未确认收到回复', interrupted: '未确认收到回复' };
export function renderSendHistory(root, records, database = null) {
  const list = root.querySelector('[data-role="send-records"]');
  if (!list) return;
  const opened = new Set([...list.querySelectorAll('details[open][data-send-key]')].map((node) => node.dataset.sendKey));
  list.replaceChildren();
  if (!records.length) { const p = document.createElement('p'); p.className = 'ssa-empty-state'; p.textContent = '还没有发送记录。下次在酒馆生成回复时自动记录；安装前的请求无法还原。'; list.append(p); return; }
  const text = (tag, value, parent) => { const node = document.createElement(tag); node.textContent = value; parent.append(node); return node; };
  const section = (parent, title, content) => { const details = document.createElement('details'); text('summary', title, details); text('pre', content || '本轮未加入这类内容。', details); parent.append(details); };
  const floors = (items) => items.length ? items.map((floor) => floor + 1).join('、') : '无';
  for (const record of [...records].sort((a, b) => b.startedAt.localeCompare(a.startedAt))) {
    let entry = document.createElement('details'); const card = entry; entry.className = 'ssa-send-record'; entry.dataset.sendKey = record.key; entry.open = opened.has(record.key);
    const title = document.createElement('summary'); title.className = 'ssa-send-head';
    text('span', `#${record.targetFloor}`, title).className = 'ssa-send-floor';
    const main = document.createElement('span'); main.className = 'ssa-send-main'; title.append(main);
    text('strong', record.type === 'swipe' ? '重新生成' : record.type === 'continue' ? '继续生成' : '生成回复', main);
    text('small', new Date(record.startedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }), main);
    title.setAttribute('aria-label', `第 ${record.targetFloor} 楼`);
    const badge = text('span', STATUS[record.status] || '状态未知', title); badge.className = 'ssa-send-status'; badge.dataset.status = record.status;
    entry.append(title);
    const body = document.createElement('div'); body.className = 'ssa-send-body'; entry.append(body);
    entry = body;
    text('h3', '这次带入的记忆', entry);
    if (!(record.memories || []).length) text('p', '没有单独选中的人物或物品记忆。', entry);
    for (const memory of record.memories || []) {
      // Memory rows still in the archive are shown as editable cards; saving
      // changes the archive and takes effect from the next round.
      const row = database?.tables?.[memory.table]?.find((item) => item.id === memory.id);
      if (row) entry.append(buildMemoryEntry(memory.table, row, database));
      else text('p', `${memory.label}：${memory.text}`, entry);
    }
    text('p', (record.includedFloors || []).length ? `还带了第 ${floors(record.includedFloors)} 楼的剧情小结。` : '没有带入楼层小结。', entry);
    section(entry, '查看完整记忆内容', [record.summaryPrompt, record.recallPrompt].filter(Boolean).join('\n\n'));
    const more = document.createElement('details'); text('summary', '更多详情', more); entry.append(more);
    if (record.note) text('p', record.note, more);
    section(more, '为什么选这些记忆', (record.memories || []).map((row) => `${row.label}：${row.reason}`).join('\n\n'));
    section(more, '原文记录', (record.rawFloors || []).map((row) => `【${row.floorIndex === null ? '宿主消息' : `第 ${row.floorIndex + 1} 楼`} · ${row.role}】\n${row.text}`).join('\n\n'));
    text('p', `以小结代替原文的楼层：${floors(record.removedFloors || [])}。`, more);
    text('small', record.verified ? '已在酒馆待发内容中核对记忆。原文记录取自插件处理时，之后可能被其他扩展调整。' : '这里记录的是准备内容，尚未核对最终待发内容。', more);
    list.append(card);
  }
}
