// A one-line note under each reply the 八股删除器 touched, with an undo button.
// The note text comes from the extension (describe), so it always matches the
// current swipe. The original text is kept, so undo puts it back.
export function describeCliche(info) {
  if (!info) return '';
  if (info.mode === 'mark') {
    const total = (info.hits ?? []).reduce((sum, hit) => sum + hit.count, 0);
    return total ? `发现八股 ${total} 处：${info.hits.slice(0, 4).map((hit) => `${hit.label}×${hit.count}`).join('、')}` : '';
  }
  if (info.skipped) return '八股删除器：已恢复原文';
  const parts = [];
  if (info.removed) parts.push(`删去 ${info.removed} 处套话`);
  if (info.rewritten) parts.push(`改写 ${info.rewritten} 句`);
  if (!info.rewritten && info.pending) parts.push(`${info.pending} 句等整理时改写`);
  return parts.length ? `八股删除器：${parts.join('，')}，原文已备份` : '';
}

export function createClicheNotes({ describe, onUndo, onRedo, beforeMount = () => {} }) {
  const mount = () => {
    beforeMount();
    for (const block of document.querySelectorAll('#chat .mes[mesid]')) {
      const index = Number(block.getAttribute('mesid'));
      const info = describe(index);
      const text = describeCliche(info);
      const body = block.querySelector('.mes_text');
      const existing = block.querySelector('.ssa-cliche-note');
      const signature = `${text}|${info?.skipped ? 1 : 0}`;
      if (!text || !body) { existing?.remove(); continue; }
      if (existing?.dataset.signature === signature) continue;
      existing?.remove();
      const note = document.createElement('div');
      note.className = 'ssa-cliche-note';
      note.dataset.signature = signature;
      const label = document.createElement('span');
      label.textContent = text;
      note.append(label);
      if (info.mode !== 'mark') {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = info.skipped ? '重新清理' : '撤销';
        button.addEventListener('click', () => (info.skipped ? onRedo(index) : onUndo(index)));
        note.append(button);
      }
      body.after(note);
    }
  };
  let pending = 0;
  const schedule = () => { if (!pending) pending = requestAnimationFrame(() => { pending = 0; mount(); }); };
  const observer = new MutationObserver(schedule);
  observer.observe(document.body, { childList: true, subtree: true, characterData: false });
  schedule();
  return { refresh: schedule, destroy() { observer.disconnect(); document.querySelectorAll('.ssa-cliche-note').forEach((node) => node.remove()); } };
}
