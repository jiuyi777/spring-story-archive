// Host DOM contract verified against SillyTavern 1.14.0 public/index.html:
// #chat .mes[mesid] .mes_block contains .mes_text. Append a sibling after the body.
// The panel lays itself out by option count: 4 full-width rows, 6 two columns,
// 8 compact pairs, 12 a dense grid of short actions.
export function createChatOptions({ onChoose, onRefresh }) {
  let state = null;
  let chosen = '';
  const remove = () => document.querySelectorAll('.ssa-chat-options').forEach((node) => node.remove());
  const mount = () => {
    if (!state) { remove(); return; }
    const target = document.querySelector(`#chat .mes[mesid="${state.floorIndex}"] .mes_text`);
    if (!target) return;
    const existing = target.parentElement.querySelector('.ssa-chat-options');
    if (existing?.dataset.signature === state.signature) return;
    remove();
    const options = state.options ?? [];
    const panel = document.createElement('section');
    panel.className = 'ssa-chat-options';
    panel.dataset.signature = state.signature;
    panel.dataset.count = String(options.length <= 4 ? 4 : options.length <= 6 ? 6 : options.length <= 8 ? 8 : 12);
    panel.setAttribute('aria-label', '剧情选项');

    const head = document.createElement('header');
    const title = document.createElement('span');
    title.className = 'ssa-co-title';
    title.textContent = state.error ? '剧情选项没有生成' : state.loading ? '正在准备剧情选项' : '下一步';
    const hint = document.createElement('span');
    hint.className = 'ssa-co-hint';
    hint.textContent = state.error || (state.loading ? '' : '点一下填入输入框');
    head.append(title, hint);
    if (!state.loading) {
      const refresh = document.createElement('button');
      refresh.type = 'button';
      refresh.className = 'ssa-co-refresh';
      refresh.textContent = state.error ? '重试' : '换一组';
      refresh.addEventListener('click', onRefresh);
      head.append(refresh);
    }
    panel.append(head);

    if (options.length) {
      const list = document.createElement('ol');
      list.className = 'ssa-co-list';
      options.forEach((option, index) => {
        const item = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'ssa-co-option';
        button.setAttribute('aria-pressed', String(option === chosen));
        const mark = document.createElement('span');
        mark.className = 'ssa-co-index';
        mark.textContent = String(index + 1).padStart(2, '0');
        mark.setAttribute('aria-hidden', 'true');
        const text = document.createElement('span');
        text.className = 'ssa-co-text';
        text.textContent = option;
        button.append(mark, text);
        button.addEventListener('click', () => {
          chosen = option;
          for (const other of list.querySelectorAll('.ssa-co-option')) other.setAttribute('aria-pressed', String(other === button));
          onChoose(option);
        });
        item.append(button);
        list.append(item);
      });
      panel.append(list);
    }
    target.after(panel);
  };
  const observer = new MutationObserver(mount);
  observer.observe(document.body, { childList: true, subtree: true });
  return {
    show(value) {
      if (!value || value.floorIndex !== state?.floorIndex) chosen = '';
      state = value ? { ...value, signature: JSON.stringify(value) } : null;
      mount();
    },
    destroy() { observer.disconnect(); state = null; remove(); },
  };
}
