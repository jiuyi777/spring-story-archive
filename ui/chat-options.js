// Host DOM contract verified against SillyTavern 1.14.0 public/index.html:
// #chat .mes[mesid] .mes_block contains .mes_text. Append a sibling after the body.
export function createChatOptions({ onChoose, onRefresh }) {
  let state = null;
  const remove = () => document.querySelectorAll('.ssa-chat-options').forEach((node) => node.remove());
  const mount = () => {
    if (!state) { remove(); return; }
    const target = document.querySelector(`#chat .mes[mesid="${state.floorIndex}"] .mes_text`);
    if (!target) return;
    const existing = target.parentElement.querySelector('.ssa-chat-options');
    if (existing?.dataset.signature === state.signature) return;
    remove();
    const panel = document.createElement('section'); panel.className = 'ssa-chat-options'; panel.dataset.signature = state.signature;
    panel.setAttribute('aria-label', '剧情选项');
    const hint = document.createElement('p'); hint.textContent = state.error || (state.loading ? '正在准备剧情选项……' : '选择下一步 · 点击填入输入框'); panel.append(hint);
    for (const option of state.options ?? []) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = option;
      button.addEventListener('click', () => onChoose(option)); panel.append(button);
    }
    if (!state.loading) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = state.error ? '重试生成选项' : '换一组选项';
      button.addEventListener('click', onRefresh); panel.append(button);
    }
    target.after(panel);
  };
  const observer = new MutationObserver(mount);
  observer.observe(document.body, { childList: true, subtree: true });
  return {
    show(value) { state = value ? { ...value, signature: JSON.stringify(value) } : null; mount(); },
    destroy() { observer.disconnect(); state = null; remove(); },
  };
}
