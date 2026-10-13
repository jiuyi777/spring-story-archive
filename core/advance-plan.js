// Decides what the push carries in one round. A concrete plan written by the
// organizing call (or by the player) wins; otherwise one or two ways are picked
// to fit the situation, skipping the ways used in the last couple of rounds.
import { advanceLines, ADVANCE_MODULES } from './play-prompts.js?v=0.7.2';

const HISTORY_LIMIT = 20;
const TENSE = /打|杀|血|逃|追|爆炸|死|伤|危险|争吵|对峙|袭|威胁|崩溃|失控|围/;
const STIRRING = new Set(['conflict', 'twist', 'world', 'clues', 'pool']);
const MODIFIERS = new Set(['pace']);

export const wayLabel = (id) => ADVANCE_MODULES.find((module) => module.id === id)?.label ?? id;

export function emptyAdvanceState(chatKey = '') {
  return { chatKey, kind: 'advance-state', goal: '', plan: null, skipNext: false, history: [], usedEvents: [] };
}

export function normalizeAdvanceState(state, chatKey = '') {
  const base = emptyAdvanceState(chatKey);
  if (!state || typeof state !== 'object') return base;
  return {
    ...base,
    ...state,
    goal: String(state.goal ?? ''),
    plan: state.plan?.text ? state.plan : null,
    skipNext: Boolean(state.skipNext),
    history: Array.isArray(state.history) ? state.history : [],
    usedEvents: Array.isArray(state.usedEvents) ? state.usedEvents : [],
  };
}

// The last character reply before the given floor.
export function lastReplyBefore(chat, floor) {
  for (let index = Math.min(floor, chat.length) - 1; index >= 0; index -= 1) {
    if (!chat[index]?.is_user && !chat[index]?.is_system) return index;
  }
  return -1;
}

// A plan holds until a newer character reply exists.
export function planIsCurrent(plan, chat, replyFloor) {
  return Boolean(plan?.text) && Number(plan.afterFloor) >= lastReplyBefore(chat, replyFloor);
}

function recentWays(history, rounds) {
  return history.filter((entry) => !entry.skipped).slice(-rounds).flatMap((entry) => entry.ways ?? []);
}

export function pickWays(database, { modules = [], history = [], recentPlayerTexts = [], latestFloor = Infinity, eventPool = '', usedEvents = [], exclude = [], limit = 2 } = {}) {
  const lines = advanceLines(database, { modules, eventPool, usedEvents, latestFloor, recentPlayerTexts });
  const candidates = [...lines.keys()].filter((id) => !MODIFIERS.has(id) && !exclude.includes(id));
  if (!candidates.length) return [];
  const events = (database?.tables?.events ?? []).slice(-3).map((row) => row.values?.summary ?? '').join(' ');
  const tense = TENSE.test(events) || recentWays(history, 1).some((id) => id === 'conflict' || id === 'twist');
  const lastFour = recentWays(history, 4);
  const calm = history.filter((entry) => !entry.skipped).length >= 4 && !lastFour.some((id) => STIRRING.has(id));
  const lastTwo = new Set(recentWays(history, 2));
  const lastUsed = (id) => { for (let index = history.length - 1; index >= 0; index -= 1) if (history[index].ways?.includes(id)) return history.length - index; return 99; };
  const score = (id) => {
    let value = Math.min(lastUsed(id), 10) / 10;
    if (lastTwo.has(id)) value -= 5;
    if (id === 'stall') value += 5;
    if (id === 'deadlines') value += 2;
    if (tense && id === 'breather') value += 4;
    if (tense && (id === 'conflict' || id === 'twist')) value -= 2;
    if (calm && (id === 'twist' || id === 'conflict' || id === 'world')) value += 2;
    if (!tense && id === 'breather') value -= 1;
    return value;
  };
  return candidates
    .map((id, order) => ({ id, value: score(id), order }))
    .sort((left, right) => right.value - left.value || left.order - right.order)
    .slice(0, Math.max(1, limit))
    .map((item) => item.id);
}

// What this round's push will be. source: skip | history | player | api | local.
export function planRound({ state, chat = [], replyFloor, isSwipe = false, database, settings = {} }) {
  const current = normalizeAdvanceState(state);
  if (current.skipNext) return { source: 'skip', ways: [], text: '' };
  const plan = current.plan;
  const kept = current.history.find((entry) => entry.floor === replyFloor);
  if (isSwipe && kept && !(plan && plan.updatedAt > kept.at)) {
    return kept.skipped ? { source: 'skip', ways: [], text: '' } : { source: 'history', ways: kept.ways ?? [], text: kept.plan ?? '', event: kept.event };
  }
  if (planIsCurrent(plan, chat, replyFloor)) return { source: plan.source || 'api', ways: plan.ways ?? [], text: plan.text, event: plan.event };
  const ways = pickWays(database, {
    modules: settings.advanceModules ?? [],
    history: current.history,
    recentPlayerTexts: chat.slice(0, replyFloor).filter((message) => message.is_user).slice(-3).map((message) => message.mes),
    latestFloor: replyFloor - 1,
    eventPool: settings.advanceEventPool,
    usedEvents: current.usedEvents,
  });
  return { source: 'local', ways, text: '' };
}

export function recordRound(state, round, replyFloor) {
  const current = normalizeAdvanceState(state);
  const entry = { floor: replyFloor, ways: round.ways ?? [], plan: round.text ?? '', source: round.source, at: new Date().toISOString(), ...(round.event ? { event: round.event } : {}), ...(round.source === 'skip' ? { skipped: true } : {}) };
  const history = [...current.history.filter((item) => item.floor !== replyFloor), entry].sort((a, b) => a.floor - b.floor).slice(-HISTORY_LIMIT);
  const usedEvents = round.event && !current.usedEvents.includes(round.event) ? [...current.usedEvents, round.event].slice(-200) : current.usedEvents;
  return { ...current, history, usedEvents, skipNext: round.source === 'skip' ? false : current.skipNext };
}

// What the organizing call is told when it should also plan the next round.
export function advanceWatch(state, settings, { tastes = '', strengthText = '' } = {}) {
  const current = normalizeAdvanceState(state);
  const used = new Set(current.usedEvents);
  return {
    ways: (settings.advanceModules ?? []).map((id) => ({ id, name: wayLabel(id) })),
    recentPushes: current.history.filter((entry) => !entry.skipped).slice(-4).map((entry) => ({ floor: entry.floor + 1, ways: (entry.ways ?? []).map(wayLabel), plan: entry.plan || '' })),
    mainGoal: current.goal || '',
    tastes,
    strength: strengthText,
    eventPool: (settings.advanceModules ?? []).includes('pool')
      ? String(settings.advanceEventPool ?? '').split('\n').map((line) => line.trim()).filter((line) => line && !used.has(line)).slice(0, 20)
      : [],
  };
}

export function normalizeNextPlan(next, { modules = [], afterFloor, eventPool = [] } = {}) {
  const text = String(next?.plan ?? '').trim().slice(0, 300);
  if (!text) return null;
  const allowed = new Set(modules);
  const ways = (Array.isArray(next.ways) ? next.ways : []).map(String).filter((id) => allowed.has(id)).slice(0, 2);
  const event = String(next.event ?? '').trim();
  return { text, ways, afterFloor, source: 'api', updatedAt: new Date().toISOString(), ...(event && eventPool.includes(event) ? { event } : {}) };
}
