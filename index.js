import { createSendHistory, normalizeFinalPrompt, pruneFinalPrompts } from './core/send-history.js?v=0.7.2';
import { renderSendHistory } from './ui/send-view.js?v=0.7.2';
import { createChatOptions } from './ui/chat-options.js?v=0.7.2';
import { createClicheNotes } from './ui/cliche-note.js?v=0.7.2';
import { buildOptionsInstruction, extractOptions, buildAdvanceInstruction, normalizeOptionCount, replaceOptionsBlock, optionRegexScripts, OPTION_REGEX_IDS, optionText, presetSlots, normalizeSlots, DEFAULT_OPTION_RULES, ADVANCE_MODULES, DEFAULT_ADVANCE_MODULES, STRENGTH } from './core/play-prompts.js?v=0.7.2';
import { normalizeAdvanceState, planRound, recordRound, advanceWatch, normalizeNextPlan, lastReplyBefore, pickWays, planIsCurrent } from './core/advance-plan.js?v=0.7.2';
import { renderPushCard } from './ui/push-card.js?v=0.7.2';
import { renderHero } from './ui/hero.js?v=0.7.2';
import { renderOptionSlots, readSlotEdit } from './ui/option-slots.js?v=0.7.2';
import { compileRules, scanCliches, summarizeHits, cleanLocally, sentencesToRewrite, applyRewrites, textHash, splitOptionsBlock } from './core/cliche-filter.js?v=0.7.2';
import { buildPrivacyPayload, fingerprintMessage, validSummaries, estimateTokens, truncateToTokenBudget, isControlMessage } from './core/privacy-payload.js?v=0.7.2';
import { formatMemoryDatabase, applyNarrativeEdits } from './core/memory-database.js?v=0.7.2';
import { renderMemoryDatabase, renderTablePages, collectMemoryEdit } from './ui/memory-view.js?v=0.7.2';
import { renderOverview } from './ui/overview-view.js?v=0.7.2';
import { renderPromptViewer, selectRecord, filterPromptRows } from './ui/prompt-view.js?v=0.7.2';
import { openApiProfiles } from './core/api-profiles.js?v=0.7.2';
import {
  callOpenAiCompatible,
  createProvider,
  listOpenAiCompatibleModels,
  requestNextPlan,
  requestNpcGenerationDecision,
  requestNpcProfile,
  requestPlayerPreferenceProfile,
  requestStoryOptions,
} from './core/api-client.js?v=0.7.2';
import { isPreferenceQuizComplete, scorePreferenceQuiz, STORY_EXPERIENCE_OPTIONS, describeTasteSettings } from './core/preference-quiz.js?v=0.7.2';
import { openArchiveStorage } from './core/storage.js?v=0.7.2';
import { SummaryEngine } from './core/summary-engine.js?v=0.7.2';
import { SemanticRecallService, fitRecall, formatRecallPrompt } from './core/semantic-recall.js?v=0.7.2';
import { keywordRecall, archiveNames } from './core/keyword-recall.js?v=0.7.2';
import { createStoryRequest, injectStoryContext, STORY_PROMPT_ID, memoryBudgetFor } from './core/story-context.js?v=0.7.2';
import {
  createArchiveShell,
  collectNpcEdits,
  collectPreferenceQuiz,
  collectStoryExperiences,
  focusLatestFloor,
  renderNpcs,
  renderModelOptions,
  renderPlayerProfile,
  renderRecallState,
  renderSnapshot,
  resetPreferenceTest,
  setOpen,
  setRetestConfirmOpen,
  setStatus,
  switchTab,
  syncSettings,
} from './ui/view.js?v=0.7.2';

const MODULE_ID = 'spring-story-archive';
let apiProfiles = null;
let modelFetchRevision = 0;
const PLAYER_PROFILE_KEY = `${MODULE_ID}::player-preference`;
const PLAYER_PROFILE_SCOPE = `${MODULE_ID}::global-player`;
const RECALL_INTERCEPTOR = 'springStoryArchiveSemanticRecallInterceptor';
const RECALL_PROMPT_ID = `${MODULE_ID}:semantic-recall`;
const PLAY_PROMPT_ID = `${MODULE_ID}:play`;
const DEFAULT_SETTINGS = Object.freeze({
  autoSummarize: true,
  // Organize floors that have no summary yet (old chats) in the background.
  autoBackfill: false,
  memoryUpdateEvery: 1,
  memoryMinTokens: 0,
  summaryContextEnabled: true,
  filterArchivedFloors: true,
  summarySource: 'current',
  rollupTokenLimit: 6000,
  remoteRawFloorLimit: 0,
  expandedFloorCount: 5,
  backfillBatchSize: 10,
  extraEndpoint: '',
  extraModel: '',
  optionMode: 'guided',
  optionCount: 6,
  optionSource: 'current',
  optionsEnabled: false,
  optionWritingNotes: '',
  preferenceNotes: '',
  preferenceQuizAnswers: {},
  storyExperiencePreferences: [],
  preferenceSource: 'current',
  autoAdvanceEnabled: false,
  uiTheme: 'chunlai',
  heroArt: 'night',
  heroImageUrl: '',
  advanceModules: null,
  preferenceGenres: [],
  preferenceTastes: {},
  preferenceMbti: '',
  advanceStrength: 'normal',
  advanceEventPool: '',
  advanceSource: 'extra',
  advanceRounds: 1,
  npcBrief: '',
  npcSource: 'current',
  autoNpcEnabled: true,
  semanticRecallEnabled: false,
  // 'auto' (vector when an embedding interface is set, else keywords) | 'keyword' | 'vector' | 'off'.
  recallMode: 'auto',
  // Ceiling, in tokens, for everything 春序 adds to a request.
  memoryTokenLimit: 20000,
  recallEmbeddingModel: '',
  recallTopK: 4,
  recallThreshold: 0.3,
  recallDepth: 4,
  // Two fixed slots. organizeProfileId '' means SillyTavern's current API.
  organizeProfileId: '',
  vectorProfileId: '',
  // 八股删除器: on by default; 'auto' cleans the reply (undoable), 'mark' only counts.
  clicheEnabled: true,
  clicheMode: 'auto',
  clicheCustomRules: '',
  // Story options are styled by SillyTavern regex scripts the extension installs.
  optionRegexEnabled: true,
  // How each floor summary is written; empty means the built-in style.
  summaryFormat: '',
});
const SOURCE_KEYS = ['summarySource', 'optionSource', 'preferenceSource', 'advanceSource', 'npcSource'];

let initialized = false;
let root = null;
let engine = null;
let recallService = null;
let subscriptions = [];
let reconcileTimer = 0;
let autoAdvanceRemaining = 0;
let advanceEpoch = 0;
let storyRequest = null;
let sendHistory = null;
let chatOptions = null;
let clicheNotes = null;
let roundInputs = null;
let clicheRuleCache = { key: null, rules: [] };
let optionsRunning = false;
let optionsPending = null;
let receivedForPostTasks = false;
let advancing = false;
let focusLatestOnNextRender = false;
let latestReadySignature = '';
let modelFetchTimer = 0;
let postGenerationTimer = 0;
let npcCheckRunning = false;
let resetFloorDisclosureOnNextRender = false;
let recallState = { indexedCount: 0, recalledFloors: [], error: '', phase: 'disabled' };
const pendingSummaryFloors = new Set();

function profileKey(chatKey, kind) {
  return `${chatKey}::profile::${kind}`;
}

// Per-chat push state: main-line goal, the next round's plan, what was pushed.
async function loadAdvanceState(chatKey = engine?.chatKey) {
  if (!chatKey) return normalizeAdvanceState(null);
  return normalizeAdvanceState(await engine.storage.getProfile(profileKey(chatKey, 'advance-state')), chatKey);
}

async function saveAdvanceState(state, chatKey = engine?.chatKey) {
  if (!chatKey) return;
  const { directive, continuityCheck, ...rest } = state;
  await engine.storage.putProfile({ ...rest, key: profileKey(chatKey, 'advance-state'), chatKey, kind: 'advance-state', updatedAt: new Date().toISOString() });
}

function nextReplyFloor(chat) {
  return chat.length && chat.at(-1)?.is_user ? chat.length : chat.length + 1;
}

// Only the organizing call that covers the newest floors plans the next round.
async function getAdvanceWatch(batch) {
  const settings = getSettings();
  if (!settings.autoAdvanceEnabled || !engine?.chatKey) return null;
  const chat = getContext().chat ?? [];
  if (Math.max(...batch) < lastReplyBefore(chat, chat.length)) return null;
  return advanceWatch(await loadAdvanceState(), settings, { tastes: describeTastes(settings), strengthText: STRENGTH[settings.advanceStrength] ?? STRENGTH.normal });
}

async function onAdvancePlan(next, afterFloor) {
  const chatKey = engine?.chatKey;
  const settings = getSettings();
  if (!chatKey || !settings.autoAdvanceEnabled) return;
  const state = await loadAdvanceState(chatKey);
  if (['player', 'reroll'].includes(state.plan?.source) && Number(state.plan.afterFloor) >= afterFloor) return;
  const plan = normalizeNextPlan(next, { modules: settings.advanceModules, afterFloor, eventPool: advanceWatch(state, settings).eventPool });
  if (!plan) return;
  await saveAdvanceState({ ...state, plan }, chatKey);
}

// What the home page shows for the coming round.
function describeNextPush(state, database) {
  const settings = getSettings();
  if (!settings.autoAdvanceEnabled) return { enabled: false };
  const chat = getContext().chat ?? [];
  const current = normalizeAdvanceState(state);
  const round = planRound({ state: current, chat, replyFloor: nextReplyFloor(chat), database, settings });
  const text = round.text || buildAdvanceInstruction(database, {
    modules: settings.advanceModules, eventPool: settings.advanceEventPool, usedEvents: current.usedEvents, ways: round.ways,
    latestFloor: chat.length - 1,
    recentPlayerTexts: chat.filter((message) => message.is_user).slice(-3).map((message) => message.mes),
  }).split('\n').filter((line) => line.startsWith('- ') && !line.startsWith('- 推进节奏')).map((line) => line.slice(2)).join('\n');
  return { enabled: true, round, text, goal: current.goal, history: current.history, usedEvents: current.usedEvents };
}

async function getPlayerPreferenceProfile(chatKey = engine?.chatKey) {
  const globalProfile = await engine.storage.getProfile(PLAYER_PROFILE_KEY);
  if (globalProfile?.summary) return globalProfile;
  if (!chatKey) return null;
  const legacyProfile = await engine.storage.getProfile(profileKey(chatKey, 'player-preference'));
  if (!legacyProfile?.summary) return null;
  const migrated = {
    ...legacyProfile,
    key: PLAYER_PROFILE_KEY,
    chatKey: PLAYER_PROFILE_SCOPE,
    migratedFromChatKey: chatKey,
  };
  await engine.storage.putProfile(migrated);
  return migrated;
}

function getContext() {
  const context = globalThis.SillyTavern?.getContext?.();
  if (!context) throw new Error('春序档案无法连接 SillyTavern。');
  return context;
}

function getSettings() {
  const context = getContext();
  const previous = context.extensionSettings?.[MODULE_ID] ?? {};
  const merged = { ...DEFAULT_SETTINGS, ...previous };
  merged.preferenceQuizAnswers = { ...DEFAULT_SETTINGS.preferenceQuizAnswers, ...(previous.preferenceQuizAnswers ?? {}) };
  merged.storyExperiencePreferences = Array.isArray(previous.storyExperiencePreferences)
    ? [...previous.storyExperiencePreferences]
    : [];
  if (merged.optionMode === 'immersion') merged.optionMode = 'guided';
  if (merged.optionMode === 'novel') merged.optionMode = 'scene';
  merged.optionCount = normalizeOptionCount(merged.optionCount);
  merged.preferenceGenres = Array.isArray(previous.preferenceGenres) ? [...previous.preferenceGenres] : [];
  merged.preferenceTastes = { ...(previous.preferenceTastes ?? {}) };
  merged.tasteLine = describeTasteSettings({ genres: merged.preferenceGenres, tastes: merged.preferenceTastes, mbti: merged.preferenceMbti });
  merged.advanceModules = Array.isArray(previous.advanceModules) ? previous.advanceModules.filter((id) => ADVANCE_MODULES.some((module) => module.id === id)) : [...DEFAULT_ADVANCE_MODULES];
  merged.memoryTokenLimit = Math.max(1000, Math.min(1000000, Math.round(Number(merged.memoryTokenLimit) || 20000)));
  // Earlier versions stored a count and a writing style; turn them into the
  // editable categories once, keeping what the player had chosen.
  if (!Array.isArray(previous.optionSlots)) merged.optionSlots = presetSlots(merged.optionCount, merged.optionMode);
  if (previous.optionRulesVersion !== 2) {
    merged.optionWritingNotes = [DEFAULT_OPTION_RULES, String(previous.optionWritingNotes ?? '').trim()].filter(Boolean).join('\n');
    merged.optionRulesVersion = 2;
  }
  merged.remoteRawFloorLimit = [0, 1, 3, 5].includes(Number(merged.remoteRawFloorLimit))
    ? Number(merged.remoteRawFloorLimit)
    : 0;
  delete merged.npcFunction;
  if (apiProfiles) {
    const profile = apiProfiles.active();
    Object.assign(merged, { extraEndpoint: profile.endpoint, extraModel: profile.model, recallEmbeddingModel: profile.embeddingModel });
    // v0.7.1 let each feature choose "current" or "extra" separately. The first
    // load after upgrading turns that into the two slots, keeping the old intent.
    if (previous.organizeProfileId === undefined) {
      merged.organizeProfileId = SOURCE_KEYS.some((key) => previous[key] === 'extra') ? profile.id : '';
    }
    if (previous.vectorProfileId === undefined) merged.vectorProfileId = profile.id;
    if (merged.organizeProfileId && !apiProfiles.get(merged.organizeProfileId)) merged.organizeProfileId = '';
    if (!apiProfiles.get(merged.vectorProfileId)) merged.vectorProfileId = profile.id;
    const vector = apiProfiles.get(merged.vectorProfileId);
    Object.assign(merged, { vectorEndpoint: vector?.endpoint ?? '', vectorEmbeddingModel: vector?.embeddingModel ?? '' });
  }
  // Earlier versions had a single vector switch; keep what the player chose.
  if (!['auto', 'off', 'keyword', 'vector'].includes(previous.recallMode)) merged.recallMode = 'auto';
  merged.semanticRecallEnabled = merged.recallMode === 'vector' || (merged.recallMode === 'auto' && Boolean(merged.vectorEndpoint && merged.vectorEmbeddingModel));
  const organizeSource = merged.organizeProfileId ? 'extra' : 'current';
  for (const key of SOURCE_KEYS) merged[key] = organizeSource;
  context.extensionSettings[MODULE_ID] = merged;
  return merged;
}

function saveSettings() {
  getContext().saveSettingsDebounced?.();
}

function getApiKey() {
  return apiProfiles?.active().apiKey ?? '';
}

function setApiKey(value) {
  apiProfiles.update({ apiKey: value });
}

function refreshApiProfiles() {
  const selector = root.querySelector('[data-api-profile="select"]');
  selector.replaceChildren(...apiProfiles.list().map(({ id, name }) => new Option(name, id)));
  selector.value = apiProfiles.active().id;
  root.querySelector('[data-api-profile="name"]').value = apiProfiles.active().name;
  root.querySelector('[data-role="delete-api-confirm"]').hidden = true;
  refreshSlotSelectors();
  syncSettings(root, getSettings(), getApiKey());
  renderOptionSlots(root, getSettings().optionSlots ?? []);
}

function onApiProfileChanged() {
  refreshApiProfiles();
  clearRecallPrompt();
  scheduleModelRefresh();
  setStatus(root, `正在编辑“${apiProfiles.active().name}”`);
}

// Credentials for the 整理 slot; every organizing request (summary, tables,
// player notes, NPC, preference analysis) goes through this one profile.
function getExtraCredentials() {
  const settings = getSettings();
  const profile = (settings.organizeProfileId && apiProfiles?.get(settings.organizeProfileId)) || apiProfiles?.active();
  return { endpoint: profile?.endpoint ?? '', model: profile?.model ?? '', apiKey: profile?.apiKey ?? '' };
}

// Exact token counts when the host offers them; otherwise an estimate, labelled so.
async function countTokens(text) {
  const context = getContext();
  if (typeof context.getTokenCountAsync === 'function') {
    try { return { value: await context.getTokenCountAsync(text), exact: true }; } catch {}
  }
  return { value: estimateTokens(text), exact: false };
}

function showRound() {
  if (!root || !roundInputs) return;
  const { snapshot, sends } = roundInputs;
  const chat = getContext().chat;
  // The prompt carries cleaned replies, so floors are matched on that text.
  const floorTexts = chat.map((message) => (message.is_user ? String(message.mes ?? '') : splitOptionsBlock(message.mes).story));
  renderPromptViewer(root, { records: sends ?? [], chat, floorTexts, database: snapshot.memory, countTokens });
}

function showRecallState() {
  renderRecallState(root, recallState);
  renderOverview(root, { recall: recallState, settings: getSettings() });
}

function openSettingsGroup(group, focusSelector) {
  switchTab(root, 'settings');
  const details = root.querySelector(`[data-group="${group}"]`);
  if (!details) return;
  details.open = true;
  const target = (focusSelector && details.querySelector(focusSelector)) || details;
  requestAnimationFrame(() => target.scrollIntoView({ block: 'start', behavior: 'smooth' }));
}

// Credentials for the 向量 slot, independent of the profile being edited.
function getRecallCredentials() {
  const settings = getSettings();
  const profile = apiProfiles?.get(settings.vectorProfileId) || apiProfiles?.active();
  return {
    profileId: profile?.id ?? '',
    endpoint: profile?.endpoint ?? '',
    apiKey: profile?.apiKey ?? '',
    embeddingModel: profile?.embeddingModel ?? '',
  };
}

function refreshSlotSelectors() {
  const settings = getSettings();
  const profiles = apiProfiles.list();
  const organize = root.querySelector('[data-setting="organizeProfileId"]');
  const vector = root.querySelector('[data-setting="vectorProfileId"]');
  if (organize) {
    organize.replaceChildren(new Option('酒馆当前 API', ''), ...profiles.map(({ id, name }) => new Option(name, id)));
    organize.value = settings.organizeProfileId;
  }
  if (vector) {
    vector.replaceChildren(...profiles.map(({ id, name }) => new Option(name, id)));
    vector.value = settings.vectorProfileId;
  }
}

function clearRecallPrompt(context = null) {
  try {
    const current = context ?? getContext();
    current.setExtensionPrompt?.(RECALL_PROMPT_ID, '', 1, Number(getSettings().recallDepth || 4), false, 0);
  } catch {}
}

function clearStoryPrompt() {
  const previous = storyRequest;
  storyRequest = null;
  previous?.cancel();
  sendHistory?.finish('stopped');
  sendHistory = null;
  getContext().setExtensionPrompt?.(STORY_PROMPT_ID, '', 1, 0, false, 0);
}

function finishStoryRequest(status = 'interrupted') {
  sendHistory?.finish(status);
  sendHistory = null;
  storyRequest?.finish();
  storyRequest = null;
  clearStoryPrompt();
  clearRecallPrompt();
}

function onFinalPrompt(data, dryRun) {
  storyRequest?.verify(data, dryRun);
  if (dryRun || !sendHistory) return;
  const messages = normalizeFinalPrompt(data?.prompt ?? data?.input);
  if (!messages) return;
  const ledger = sendHistory;
  const chatKey = engine?.chatKey;
  ledger.final(messages);
  void ledger.idle().then(() => (chatKey ? pruneFinalPrompts(engine.storage, chatKey) : null)).catch(() => {});
}

function captureChatTask() {
  const owner = engine;
  const chatKey = currentChatKey();
  const revision = owner.chatRevision;
  const signature = getContext().chat.map(fingerprintMessage).join('|');
  return {
    chatKey,
    isCurrent: () => engine === owner && owner.chatKey === chatKey && owner.chatRevision === revision
      && currentChatKey() === chatKey && getContext().chat.map(fingerprintMessage).join('|') === signature,
  };
}

function showStoryContextStatus(text) {
  const status = root?.querySelector('[data-role="story-context-status"]');
  if (status) status.textContent = text;
}

function currentChatKey(context = getContext()) {
  const runtimeId = context.getCurrentChatId?.() ?? context.chatId;
  if (runtimeId !== undefined && runtimeId !== null && String(runtimeId).trim()) return String(runtimeId);
  if (context.groupId !== undefined && context.groupId !== null) return `group:${context.groupId}:unsaved`;
  if (context.characterId !== undefined && context.characterId !== null) return `character:${context.characterId}:unsaved`;
  return '';
}

function requestLatestSummaryFocus() {
  focusLatestOnNextRender = true;
}

function focusLatestSummary() {
  if (!root?.classList.contains('is-open')) return;
  if (!root.querySelector('.ssa-page[data-page="summary"]')?.classList.contains('is-active')) return;
  const behavior = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
  focusLatestFloor(root, { behavior });
}

async function refreshView() {
  if (!root || !engine) return;
  const chatKey = engine.chatKey;
  const [snapshot, playerProfile, advanceState, npcs, sends] = await Promise.all([
    engine.getSnapshot(),
    getPlayerPreferenceProfile(chatKey),
    chatKey ? engine.storage.getProfile(profileKey(chatKey, 'advance-state')) : null,
    chatKey ? engine.storage.listNpcs(chatKey) : [],
    chatKey ? engine.storage.listSendRecords(chatKey) : [],
  ]);
  if (!root || !engine || engine.chatKey !== chatKey) return;
  const latest = snapshot.summaries.at(-1);
  const readySignature = latest?.status === 'ready'
    ? `${chatKey}:${latest.floorIndex}:${latest.messageFingerprint}:${latest.updatedAt}`
    : '';
  const shouldFocusLatest = focusLatestOnNextRender
    || Boolean(readySignature && readySignature !== latestReadySignature);
  const settings = getSettings();
  renderSnapshot(root, snapshot, {
    expandedFloorCount: settings.expandedFloorCount,
    resetDisclosure: resetFloorDisclosureOnNextRender,
  });
  renderMemoryDatabase(root, snapshot.memory);
  renderTablePages(root, snapshot.memory);
  renderSendHistory(root, sends, snapshot.memory);
  renderOverview(root, { summaries: snapshot.summaries, sends, settings, recall: recallState });
  roundInputs = { snapshot, sends };
  showRound();
  resetFloorDisclosureOnNextRender = false;
  renderPlayerProfile(root, playerProfile);
  renderPushCard(root, describeNextPush(advanceState, snapshot.memory));
  const sceneRow = snapshot.memory?.tables?.scene?.[0]?.values ?? {};
  const heroContext = getContext();
  renderHero(root, {
    floor: (heroContext.chat ?? []).filter((message) => !message.is_system).length,
    scene: [sceneRow.time, sceneRow.location].filter(Boolean).join('，'),
    chat: String(heroContext.name2 ?? heroContext.groupId ?? '').trim(),
  });
  renderNpcs(root, npcs);
  showRecallState();
  syncSettings(root, settings, getApiKey());
  focusLatestOnNextRender = false;
  latestReadySignature = readySignature;
  if (shouldFocusLatest) window.requestAnimationFrame(focusLatestSummary);
}

async function switchCurrentChat({ queueMissing = false } = {}) {
  const chatKey = currentChatKey();
  const changed = engine.chatKey !== chatKey;
  engine.setChat(chatKey);
  if (changed) {
    receivedForPostTasks = false;
    chatOptions?.show(null);
    latestReadySignature = '';
    recallState = {
      indexedCount: 0,
      recalledFloors: [],
      error: '',
      phase: recallOn() ? 'armed' : 'disabled',
    };
    clearRecallPrompt();
    clearStoryPrompt();
    showStoryContextStatus('等待下次回复前读取当前聊天的剧情总摘要');
  }
  if (!chatKey) {
    setStatus(root, '请先打开一个聊天', 'warning');
    await refreshView();
    return;
  }
  await engine.reconcile({ queueMissing });
  await restoreChatOptions();
  setStatus(root, '本地档案已同步');
  void runAutoBackfill();
}

// Old chats get organized without a button: one batch at a time, in the
// background, stopping as soon as the chat changes or the setting is turned off.
let autoBackfillRunning = false;
async function runAutoBackfill() {
  if (autoBackfillRunning || !getSettings().autoBackfill || !getSettings().autoSummarize || !engine?.chatKey) return;
  autoBackfillRunning = true;
  const task = captureChatTask();
  try {
    for (let round = 0; round < 500; round += 1) {
      await engine.waitForIdle();
      if (!task.isCurrent() || !getSettings().autoBackfill) return;
      const result = await engine.backfill(getSettings().backfillBatchSize);
      if (result.busy) { await new Promise((resolve) => setTimeout(resolve, 1500)); continue; }
      if (!result.queuedCount) return;
      setStatus(root, `正在自动整理旧楼层，剩余 ${result.remainingCount} 楼`);
      await engine.waitForIdle();
      if (!result.remainingCount) { setStatus(root, '旧楼层已全部整理'); return; }
    }
  } catch (error) {
    setStatus(root, `自动整理旧楼层暂停：${error.message}`, 'error');
  } finally {
    autoBackfillRunning = false;
  }
}

// Genre and taste picks from the preference page, as one short line.
function describeTastes(settings) {
  return describeTasteSettings({ genres: settings.preferenceGenres, tastes: settings.preferenceTastes, mbti: settings.preferenceMbti });
}

function recallOn() {
  return getSettings().recallMode !== 'off';
}

function vectorReady() {
  const credentials = getRecallCredentials();
  return Boolean(credentials.endpoint && credentials.embeddingModel && recallService);
}

// Keyword recall needs nothing but the archive: names it knows, matched against
// the latest few floors.
async function keywordRecallForCurrentContext({ type, phase = 'matched', note = '' } = {}) {
  const settings = getSettings();
  const context = getContext();
  const task = captureChatTask();
  const targetFloorIndex = context.chat.length - (type === 'swipe' ? 2 : 1);
  if (targetFloorIndex < 0) return { indexedCount: 0, records: [], prompt: '' };
  const snapshot = await engine.getSnapshot();
  if (!task.isCurrent()) return { indexedCount: 0, records: [], prompt: '' };
  const summaries = validSummaries(applyNarrativeEdits(snapshot.summaries, snapshot.memoryEdits, targetFloorIndex), context.chat);
  const query = context.chat.slice(0, targetFloorIndex + 1).filter((message) => !message.is_system).slice(-2).map((message) => splitOptionsBlock(message.mes).story).join('\n');
  const records = keywordRecall(summaries, { query, names: archiveNames(snapshot.memory), topK: settings.recallTopK, latestFloorIndex: targetFloorIndex });
  recallState = { indexedCount: summaries.length, recalledFloors: records.map((record) => record.floorIndex), error: '', phase, mode: 'keyword', note };
  showRecallState();
  return { indexedCount: summaries.length, records, prompt: formatRecallPrompt(records) };
}

async function recallForCurrentContext({ force = false, phase = 'matched', type } = {}) {
  const settings = getSettings();
  if (!recallOn() || !engine?.chatKey) return { indexedCount: 0, records: [], prompt: '' };
  if (settings.recallMode === 'keyword') return keywordRecallForCurrentContext({ type, phase });
  if (!vectorReady()) return keywordRecallForCurrentContext({ type, phase, note: settings.recallMode === 'vector' ? '向量接口没设好，这次用关键词回忆' : '' });
  try { return await vectorRecallForCurrentContext({ force, phase, type }); }
  catch (error) { return keywordRecallForCurrentContext({ type, phase, note: `向量回忆失败（${error.message}），这次用关键词回忆` }); }
}

async function vectorRecallForCurrentContext({ force = false, phase = 'matched', type } = {}) {
  const settings = getSettings();
  const context = getContext();
  const task = captureChatTask();
  const targetFloorIndex = context.chat.length - (type === 'swipe' ? 2 : 1);
  if (targetFloorIndex < 0) return { indexedCount: 0, records: [], prompt: '' };
  const snapshot = await engine.getSnapshot();
  if (!task.isCurrent()) return { indexedCount: 0, records: [], prompt: '' };
  const result = await recallService.recall({
    chatKey: task.chatKey,
    summaries: applyNarrativeEdits(snapshot.summaries, snapshot.memoryEdits, targetFloorIndex),
    chat: context.chat,
    targetFloorIndex,
    topK: settings.recallTopK,
    threshold: settings.recallThreshold,
    recentRawFloorLimit: settings.remoteRawFloorLimit,
    force,
  });
  if (!task.isCurrent()) return { indexedCount: 0, records: [], prompt: '' };
  recallState = {
    indexedCount: result.indexedCount,
    recalledFloors: result.records.map((record) => record.floorIndex),
    error: '',
    phase,
    mode: 'vector',
    note: '',
  };
  showRecallState();
  return result;
}

async function addSemanticRecall(payload) {
  const task = captureChatTask();
  queuePendingSummaries({ force: true });
  await engine.waitForIdle();
  if (!task.isCurrent()) throw new Error('聊天已变化，请重新执行。');
  const snapshot = await engine.getSnapshot();
  if (!task.isCurrent()) throw new Error('聊天已变化，请重新执行。');
  const latestPlot = getContext().chat.findLastIndex((message) => !message.is_system && !isControlMessage(message));
  const ready = validSummaries(snapshot.summaries, getContext().chat);
  if (latestPlot >= 0 && !ready.some((record) => record.floorIndex === latestPlot)) {
    throw new Error('最新剧情还没有成功入档，请先同步记忆；选项与推进将等待有效的剧情信息。');
  }
  payload = { ...payload, rollingSummary: truncateToTokenBudget(snapshot.rollup?.text ?? '', 2400),
    currentMemory: formatMemoryDatabase(snapshot.memory, { budget: 1600, query: getContext().chat.slice(-5).map((message) => message.mes).join('\n') }) };
  if (!recallOn()) return payload;
  try {
    const result = await recallForCurrentContext({ phase: 'feature' });
    return { ...payload, semanticRecall: result.prompt || '' };
  } catch (error) {
    recallState = { ...recallState, recalledFloors: [], error: error.message, phase: 'error' };
    showRecallState();
    return { ...payload, semanticRecall: '' };
  }
}

// Options and push ride inside the main reply as one short instruction at the
// end of the prompt; nothing extra is requested from any API.
async function setPlayPrompt(type) {
  const context = getContext();
  const settings = getSettings();
  const parts = [];
  if (type !== 'impersonate') {
    if (settings.optionsEnabled) parts.push(buildOptionsInstruction({ slots: settings.optionSlots, notes: settings.optionWritingNotes }));
    if (settings.autoAdvanceEnabled && engine?.chatKey) {
      const chatKey = engine.chatKey;
      const [memory, profile, state] = await Promise.all([engine.getMemory().catch(() => null), getPlayerPreferenceProfile().catch(() => null), loadAdvanceState(chatKey)]);
      const chat = context.chat;
      const isSwipe = type === 'swipe' || type === 'regenerate';
      const replyFloor = type === 'swipe' ? chat.length - 1 : chat.length;
      const round = planRound({ state, chat, replyFloor, isSwipe, database: memory, settings });
      if (round.source !== 'skip') {
        const advance = buildAdvanceInstruction(memory, {
          modules: settings.advanceModules, strength: settings.advanceStrength, eventPool: settings.advanceEventPool,
          usedEvents: state.usedEvents, ways: round.ways, plan: round.text, goal: state.goal,
          latestFloor: replyFloor - 1,
          recentPlayerTexts: chat.slice(0, replyFloor).filter((message) => message.is_user).slice(-3).map((message) => message.mes),
          playerProfileSummary: profile?.summary ?? '',
          tastes: describeTastes(settings),
        });
        if (advance) parts.push(advance);
      }
      await saveAdvanceState(recordRound(state, round, replyFloor), chatKey).catch(() => {});
    }
  }
  context.setExtensionPrompt?.(PLAY_PROMPT_ID, parts.join('\n\n'), 1, 0, false, 0);
}

async function semanticRecallInterceptor(chat, contextSize, abort, type) {
  if (type === 'quiet') return;
  finishStoryRequest();
  const original = [...chat];
  const chatKey = currentChatKey();
  const signature = getContext().chat.map(fingerprintMessage).join('|');
  const { summaryContextEnabled, filterArchivedFloors } = getSettings();
  const isCurrent = () => currentChatKey() === chatKey && getContext().chat.map(fingerprintMessage).join('|') === signature
    && getSettings().summaryContextEnabled === summaryContextEnabled && getSettings().filterArchivedFloors === filterArchivedFloors;
  const ledger = createSendHistory({ storage: engine.storage, chatKey, chat: getContext().chat, promptChat: chat, type, onChange: async (error) => {
    if (!root) return;
    if (error) { setStatus(root, `发送记录保存失败：${error.message}`, 'error'); return; }
    if (root && engine?.chatKey === chatKey) { const sends = await engine.storage.listSendRecords(chatKey); renderSendHistory(root, sends, roundInputs?.snapshot?.memory); renderOverview(root, { sends }); if (roundInputs) { roundInputs = { ...roundInputs, sends }; showRound(); } }
  } });
  sendHistory = ledger;
  const request = createStoryRequest({ context: getContext(), promptChat: chat, abort, isCurrent, onStatus: showStoryContextStatus, onEvidence: ledger.evidence });
  request.recordPlan = (plan, filter) => ledger.plan(plan, filter);
  request.recordRecall = (prompt, records) => ledger.recall(prompt, records);
  request.recordBudget = (budget) => ledger.budget(budget);
  storyRequest = request;
  try {
    await prepareArchivePrompt(chat, contextSize, abort, type, request);
    try { await setPlayPrompt(type); } catch (error) { setStatus(root, `选项或推进提示没能加入：${error.message}`, 'warning'); }
    const context = getContext();
    context.eventSource?.makeLast?.((context.eventTypes ?? context.event_types)?.GENERATE_AFTER_DATA, onFinalPrompt);
  } finally {
    const settings = getSettings();
    if (currentChatKey() !== chatKey || getContext().chat.map(fingerprintMessage).join('|') !== signature
      || settings.summaryContextEnabled !== summaryContextEnabled || settings.filterArchivedFloors !== filterArchivedFloors) {
      chat.splice(0, chat.length, ...original);
      clearStoryPrompt();
      clearRecallPrompt();
      showStoryContextStatus('聊天或设置已变化，本轮已停止；请重新发送');
      abort(true);
    }
  }
}

async function prepareArchivePrompt(chat, contextSize, abort, type, request) {
  const context = getContext();
  const chatKey = currentChatKey(context);
  let storyPlan = null;
  const memoryBudget = memoryBudgetFor(contextSize, getSettings().memoryTokenLimit);
  try {
    const settings = getSettings();
    const canGuard = typeof context.stopGeneration === 'function'
      && Boolean((context.eventTypes ?? context.event_types)?.GENERATE_AFTER_DATA);
    const status = await injectStoryContext({
      context, storage: engine.storage, chatKey, promptChat: chat, contextSize, type,
      enabled: settings.summaryContextEnabled,
      filter: settings.filterArchivedFloors && canGuard,
      memoryBudget,
      onPlan: (plan) => { storyPlan = plan; if (canGuard) request.plan(plan); request.recordPlan?.(plan, settings.filterArchivedFloors && canGuard); },
      isCurrent: () => currentChatKey() === chatKey && getSettings().summaryContextEnabled
        && getSettings().filterArchivedFloors === settings.filterArchivedFloors,
    });
    showStoryContextStatus(status);
  } catch (error) {
    finishStoryRequest();
    showStoryContextStatus(`总摘要读取失败，保留原文：${error.message}`);
  }
  if (!recallOn() || !engine?.chatKey || type === 'quiet') {
    clearRecallPrompt(context);
    recallState = { ...recallState, recalledFloors: [], error: '', phase: recallOn() ? 'armed' : 'disabled' };
    showRecallState();
    return;
  }
  try {
    if (typeof context.setExtensionPrompt !== 'function') throw new Error('当前酒馆版本不支持生成前注入。');
    recallState = { ...recallState, recalledFloors: [], error: '', phase: 'preparing' };
    showRecallState();
    const found = await recallForCurrentContext({ phase: 'preparing', type });
    // Skip floors the prompt already carries, then fit the rest into what is left of the budget.
    const rows = context.chat.filter((message) => !message.is_system || Array.isArray(message.extra?.tool_invocations));
    const skipFloors = new Set([...(storyPlan?.includedFloors ?? []), ...chat.map((item) => rows[item?.index]?.floorIndex).filter(Number.isInteger)]);
    const result = { ...found, ...fitRecall(found.records, { skipFloors, budget: Math.max(0, memoryBudget - (storyPlan?.usedTokens ?? 0)), estimate: estimateTokens }) };
    request.recordBudget?.({ limit: memoryBudget, story: storyPlan?.usedTokens ?? 0, recall: result.usedTokens, dropped: result.dropped });
    if (currentChatKey() !== chatKey) {
      clearStoryPrompt();
      clearRecallPrompt(context);
      abort(true);
      return;
    }
    if (!recallOn()) {
      clearRecallPrompt(context);
      return;
    }
    context.setExtensionPrompt?.(
      RECALL_PROMPT_ID,
      result.prompt,
      1,
      Number(getSettings().recallDepth || 4),
      false,
      0,
    );
    request.recordRecall?.(result.prompt, result.records);
    request.recallPlan?.(result.prompt);
    recallState = {
      ...recallState,
      phase: result.prompt ? 'injected' : 'empty',
      recalledFloors: result.records.map((record) => record.floorIndex),
      error: '',
    };
    showRecallState();
  } catch (error) {
    clearRecallPrompt(context);
    recallState = { ...recallState, recalledFloors: [], error: error.message, phase: 'error' };
    showRecallState();
  }
}

function scheduleReconcile({ queueMissing = false } = {}) {
  window.clearTimeout(reconcileTimer);
  reconcileTimer = window.setTimeout(() => {
    void switchCurrentChat({ queueMissing }).catch((error) => setStatus(root, error.message, 'error'));
  }, 80);
}

function subscribe(eventName, handler) {
  const context = getContext();
  const events = context.eventTypes ?? context.event_types;
  const event = events?.[eventName];
  if (!event) return;
  context.eventSource.on(event, handler);
  subscriptions.push([event, handler]);
}

function messageIndexFromEvent(value) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric >= 0 ? numeric : getContext().chat.length - 1;
}

async function onMessageSent(messageId) {
  const settings = getSettings();
  // Push now happens inside each reply; there are no extra automatic rounds.
  autoAdvanceRemaining = 0;
  requestLatestSummaryFocus();
  scheduleReconcile({ queueMissing: false });
  const floorIndex = messageIndexFromEvent(messageId);
  if (settings.autoSummarize) pendingSummaryFloors.add(floorIndex);
}

function clicheRules() {
  const custom = getSettings().clicheCustomRules ?? '';
  if (clicheRuleCache.key !== custom) clicheRuleCache = { key: custom, rules: compileRules(custom) };
  return clicheRuleCache.rules;
}

function clicheActive(message) {
  return Boolean(getSettings().clicheEnabled) && message && !message.is_user && !message.is_system;
}

function saveChatQuietly() {
  const context = getContext();
  void (context.saveChatDebounced?.() ?? context.saveChat?.());
}

// Notes for one exact text of a reply (each swipe and each edit has its own):
// { original, removed, rewritten } after cleaning, or { skip, cleaned } after undo.
function clicheVersions(message) {
  message.extra = message.extra ?? {};
  const state = message.extra.ssa_cliche;
  if (!state?.versions) message.extra.ssa_cliche = { versions: {} };
  return message.extra.ssa_cliche.versions;
}

function clicheVersion(message) {
  return message?.extra?.ssa_cliche?.versions?.[textHash(message.mes)] ?? null;
}

// Write text into the reply: current swipe, page and chat file. The notes kept
// for the old text move with it so undo still finds the original.
function writeMessageText(index, text, { note } = {}) {
  const context = getContext();
  const message = context.chat[index];
  if (!message || message.mes === text) return;
  const versions = clicheVersions(message);
  const oldKey = textHash(message.mes);
  const carried = note ?? versions[oldKey];
  delete versions[oldKey];
  if (carried) versions[textHash(text)] = carried;
  message.mes = text;
  if (Array.isArray(message.swipes) && Number.isInteger(message.swipe_id) && message.swipe_id < message.swipes.length) message.swipes[message.swipe_id] = text;
  try { context.updateMessageBlock?.(index, message); } catch {}
  saveChatQuietly();
  clicheNotes?.refresh();
}

// A new reply is cleaned once, right after it arrives. The options block is left alone.
function cleanReceivedReply(index) {
  const message = getContext().chat[index];
  if (!clicheActive(message) || getSettings().clicheMode !== 'auto' || clicheVersion(message)) return;
  const { story, block } = splitOptionsBlock(message.mes);
  const { text, removed } = cleanLocally(story, clicheRules());
  if (!removed) return;
  writeMessageText(index, `${text}${block}`, { note: { original: message.mes, removed, rewritten: 0 } });
}

function clicheSentencesFor(message) {
  if (!clicheActive(message) || getSettings().clicheMode !== 'auto' || clicheVersion(message)?.skip) return [];
  return sentencesToRewrite(splitOptionsBlock(message.mes).story, clicheRules());
}

// Rewrites from the organizing call go straight into the reply. The returned
// fingerprint lets the archive follow the new text without organizing it again.
async function applyFloorRewrites(index, rewrites) {
  const message = getContext().chat[index];
  if (!clicheActive(message) || getSettings().clicheMode !== 'auto' || clicheVersion(message)?.skip) return null;
  const { story, block } = splitOptionsBlock(message.mes);
  const { text, applied } = applyRewrites(story, rewrites);
  if (!applied) return null;
  const before = clicheVersion(message);
  writeMessageText(index, `${text}${block}`, { note: { original: before?.original ?? message.mes, removed: before?.removed ?? 0, rewritten: (before?.rewritten ?? 0) + applied } });
  return fingerprintMessage(message, index);
}

function describeReply(index) {
  const message = getContext().chat[index];
  if (!clicheActive(message)) return null;
  const rules = clicheRules();
  const { story } = splitOptionsBlock(message.mes);
  if (getSettings().clicheMode === 'mark') return { mode: 'mark', hits: summarizeHits(scanCliches(story, rules)) };
  const version = clicheVersion(message);
  if (version?.skip) return { mode: 'auto', skipped: true };
  if (!version?.original) return null;
  return { mode: 'auto', removed: version.removed, rewritten: version.rewritten, pending: version.rewritten ? 0 : sentencesToRewrite(story, rules).length };
}

// Undo puts the original back into the chat and remembers the cleaned text for redo.
function undoClicheCleanup(index) {
  const message = getContext().chat[index];
  const version = clicheVersion(message);
  if (!version?.original) return;
  writeMessageText(index, version.original, { note: { skip: true, cleaned: message.mes, removed: version.removed, rewritten: version.rewritten } });
  scheduleReconcile({ queueMissing: false });
  setStatus(root, `第 ${index + 1} 楼已恢复原文，这一版回复不再清理`);
}

function redoClicheCleanup(index) {
  const message = getContext().chat[index];
  const version = clicheVersion(message);
  if (!version?.skip || typeof version.cleaned !== 'string') return;
  writeMessageText(index, version.cleaned, { note: { original: message.mes, removed: version.removed ?? 0, rewritten: version.rewritten ?? 0 } });
  scheduleReconcile({ queueMissing: false });
  setStatus(root, `第 ${index + 1} 楼重新用回清理后的版本`);
}

// The reply carries its own options block; move it out of the text into the
// message's extra data and show it as buttons under the reply.
// Regex beautification needs the host's regex extension. When it is off the
// block is taken out of the reply and shown in the extension's own panel.
function optionRegexActive() {
  const context = getContext();
  return Boolean(getSettings().optionRegexEnabled) && !context.extensionSettings?.disabledExtensions?.includes('regex');
}

const OPTION_SCRIPT_IDS = new Set(optionRegexScripts().map((script) => script.id));

// Install the regex scripts once; later edits made in the host's regex panel
// are kept. reset=true puts the default scripts back.
function syncOptionRegex({ reset = false } = {}) {
  const context = getContext();
  const settings = context.extensionSettings;
  if (!settings) return;
  const list = Array.isArray(settings.regex) ? settings.regex : [];
  const wanted = getSettings().optionsEnabled && getSettings().optionRegexEnabled;
  let next = reset ? list.filter((script) => !OPTION_SCRIPT_IDS.has(script.id)) : [...list];
  if (wanted) {
    for (const script of optionRegexScripts()) if (!next.some((item) => item.id === script.id)) next.push(script);
  } else {
    next = next.filter((script) => !OPTION_SCRIPT_IDS.has(script.id));
  }
  if (next.length === list.length && next.every((item, index) => item === list[index])) return;
  settings.regex = next;
  context.saveSettingsDebounced?.();
}

function takeReplyOptions(index) {
  const message = getContext().chat[index];
  if (!message || message.is_user) return;
  const { text, options } = extractOptions(message.mes);
  if (text === message.mes) return;
  message.extra = message.extra ?? {};
  if (options.length) message.extra.ssa_options = options;
  if (optionRegexActive()) {
    // Keep the block: the display regex styles it and the prompt regex keeps it out of requests.
    saveChatQuietly();
    chatOptions?.show(null);
    return;
  }
  writeMessageText(index, text);
  if (options.length && getSettings().optionsEnabled) chatOptions?.show({ floorIndex: index, options });
}

// Clicks inside the regex-rendered card. Classes arrive prefixed with "custom-".
function onChatOptionClick(event) {
  const option = event.target.closest?.('#chat .custom-chunxu-opt');
  if (option) {
    try { chooseOption((option.querySelector('.custom-chunxu-opt-text') ?? option).textContent.trim()); } catch (error) { setStatus(root, error.message, 'error'); return; }
    option.closest('.custom-chunxu-options-list')?.querySelectorAll('.custom-chunxu-opt').forEach((item) => item.classList.toggle('is-picked', item === option));
    return;
  }
  const refresh = event.target.closest?.('#chat .custom-chunxu-options-refresh');
  if (refresh) {
    const floor = Number(refresh.closest('.mes')?.getAttribute('mesid'));
    if (floor !== getContext().chat.length - 1) { setStatus(root, '只能为最新一楼换一组选项', 'warning'); return; }
    refresh.textContent = '正在生成…';
    void generateOptions().catch((error) => { refresh.textContent = '换一组'; setStatus(root, error.message, 'error'); });
  }
}

async function onMessageReceived(messageId) {
  const receivedFloor = messageIndexFromEvent(messageId);
  sendHistory?.finish('received', receivedFloor);
  receivedForPostTasks = true;
  const settings = getSettings();
  requestLatestSummaryFocus();
  scheduleReconcile({ queueMissing: false });
  const floorIndex = messageIndexFromEvent(messageId);
  try { takeReplyOptions(floorIndex); } catch (error) { setStatus(root, `剧情选项读取失败：${error.message}`, 'error'); }
  try { cleanReceivedReply(floorIndex); } catch (error) { setStatus(root, `八股删除器出错：${error.message}`, 'error'); }
  if (settings.autoSummarize) pendingSummaryFloors.add(floorIndex);
}

function queuePendingSummaries({ force = false } = {}) {
  const settings = getSettings();
  if (!settings.autoSummarize && !force) return;
  const chat = getContext().chat;
  const indexes = [...pendingSummaryFloors];
  const rounds = indexes.filter((index) => chat[index] && !chat[index].is_user).length;
  const tokens = indexes.reduce((sum, index) => sum + (isControlMessage(chat[index]) ? 0 : estimateTokens(chat[index]?.mes)), 0);
  if (!force && (rounds < Math.max(1, Number(settings.memoryUpdateEvery) || 1) || tokens < (Number(settings.memoryMinTokens) || 0))) return;
  engine.enqueueBatch([...pendingSummaryFloors].sort((left, right) => left - right));
  pendingSummaryFloors.clear();
}

function clearPlayPrompt() {
  try { getContext().setExtensionPrompt?.(PLAY_PROMPT_ID, '', 1, 0, false, 0); } catch {}
}

function onGenerationEnded() {
  clearPlayPrompt();
  const hasReply = receivedForPostTasks;
  receivedForPostTasks = false;
  finishStoryRequest('ended');
  if (!hasReply) return;
  queuePendingSummaries();
  window.clearTimeout(postGenerationTimer);
  postGenerationTimer = window.setTimeout(() => void runPostGenerationTasks().catch((error) => setStatus(root, error.message, 'error')), 120);
}

function onGenerationStopped() {
  clearPlayPrompt();
  receivedForPostTasks = false;
  sendHistory?.finish('stopped');
  advanceEpoch += 1;
  finishStoryRequest();
  autoAdvanceRemaining = 0;
  window.clearTimeout(postGenerationTimer);
  queuePendingSummaries();
}

async function runPostGenerationTasks() {
  const task = captureChatTask();
  if (getSettings().autoNpcEnabled && await hasPendingNpcSignal(task)) await runAutoNpcCheck();

}

async function applyNpcStateUpdates(existingNpcs, updates, isCurrent) {
  const byId = new Map(existingNpcs.map((npc) => [npc.id, npc]));
  let changed = 0;
  for (const update of updates ?? []) {
    if (!isCurrent()) break;
    const existing = byId.get(update.id);
    if (!existing) continue;
    await engine.storage.putNpc({
      ...existing,
      ...update,
      id: existing.id,
      chatKey: existing.chatKey,
      updatedAutomatically: true,
      updatedAt: new Date().toISOString(),
    });
    changed += 1;
  }
  return changed;
}

// The organizing call flags floors where the story needs a new person. Only
// those floors start the NPC design request; ordinary replies cost nothing extra.
async function hasPendingNpcSignal(task) {
  await engine.waitForIdle();
  if (!task.isCurrent()) return false;
  const [records, state] = await Promise.all([
    engine.storage.listSummaries(engine.chatKey),
    engine.storage.getProfile(profileKey(engine.chatKey, 'auto-npc-state')),
  ]);
  const handledFloor = Number.isInteger(state?.signalFloor) ? state.signalFloor : -1;
  return records.some((record) => record.status === 'ready' && record.npcSignal?.needed && record.floorIndex > handledFloor);
}

async function runAutoNpcCheck() {
  const settings = getSettings();
  if (!settings.autoNpcEnabled || npcCheckRunning || !engine.chatKey) return;
  const context = getContext();
  const task = captureChatTask();
  const isCurrent = () => task.isCurrent() && getSettings().autoNpcEnabled;
  const startingChatKey = engine.chatKey;
  const targetFloorIndex = context.chat.length - 1;
  const latestMessage = context.chat[targetFloorIndex];
  if (targetFloorIndex < 0 || latestMessage?.is_user) return;
  const messageFingerprint = fingerprintMessage(latestMessage, targetFloorIndex);
  const stateKey = profileKey(engine.chatKey, 'auto-npc-state');
  const previousState = await engine.storage.getProfile(stateKey);
  if (!isCurrent()) return;
  if (previousState?.messageFingerprint === messageFingerprint) return;
  npcCheckRunning = true;
  try {
    setStatus(root, '正在判断剧情是否需要新 NPC……');
    await engine.waitForIdle();
    const latestContext = getContext();
    if (engine.chatKey !== startingChatKey || fingerprintMessage(latestContext.chat?.[targetFloorIndex], targetFloorIndex) !== messageFingerprint) return;
    const [rollup, playerProfile, existingNpcs] = await Promise.all([
      engine.storage.getRollup(engine.chatKey),
      getPlayerPreferenceProfile(),
      engine.storage.listNpcs(engine.chatKey),
    ]);
    const payload = await addSemanticRecall(buildPrivacyPayload({
      chat: latestContext.chat,
      targetFloorIndex,
      rollingSummary: rollup?.text ?? '',
      rawFloorLimit: settings.remoteRawFloorLimit,
    }));
    const provider = createProvider({
      source: settings.npcSource,
      context: latestContext,
      extra: getExtraCredentials(),
    });
    const decision = await requestNpcGenerationDecision(provider, payload, {
      playerProfile,
      existingNpcs: existingNpcs.slice(-8),
      brief: settings.npcBrief,
    });
    if (!isCurrent()) return;
    await engine.storage.putProfile({
      key: stateKey,
      chatKey: task.chatKey,
      kind: 'auto-npc-state',
      messageFingerprint,
      needed: decision.needed,
      reason: decision.reason,
      signalFloor: targetFloorIndex,
      updatedAt: new Date().toISOString(),
    });
    const updatedNpcCount = await applyNpcStateUpdates(existingNpcs, decision.updates, isCurrent);
    if (!isCurrent()) return;
    if (decision.needed && decision.npc) {
      const createdAt = new Date().toISOString();
      await engine.storage.putNpc({
        id: `${task.chatKey}::npc::${createdAt}::${Math.random().toString(36).slice(2, 8)}`,
        chatKey: task.chatKey,
        ...decision.npc,
        generatedAutomatically: true,
        createdAt,
      });
      await refreshView();
      setStatus(root, `剧情需要新人物，“${decision.npc.name}”已自动存入档案${updatedNpcCount ? `；并更新 ${updatedNpcCount} 份既有档案` : ''}`);
    } else if (updatedNpcCount) {
      await refreshView();
      setStatus(root, `已根据明确剧情事实更新 ${updatedNpcCount} 份 NPC 档案`);
    } else {
      setStatus(root, '当前剧情不需要新增 NPC');
    }
  } catch (error) {
    setStatus(root, `自动 NPC 判断暂停：${error.message}`, 'error');
  } finally {
    npcCheckRunning = false;
  }
}

// Home-page push controls: save an edited plan, skip one round, or ask for a
// different plan (organizing API first, the local pick if that fails).
async function editPush(action) {
  const chatKey = engine?.chatKey;
  if (!chatKey) return;
  const settings = getSettings();
  const context = getContext();
  const chat = context.chat ?? [];
  const afterFloor = lastReplyBefore(chat, nextReplyFloor(chat));
  const state = await loadAdvanceState(chatKey);
  if (action === 'push-skip') {
    await saveAdvanceState({ ...state, skipNext: !state.skipNext }, chatKey);
    setStatus(root, state.skipNext ? '已恢复推进' : '下一次回复不推进，之后自动恢复');
  } else if (action === 'save-push-plan') {
    const text = String(root.querySelector('[data-role="push-plan"]')?.value ?? '').trim();
    await saveAdvanceState({ ...state, plan: text ? { text, ways: [], afterFloor, source: 'player', updatedAt: new Date().toISOString() } : null }, chatKey);
    setStatus(root, text ? '已保存，下一次回复按这个推进' : '已清空，改由插件按局面挑选');
  } else {
    const memory = await engine.getMemory().catch(() => null);
    const current = planRound({ state, chat, replyFloor: nextReplyFloor(chat), database: memory, settings });
    const shown = String(root.querySelector('[data-role="push-plan"]')?.value ?? current.text ?? '').trim();
    setStatus(root, '正在换一个推进安排……');
    let plan = null;
    try {
      const rollup = await engine.storage.getRollup(chatKey);
      const payload = await addSemanticRecall(buildPrivacyPayload({ chat, targetFloorIndex: chat.length - 1, rollingSummary: rollup?.text ?? '', rawFloorLimit: settings.remoteRawFloorLimit }));
      const watch = advanceWatch(state, settings, { tastes: describeTastes(settings), strengthText: STRENGTH[settings.advanceStrength] ?? STRENGTH.normal });
      const provider = createProvider({ source: settings.advanceSource, context, extra: getExtraCredentials() });
      const next = await requestNextPlan(provider, payload, { watch, avoid: shown });
      plan = normalizeNextPlan(next, { modules: settings.advanceModules, afterFloor, eventPool: watch.eventPool });
    } catch { plan = null; }
    if (engine?.chatKey !== chatKey) return;
    if (!plan) {
      const ways = pickWays(memory, {
        modules: settings.advanceModules, history: state.history, latestFloor: chat.length - 1,
        recentPlayerTexts: chat.filter((message) => message.is_user).slice(-3).map((message) => message.mes),
        eventPool: settings.advanceEventPool, usedEvents: state.usedEvents, exclude: current.ways,
      });
      const lines = buildAdvanceInstruction(memory, { modules: settings.advanceModules, eventPool: settings.advanceEventPool, usedEvents: state.usedEvents, ways, latestFloor: chat.length - 1 })
        .split('\n').filter((line) => line.startsWith('- ') && !line.startsWith('- 推进节奏')).map((line) => line.slice(2));
      if (!lines.length) { setStatus(root, '没有别的推进方式可换了，可以去设置里多勾几种', 'warning'); return; }
      plan = { text: lines.join('\n'), ways, afterFloor, updatedAt: new Date().toISOString() };
    }
    await saveAdvanceState({ ...state, plan: { ...plan, source: 'reroll' } }, chatKey);
    setStatus(root, '已换成新的推进安排');
  }
  await refreshView();
}

async function restoreChatOptions() {
  if (!chatOptions || !getSettings().optionsEnabled) { chatOptions?.show(null); return; }
  const task = captureChatTask();
  const index = getContext().chat.length - 1;
  const fromReply = getContext().chat[index]?.extra?.ssa_options;
  if (optionRegexActive()) { chatOptions.show(null); return; }
  if (Array.isArray(fromReply) && fromReply.length) { chatOptions.show({ floorIndex: index, options: fromReply }); return; }
  const row = await engine.storage.getProfile(`${task.chatKey}::chat-options`);
  if (!task.isCurrent()) return;
  chatOptions.show(row && row.floorIndex === index && row.fingerprint === fingerprintMessage(getContext().chat[index], index) ? row : null);
}

async function generateOptions() {
  if (optionsRunning) { optionsPending = captureChatTask(); return; }
  optionsRunning = true;
  const optionTask = captureChatTask();
  const floorIndex = getContext().chat.length - 1;
  try { await generateOptionsForCurrentReply(floorIndex); }
  catch (error) {
    if (optionTask.isCurrent() && getSettings().optionsEnabled) chatOptions?.show({ floorIndex, error: error.message });
    throw error;
  } finally {
    optionsRunning = false;
    const pending = optionsPending; optionsPending = null;
    if (pending?.isCurrent() && getSettings().optionsEnabled) void generateOptions().catch((error) => setStatus(root, error.message, 'error'));
  }
}

async function generateOptionsForCurrentReply(floorIndex) {
  const task = captureChatTask();
  const settings = getSettings();
  if (!settings.optionsEnabled) throw new Error('请先开启剧情选项功能。');
  const context = getContext();
  if (!context.chat.length || context.chat[floorIndex]?.is_user) throw new Error('请等待角色回复后生成选项。');
  chatOptions?.show({ floorIndex, loading: true });
  setStatus(root, '正在生成剧情选项……');
  if (settings.optionSource === 'current') await engine.waitForIdle();
  const rollup = await engine.storage.getRollup(engine.chatKey);
  const payload = await addSemanticRecall(buildPrivacyPayload({
    chat: context.chat,
    targetFloorIndex: context.chat.length - 1,
    rollingSummary: rollup?.text ?? '',
    rawFloorLimit: settings.remoteRawFloorLimit,
  }));
  const provider = createProvider({
    source: settings.optionSource,
    context,
    extra: getExtraCredentials(),
  });
  const playerProfile = await getPlayerPreferenceProfile();
  if (!task.isCurrent()) return;
  const options = await requestStoryOptions(provider, payload, {
    mode: settings.optionMode,
    count: settings.optionCount,
    writingNotes: settings.optionWritingNotes,
    playerProfile,
    instruction: buildOptionsInstruction({ slots: settings.optionSlots, notes: settings.optionWritingNotes }),
  });
  if (!task.isCurrent()) return;
  if (!getSettings().optionsEnabled) { chatOptions?.show(null); return; }
  const saved = { key: `${task.chatKey}::chat-options`, chatKey: task.chatKey, floorIndex, fingerprint: fingerprintMessage(context.chat[floorIndex], floorIndex), options };
  await engine.storage.putProfile(saved);
  const message = context.chat[floorIndex];
  if (message) {
    message.extra = { ...(message.extra ?? {}), ssa_options: options };
    if (optionRegexActive()) { writeMessageText(floorIndex, replaceOptionsBlock(message.mes, options)); setStatus(root, `已换成 ${options.length} 个新选项`); return; }
    void (context.saveChat?.() ?? context.saveChatDebounced?.());
  }
  if (task.isCurrent()) chatOptions?.show(saved);
  setStatus(root, `已生成 ${options.length} 个剧情选项`);
}

async function analyzePreferences({ skipQuiz = false } = {}) {
  const task = captureChatTask();
  const settings = getSettings();
  const context = getContext();
  if (!context.chat.length) throw new Error('当前聊天还没有可用于分析的内容。');
  const quizAnswers = collectPreferenceQuiz(root);
  const selectedExperiences = skipQuiz ? [] : collectStoryExperiences(root);
  if (!skipQuiz && !isPreferenceQuizComplete(quizAnswers)) throw new Error('请完成 10 道测试题，或选择“跳过测试”。');
  settings.preferenceQuizAnswers = skipQuiz ? {} : quizAnswers;
  settings.storyExperiencePreferences = selectedExperiences;
  saveSettings();
  setStatus(root, '正在分析玩家剧情偏好……');
  if (settings.preferenceSource === 'current') await engine.waitForIdle();
  const rollup = await engine.storage.getRollup(engine.chatKey);
  const payload = await addSemanticRecall(buildPrivacyPayload({
    chat: context.chat,
    targetFloorIndex: context.chat.length - 1,
    rollingSummary: rollup?.text ?? '',
    rawFloorLimit: settings.remoteRawFloorLimit,
  }));
  const provider = createProvider({
    source: settings.preferenceSource,
    context,
    extra: getExtraCredentials(),
  });
  const profile = await requestPlayerPreferenceProfile(provider, payload, {
    quizSkipped: skipQuiz,
    quizAnswers: skipQuiz ? {} : quizAnswers,
    quizScores: skipQuiz ? {} : scorePreferenceQuiz(quizAnswers),
    selectedExperiences: STORY_EXPERIENCE_OPTIONS.filter((option) => selectedExperiences.includes(option.id)),
    genresAndTastes: describeTasteSettings({ genres: settings.preferenceGenres, tastes: settings.preferenceTastes, mbti: settings.preferenceMbti }),
    notes: settings.preferenceNotes,
  });
  if (!task.isCurrent()) return;
  const quizScores = skipQuiz ? {} : scorePreferenceQuiz(quizAnswers);
  await engine.storage.putProfile({
    key: PLAYER_PROFILE_KEY,
    chatKey: PLAYER_PROFILE_SCOPE,
    kind: 'player-preference',
    answers: {
      quizSkipped: skipQuiz,
      quizAnswers: skipQuiz ? {} : quizAnswers,
      quizScores,
      selectedExperiences,
      notes: settings.preferenceNotes,
    },
    quizScores,
    selectedExperiences,
    ...profile,
    updatedAt: new Date().toISOString(),
  });
  await refreshView();
  switchTab(root, 'advance');
  setStatus(root, '玩家剧情偏好已保存，之后不需要重复测试');
}

async function generateNpc() {
  const settings = getSettings();
  const context = getContext();
  const task = captureChatTask();
  if (!context.chat.length) throw new Error('当前聊天还没有可用的剧情档案。');
  setStatus(root, '正在生成 NPC……');
  if (settings.npcSource === 'current') await engine.waitForIdle();
  if (!task.isCurrent()) return;
  const [rollup, playerProfile, existingNpcs] = await Promise.all([
    engine.storage.getRollup(engine.chatKey),
    getPlayerPreferenceProfile(),
    engine.storage.listNpcs(engine.chatKey),
  ]);
  const payload = await addSemanticRecall(buildPrivacyPayload({
    chat: context.chat,
    targetFloorIndex: context.chat.length - 1,
    rollingSummary: rollup?.text ?? '',
    rawFloorLimit: settings.remoteRawFloorLimit,
  }));
  const provider = createProvider({
    source: settings.npcSource,
    context,
    extra: getExtraCredentials(),
  });
  if (!task.isCurrent()) return;
  const npc = await requestNpcProfile(provider, payload, {
    brief: settings.npcBrief,
    playerProfile,
    existingNpcs: existingNpcs.slice(-8),
  });
  if (!task.isCurrent()) return;
  const createdAt = new Date().toISOString();
  await engine.storage.putNpc({
    id: `${task.chatKey}::npc::${createdAt}::${Math.random().toString(36).slice(2, 8)}`,
    chatKey: task.chatKey,
    ...npc,
    createdAt,
  });
  await refreshView();
  setStatus(root, `NPC “${npc.name}”已保存到当前聊天`);
}

async function saveNpcEdits(npcId) {
  const existing = (await engine.storage.listNpcs(engine.chatKey)).find((npc) => npc.id === npcId);
  if (!existing) throw new Error('这份 NPC 档案已经不存在。');
  const edits = collectNpcEdits(root, npcId);
  await engine.storage.putNpc({
    ...existing,
    ...edits,
    editedByPlayer: true,
    updatedAt: new Date().toISOString(),
  });
  await refreshView();
  setStatus(root, `NPC “${edits.name}”的修改已保存`);
}

function chooseOption(text) {
  text = optionText(text);
  const textarea = document.querySelector('#send_textarea');
  if (!textarea) throw new Error('没有找到酒馆输入框。');
  textarea.value = text;
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  textarea.focus();
  setStatus(root, '选项已填入酒馆输入框，尚未发送');
}

async function testExtraApi() {
  const profileId = apiProfiles.active().id;
  setStatus(root, '正在测试额外 API……');
  const result = await callOpenAiCompatible({
    ...getExtraCredentials(),
    maxTokens: 20,
    messages: [
      { role: 'system', content: '只回复 OK。' },
      { role: 'user', content: '连接测试，不包含聊天内容。' },
    ],
  });
  if (profileId === apiProfiles.active().id) setStatus(root, `额外 API 已连接：${result.slice(0, 30)}`);
}

async function refreshExtraModels({ quiet = false } = {}) {
  const revision = ++modelFetchRevision;
  const credentials = getExtraCredentials();
  if (!String(credentials.endpoint ?? '').trim()) {
    renderModelOptions(root, [], '填写接口地址后会自动读取可用模型。');
    if (!quiet) setStatus(root, '请先填写额外 API 地址', 'warning');
    return [];
  }
  renderModelOptions(root, [], '正在从接口读取模型……');
  try {
    const models = await listOpenAiCompatibleModels(credentials);
    if (revision !== modelFetchRevision || !root) return [];
    const settings = getSettings();
    if (!String(settings.recallEmbeddingModel ?? '').trim()) {
      const embeddingModel = models.find((model) => /embed(?:ding)?/i.test(model));
      if (embeddingModel) {
        settings.recallEmbeddingModel = embeddingModel;
        apiProfiles.update({ embeddingModel });
        saveSettings();
      }
    }
    renderModelOptions(root, models, models.length ? `已读取 ${models.length} 个模型，可直接选择或继续手动输入。` : '接口没有返回模型；仍可手动输入模型名称。');
    syncSettings(root, settings, getApiKey());
    if (!quiet) setStatus(root, models.length ? `已读取 ${models.length} 个模型` : '接口没有返回模型列表', models.length ? 'normal' : 'warning');
    return models;
  } catch (error) {
    if (revision !== modelFetchRevision || !root) return [];
    renderModelOptions(root, [], `自动读取失败：${error.message}；仍可手动输入。`);
    if (!quiet) setStatus(root, `模型读取失败：${error.message}`, 'error');
    return [];
  }
}

function scheduleModelRefresh() {
  modelFetchRevision += 1;
  renderModelOptions(root, [], '配置已更新，准备读取模型；也可手动填写。');
  window.clearTimeout(modelFetchTimer);
  modelFetchTimer = window.setTimeout(() => void refreshExtraModels({ quiet: true }), 450);
}

async function handleAction(action, button) {
  if (action === 'save-memory-row' || action === 'remove-memory-row') {
    const edit = collectMemoryEdit(button.closest('[data-memory-row]'));
    if (action === 'remove-memory-row') edit.operation = 'delete';
    await engine.editMemory(edit);
    const memory = await engine.getMemory();
    renderMemoryDatabase(root, memory, { force: true });
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    renderTablePages(root, memory);
    clearStoryPrompt();
    setStatus(root, action === 'remove-memory-row' ? '条目已移除，来源楼层仍保留' : '记忆已保存，下次续写、选项和推进会使用新内容');
    return;
  }
  if (action === 'add-table-row') {
    renderTablePages(root, await engine.getMemory(), { add: button.dataset.table });
    return;
  }
  if (action === 'add-memory-row') {
    renderMemoryDatabase(root, await engine.getMemory(), { force: true, add: true });
    return;
  }
  if (action === 'add-api-profile') {
    apiProfiles.add();
    onApiProfileChanged();
    root.querySelector('[data-api-profile="name"]').focus();
    return;
  }
  if (action === 'delete-api-profile' || action === 'cancel-delete-api') {
    root.querySelector('[data-role="delete-api-confirm"]').hidden = action === 'cancel-delete-api';
    return;
  }
  if (action === 'confirm-delete-api') {
    apiProfiles.remove();
    onApiProfileChanged();
    return;
  }
  if (action === 'open') {
    setOpen(root, true);
    switchTab(root, 'sending');
    requestLatestSummaryFocus();
    await switchCurrentChat({ queueMissing: false });
    window.requestAnimationFrame(focusLatestSummary);
    return;
  }
  if (action === 'refresh-send-records') return refreshView();
  if (action === 'close') return setOpen(root, false);
  if (action === 'backfill') {
    const result = await engine.backfill(getSettings().backfillBatchSize);
    setStatus(root, result.busy
      ? '上一批仍在处理中，请完成后再补下一批'
      : result.queuedCount
        ? `本批已加入 ${result.queuedCount} 楼，剩余 ${result.remainingCount} 楼待补全`
        : '没有需要补全的楼层');
    return;
  }
  if (action === 'regenerate-floor') {
    await engine.regenerate(Number(button.dataset.floor));
    setStatus(root, `第 ${Number(button.dataset.floor) + 1} 楼已加入摘要队列`);
    return;
  }
  if (action === 'compress') {
    setStatus(root, '正在进行大总结……');
    const task = captureChatTask();
    const result = await engine.compressNow();
    if (task.isCurrent()) setStatus(root, result?.status === 'ready' && !result.rateLimited ? '大总结已更新' : '大总结未更新，已保留逐楼摘要，请查看错误状态');
    return;
  }
  if (action === 'save-push-plan' || action === 'push-skip' || action === 'push-reroll') return editPush(action);
  if (action === 'generate-options') return generateOptions();
  if (action === 'choose-option') return chooseOption(button.dataset.option ?? '');
  if (action === 'open-preference-test') {
    if (root.dataset.hasPreferenceProfile === 'true') {
      setRetestConfirmOpen(root, true);
      return;
    }
    resetPreferenceTest(root);
    switchTab(root, 'preference-test');
    return;
  }
  if (action === 'close-preference-test') return switchTab(root, 'player');
  if (action === 'cancel-retest') return setRetestConfirmOpen(root, false);
  if (action === 'confirm-retest') {
    setRetestConfirmOpen(root, false);
    resetPreferenceTest(root);
    switchTab(root, 'preference-test');
    return;
  }
  if (action === 'analyze-preferences') return analyzePreferences({ skipQuiz: false });
  if (action === 'skip-preference-quiz') return analyzePreferences({ skipQuiz: true });
  if (action === 'generate-npc') return generateNpc();
  if (action === 'save-npc') return saveNpcEdits(button.dataset.npcId ?? '');
  if (action === 'test-extra-api') return testExtraApi();
  if (action === 'refresh-models') return refreshExtraModels();
  if (action === 'save-floor-text' || action === 'save-floor-summary') {
    const floorIndex = Number(button.dataset.floor);
    const input = button.closest('.ssa-floor-editor')?.querySelector('textarea');
    if (!Number.isInteger(floorIndex) || !input) return;
    const value = input.value.trim();
    if (!value) throw new Error('内容不能为空。');
    if (action === 'save-floor-text') {
      if (!getContext().chat[floorIndex]) throw new Error('这一楼已经不存在。');
      writeMessageText(floorIndex, value);
      scheduleReconcile({ queueMissing: false });
      if (getSettings().autoSummarize) engine.enqueue(floorIndex);
      setStatus(root, `第 ${floorIndex + 1} 楼原文已修改，会重新整理这一楼`);
    } else {
      await engine.editMemory({ table: 'events', id: `floor:${floorIndex}`, operation: 'upsert', values: { summary: value } });
      clearStoryPrompt();
      setStatus(root, `第 ${floorIndex + 1} 楼的小结已修改，下一轮生效`);
    }
    input.blur();
    await refreshView();
    return;
  }
  if (action === 'add-option-slot' || action === 'remove-option-slot' || action === 'option-preset') {
    const settings = getSettings();
    const slots = [...(settings.optionSlots ?? [])];
    if (action === 'add-option-slot') slots.push({ label: '', count: 1, rule: '' });
    if (action === 'remove-option-slot') slots.splice(Number(button.closest('[data-slot]')?.dataset.slot), 1);
    settings.optionSlots = action === 'option-preset' ? presetSlots(Number(button.dataset.count)) : slots;
    saveSettings();
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    renderOptionSlots(root, settings.optionSlots);
    if (action === 'add-option-slot') root.querySelector('[data-role="option-slots"] .ssa-slot-row:last-child input')?.focus();
    if (action === 'option-preset') setStatus(root, `已换成 ${button.dataset.count} 个的预设，可以继续改`);
    return;
  }
  if (action === 'summary-format-preset') {
    const input = root.querySelector('[data-setting="summaryFormat"]');
    if (!input) return;
    input.value = button.dataset.format ?? '';
    getSettings().summaryFormat = input.value;
    saveSettings();
    setStatus(root, input.value ? '摘要格式已更新，之后整理的楼层按新格式写' : '已改回默认摘要写法');
    return;
  }
  if (action === 'reset-option-regex') {
    syncOptionRegex({ reset: true });
    setStatus(root, '剧情选项的美化正则已恢复默认；之前的回复刷新页面后生效');
    return;
  }
  if (action === 'goto-api') return openSettingsGroup('api');
  if (action === 'goto-recall') return openSettingsGroup('advanced', '[data-role="recall-card"]');
  if (action === 'enable-recall') {
    const select = root.querySelector('[data-setting="recallMode"]');
    if (select && select.value !== 'vector') { select.value = 'vector'; select.dispatchEvent(new Event('change', { bubbles: true })); }
    setStatus(root, '向量回忆已开启，下次回复时自动建立索引并查找相关往事');
    return;
  }
  if (action === 'rebuild-recall') {
    if (getSettings().recallMode === 'off' || getSettings().recallMode === 'keyword' || !vectorReady()) throw new Error('重建索引只用于向量回忆，请先配好“向量用”的嵌入接口。');
    setStatus(root, '正在重建语义索引……');
    const task = captureChatTask();
    const snapshot = await engine.getSnapshot();
    if (!task.isCurrent()) return;
    const vectors = await recallService.rebuild(task.chatKey, validSummaries(applyNarrativeEdits(snapshot.summaries, snapshot.memoryEdits), getContext().chat));
    if (!task.isCurrent()) return;
    recallState = { indexedCount: vectors.length, recalledFloors: [], error: '', phase: 'indexed' };
    showRecallState();
    setStatus(root, `语义索引已重建，共 ${vectors.length} 楼`);
    return;
  }
}

async function handleSettingChange(input) {
  const key = input.dataset.setting;
  const profileField = { extraEndpoint: 'endpoint', extraModel: 'model', recallEmbeddingModel: 'embeddingModel' }[key];
  if (profileField) apiProfiles.update({ [profileField]: input.value.trim() });
  const settings = getSettings();
  settings[key] = input.type === 'checkbox'
    ? input.checked
    : ['memoryTokenLimit', 'optionCount', 'backfillBatchSize', 'rollupTokenLimit', 'remoteRawFloorLimit', 'advanceRounds', 'expandedFloorCount', 'recallTopK', 'recallThreshold', 'recallDepth', 'memoryUpdateEvery', 'memoryMinTokens'].includes(key)
      ? Number(input.value)
      : input.value;
  if (key === 'autoAdvanceEnabled' && !settings.autoAdvanceEnabled) {
    advanceEpoch += 1;
    autoAdvanceRemaining = 0;
  }
  if (key === 'summaryContextEnabled' || key === 'filterArchivedFloors') {
    clearStoryPrompt();
    showStoryContextStatus(settings.summaryContextEnabled ? '设置已更新，下次回复前读取总摘要' : '总摘要发送已关闭，保留聊天原文');
  }
  if (key === 'optionsEnabled' || key === 'optionRegexEnabled') syncOptionRegex();
  if (key === 'vectorProfileId' || key === 'organizeProfileId') {
    if (key === 'vectorProfileId') clearRecallPrompt();
    setStatus(root, key === 'vectorProfileId' ? '向量回忆改用这套配置，下次回复时自动重建索引' : '整理改用这个接口');
  }
  if (key === 'autoBackfill' && settings.autoBackfill) void runAutoBackfill();
  if (key === 'recallMode') {
    if (recallOn() && typeof getContext().setExtensionPrompt !== 'function') {
      settings.recallMode = 'off';
      input.checked = false;
      recallState = { indexedCount: 0, recalledFloors: [], error: '当前酒馆版本不支持生成前注入。', phase: 'error' };
    } else if (recallOn()) {
      recallState = { ...recallState, recalledFloors: [], error: '', phase: 'armed' };
    } else {
      clearRecallPrompt();
      recallState = { indexedCount: 0, recalledFloors: [], error: '', phase: 'disabled' };
    }
    showRecallState();
  }
  saveSettings();
  syncSettings(root, settings, getApiKey());
  renderOverview(root, { settings });
  if (key === 'autoSummarize' && settings.autoSummarize) {
    await switchCurrentChat({ queueMissing: false });
  }
  if (key === 'expandedFloorCount') {
    resetFloorDisclosureOnNextRender = true;
    await refreshView();
  }
  if (key === 'optionsEnabled') {
    if (!settings.optionsEnabled) chatOptions?.show(null);
    else await restoreChatOptions();
  }
  if (key === 'extraEndpoint') scheduleModelRefresh();
  setStatus(root, key === 'autoAdvanceEnabled' && settings.autoAdvanceEnabled
    ? '自主推进已开启，将从玩家下一次发言后生效'
    : '设置已保存');
}

function bindUi() {
  root.addEventListener('click', (event) => {
    const tab = event.target.closest('[data-tab]');
    if (tab) {
      switchTab(root, tab.dataset.tab);
      if (tab.dataset.tab === 'summary') window.requestAnimationFrame(focusLatestSummary);
      return;
    }
    const button = event.target.closest('[data-action]');
    if (!button) return;
    void handleAction(button.dataset.action, button).catch((error) => setStatus(root, error.message, 'error'));
  });
  root.addEventListener('change', (event) => {
    if (event.target.matches('[data-role="push-goal"]')) {
      void (async () => {
        const state = await loadAdvanceState();
        await saveAdvanceState({ ...state, goal: event.target.value.trim().slice(0, 200) });
        setStatus(root, event.target.value.trim() ? '主线目标已保存，之后的推进会慢慢往这个方向靠' : '主线目标已清空');
      })();
      return;
    }
    if (event.target.matches('[data-genre-id], [data-taste-id]')) {
      const settings = getSettings();
      if (event.target.dataset.genreId) {
        const set = new Set(settings.preferenceGenres ?? []);
        if (event.target.checked) set.add(event.target.dataset.genreId); else set.delete(event.target.dataset.genreId);
        settings.preferenceGenres = [...set];
      } else {
        settings.preferenceTastes = { ...(settings.preferenceTastes ?? {}), [event.target.dataset.tasteId]: event.target.value };
      }
      saveSettings();
      syncSettings(root, getSettings(), getApiKey());
      return;
    }
    if (event.target.matches('[data-advance-module]')) {
      const settings = getSettings();
      const set = new Set(settings.advanceModules ?? []);
      if (event.target.checked) set.add(event.target.dataset.advanceModule); else set.delete(event.target.dataset.advanceModule);
      settings.advanceModules = ADVANCE_MODULES.map((module) => module.id).filter((id) => set.has(id));
      saveSettings();
      return;
    }
    if (event.target.matches('[data-role="prompt-record"]')) { selectRecord(event.target.value); showRound(); return; }
    if (event.target.matches('[data-role="memory-table-select"]')) {
      void engine.getMemory().then((memory) => renderMemoryDatabase(root, memory, { force: true })).catch((error) => setStatus(root, error.message, 'error'));
      return;
    }
    const profileInput = event.target.closest('[data-api-profile]');
    if (profileInput) {
      try {
        if (profileInput.dataset.apiProfile === 'select') {
          apiProfiles.select(profileInput.value);
          onApiProfileChanged();
        } else {
          apiProfiles.update({ name: profileInput.value });
          refreshApiProfiles();
          setStatus(root, 'API 配置名称已保存');
        }
      } catch (error) { setStatus(root, error.message, 'error'); }
      return;
    }
    const quizInput = event.target.closest('[data-quiz-id]');
    if (quizInput || event.target.closest('[data-experience-id]')) return;
    const input = event.target.closest('[data-setting]');
    if (!input) return;
    void handleSettingChange(input).catch((error) => setStatus(root, error.message, 'error'));
  });
  root.addEventListener('input', (event) => {
    if (event.target.matches('[data-role="prompt-search"]')) { filterPromptRows(root, event.target.value); return; }
    if (event.target.matches('[data-slot-field]')) {
      const edit = readSlotEdit(event.target);
      const settings = getSettings();
      const slots = [...(settings.optionSlots ?? [])];
      if (edit && slots[edit.index]) {
        slots[edit.index] = { ...slots[edit.index], [edit.field]: edit.field === 'count' ? Number(edit.value) : edit.value };
        settings.optionSlots = slots;
        saveSettings();
        const total = normalizeSlots(slots).reduce((sum, slot) => sum + slot.count, 0);
        const counter = root.querySelector('[data-role="option-slot-total"]');
        if (counter) counter.textContent = `一共 ${total} 个`;
      }
      return;
    }
    if (event.target.matches('[data-role="table-search"]')) {
      void engine.getMemory().then((memory) => renderTablePages(root, memory)).catch((error) => setStatus(root, error.message, 'error'));
      return;
    }
    if (event.target.matches('[data-role="memory-search"]')) {
      void engine.getMemory().then((memory) => renderMemoryDatabase(root, memory, { force: true })).catch((error) => setStatus(root, error.message, 'error'));
      return;
    }
    const field = event.target.dataset?.setting;
    if (['optionWritingNotes', 'preferenceNotes', 'npcBrief', 'clicheCustomRules', 'summaryFormat', 'advanceEventPool'].includes(field)) {
      getSettings()[field] = event.target.value;
      saveSettings();
      return;
    }
    const profileField = { extraEndpoint: 'endpoint', extraModel: 'model', recallEmbeddingModel: 'embeddingModel' }[field];
    const isName = event.target.dataset?.apiProfile === 'name';
    if (profileField || isName) {
      try {
        apiProfiles.update({ [isName ? 'name' : profileField]: event.target.value });
        if (isName) {
          const selector = root.querySelector('[data-api-profile="select"]');
          selector.selectedOptions[0].textContent = apiProfiles.active().name;
          refreshSlotSelectors();
        }
        if (field === 'extraEndpoint') scheduleModelRefresh();
        renderOverview(root, { settings: getSettings() });
      } catch (error) { setStatus(root, error.message, 'error'); }
      return;
    }
    const secret = event.target.closest('[data-secret="extraApiKey"]');
    if (secret) {
      try {
        setApiKey(secret.value);
        scheduleModelRefresh();
      } catch (error) { setStatus(root, error.message, 'error'); }
    }
  });
}

function bindHostEvents() {
  subscribe('GENERATE_AFTER_DATA', onFinalPrompt);
  subscribe('MESSAGE_SENT', onMessageSent);
  subscribe('MESSAGE_RECEIVED', onMessageReceived);
  subscribe('GENERATION_ENDED', onGenerationEnded);
  subscribe('GENERATION_STOPPED', onGenerationStopped);
  subscribe('MESSAGE_EDITED', (messageId) => {
    clearStoryPrompt();
    requestLatestSummaryFocus();
    scheduleReconcile({ queueMissing: false });
    const task = captureChatTask();
    if (getSettings().autoSummarize) window.setTimeout(() => { if (task.isCurrent()) engine.enqueue(messageIndexFromEvent(messageId)); }, 100);
  });
  subscribe('MESSAGE_SWIPED', (messageId) => {
    clearStoryPrompt();
    requestLatestSummaryFocus();
    scheduleReconcile({ queueMissing: false });
    const task = captureChatTask();
    if (getSettings().autoSummarize) window.setTimeout(() => { if (task.isCurrent()) engine.enqueue(messageIndexFromEvent(messageId)); }, 100);
  });
  subscribe('MESSAGE_DELETED', () => scheduleReconcile({ queueMissing: false }));
  subscribe('CHAT_CHANGED', () => {
    advanceEpoch += 1;
    autoAdvanceRemaining = 0;
    pendingSummaryFloors.clear();
    requestLatestSummaryFocus();
    void switchCurrentChat({ queueMissing: false }).catch((error) => setStatus(root, error.message, 'error'));
  });
}

async function initialize() {
  if (initialized) return;
  initialized = true;
  try {
    getSettings();
    const storage = await openArchiveStorage();
    root = createArchiveShell();
    apiProfiles = openApiProfiles({ storage: localStorage, session: sessionStorage, legacy: getSettings() });
    refreshApiProfiles();
    engine = new SummaryEngine({
      storage,
      getContext,
      getSettings,
      getExtraCredentials,
      onChange: refreshView,
      clicheSentencesFor,
      applyFloorRewrites,
      getAdvanceWatch,
      onAdvancePlan,
    });
    recallService = new SemanticRecallService({ storage, getCredentials: getRecallCredentials });
    globalThis[RECALL_INTERCEPTOR] = semanticRecallInterceptor;
    bindUi();
    bindHostEvents();
    syncOptionRegex();
    document.addEventListener('click', onChatOptionClick);
    clicheNotes = createClicheNotes({ describe: describeReply, onUndo: undoClicheCleanup, onRedo: redoClicheCleanup });
    chatOptions = createChatOptions({ onChoose: (text) => { try { chooseOption(text); } catch (error) { setStatus(root, error.message, 'error'); } }, onRefresh: () => void generateOptions().catch((error) => setStatus(root, error.message, 'error')) });
    if (recallOn() && typeof getContext().setExtensionPrompt !== 'function') {
      getSettings().recallMode = 'off';
      recallState = { indexedCount: 0, recalledFloors: [], error: '当前酒馆版本不支持生成前注入。', phase: 'error' };
      saveSettings();
    } else {
      recallState.phase = recallOn() ? 'armed' : 'disabled';
    }
    await switchCurrentChat({ queueMissing: false });
    syncSettings(root, getSettings(), getApiKey());
    if (getSettings().extraEndpoint) scheduleModelRefresh();
  } catch (error) {
    initialized = false;
    if (root) setStatus(root, error.message, 'error');
    console.error(`[${MODULE_ID}]`, error);
  }
}

function cleanup() {
  modelFetchRevision += 1;
  advanceEpoch += 1;
  window.clearTimeout(reconcileTimer);
  window.clearTimeout(modelFetchTimer);
  window.clearTimeout(postGenerationTimer);
  try {
    const context = getContext();
    for (const [event, handler] of subscriptions) context.eventSource.off?.(event, handler);
  } catch {}
  subscriptions = [];
  chatOptions?.destroy();
  clicheNotes?.destroy();
  document.removeEventListener('click', onChatOptionClick);
  chatOptions = null;
  engine?.destroy();
  clearStoryPrompt();
  clearRecallPrompt();
  if (globalThis[RECALL_INTERCEPTOR] === semanticRecallInterceptor) delete globalThis[RECALL_INTERCEPTOR];
  root?.remove();
  engine = null;
  recallService = null;
  root = null;
  initialized = false;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initialize, { once: true });
} else {
  queueMicrotask(initialize);
}

try {
  const context = getContext();
  const appReady = (context.eventTypes ?? context.event_types)?.APP_READY;
  if (appReady) context.eventSource.once(appReady, initialize);
} catch {}

window.addEventListener('beforeunload', cleanup, { once: true });
