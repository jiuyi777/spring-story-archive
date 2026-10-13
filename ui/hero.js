// The picture at the top of the panel. On the home page it shows which floor
// the story is on and where; on the other pages, the page's name. It shrinks
// to a slim band once the page below is scrolled.
const ASSETS = 'https://raw.githubusercontent.com/jiuyi777/sillytavern-theme-assets/7772da2f525049438348c26cb0b7e7e948e08932/assets/chunlai';
export const HERO_ARTS = [
  { id: 'night', name: '春来 · 夜', note: '深色水岸与白花', url: `${ASSETS}/chunlai-botanical-night-v5.png`, tone: 'dark' },
  { id: 'day', name: '春来 · 昼', note: '米色纸面与白花', url: `${ASSETS}/chunlai-botanical-paper.png`, tone: 'light' },
  { id: 'mist', name: '雾山', note: '跟着色卡变的山色', url: '', tone: 'dark' },
  { id: 'custom', name: '自己的图', note: '填一个图片链接', url: '', tone: 'dark' },
];

const PAGES = {
  database: ['数据库', '剧情里发生过的事，按类别整理'],
  people: ['人物', '登场的人和他们各自的经历'],
  player: ['玩家', '你说过的喜好和要求'],
  settings: ['设置', '修改后自动保存'],
  'preference-test': ['偏好测试', '选一选你喜欢的故事'],
};

let state = { tab: 'sending', floor: 0, scene: '', chat: '' };

export function heroArt(settings) {
  const art = HERO_ARTS.find((item) => item.id === settings?.heroArt) ?? HERO_ARTS[0];
  const url = art.id === 'custom' ? String(settings?.heroImageUrl ?? '').trim() : art.url;
  return { ...art, url: /^https?:\/\//i.test(url) || /^data:image\//i.test(url) ? url : '' };
}

export function applyHeroArt(root, settings) {
  const art = heroArt(settings);
  root.dataset.heroArt = art.url ? art.id : 'mist';
  root.dataset.heroTone = art.tone;
  root.style.setProperty('--ssa-hero-image', art.url ? `url("${art.url.replace(/"/g, '%22')}")` : 'none');
}

export function renderHero(root, update = {}) {
  state = { ...state, ...update };
  const kicker = root.querySelector('[data-role="hero-kicker"]');
  const title = root.querySelector('[data-role="hero-title"]');
  const sub = root.querySelector('[data-role="hero-sub"]');
  if (!kicker || !title || !sub) return;
  kicker.textContent = state.chat ? `春序　${state.chat}` : '春序';
  title.replaceChildren();
  if (state.tab === 'sending' || !PAGES[state.tab]) {
    if (state.floor > 0) {
      const number = document.createElement('span');
      number.className = 'ssa-hero-num';
      number.textContent = String(state.floor);
      const unit = document.createElement('span');
      unit.className = 'ssa-hero-unit';
      unit.textContent = '楼';
      title.append(number, unit);
    } else {
      title.textContent = '还没开始';
    }
    sub.textContent = state.scene || (state.floor > 0 ? '聊到这里了' : '开始聊天后，这里会显示故事进行到哪');
  } else {
    title.textContent = PAGES[state.tab][0];
    sub.textContent = PAGES[state.tab][1];
  }
}

// Shrinks once scrolled and grows back only near the top. A page too short to
// stay scrolled after the picture shrinks never shrinks it, or it would bounce.
export function watchHeroScroll(root) {
  const main = root.querySelector('.ssa-main');
  const header = root.querySelector('.ssa-header');
  if (!main || !header) return;
  let compact = false;
  let frame = 0;
  const update = () => {
    frame = 0;
    const room = main.scrollHeight - main.clientHeight;
    const saved = compact ? 0 : header.offsetHeight - 86;
    if (!compact && main.scrollTop > 56 && room - saved > 80) compact = true;
    else if (compact && main.scrollTop < 6) compact = false;
    else return;
    root.classList.toggle('is-hero-compact', compact);
  };
  main.addEventListener('scroll', () => { if (!frame) frame = requestAnimationFrame(update); }, { passive: true });
  bindGrip(root);
}

// Pull the handle (or the picture) down to close the panel.
function bindGrip(root) {
  const app = root.querySelector('.ssa-app');
  const header = root.querySelector('.ssa-header');
  let drag = null;
  header.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || event.target.closest('[data-action="close"]')) return;
    drag = { id: event.pointerId, y: event.clientY, dy: 0, moved: false };
    header.setPointerCapture?.(event.pointerId);
  });
  header.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    drag.dy = Math.max(0, event.clientY - drag.y);
    if (!drag.moved && drag.dy < 6) return;
    drag.moved = true;
    app.classList.add('is-dragging');
    app.style.transform = `translateY(${drag.dy}px)`;
  });
  const end = (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    const { dy, moved } = drag;
    drag = null;
    app.classList.remove('is-dragging');
    if (!moved) { app.style.transform = ''; return; }
    app.classList.add('is-settling');
    const close = dy > Math.min(160, app.offsetHeight * 0.22);
    app.style.transform = close ? `translateY(${app.offsetHeight}px)` : '';
    setTimeout(() => {
      app.classList.remove('is-settling');
      app.style.transform = '';
      if (close) root.querySelector('[data-action="close"]')?.click();
    }, 220);
  };
  header.addEventListener('pointerup', end);
  header.addEventListener('pointercancel', end);
}
