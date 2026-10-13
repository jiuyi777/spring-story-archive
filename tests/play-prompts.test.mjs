import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOptionsInstruction, extractOptions, buildAdvanceInstruction, OPTION_TAG } from '../core/play-prompts.js';

test('options instruction fixes types, counts and order for each size', () => {
  const six = buildOptionsInstruction({ count: 6, mode: 'guided', notes: '别太长' });
  assert.match(six, new RegExp(`<${OPTION_TAG}>`));
  assert.equal((six.match(/<co>【行动】/g) ?? []).length, 4);
  assert.equal((six.match(/<co>【他人】/g) ?? []).length, 1);
  assert.equal((six.match(/<co>【时间】/g) ?? []).length, 1);
  assert.ok(six.indexOf('【行动】……') < six.indexOf('【他人】……') && six.indexOf('【他人】……') < six.indexOf('【时间】……'));
  assert.match(six, /25–50 字/);
  assert.match(six, /别太长/);
  const four = buildOptionsInstruction({ count: 4 });
  assert.equal((four.match(/<co>【时间】/g) ?? []).length, 0);
  assert.doesNotMatch(four, /- 【时间】/);
  const twelve = buildOptionsInstruction({ count: 12, mode: 'scene' });
  assert.equal((twelve.match(/<co>/g) ?? []).length, 12);
  assert.match(twelve, /8–15 字/);
  assert.match(twelve, /可以走进的一个具体场景/);
});

test('the options block is pulled out of the reply and parsed line by line', () => {
  const reply = `林素合上账本。\n\n<${OPTION_TAG}>\n1. 追问账本缺的那一页\n2、去西廊找沈砚\n- 先离开档案室\n</${OPTION_TAG}>`;
  const { text, options } = extractOptions(reply);
  assert.equal(text, '林素合上账本。');
  assert.deepEqual(options, ['追问账本缺的那一页', '去西廊找沈砚', '先离开档案室']);
});

test('an unclosed block is still removed so it never leaks into history', () => {
  const { text, options } = extractOptions(`正文。\n<${OPTION_TAG}>\n1. 甲\n2. 乙`);
  assert.equal(text, '正文。');
  assert.deepEqual(options, ['甲', '乙']);
});

test('a reply without options is left untouched', () => {
  assert.deepEqual(extractOptions('只是正文。'), { text: '只是正文。', options: [] });
});

test('push follows the checked ways, fed by the archive', () => {
  const database = { tables: {
    scene: [{ values: { time: '雨夜', location: '档案室' } }],
    tasks: [{ values: { name: '天亮前核对登记簿', deadline: '天亮前', state: '进行中' } }, { values: { name: '旧约', deadline: '昨天', state: '已完成' } }],
    clues: [{ floorIndex: 2, values: { name: '缺页', detail: '账本少了一页' } }, { floorIndex: 40, values: { name: '新线索' } }],
    characters: [{ values: { name: '林素', location: '档案室', goal: '找到缺页' } }, { values: { name: '沈砚', location: '西廊', goal: '离开' } }],
    player: [{ values: { kind: '喜欢', content: '慢热' } }],
  } };
  const text = buildAdvanceInstruction(database, { modules: ['deadlines', 'clues', 'present', 'offscreen', 'pace'], latestFloor: 45, strength: 'light' });
  assert.match(text, /天亮前核对登记簿/);
  assert.doesNotMatch(text, /旧约/);
  assert.match(text, /缺页/);
  assert.doesNotMatch(text, /新线索/, 'recent clues are not "long forgotten"');
  assert.match(text, /林素想要找到缺页/);
  assert.match(text, /沈砚（在西廊，想要离开）/);
  assert.match(text, /慢热/);
  assert.match(text, /推进要轻/);
  assert.doesNotMatch(text, /不替玩家/, 'speaking for the player is left to the preset');
});

test('unchecked ways and ways with nothing to work with stay out', () => {
  const text = buildAdvanceInstruction({ tables: {} }, { modules: ['deadlines', 'clues', 'time'] });
  assert.match(text, /时间和环境/);
  assert.doesNotMatch(text, /期限|线索/);
  assert.equal(buildAdvanceInstruction({ tables: {} }, { modules: [] }), '');
});

test('the stall rule fires only after several short replies; the event pool is offered', () => {
  const quiet = buildAdvanceInstruction({ tables: {} }, { modules: ['stall', 'pool'], recentPlayerTexts: ['嗯', '好', '继续'], eventPool: '门外有人敲门\n停电' });
  assert.match(quiet, /回应很短/);
  assert.match(quiet, /门外有人敲门；停电/);
  assert.doesNotMatch(buildAdvanceInstruction({ tables: {} }, { modules: ['stall', 'time'], recentPlayerTexts: ['我把灯提起来照照墙上那道新刮的痕迹', '好', '嗯'] }), /回应很短/);
});

import { optionRegexScripts, replaceOptionsBlock, formatOptionsBlock } from '../core/play-prompts.js';
import { storyText } from '../core/privacy-payload.js';
import { requestFloorSummaries } from '../core/api-client.js';
import { memorySchemaForPrompt } from '../core/memory-database.js';

const toRegExp = (text) => { const m = text.match(/^\/([\s\S]*)\/([a-z]*)$/); return new RegExp(m[1], m[2]); };
const reply = `林素合上账本。\n\n${formatOptionsBlock(['追问缺页', '去西廊'])}`;

test('regex scripts render the card for display and remove the block from prompts', () => {
  const [card, item, prompt] = optionRegexScripts();
  assert.equal(card.markdownOnly, true); assert.equal(prompt.promptOnly, true);
  assert.deepEqual(card.placement, [2]);
  const shown = reply.replace(toRegExp(item.findRegex), item.replaceString).replace(toRegExp(card.findRegex), card.replaceString);
  assert.match(shown, /<span class="chunxu-opt" data-kind=""><span class="chunxu-opt-kind"><\/span><span class="chunxu-opt-text">追问缺页<\/span><\/span>/);
  const typed = formatOptionsBlock(['【他人】林素合上了账本']).replace(toRegExp(item.findRegex), item.replaceString);
  assert.match(typed, /data-kind="他人"><span class="chunxu-opt-kind">他人<\/span><span class="chunxu-opt-text">林素合上了账本<\/span>/);
  assert.match(shown, /^林素合上账本。\n\n<div class="chunxu-options">/);
  assert.equal(reply.replace(toRegExp(prompt.findRegex), ''), '林素合上账本。');
});

test('organizing and recall read the reply without the options block', () => {
  assert.equal(storyText(reply), '林素合上账本。');
});

test('a new set of options replaces the old block instead of stacking', () => {
  const next = replaceOptionsBlock(reply, ['离开']);
  assert.equal((next.match(/<chunxu-options>/g) ?? []).length, 1);
  assert.match(next, /<co>离开<\/co>/);
  assert.doesNotMatch(next, /追问缺页/);
});

test('a custom summary format replaces the default summary wording', async () => {
  let system = '';
  await requestFloorSummaries(async (request) => {
    system = request.messages[0].content;
    return JSON.stringify({ floors: [{ floor: 1, summary: 'x', characters: [], relationships: [], clues: [], timeline: [], changes: [] }] });
  }, { memorySchema: memorySchemaForPrompt(), targetFloors: [{ floor: 1, text: 'a' }], summaryFormat: '【时间｜地点】人物：做了什么' });
  assert.match(system, /按玩家指定的格式写/);
  assert.match(system, /【时间｜地点】人物：做了什么/);
  assert.doesNotMatch(system, /一两句够用就停止/);
});

import { optionText } from '../core/play-prompts.js';
test('filling the input drops the type label', () => {
  assert.equal(optionText('【行动】我借她的灯去西廊'), '我借她的灯去西廊');
  assert.equal(optionText('没有标签的选项'), '没有标签的选项');
});

import { presetSlots, normalizeSlots, DEFAULT_OPTION_RULES } from '../core/play-prompts.js';
test('player-defined categories: own labels, counts and requirements; tag format stays fixed', () => {
  const text = buildOptionsInstruction({ slots: [{ label: '行动', count: 3, rule: '第一人称，20 字内' }, { label: '心声', count: 1, rule: '写此刻没说出口的一句心里话' }], notes: '' });
  assert.equal((text.match(/<co>【行动】……<\/co>/g) ?? []).length, 3);
  assert.match(text, /<co>【心声】……<\/co>/);
  assert.match(text, /- 【心声】1 个：写此刻没说出口的一句心里话/);
  assert.doesNotMatch(text, /不替玩家决定内心/);
  assert.match(text, /之后空一行再结束回复/);
});

test('labels are cleaned and the total is capped at twelve', () => {
  const slots = normalizeSlots([{ label: '【行 动】<x>', count: 10 }, { label: '他人', count: 5 }, { label: '', count: 2 }]);
  assert.deepEqual(slots.map((slot) => [slot.label, slot.count]), [['行动x', 10], ['他人', 2]]);
});

test('presets and shared rules are just starting points', () => {
  assert.deepEqual(presetSlots(8).map((slot) => slot.count), [5, 2, 1]);
  const text = buildOptionsInstruction({ slots: presetSlots(6), notes: DEFAULT_OPTION_RULES });
  assert.match(text, /- 不替玩家决定内心。/);
});

import { describeTasteSettings, genreLabels, GENRE_GROUPS } from '../core/preference-quiz.js';
test('genre and taste picks become one line for push and analysis; MBTI is only a self-reported hint', () => {
  const line = describeTasteSettings({ genres: ['infinite_f', 'mystery'], tastes: { sweetness: '偏甜', ending: '不在意', romance: '慢热' }, mbti: 'INFP' });
  assert.match(line, /无限流（副本解谜/);
  assert.match(line, /甜还是虐：偏甜/);
  assert.doesNotMatch(line, /结局偏好/);
  assert.match(line, /自述 MBTI：INFP（仅作参考）/);
  assert.equal(describeTasteSettings({ mbti: 'XXXX' }), '');
  const text = buildAdvanceInstruction({ tables: {} }, { modules: [], tastes: line });
  assert.match(text, /玩家喜欢的题材和口味：喜欢的题材/);
});

test('both 男频 and 女频 list 无限流 separately', () => {
  const ids = GENRE_GROUPS.flatMap((group) => group.genres.map((genre) => genre.id));
  assert.ok(ids.includes('infinite_m') && ids.includes('infinite_f'));
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(genreLabels(['xuanhuan']), ['玄幻']);
});
