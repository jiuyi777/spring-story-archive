// Small play features that ride inside the main reply instead of costing their
// own API call: story options at the end of a reply, and a director's nudge.
import { MODE_LABELS } from './api-client.js?v=0.7.3';

export const OPTION_TAG = 'chunxu-options';
const BLOCK = new RegExp(`<${OPTION_TAG}>([\\s\\S]*?)(?:</${OPTION_TAG}>|$)`, 'i');

export const OPTION_COUNTS = [4, 6, 8, 12];
export const MAX_OPTIONS = 12;
export const MAX_LABEL = 8;

// Ready-made sets the player can start from; every field stays editable.
const PRESET_SLOTS = { 4: [3, 1, 0], 6: [4, 1, 1], 8: [5, 2, 1], 12: [8, 2, 2] };
const PRESET_LENGTH = { 4: '25–50 字', 6: '25–50 字', 8: '15–30 字', 12: '8–15 字' };
const ACTION_VOICE = {
  guided: '用第一人称写{{user}}要做的事或要做的决定',
  scene: '写{{user}}可以走进的一个具体场景：去哪里、找谁、碰上什么',
  third: '用第三人称写{{user}}要做的事或要做的决定',
  mixed: '第一人称的行动、可以走进的场景、第三人称的行动三种写法都要用到',
};

export function normalizeOptionCount(count) {
  const value = Number(count) || 6;
  return OPTION_COUNTS.reduce((best, item) => (Math.abs(item - value) < Math.abs(best - value) ? item : best), 6);
}

// Shared rules for every option; the player can rewrite or clear them.
export const DEFAULT_OPTION_RULES = '所有选项都要符合当前场景和人物的能力，能推进剧情或关系，不重复，不与已经发生的事矛盾。\n不替{{user}}决定内心。';

export function presetSlots(count = 6, mode = 'guided') {
  const size = normalizeOptionCount(count);
  const [actions, others, times] = PRESET_SLOTS[size];
  const length = PRESET_LENGTH[size];
  return [
    { label: '行动', count: actions, rule: `${ACTION_VOICE[mode] ?? ACTION_VOICE.guided}，每个 ${length}。只写做什么，不写结果。几个之间的方向、态度或代价要明显不同，不能只是换个说法。` },
    { label: '他人', count: others, rule: `另一个在场或相关的人物可能的举动或反应，用第三人称写，每个 ${length}。` },
    { label: '时间', count: times, rule: `一次时间跳跃，写清过了多久、期间发生了哪些小变化，每个 ${length}。` },
  ].filter((slot) => slot.count > 0);
}

// Labels sit inside 【】 in the reply and are matched by the display regex, so
// they are kept short and free of the characters that would break the block.
export function normalizeSlots(slots) {
  const clean = [];
  let total = 0;
  for (const slot of Array.isArray(slots) ? slots : []) {
    const label = String(slot?.label ?? '').replace(/[【】<>\s]/g, '').slice(0, MAX_LABEL);
    const count = Math.max(0, Math.min(MAX_OPTIONS - total, Math.round(Number(slot?.count) || 0)));
    if (!label || !count) continue;
    clean.push({ label, count, rule: String(slot?.rule ?? '').trim().slice(0, 400) });
    total += count;
    if (total >= MAX_OPTIONS) break;
  }
  return clean;
}

export function buildOptionsInstruction({ slots, count = 6, mode = 'guided', notes = '' } = {}) {
  const list = normalizeSlots(slots);
  const use = list.length ? list : presetSlots(count, mode);
  const lines = use.flatMap((slot) => Array(slot.count).fill(`<co>【${slot.label}】……</co>`));
  return [
    '【剧情选项】',
    '每次写完正文后，必须在回复末尾输出一组剧情选项，不能省略。格式固定如下，类别、数量和顺序都不能改，也不要增加别的内容：',
    '',
    `<${OPTION_TAG}>`,
    ...lines,
    `</${OPTION_TAG}>`,
    '',
    '规则：',
    ...use.map((slot) => `- 【${slot.label}】${slot.count} 个${slot.rule ? `：${slot.rule}` : '。'}`),
    ...String(notes ?? '').split('\n').map((line) => line.trim()).filter(Boolean).map((line) => `- ${line.replace(/^[-·•]\s*/, '')}`),
    '- 选项只写在这个块里，正文里不要出现选项内容。',
    `- </${OPTION_TAG}> 之后空一行再结束回复。`,
  ].filter((line) => line !== null).join('\n');
}

// Pull the options block out of a reply. The block never stays in the message,
// so it is never sent back as history or organized into memory.
export function extractOptions(text) {
  const source = String(text ?? '');
  const match = source.match(BLOCK);
  if (!match) return { text: source, options: [] };
  const tagged = [...match[1].matchAll(/<co>([\s\S]*?)<\/co>/gi)].map((item) => item[1].trim());
  const options = (tagged.length ? tagged : match[1].split('\n'))
    .map((line) => line.replace(/<\/?co>/gi, '').replace(/^\s*(?:[-*•·]|\d+[.、)）]|[（(]?\d+[)）])\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 12);
  const stripped = (source.slice(0, match.index) + source.slice(match.index + match[0].length)).replace(/\s+$/, '');
  return { text: stripped, options };
}

// The director's nudge is assembled locally from the memory database: open
// agreements, unresolved clues and what present characters want.
// ---- 剧情推进 ---------------------------------------------------------------
// Ways to push the story, each a small rule fed by the archive. The player picks
// any of them; an item with nothing to work with stays silent.
const CLOSED = /已完成|已取消|已结束|已解决|已失效/;
const isOpen = (row) => !CLOSED.test(row.values.state || '');

export const ADVANCE_MODULES = [
  { id: 'time', label: '时间流动', description: '昼夜、天气、季节自然往前走，环境跟着变' },
  { id: 'deadlines', label: '约定倒计时', description: '有期限的约定和任务临近或过期时，让后果出现' },
  { id: 'clues', label: '伏笔回收', description: '很久没提的线索找机会重新冒出来' },
  { id: 'present', label: '在场人物主动', description: '在场的人按自己的目标做事、提要求、表态' },
  { id: 'offscreen', label: 'NPC 幕后行动', description: '不在场的人也在推进自己的事，留下痕迹或消息' },
  { id: 'consequence', label: '前文后果', description: '之前做过的决定和发生过的事开始产生影响' },
  { id: 'relationship', label: '关系推进', description: '借一件具体的小事让人物关系往前或往后走一步' },
  { id: 'conflict', label: '冲突升级', description: '已有的矛盾逐步加码，不凭空制造新敌人' },
  { id: 'twist', label: '意外转折', description: '剧情平稳太久时，加入一个合理但出乎意料的变化' },
  { id: 'breather', label: '日常喘息', description: '紧张段落之后，给一段安静的日常和人物互动' },
  { id: 'world', label: '世界运转', description: '更大范围的事件（消息、势力、规则）波及眼前' },
  { id: 'stall', label: '冷场加力', description: '玩家连续几轮回应很短或原地打转时，推得更明显' },
  { id: 'pace', label: '跟随玩家节奏', description: '按玩家表里说过的喜好（慢热、快节奏、雷点）控制推进' },
  { id: 'pool', label: '自定义事件池', description: '从玩家自己写的事件里挑一件合适的' },
];
export const DEFAULT_ADVANCE_MODULES = ['time', 'deadlines', 'present', 'consequence', 'pace'];
export const STRENGTH = {
  light: '推进要轻：只在回应{{user}}之后加一两句变化，不打断{{user}}正在做的事。',
  normal: '推进幅度不超过一个场景。',
  strong: '可以推得明显一些：让一件事真正发生，逼出新的局面，但仍然只到一个场景为止。',
};

// The data-backed line for each checked way; ways with nothing to work with
// are left out. 'pace' and 'stall' are modifiers rather than events.
export function advanceLines(database, {
  modules = DEFAULT_ADVANCE_MODULES, eventPool = '', usedEvents = [], latestFloor = Infinity, recentPlayerTexts = [],
} = {}) {
  const tables = database?.tables ?? {};
  const here = tables.scene?.[0]?.values?.location;
  const on = new Set(modules);
  const lines = new Map();
  const add = (id, text) => { if (on.has(id) && text) lines.set(id, text); };

  add('time', '让时间和环境自然往前走一点：时辰、天色、天气或周围的动静。');
  const deadlines = (tables.tasks ?? []).filter((row) => isOpen(row) && row.values.deadline).slice(-4)
    .map((row) => `「${row.values.name}」期限：${row.values.deadline}${row.values.state ? `（现在：${row.values.state}）` : ''}`);
  if (deadlines.length) add('deadlines', `留意这些约定的期限，快到或已过时让后果出现：${deadlines.join('；')}。`);
  const stale = (tables.clues ?? []).filter((row) => isOpen(row) && Number.isFinite(latestFloor) && latestFloor - row.floorIndex >= 20).slice(0, 3)
    .map((row) => `「${row.values.name}」${row.values.detail ? `（${row.values.detail}）` : ''}`);
  if (stale.length) add('clues', `这些线索很久没提了，找自然的机会让它们重新出现：${stale.join('；')}。`);
  const present = (tables.characters ?? []).filter((row) => row.values.goal && (!here || row.values.location === here)).slice(0, 3)
    .map((row) => `${row.values.name}想要${row.values.goal}`);
  if (present.length) add('present', `在场的人可以按自己的目标行动：${present.join('；')}。`);
  const away = (tables.characters ?? []).filter((row) => row.values.goal && here && row.values.location && row.values.location !== here).slice(0, 3)
    .map((row) => `${row.values.name}（在${row.values.location}，想要${row.values.goal}）`);
  if (away.length) add('offscreen', `不在场的人也在推进自己的事，可以通过消息、痕迹或旁人提起让{{user}}察觉：${away.join('；')}。`);
  const recentEvents = (tables.events ?? []).slice(-12, -2).map((row) => row.values.summary).filter(Boolean).slice(-3);
  if (recentEvents.length) add('consequence', `之前发生的事可以开始产生影响：${recentEvents.join('；')}。`);
  const relations = (tables.relationships ?? []).slice(-3).map((row) => `${row.values.from}与${row.values.to}：${row.values.relation || row.values.state || '有关联'}`);
  if (relations.length) add('relationship', `借一件具体的小事让这些关系往前或往后走一步：${relations.join('；')}。`);
  add('conflict', '已有的矛盾加码一点，但不要凭空制造新的敌人或灾难。');
  add('twist', '加入一个合理但出乎意料的变化，要能从前文找到伏笔。');
  add('breather', '给一段安静的日常和人物之间的小互动，别急着制造新事件。');
  add('world', '让更大范围的事情波及眼前：一条消息、某个势力的动作、世界规则带来的代价。');
  const short = recentPlayerTexts.slice(-3).filter((text) => String(text).replace(/\s/g, '').length <= 12);
  if (short.length >= 3) add('stall', '{{user}}最近几轮回应很短，这次推进要明显一些，让局面出现{{user}}必须回应的变化。');
  const wishes = (tables.player ?? []).map((row) => [row.values.kind, row.values.content].filter(Boolean).join('：')).filter(Boolean).slice(0, 6);
  if (wishes.length) add('pace', `推进节奏要符合{{user}}说过的话：${wishes.join('；')}。`);
  const pool = unusedEvents(eventPool, usedEvents);
  if (pool.length) add('pool', `可以从这些事件里挑一件发生：${pool.slice(0, 20).join('；')}。`);
  return lines;
}

export function unusedEvents(eventPool, usedEvents = []) {
  const used = new Set(usedEvents);
  return String(eventPool ?? '').split('\n').map((line) => line.trim()).filter((line) => line && !used.has(line));
}

// ways: only these ways' lines (null = every checked way). plan: one concrete
// arrangement for this round, which replaces the generic lines.
export function buildAdvanceInstruction(database, {
  modules = DEFAULT_ADVANCE_MODULES, strength = 'normal', eventPool = '', usedEvents = [], latestFloor = Infinity,
  recentPlayerTexts = [], playerProfileSummary = '', tastes = '', ways = null, plan = '', goal = '',
} = {}) {
  const scene = database?.tables?.scene?.[0]?.values ?? {};
  const here = scene.location;
  const all = advanceLines(database, { modules, eventPool, usedEvents, latestFloor, recentPlayerTexts });
  const lines = [];
  if (String(plan).trim()) {
    lines.push(`- 这一轮：${String(plan).trim()}`);
  } else {
    for (const [id, text] of all) if (id !== 'pace' && (!ways || ways.includes(id))) lines.push(`- ${text}`);
  }
  if (all.has('pace')) lines.push(`- ${all.get('pace')}`);
  if (!lines.length && !tastes && !playerProfileSummary && !goal) return '';
  return [
    '【剧情推进】回应完{{user}}之后，让世界自己往前走：',
    ...lines,
    scene.time || here ? `当前：${[scene.time, here].filter(Boolean).join('，')}。` : '',
    goal ? `主线方向（慢慢靠近，不要一步到位）：${goal}` : '',
    tastes ? `{{user}}喜欢的题材和口味：${tastes}` : '',
    playerProfileSummary ? `{{user}}想要的体验：${String(playerProfileSummary).slice(0, 300)}` : '',
    STRENGTH[strength] ?? STRENGTH.normal,
    '不跳时、不瞬移、不改变已有关系的事实。',
  ].filter(Boolean).join('\n');
}

export function formatOptionsBlock(options) {
  return `<${OPTION_TAG}>\n${options.map((option) => `<co>${String(option).replace(/</g, '＜')}</co>`).join('\n')}\n</${OPTION_TAG}>`;
}

// Replace the options block in a reply, or append one.
export function replaceOptionsBlock(text, options) {
  const block = formatOptionsBlock(options);
  const source = String(text ?? '');
  return BLOCK.test(source) ? source.replace(BLOCK, block) : `${source.replace(/\s+$/, '')}\n\n${block}`;
}

// Two SillyTavern regex scripts, installed into the global regex list so they
// show up (and can be edited) in the host's own regex panel:
//   display - turns the block into the styled options card (display only);
//   prompt  - removes the block from what is sent to the model.
// SillyTavern prefixes message classes with "custom-"; styles target that.
export const OPTION_REGEX_IDS = { display: '6c1f0e2a-5b7d-4c61-9a3e-c4a5f0b7e101', prompt: '6c1f0e2a-5b7d-4c61-9a3e-c4a5f0b7e102' };
const AI_OUTPUT = 2;
export function optionRegexScripts() {
  const base = { trimStrings: [], placement: [AI_OUTPUT], disabled: false, runOnEdit: true, substituteRegex: 0, minDepth: null, maxDepth: null };
  return [
    {
      ...base,
      id: OPTION_REGEX_IDS.display,
      scriptName: '喵喵 · 剧情选项美化',
      findRegex: `/\\s*<${OPTION_TAG}>\\s*([\\s\\S]*?)\\s*<\\/${OPTION_TAG}>/gi`,
      replaceString: '\n\n<div class="chunxu-options"><div class="chunxu-options-head"><span class="chunxu-options-title">下一步</span><span class="chunxu-options-hint">点选填入输入框</span><span class="chunxu-options-refresh" title="重新生成一组选项">换一组</span></div><div class="chunxu-options-list">$1</div></div>',
      markdownOnly: true,
      promptOnly: false,
    },
    {
      ...base,
      id: OPTION_REGEX_IDS.display.replace(/101$/, '103'),
      scriptName: '喵喵 · 剧情选项美化（单项）',
      findRegex: '/\\s*<co>\\s*(?:【([^】]{1,8})】)?\\s*([\\s\\S]*?)\\s*<\\/co>\\s*/gi',
      replaceString: '<span class="chunxu-opt" data-kind="$1"><span class="chunxu-opt-kind">$1</span><span class="chunxu-opt-text">$2</span></span>',
      markdownOnly: true,
      promptOnly: false,
    },
    {
      ...base,
      id: OPTION_REGEX_IDS.prompt,
      scriptName: '喵喵 · 剧情选项不发送',
      findRegex: `/\\s*<${OPTION_TAG}>[\\s\\S]*?(?:<\\/${OPTION_TAG}>|$)/gi`,
      replaceString: '',
      markdownOnly: false,
      promptOnly: true,
    },
  ];
}

// The words to put in the input box: the option text without its 【类型】 label.
export function optionText(option) {
  return String(option ?? '').replace(/^\s*【[^】]{1,8}】\s*/, '').trim();
}
