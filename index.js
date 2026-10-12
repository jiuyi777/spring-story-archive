import { createSendHistory } from './core/send-history.js?v=0.7.1';
import { renderSendHistory } from './ui/send-view.js?v=0.7.1';
import { createChatOptions } from './ui/chat-options.js?v=0.7.1';
import { buildPrivacyPayload, fingerprintMessage, validSummaries, estimateTokens, truncateToTokenBudget, isControlMessage } from './core/privacy-payload.js?v=0.7.1';
import { formatMemoryDatabase, applyNarrativeEdits } from './core/memory-database.js?v=0.7.1';
import { renderMemoryDatabase, collectMemoryEdit } from './ui/memory-view.js?v=0.7.1';
import { openApiProfiles } from './core/api-profiles.js?v=0.7.1';
import {
  callOpenAiCompatible,
  createProvider,
  listOpenAiCompatibleModels,
  requestAdvanceDirective,
  requestNpcGenerationDecision,
  requestNpcProfile,
  requestPlayerPreferenceProfile,
  requestStoryOptions,
} from './core/api-client.js?v=0.7.1';
import { isPreferenceQuizComplete, scorePreferenceQuiz, STORY_EXPERIENCE_OPTIONS } from './core/preference-quiz.js?v=0.7.1';
import { openArchiveStorage } from './core/storage.js?v=0.7.1';
import { SummaryEngine } from './core/summary-engine.js?v=0.7.1';
import { SemanticRecallService } from './core/semantic-recall.js?v=0.7.1';
import { createStoryRequest, injectStoryContext, STORY_PROMPT_ID } from './core/story-context.js?v=0.7.1';
import {
  createArchiveShell,
  collectNpcEdits,
  collectPreferenceQuiz,
  collectStoryExperiences,
  focusLatestFloor,
  renderAdvanceState,
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
} from './ui/view.js?v=0.7.1';

const MODULE_ID = 'spring-story-archive';
let apiProfiles = null;
let modelFetchRevision = 0;
const PLAYER_PROFILE_KEY = `${MODULE_ID}::player-preference`;
const PLAYER_PROFILE_SCOPE = `${MODULE_ID}::global-player`;
const RECALL_INTERCEPTOR = 'springStoryArchiveSemanticRecallInterceptor';
const RECALL_PROMPT_ID = `${MODULE_ID}:semantic-recall`;
const DEFAULT_SETTINGS = Object.freeze({
  autoSummarize: true,
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
  advanceSource: 'extra',
  advanceRounds: 1,
  npcBrief: '',
  npcSource: 'current',
  autoNpcEnabled: false,
  semanticRecallEnabled: false,
  recallEmbeddingModel: '',
  recallTopK: 4,
  recallThreshold: 0.3,
  recallDepth: 4,
});

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
  merged.remoteRawFloorLimit = [0, 1, 3, 5].includes(Number(merged.remoteRawFloorLimit))
    ? Number(merged.remoteRawFloorLimit)
    : 0;
  delete merged.npcFunction;
  if (apiProfiles) {
    const profile = apiProfiles.active();
    Object.assign(merged, { extraEndpoint: profile.endpoint, extraModel: profile.model, recallEmbeddingModel: profile.embeddingModel });
  }
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
  syncSettings(root, getSettings(), getApiKey());
}

function onApiProfileChanged() {
  refreshApiProfiles();
  clearRecallPrompt();
  scheduleModelRefresh();
  setStatus(root, `已切换到“${apiProfiles.active().name}”，之后的额外 API 请求使用此配置`);
}

function getExtraCredentials() {
  const settings = getSettings();
  return {
    endpoint: settings.extraEndpoint,
    model: settings.extraModel,
    apiKey: getApiKey(),
  };
}

function getRecallCredentials() {
  const settings = getSettings();
  return {
    profileId: apiProfiles?.active().id ?? '',
    endpoint: settings.extraEndpoint,
    apiKey: getApiKey(),
    embeddingModel: settings.recallEmbeddingModel,
  };
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
  renderSendHistory(root, sends);
  resetFloorDisclosureOnNextRender = false;
  renderPlayerProfile(root, playerProfile);
  renderAdvanceState(root, advanceState);
  renderNpcs(root, npcs);
  renderRecallState(root, recallState);
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
      phase: getSettings().semanticRecallEnabled ? 'armed' : 'disabled',
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
}

async function recallForCurrentContext({ force = false, phase = 'matched', type } = {}) {
  const settings = getSettings();
  if (!settings.semanticRecallEnabled || !engine?.chatKey || !recallService) {
    return { indexedCount: 0, records: [], prompt: '' };
  }
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
  };
  renderRecallState(root, recallState);
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
  if (!getSettings().semanticRecallEnabled) return payload;
  try {
    const result = await recallForCurrentContext({ phase: 'feature' });
    return { ...payload, semanticRecall: result.prompt || '' };
  } catch (error) {
    recallState = { ...recallState, recalledFloors: [], error: error.message, phase: 'error' };
    renderRecallState(root, recallState);
    return { ...payload, semanticRecall: '' };
  }
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
    if (root && engine?.chatKey === chatKey) renderSendHistory(root, await engine.storage.listSendRecords(chatKey));
  } });
  sendHistory = ledger;
  const request = createStoryRequest({ context: getContext(), promptChat: chat, abort, isCurrent, onStatus: showStoryContextStatus, onEvidence: ledger.evidence });
  request.recordPlan = (plan, filter) => ledger.plan(plan, filter);
  request.recordRecall = (prompt, records) => ledger.recall(prompt, records);
  storyRequest = request;
  try {
    await prepareArchivePrompt(chat, contextSize, abort, type, request);
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
  try {
    const settings = getSettings();
    const canGuard = typeof context.stopGeneration === 'function'
      && Boolean((context.eventTypes ?? context.event_types)?.GENERATE_AFTER_DATA);
    const status = await injectStoryContext({
      context, storage: engine.storage, chatKey, promptChat: chat, contextSize, type,
      enabled: settings.summaryContextEnabled,
      filter: settings.filterArchivedFloors && canGuard,
      onPlan: (plan) => { if (canGuard) request.plan(plan); request.recordPlan?.(plan, settings.filterArchivedFloors && canGuard); },
      isCurrent: () => currentChatKey() === chatKey && getSettings().summaryContextEnabled
        && getSettings().filterArchivedFloors === settings.filterArchivedFloors,
    });
    showStoryContextStatus(status);
  } catch (error) {
    finishStoryRequest();
    showStoryContextStatus(`总摘要读取失败，保留原文：${error.message}`);
  }
  if (!getSettings().semanticRecallEnabled || !engine?.chatKey || type === 'quiet') {
    clearRecallPrompt(context);
    recallState = { ...recallState, recalledFloors: [], error: '', phase: getSettings().semanticRecallEnabled ? 'armed' : 'disabled' };
    renderRecallState(root, recallState);
    return;
  }
  try {
    if (typeof context.setExtensionPrompt !== 'function') throw new Error('当前酒馆版本不支持生成前注入。');
    recallState = { ...recallState, recalledFloors: [], error: '', phase: 'preparing' };
    renderRecallState(root, recallState);
    const result = await recallForCurrentContext({ phase: 'preparing', type });
    if (currentChatKey() !== chatKey) {
      clearStoryPrompt();
      clearRecallPrompt(context);
      abort(true);
      return;
    }
    if (!getSettings().semanticRecallEnabled) {
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
    renderRecallState(root, recallState);
  } catch (error) {
    clearRecallPrompt(context);
    recallState = { ...recallState, recalledFloors: [], error: error.message, phase: 'error' };
    renderRecallState(root, recallState);
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
  autoAdvanceRemaining = settings.autoAdvanceEnabled ? Number(settings.advanceRounds || 1) : 0;
  requestLatestSummaryFocus();
  scheduleReconcile({ queueMissing: false });
  const floorIndex = messageIndexFromEvent(messageId);
  if (settings.autoSummarize) pendingSummaryFloors.add(floorIndex);
}

async function onMessageReceived(messageId) {
  const receivedFloor = messageIndexFromEvent(messageId);
  sendHistory?.finish('received', receivedFloor);
  receivedForPostTasks = true;
  const settings = getSettings();
  requestLatestSummaryFocus();
  scheduleReconcile({ queueMissing: false });
  const floorIndex = messageIndexFromEvent(messageId);
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

function onGenerationEnded() {
  const hasReply = receivedForPostTasks;
  receivedForPostTasks = false;
  finishStoryRequest('ended');
  if (!hasReply) return;
  queuePendingSummaries();
  window.clearTimeout(postGenerationTimer);
  postGenerationTimer = window.setTimeout(() => void runPostGenerationTasks().catch((error) => setStatus(root, error.message, 'error')), 120);
}

function onGenerationStopped() {
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
  if (getSettings().optionsEnabled) {
    try { await generateOptions(); } catch (error) { setStatus(root, error.message, 'error'); }
  }
  if (!task.isCurrent()) return;
  if (getSettings().autoNpcEnabled) await runAutoNpcCheck();
  if (!task.isCurrent()) return;
  if (autoAdvanceRemaining > 0 && !advancing) await runAutoAdvance();
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

async function runAutoAdvance() {
  const settings = getSettings();
  if (!settings.autoAdvanceEnabled || autoAdvanceRemaining <= 0 || advancing) return;
  const context = getContext();
  const task = captureChatTask();
  const epoch = advanceEpoch;
  const isCurrent = () => task.isCurrent() && epoch === advanceEpoch && getSettings().autoAdvanceEnabled && autoAdvanceRemaining > 0;
  const playerProfile = await getPlayerPreferenceProfile();
  if (!isCurrent()) return;
  if (!playerProfile?.summary) {
    settings.autoAdvanceEnabled = false;
    autoAdvanceRemaining = 0;
    saveSettings();
    syncSettings(root, settings, getApiKey());
    setStatus(root, '自主推进已停止：请先分析玩家剧情偏好', 'warning');
    return;
  }
  const textarea = document.querySelector('#send_textarea');
  if (String(textarea?.value ?? '').trim()) {
    autoAdvanceRemaining = 0;
    setStatus(root, '检测到未发送草稿，自动推进已停止', 'warning');
    return;
  }
  if (typeof context.generate !== 'function') {
    autoAdvanceRemaining = 0;
    setStatus(root, '当前酒馆版本不支持自动推进', 'error');
    return;
  }
  const targetFloorIndex = context.chat.length - 1;
  if (targetFloorIndex < 0 || context.chat[targetFloorIndex]?.is_user) return;
  advancing = true;
  try {
    setStatus(root, `正在规划自动推进 · 剩余 ${autoAdvanceRemaining} 轮`);
    await engine.waitForIdle();
    if (!isCurrent()) return;
    if (String(textarea?.value ?? '').trim()) {
      autoAdvanceRemaining = 0;
      setStatus(root, '检测到未发送草稿，自动推进已停止', 'warning');
      return;
    }
    const rollup = await engine.storage.getRollup(engine.chatKey);
    const payload = await addSemanticRecall(buildPrivacyPayload({
      chat: context.chat,
      targetFloorIndex,
      rollingSummary: rollup?.text ?? '',
      rawFloorLimit: settings.remoteRawFloorLimit,
    }));
    const provider = createProvider({
      source: settings.advanceSource,
      context,
      extra: getExtraCredentials(),
    });
    const npcProfiles = (await engine.storage.listNpcs(engine.chatKey)).slice(-6);
    if (!isCurrent()) return;
    const directive = await requestAdvanceDirective(provider, payload, { playerProfile, npcProfiles });
    if (!isCurrent()) return;
    if (String(textarea?.value ?? '').trim()) {
      autoAdvanceRemaining = 0;
      setStatus(root, '检测到未发送草稿，自动推进已停止', 'warning');
      return;
    }
    await engine.storage.putProfile({
      key: profileKey(task.chatKey, 'advance-state'),
      chatKey: task.chatKey,
      kind: 'advance-state',
      ...directive,
      updatedAt: new Date().toISOString(),
    });
    await refreshView();
    if (!isCurrent() || String(textarea?.value ?? '').trim()) return;
    autoAdvanceRemaining -= 1;
    await context.generate('normal', {
      automatic_trigger: true,
      quiet_prompt: `请自然延续剧情。严格遵守已有时间、地点、人物状态与关系，并执行这条导演指令：${directive.directive}`,
      quietToLoud: true,
    });
    setStatus(root, autoAdvanceRemaining > 0 ? '本轮推进完成，正在准备下一轮' : '自动推进已完成');
  } catch (error) {
    autoAdvanceRemaining = 0;
    setStatus(root, `自动推进停止：${error.message}`, 'error');
  } finally {
    advancing = false;
  }
  if (autoAdvanceRemaining > 0) window.setTimeout(() => void runAutoAdvance(), 180);
}

async function restoreChatOptions() {
  if (!chatOptions || !getSettings().optionsEnabled) { chatOptions?.show(null); return; }
  const task = captureChatTask();
  const row = await engine.storage.getProfile(`${task.chatKey}::chat-options`);
  const index = getContext().chat.length - 1;
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
  });
  if (!task.isCurrent()) return;
  if (!getSettings().optionsEnabled) { chatOptions?.show(null); return; }
  const saved = { key: `${task.chatKey}::chat-options`, chatKey: task.chatKey, floorIndex, fingerprint: fingerprintMessage(context.chat[floorIndex], floorIndex), options };
  await engine.storage.putProfile(saved);
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
    renderMemoryDatabase(root, await engine.getMemory(), { force: true });
    clearStoryPrompt();
    setStatus(root, action === 'remove-memory-row' ? '条目已移除，来源楼层仍保留' : '记忆已保存，下次续写、选项和推进会使用新内容');
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
  if (action === 'close-preference-test') return switchTab(root, 'advance');
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
  if (action === 'rebuild-recall') {
    if (!getSettings().semanticRecallEnabled) throw new Error('请先开启“自动找回相关往事”。');
    setStatus(root, '正在重建语义索引……');
    const task = captureChatTask();
    const snapshot = await engine.getSnapshot();
    if (!task.isCurrent()) return;
    const vectors = await recallService.rebuild(task.chatKey, validSummaries(applyNarrativeEdits(snapshot.summaries, snapshot.memoryEdits), getContext().chat));
    if (!task.isCurrent()) return;
    recallState = { indexedCount: vectors.length, recalledFloors: [], error: '', phase: 'indexed' };
    renderRecallState(root, recallState);
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
    : ['optionCount', 'backfillBatchSize', 'rollupTokenLimit', 'remoteRawFloorLimit', 'advanceRounds', 'expandedFloorCount', 'recallTopK', 'recallThreshold', 'recallDepth', 'memoryUpdateEvery', 'memoryMinTokens'].includes(key)
      ? Number(input.value)
      : input.value;
  if (key === 'autoAdvanceEnabled' && settings.autoAdvanceEnabled) {
    const playerProfile = await getPlayerPreferenceProfile();
    if (!playerProfile?.summary) {
      settings.autoAdvanceEnabled = false;
      input.checked = false;
      saveSettings();
      setStatus(root, '请先完成玩家剧情偏好分析', 'warning');
      switchTab(root, 'advance');
      return;
    }
  }
  if (key === 'autoAdvanceEnabled' && !settings.autoAdvanceEnabled) {
    advanceEpoch += 1;
    autoAdvanceRemaining = 0;
  }
  if (key === 'summaryContextEnabled' || key === 'filterArchivedFloors') {
    clearStoryPrompt();
    showStoryContextStatus(settings.summaryContextEnabled ? '设置已更新，下次回复前读取总摘要' : '总摘要发送已关闭，保留聊天原文');
  }
  if (key === 'semanticRecallEnabled') {
    if (settings.semanticRecallEnabled && typeof getContext().setExtensionPrompt !== 'function') {
      settings.semanticRecallEnabled = false;
      input.checked = false;
      recallState = { indexedCount: 0, recalledFloors: [], error: '当前酒馆版本不支持生成前注入。', phase: 'error' };
    } else if (settings.semanticRecallEnabled) {
      recallState = { ...recallState, recalledFloors: [], error: '', phase: 'armed' };
    } else {
      clearRecallPrompt();
      recallState = { indexedCount: 0, recalledFloors: [], error: '', phase: 'disabled' };
    }
    renderRecallState(root, recallState);
  }
  saveSettings();
  syncSettings(root, settings, getApiKey());
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
    if (event.target.matches('[data-role="memory-search"]')) {
      void engine.getMemory().then((memory) => renderMemoryDatabase(root, memory, { force: true })).catch((error) => setStatus(root, error.message, 'error'));
      return;
    }
    const field = event.target.dataset?.setting;
    if (['optionWritingNotes', 'preferenceNotes', 'npcBrief'].includes(field)) {
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
        }
        if (field === 'extraEndpoint') scheduleModelRefresh();
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
    });
    recallService = new SemanticRecallService({ storage, getCredentials: getRecallCredentials });
    globalThis[RECALL_INTERCEPTOR] = semanticRecallInterceptor;
    bindUi();
    bindHostEvents();
    chatOptions = createChatOptions({ onChoose: (text) => { try { chooseOption(text); } catch (error) { setStatus(root, error.message, 'error'); } }, onRefresh: () => void generateOptions().catch((error) => setStatus(root, error.message, 'error')) });
    if (getSettings().semanticRecallEnabled && typeof getContext().setExtensionPrompt !== 'function') {
      getSettings().semanticRecallEnabled = false;
      recallState = { indexedCount: 0, recalledFloors: [], error: '当前酒馆版本不支持生成前注入。', phase: 'error' };
      saveSettings();
    } else {
      recallState.phase = getSettings().semanticRecallEnabled ? 'armed' : 'disabled';
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
