// Editor for the story-option categories: label, how many, and what each one asks for.
import { MAX_OPTIONS, MAX_LABEL } from '../core/play-prompts.js?v=0.7.3';

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

export function renderOptionSlots(root, slots) {
  const host = root.querySelector('[data-role="option-slots"]');
  if (!host || host.contains(document.activeElement)) return;
  host.replaceChildren();
  const total = slots.reduce((sum, slot) => sum + (Number(slot.count) || 0), 0);
  const counter = root.querySelector('[data-role="option-slot-total"]');
  if (counter) counter.textContent = `一共 ${total} 个${total > MAX_OPTIONS ? `，超过 ${MAX_OPTIONS} 个的部分不会发送` : ''}`;
  slots.forEach((slot, index) => {
    const row = el('div', 'ssa-slot-row');
    row.dataset.slot = String(index);
    const name = el('label', 'ssa-slot-label');
    name.append(el('span', 'ssa-visually-hidden', '类别名'));
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.maxLength = MAX_LABEL;
    nameInput.value = slot.label ?? '';
    nameInput.placeholder = '类别名';
    nameInput.dataset.slotField = 'label';
    name.append(el('span', 'ssa-slot-bracket', '【'), nameInput, el('span', 'ssa-slot-bracket', '】'));
    const count = el('label', 'ssa-slot-count');
    count.append(el('span', 'ssa-visually-hidden', '数量'));
    const countInput = document.createElement('select');
    countInput.dataset.slotField = 'count';
    for (let value = 1; value <= 8; value += 1) countInput.append(new Option(`${value} 个`, String(value)));
    countInput.value = String(Math.min(8, Math.max(1, Number(slot.count) || 1)));
    count.append(countInput);
    const remove = el('button', 'ssa-text-button is-danger', '删除');
    remove.type = 'button';
    remove.dataset.action = 'remove-option-slot';
    const rule = el('label', 'ssa-slot-rule');
    rule.append(el('span', 'ssa-visually-hidden', '要求'));
    const ruleInput = document.createElement('textarea');
    ruleInput.rows = Math.min(6, Math.max(2, Math.ceil(String(slot.rule ?? '').length / 24) + 1));
    ruleInput.maxLength = 400;
    ruleInput.value = slot.rule ?? '';
    ruleInput.placeholder = '这一类要写什么、怎么写、多少字';
    ruleInput.dataset.slotField = 'rule';
    rule.append(ruleInput);
    row.append(name, count, remove, rule);
    host.append(row);
  });
  if (!slots.length) host.append(el('p', 'ssa-memory-empty', '还没有类别。点“添加一类”，或从预设开始。'));
}

export function readSlotEdit(target) {
  const row = target.closest('[data-slot]');
  if (!row) return null;
  return { index: Number(row.dataset.slot), field: target.dataset.slotField, value: target.value };
}
