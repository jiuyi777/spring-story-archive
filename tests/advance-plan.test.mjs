import test from 'node:test';
import assert from 'node:assert/strict';
import { pickWays, planRound, recordRound, normalizeNextPlan, planIsCurrent, advanceWatch, normalizeAdvanceState } from '../core/advance-plan.js';
import { buildAdvanceInstruction } from '../core/play-prompts.js';
import { requestFloorSummaries } from '../core/api-client.js';

const db = (events = ['两人在书店整理旧书']) => ({ tables: {
  scene: [{ values: { time: '夜里', location: '旧书店' } }],
  characters: [{ values: { name: '沈砚', goal: '找回账本', location: '旧书店' } }],
  tasks: [{ values: { name: '还债', deadline: '三天后', state: '未凑齐' } }],
  events: events.map((summary) => ({ values: { summary } })),
  player: [{ values: { kind: '喜欢', content: '慢热' } }],
} });
const ALL = ['time', 'deadlines', 'present', 'breather', 'twist', 'conflict', 'pace'];
const chat = [{ mes: '开场', is_user: false }, { mes: '我推门进去看看里面有什么', is_user: true }];

test('at most two ways, never the pace modifier, deadlines first when nothing was pushed', () => {
  const ways = pickWays(db(), { modules: ALL });
  assert.equal(ways.length, 2);
  assert.ok(!ways.includes('pace'));
  assert.equal(ways[0], 'deadlines');
});

test('ways used in the last two rounds sit out', () => {
  const history = [{ floor: 3, ways: ['deadlines', 'time'] }, { floor: 5, ways: ['present', 'twist'] }];
  const ways = pickWays(db(), { modules: ALL, history });
  for (const id of ['deadlines', 'time', 'present', 'twist']) assert.ok(!ways.includes(id), id);
});

test('a tense stretch gets a breather; a long calm stretch gets stirred', () => {
  assert.equal(pickWays(db(['沈砚被人追进巷子，受了伤']), { modules: ['breather', 'conflict', 'time'] })[0], 'breather');
  const calm = [1, 3, 5, 7].map((floor) => ({ floor, ways: ['time'] }));
  assert.ok(['twist', 'conflict'].includes(pickWays(db(), { modules: ['time', 'breather', 'twist', 'conflict'], history: calm })[0]));
});

test('short player replies put the stall push first', () => {
  const ways = pickWays(db(), { modules: [...ALL, 'stall'], recentPlayerTexts: ['嗯', '好', '然后呢'] });
  assert.equal(ways[0], 'stall');
});

test('a plan holds until a newer character reply exists', () => {
  assert.equal(planIsCurrent({ text: 'x', afterFloor: 0 }, chat, 2), true);
  const later = [...chat, { mes: '回复', is_user: false }, { mes: '继续', is_user: true }];
  assert.equal(planIsCurrent({ text: 'x', afterFloor: 0 }, later, 4), false);
});

test('planRound: skip > current plan > local pick; swipes keep the floor\'s push', () => {
  const settings = { advanceModules: ALL };
  assert.equal(planRound({ state: { skipNext: true }, chat, replyFloor: 2, database: db(), settings }).source, 'skip');
  const withPlan = { plan: { text: '让沈砚主动提账本', ways: ['present'], afterFloor: 0, source: 'api' } };
  assert.deepEqual(planRound({ state: withPlan, chat, replyFloor: 2, database: db(), settings }), { source: 'api', ways: ['present'], text: '让沈砚主动提账本', event: undefined });
  const local = planRound({ state: {}, chat, replyFloor: 2, database: db(), settings });
  assert.equal(local.source, 'local');
  const recorded = recordRound({}, local, 2);
  const swiped = planRound({ state: recorded, chat: [...chat, { mes: 'r' }], replyFloor: 2, isSwipe: true, database: db(), settings });
  assert.deepEqual(swiped.ways, local.ways);
  assert.equal(swiped.source, 'history');
});

test('recording a skipped round clears the skip and marks used events', () => {
  const skipped = recordRound({ skipNext: true }, { source: 'skip', ways: [] }, 4);
  assert.equal(skipped.skipNext, false);
  assert.equal(skipped.history[0].skipped, true);
  const used = recordRound({}, { source: 'api', ways: ['pool'], text: '停电了', event: '旧宅突然停电' }, 6);
  assert.deepEqual(used.usedEvents, ['旧宅突然停电']);
  const watch = advanceWatch(used, { advanceModules: ['pool'], advanceEventPool: '门外有人敲门\n旧宅突然停电' });
  assert.deepEqual(watch.eventPool, ['门外有人敲门']);
});

test('a plan from the model keeps only checked ways and real pool events', () => {
  const plan = normalizeNextPlan({ ways: ['present', 'made-up', 'time'], plan: ' 沈砚翻出账本缺页 ', event: '编的事件' }, { modules: ['present', 'time'], afterFloor: 3, eventPool: ['门外有人敲门'] });
  assert.deepEqual(plan.ways, ['present', 'time']);
  assert.equal(plan.text, '沈砚翻出账本缺页');
  assert.equal(plan.event, undefined);
  assert.equal(normalizeNextPlan({ plan: '' }, {}), null);
});

test('a concrete plan replaces the generic lines; pace and the main goal stay', () => {
  const text = buildAdvanceInstruction(db(), { modules: ALL, plan: '沈砚发现账本少了一页', goal: '慢慢走到告白' });
  assert.match(text, /- 这一轮：沈砚发现账本少了一页/);
  assert.match(text, /慢热/);
  assert.match(text, /主线方向（慢慢靠近，不要一步到位）：慢慢走到告白/);
  assert.doesNotMatch(text, /时辰、天色/);
  const picked = buildAdvanceInstruction(db(), { modules: ALL, ways: ['deadlines'] });
  assert.match(picked, /还债/);
  assert.doesNotMatch(picked, /时辰、天色/);
});

test('the organizing call asks for next round\'s plan only when told to, and returns it', async () => {
  let system = '';
  const reply = { floors: [{ floor: 1, summary: '推门进书店' }], next: { ways: ['present'], plan: '沈砚问来意' } };
  const result = await requestFloorSummaries(async ({ messages }) => { system = messages[0].content; return JSON.stringify(reply); },
    { rollingSummary: '', targetFloors: [{ floor: 1, text: '一' }], advanceWatch: { ways: [{ id: 'present', name: '在场人物主动' }] } });
  assert.match(system, /"next"/);
  assert.equal(result.next.plan, '沈砚问来意');
  const plain = await requestFloorSummaries(async ({ messages }) => { system = messages[0].content; return JSON.stringify(reply); },
    { rollingSummary: '', targetFloors: [{ floor: 1, text: '一' }] });
  assert.doesNotMatch(system, /"next"/);
  assert.equal(plain.next, undefined);
});

test('old saved state from the removed background director loads cleanly', () => {
  const state = normalizeAdvanceState({ directive: 'old', continuityCheck: 'x' }, 'A');
  assert.deepEqual([state.history, state.plan, state.goal], [[], null, '']);
});
