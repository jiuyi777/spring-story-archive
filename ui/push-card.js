// Home page: what the push will do in the coming round, editable, with
// 换一个 / 这轮不推, the per-chat main-line goal, and what was pushed before.
import { wayLabel } from '../core/advance-plan.js?v=0.7.2';

const SOURCE = {
  api: '整理时安排的',
  player: '你改过的',
  reroll: '换过的',
  history: '沿用这一楼原来的安排',
};

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

function button(label, action, extra = 'ssa-text-button') {
  const node = el('button', extra, label);
  node.type = 'button';
  node.dataset.action = action;
  return node;
}

export function sourceText(round) {
  if (round.source === 'skip') return '这一轮不推进';
  if (round.source === 'local') return round.ways.length ? `按局面挑的：${round.ways.map(wayLabel).join('、')}` : '档案里还没有能用的内容';
  return SOURCE[round.source] ?? '';
}

export function renderPushCard(root, view) {
  const host = root.querySelector('[data-role="push-card"]');
  if (!host) return;
  if (!view?.enabled) { host.hidden = true; host.replaceChildren(); return; }
  if (host.contains(document.activeElement) && ['TEXTAREA', 'INPUT'].includes(document.activeElement.tagName)) return;
  host.hidden = false;
  const { round, text, goal, history = [] } = view;
  const head = el('div', 'ssa-push-head');
  head.append(el('h3', 'ssa-push-title', '下一轮会推'), el('span', 'ssa-push-source', sourceText(round)));
  const parts = [head];
  if (round.source === 'skip') {
    parts.push(el('p', 'ssa-push-skip', '下一次回复不加推进，之后自动恢复。'));
  } else {
    const input = document.createElement('textarea');
    input.dataset.role = 'push-plan';
    input.rows = Math.min(7, Math.max(2, Math.ceil(String(text).length / 19) + String(text).split('\n').length - 1));
    input.value = text;
    input.placeholder = '写下这一轮想让什么发生，例如：沈砚主动提起账本的事';
    input.setAttribute('aria-label', '下一轮推进安排');
    parts.push(input);
  }
  const actions = el('div', 'ssa-push-actions');
  if (round.source !== 'skip') actions.append(button('保存改动', 'save-push-plan'), button('换一个', 'push-reroll'));
  actions.append(button(round.source === 'skip' ? '恢复推进' : '这轮不推', 'push-skip'));
  parts.push(actions);

  const goalBox = el('label', 'ssa-push-goal');
  goalBox.append(el('span', '', '主线目标'));
  const goalInput = document.createElement('input');
  goalInput.type = 'text';
  goalInput.dataset.role = 'push-goal';
  goalInput.value = goal ?? '';
  goalInput.placeholder = '可不填。例：慢慢走到告白；揭开主神空间的秘密';
  goalBox.append(goalInput);
  parts.push(goalBox);

  const done = history.slice(-6).reverse();
  if (done.length) {
    const details = el('details', 'ssa-push-history');
    details.append(el('summary', '', `最近推过（${done.length}）`));
    const list = el('ol');
    for (const entry of done) {
      const item = el('li');
      const what = entry.skipped ? '这轮没推' : entry.plan || (entry.ways ?? []).map(wayLabel).join('、') || '没有可用内容';
      item.append(el('span', 'ssa-push-floor', `第 ${entry.floor + 1} 楼`), el('span', '', what));
      if (entry.event) item.append(el('span', 'ssa-push-event', '用了事件池'));
      list.append(item);
    }
    details.append(list);
    parts.push(details);
  }
  host.replaceChildren(...parts);
}
