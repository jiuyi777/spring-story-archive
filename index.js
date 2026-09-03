import { buildPrivacyPayload, fingerprintMessage } from './core/privacy-payload.js';
import {
  callOpenAiCompatible,
  createProvider,
  listOpenAiCompatibleModels,
  requestAdvanceDirective,
  requestNpcGenerationDecision,
  requestNpcProfile,
  requestPlayerPreferenceProfile,
  requestStoryOptions,
} from './core/api-client.js';
import { isPreferenceQuizComplete, scorePreferenceQuiz, STORY_EXPERIENCE_OPTIONS } from './core/preference-quiz.js';
import { openArchiveStorage } from './core/storage.js';
import { SummaryEngine } from './core/summary-engine.js';
import { SemanticRecallService } from './core/semantic-recall.js';
import {
  createArchiveShell,
  collectNpcEdits,
  collectPreferenceQuiz,
  collectStoryExperiences,
  focusLatestFloor,
  renderAdvanceState,
  renderNpcs,
  renderModelOptions,
  renderOptions,
  renderPlayerProfile,
  renderRecallState,
  renderSnapshot,
  resetPreferenceTest,
  setOpen,
  setRetestConfirmOpen,
  setStatus,
  switchTab,
  syncSettings,
} from './ui/view.js';

const MODULE_ID = 'spring-story-archive';
const SECRET_KEY = `${MODULE_ID}:extra-api-key`;
const PLAYER_PROFILE_KEY = `${MODULE_ID}::player-preference`;
const PLAYER_PROFILE_SCOPE = `${MODULE_ID}::global-player`;
const RECALL_INTERCEPTOR = 'springStoryArchiveSemanticRecallInterceptor';
const RECALL_PROMPT_ID = `${MODULE_ID}:semantic-recall`;
const DEFAULT_SETTINGS = Object.freeze({
  autoSummarize: true,
  summarySource: 'current',
  rollupTokenLimit: 6000,
  expandedFloorCount: 5,
  extraEndpoint: '',
  extraModel: '',
  optionMode: 'guided',
  optionCount: 6,
  optionSource: 'current',
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
let advancing = false;
let focusLatestOnNextRender = false;
let latestReadySignature = '';
let modelFetchTimer = 0;
let postGenerationTimer = 0;
let npcCheckRunning = false;
let resetFloorDisclosureOnNextRender = false;
let recallState = { indexedCount: 0, recalledFloors: [], error: '' };
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
  delete merged.npcFunction;
  context.extensionSettings[MODULE_ID] = merged;
  return merged;
}

function saveSettings() {
  getContext().saveSettingsDebounced?.();
}

function getApiKey() {
  try {
    return sessionStorage.getItem(SECRET_KEY) ?? '';
  } catch {
    return '';
  }
}

function setApiKey(value) {
  try {
    if (value) sessionStorage.setItem(SECRET_KEY, value);
    else sessionStorage.removeItem(SECRET_KEY);
  } catch {
    setStatus(root, '浏览器阻止了会话级 Key 保存', 'error');
  }
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
  const [snapshot, playerProfile, advanceState, npcs] = await Promise.all([
    engine.getSnapshot(),
    getPlayerPreferenceProfile(chatKey),
    chatKey ? engine.storage.getProfile(profileKey(chatKey, 'advance-state')) : null,
    chatKey ? engine.storage.listNpcs(chatKey) : [],
  ]);
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
  if (engine.chatKey !== chatKey) {
    latestReadySignature = '';
    recallState = { indexedCount: 0, recalledFloors: [], error: '' };
    clearRecallPrompt();
  }
  engine.setChat(chatKey);
  if (!chatKey) {
    setStatus(root, '请先打开一个聊天', 'warning');
    await refreshView();
    return;
  }
  await engine.reconcile({ queueMissing });
  setStatus(root, queueMissing ? '已自动读取楼层，正在补全缺失摘要' : '本地档案已同步');
}

async function recallForCurrentContext({ force = false } = {}) {
  const settings = getSettings();
  if (!settings.semanticRecallEnabled || !engine?.chatKey || !recallService) {
    return { indexedCount: 0, records: [], prompt: '' };
  }
  const context = getContext();
  const targetFloorIndex = context.chat.length - 1;
  if (targetFloorIndex < 0) return { indexedCount: 0, records: [], prompt: '' };
  const snapshot = await engine.getSnapshot();
  const result = await recallService.recall({
    chatKey: engine.chatKey,
    summaries: snapshot.summaries,
    chat: context.chat,
    targetFloorIndex,
    topK: settings.recallTopK,
    threshold: settings.recallThreshold,
    force,
  });
  recallState = {
    indexedCount: result.indexedCount,
    recalledFloors: result.records.map((record) => record.floorIndex),
    error: '',
  };
  renderRecallState(root, recallState);
  return result;
}

async function addSemanticRecall(payload) {
  if (!getSettings().semanticRecallEnabled) return payload;
  try {
    const result = await recallForCurrentContext();
    return { ...payload, semanticRecall: result.prompt || '' };
  } catch (error) {
    recallState = { ...recallState, recalledFloors: [], error: error.message };
    renderRecallState(root, recallState);
    return { ...payload, semanticRecall: '' };
  }
}

async function semanticRecallInterceptor(chat, contextSize, abort, type) {
  const context = getContext();
  if (!getSettings().semanticRecallEnabled || !engine?.chatKey || type === 'quiet') {
    clearRecallPrompt(context);
    return;
  }
  try {
    if (typeof context.setExtensionPrompt !== 'function') throw new Error('当前酒馆版本不支持生成前注入。');
    await engine.waitForIdle();
    const result = await recallForCurrentContext();
    context.setExtensionPrompt?.(
      RECALL_PROMPT_ID,
      result.prompt,
      1,
      Number(getSettings().recallDepth || 4),
      false,
      0,
    );
  } catch (error) {
    clearRecallPrompt(context);
    recallState = { ...recallState, recalledFloors: [], error: error.message };
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
  const settings = getSettings();
  requestLatestSummaryFocus();
  scheduleReconcile({ queueMissing: false });
  const floorIndex = messageIndexFromEvent(messageId);
  if (settings.autoSummarize) pendingSummaryFloors.add(floorIndex);
}

function queuePendingSummaries() {
  for (const floorIndex of [...pendingSummaryFloors].sort((left, right) => left - right)) engine.enqueue(floorIndex);
  pendingSummaryFloors.clear();
}

function onGenerationEnded() {
  queuePendingSummaries();
  window.clearTimeout(postGenerationTimer);
  postGenerationTimer = window.setTimeout(() => void runPostGenerationTasks(), 120);
}

function onGenerationStopped() {
  autoAdvanceRemaining = 0;
  window.clearTimeout(postGenerationTimer);
  queuePendingSummaries();
}

async function runPostGenerationTasks() {
  if (getSettings().autoNpcEnabled) await runAutoNpcCheck();
  if (autoAdvanceRemaining > 0 && !advancing) await runAutoAdvance();
}

async function applyNpcStateUpdates(existingNpcs, updates) {
  const byId = new Map(existingNpcs.map((npc) => [npc.id, npc]));
  let changed = 0;
  for (const update of updates ?? []) {
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
  const startingChatKey = engine.chatKey;
  const targetFloorIndex = context.chat.length - 1;
  const latestMessage = context.chat[targetFloorIndex];
  if (targetFloorIndex < 0 || latestMessage?.is_user) return;
  const messageFingerprint = fingerprintMessage(latestMessage, targetFloorIndex);
  const stateKey = profileKey(engine.chatKey, 'auto-npc-state');
  const previousState = await engine.storage.getProfile(stateKey);
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
    if (engine.chatKey !== startingChatKey || fingerprintMessage(getContext().chat?.[targetFloorIndex], targetFloorIndex) !== messageFingerprint) return;
    await engine.storage.putProfile({
      key: stateKey,
      chatKey: engine.chatKey,
      kind: 'auto-npc-state',
      messageFingerprint,
      needed: decision.needed,
      reason: decision.reason,
      updatedAt: new Date().toISOString(),
    });
    const updatedNpcCount = await applyNpcStateUpdates(existingNpcs, decision.updates);
    if (decision.needed && decision.npc) {
      const createdAt = new Date().toISOString();
      await engine.storage.putNpc({
        id: `${engine.chatKey}::npc::${createdAt}::${Math.random().toString(36).slice(2, 8)}`,
        chatKey: engine.chatKey,
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
  const playerProfile = await getPlayerPreferenceProfile();
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
  const startingChatKey = engine.chatKey;
  const startingChatLength = context.chat.length;
  advancing = true;
  try {
    setStatus(root, `正在规划自动推进 · 剩余 ${autoAdvanceRemaining} 轮`);
    await engine.waitForIdle();
    if (engine.chatKey !== startingChatKey || getContext().chat.length !== startingChatLength) return;
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
    }));
    const provider = createProvider({
      source: settings.advanceSource,
      context,
      extra: getExtraCredentials(),
    });
    const npcProfiles = (await engine.storage.listNpcs(engine.chatKey)).slice(-6);
    const directive = await requestAdvanceDirective(provider, payload, { playerProfile, npcProfiles });
    if (engine.chatKey !== startingChatKey || getContext().chat.length !== startingChatLength) return;
    if (String(textarea?.value ?? '').trim()) {
      autoAdvanceRemaining = 0;
      setStatus(root, '检测到未发送草稿，自动推进已停止', 'warning');
      return;
    }
    await engine.storage.putProfile({
      key: profileKey(engine.chatKey, 'advance-state'),
      chatKey: engine.chatKey,
      kind: 'advance-state',
      ...directive,
      updatedAt: new Date().toISOString(),
    });
    await refreshView();
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

async function generateOptions() {
  const settings = getSettings();
  const context = getContext();
  if (!context.chat.length) throw new Error('当前聊天还没有可生成选项的内容。');
  setStatus(root, '正在生成剧情选项……');
  if (settings.optionSource === 'current') await engine.waitForIdle();
  const rollup = await engine.storage.getRollup(engine.chatKey);
  const payload = await addSemanticRecall(buildPrivacyPayload({
    chat: context.chat,
    targetFloorIndex: context.chat.length - 1,
    rollingSummary: rollup?.text ?? '',
  }));
  const provider = createProvider({
    source: settings.optionSource,
    context,
    extra: getExtraCredentials(),
  });
  const playerProfile = await getPlayerPreferenceProfile();
  const options = await requestStoryOptions(provider, payload, {
    mode: settings.optionMode,
    count: settings.optionCount,
    playerProfile,
  });
  renderOptions(root, options, settings.optionMode);
  setStatus(root, `已生成 ${options.length} 个剧情选项`);
}

async function analyzePreferences({ skipQuiz = false } = {}) {
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
  if (!context.chat.length) throw new Error('当前聊天还没有可用的剧情档案。');
  setStatus(root, '正在生成 NPC……');
  if (settings.npcSource === 'current') await engine.waitForIdle();
  const [rollup, playerProfile, existingNpcs] = await Promise.all([
    engine.storage.getRollup(engine.chatKey),
    getPlayerPreferenceProfile(),
    engine.storage.listNpcs(engine.chatKey),
  ]);
  const payload = await addSemanticRecall(buildPrivacyPayload({
    chat: context.chat,
    targetFloorIndex: context.chat.length - 1,
    rollingSummary: rollup?.text ?? '',
  }));
  const provider = createProvider({
    source: settings.npcSource,
    context,
    extra: getExtraCredentials(),
  });
  const npc = await requestNpcProfile(provider, payload, {
    brief: settings.npcBrief,
    playerProfile,
    existingNpcs: existingNpcs.slice(-8),
  });
  const createdAt = new Date().toISOString();
  await engine.storage.putNpc({
    id: `${engine.chatKey}::npc::${createdAt}::${Math.random().toString(36).slice(2, 8)}`,
    chatKey: engine.chatKey,
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
  setOpen(root, false);
}

async function testExtraApi() {
  setStatus(root, '正在测试额外 API……');
  const result = await callOpenAiCompatible({
    ...getExtraCredentials(),
    maxTokens: 20,
    messages: [
      { role: 'system', content: '只回复 OK。' },
      { role: 'user', content: '连接测试，不包含聊天内容。' },
    ],
  });
  setStatus(root, `额外 API 已连接：${result.slice(0, 30)}`);
}

async function refreshExtraModels({ quiet = false } = {}) {
  const credentials = getExtraCredentials();
  if (!String(credentials.endpoint ?? '').trim()) {
    renderModelOptions(root, [], '填写接口地址后会自动读取可用模型。');
    if (!quiet) setStatus(root, '请先填写额外 API 地址', 'warning');
    return [];
  }
  renderModelOptions(root, [], '正在从接口读取模型……');
  try {
    const models = await listOpenAiCompatibleModels(credentials);
    const settings = getSettings();
    if (!String(settings.recallEmbeddingModel ?? '').trim()) {
      const embeddingModel = models.find((model) => /embed(?:ding)?/i.test(model));
      if (embeddingModel) {
        settings.recallEmbeddingModel = embeddingModel;
        saveSettings();
      }
    }
    renderModelOptions(root, models, models.length ? `已读取 ${models.length} 个模型，可直接选择或继续手动输入。` : '接口没有返回模型；仍可手动输入模型名称。');
    syncSettings(root, settings, getApiKey());
    if (!quiet) setStatus(root, models.length ? `已读取 ${models.length} 个模型` : '接口没有返回模型列表', models.length ? 'normal' : 'warning');
    return models;
  } catch (error) {
    renderModelOptions(root, [], `自动读取失败：${error.message}；仍可手动输入。`);
    if (!quiet) setStatus(root, `模型读取失败：${error.message}`, 'error');
    return [];
  }
}

function scheduleModelRefresh() {
  window.clearTimeout(modelFetchTimer);
  modelFetchTimer = window.setTimeout(() => void refreshExtraModels({ quiet: true }), 450);
}

async function handleAction(action, button) {
  if (action === 'open') {
    setOpen(root, true);
    switchTab(root, 'summary');
    requestLatestSummaryFocus();
    await switchCurrentChat({ queueMissing: getSettings().autoSummarize });
    window.requestAnimationFrame(focusLatestSummary);
    return;
  }
  if (action === 'close') return setOpen(root, false);
  if (action === 'backfill') {
    setStatus(root, '已开始补全缺失摘要');
    await engine.backfill();
    return;
  }
  if (action === 'regenerate-floor') {
    await engine.regenerate(Number(button.dataset.floor));
    setStatus(root, `第 ${Number(button.dataset.floor) + 1} 楼已加入摘要队列`);
    return;
  }
  if (action === 'compress') {
    setStatus(root, '正在进行大总结……');
    await engine.compressNow();
    setStatus(root, '大总结已更新');
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
    const snapshot = await engine.getSnapshot();
    const vectors = await recallService.rebuild(engine.chatKey, snapshot.summaries);
    recallState = { indexedCount: vectors.length, recalledFloors: [], error: '' };
    renderRecallState(root, recallState);
    setStatus(root, `语义索引已重建，共 ${vectors.length} 楼`);
    return;
  }
}

async function handleSettingChange(input) {
  const key = input.dataset.setting;
  const settings = getSettings();
  settings[key] = input.type === 'checkbox'
    ? input.checked
    : ['optionCount', 'rollupTokenLimit', 'advanceRounds', 'expandedFloorCount', 'recallTopK', 'recallThreshold', 'recallDepth'].includes(key)
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
  if (key === 'autoAdvanceEnabled' && !settings.autoAdvanceEnabled) autoAdvanceRemaining = 0;
  if (key === 'semanticRecallEnabled' && !settings.semanticRecallEnabled) {
    clearRecallPrompt();
    recallState = { indexedCount: 0, recalledFloors: [], error: '' };
    renderRecallState(root, recallState);
  }
  saveSettings();
  syncSettings(root, settings, getApiKey());
  if (key === 'autoSummarize' && settings.autoSummarize) {
    await switchCurrentChat({ queueMissing: true });
  }
  if (key === 'expandedFloorCount') {
    resetFloorDisclosureOnNextRender = true;
    await refreshView();
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
    const quizInput = event.target.closest('[data-quiz-id]');
    if (quizInput || event.target.closest('[data-experience-id]')) return;
    const input = event.target.closest('[data-setting]');
    if (!input) return;
    void handleSettingChange(input).catch((error) => setStatus(root, error.message, 'error'));
  });
  root.addEventListener('input', (event) => {
    const secret = event.target.closest('[data-secret="extraApiKey"]');
    if (secret) {
      setApiKey(secret.value);
      scheduleModelRefresh();
    }
  });
}

function bindHostEvents() {
  subscribe('MESSAGE_SENT', onMessageSent);
  subscribe('MESSAGE_RECEIVED', onMessageReceived);
  subscribe('GENERATION_ENDED', onGenerationEnded);
  subscribe('GENERATION_STOPPED', onGenerationStopped);
  subscribe('MESSAGE_EDITED', (messageId) => {
    requestLatestSummaryFocus();
    scheduleReconcile({ queueMissing: false });
    if (getSettings().autoSummarize) window.setTimeout(() => engine.enqueue(messageIndexFromEvent(messageId)), 100);
  });
  subscribe('MESSAGE_SWIPED', (messageId) => {
    requestLatestSummaryFocus();
    scheduleReconcile({ queueMissing: false });
    if (getSettings().autoSummarize) window.setTimeout(() => engine.enqueue(messageIndexFromEvent(messageId)), 100);
  });
  subscribe('MESSAGE_DELETED', () => scheduleReconcile({ queueMissing: false }));
  subscribe('CHAT_CHANGED', () => {
    autoAdvanceRemaining = 0;
    pendingSummaryFloors.clear();
    requestLatestSummaryFocus();
    scheduleReconcile({ queueMissing: getSettings().autoSummarize });
  });
}

async function initialize() {
  if (initialized) return;
  initialized = true;
  try {
    getSettings();
    const storage = await openArchiveStorage();
    root = createArchiveShell();
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
    await switchCurrentChat({ queueMissing: getSettings().autoSummarize });
    syncSettings(root, getSettings(), getApiKey());
    if (getSettings().extraEndpoint) scheduleModelRefresh();
  } catch (error) {
    initialized = false;
    console.error(`[${MODULE_ID}]`, error);
  }
}

function cleanup() {
  window.clearTimeout(reconcileTimer);
  window.clearTimeout(modelFetchTimer);
  window.clearTimeout(postGenerationTimer);
  try {
    const context = getContext();
    for (const [event, handler] of subscriptions) context.eventSource.off?.(event, handler);
  } catch {}
  subscriptions = [];
  engine?.destroy();
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
