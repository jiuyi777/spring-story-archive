import {
  buildPrivacyPayload,
  estimateTokens,
  fingerprintMessage,
  fingerprintSummaries,
} from './privacy-payload.js';
import { createProvider, requestCompression, requestFloorSummary } from './api-client.js';

function nowIso() {
  return new Date().toISOString();
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function summaryKey(chatKey, floorIndex) {
  return `${chatKey}::floor::${floorIndex}`;
}

function checkpointKey(chatKey, throughFloor) {
  return `${chatKey}::checkpoint::${throughFloor}`;
}

function messageMetadata(message) {
  const isUser = Boolean(message?.is_user);
  return {
    isUser,
    priority: isUser ? 'player-statement' : 'normal',
    speakerName: String(message?.name ?? (isUser ? '玩家' : '角色')).trim(),
    userText: isUser ? String(message?.mes ?? '') : '',
  };
}

function formatFactLine(label, items) {
  return items?.length ? `\n${label}：${items.join('；')}` : '';
}

function formatCheckpoint(checkpoint) {
  if (!checkpoint?.summary) return '';
  return [
    `【压缩总摘要】${checkpoint.summary}`,
    formatFactLine('【固定时间线】', checkpoint.timeline),
    formatFactLine('【人物状态】', checkpoint.characters),
    formatFactLine('【人物关系】', checkpoint.relationships),
    formatFactLine('【未解决线索】', checkpoint.clues),
    formatFactLine('【连续性规则】', checkpoint.continuityRules),
  ].join('').trim();
}

function formatFloorRecord(record) {
  const type = record.isUser ? '玩家原文记录' : '角色回复';
  return [
    `【${type}】第 ${record.floorIndex + 1} 楼：${record.summary}`,
    formatFactLine('时间线', record.timeline),
    formatFactLine('人物状态', record.characters),
    formatFactLine('人物关系', record.relationships),
    formatFactLine('伏笔线索', record.clues),
  ].join('').trim();
}

export class SummaryEngine {
  constructor({ storage, getContext, getSettings, getExtraCredentials, onChange = () => {} }) {
    this.storage = storage;
    this.getContext = getContext;
    this.getSettings = getSettings;
    this.getExtraCredentials = getExtraCredentials;
    this.onChange = onChange;
    this.chatKey = '';
    this.queue = [];
    this.running = false;
    this.currentFloor = null;
    this.idleWaiters = [];
    this.abortController = null;
  }

  setChat(chatKey) {
    if (this.chatKey === chatKey) return;
    this.chatKey = chatKey;
    this.queue = [];
    this.abortController?.abort();
    this.abortController = null;
  }

  async reconcile({ queueMissing = false } = {}) {
    const context = this.getContext();
    const chat = Array.isArray(context.chat) ? context.chat : [];
    const chatKey = this.chatKey;
    if (!chatKey) return;
    const existing = await this.storage.listSummaries(chatKey);
    const byFloor = new Map(existing.map((record) => [record.floorIndex, record]));

    for (let floorIndex = 0; floorIndex < chat.length; floorIndex += 1) {
      const messageFingerprint = fingerprintMessage(chat[floorIndex], floorIndex);
      const metadata = messageMetadata(chat[floorIndex]);
      const current = byFloor.get(floorIndex);
      if (!current || current.messageFingerprint !== messageFingerprint) {
        await this.storage.putSummary({
          key: summaryKey(chatKey, floorIndex),
          chatKey,
          floorIndex,
          messageFingerprint,
          ...metadata,
          status: 'missing',
          summary: '',
          characters: [],
          relationships: [],
          clues: [],
          timeline: [],
          error: '',
          updatedAt: nowIso(),
        });
        if (queueMissing) this.enqueue(floorIndex);
      } else if (current.status === 'processing' && this.currentFloor !== floorIndex) {
        await this.storage.putSummary({ ...current, ...metadata, status: 'missing', error: '', updatedAt: nowIso() });
        if (queueMissing) this.enqueue(floorIndex);
      } else if (current.isUser !== metadata.isUser || current.userText !== metadata.userText || current.speakerName !== metadata.speakerName) {
        const rebuildPlayerSummary = metadata.isUser && current.priority !== 'player-statement';
        await this.storage.putSummary({
          ...current,
          ...metadata,
          ...(rebuildPlayerSummary ? {
            status: 'missing',
            summary: '',
            characters: [],
            relationships: [],
            clues: [],
            timeline: [],
            error: '',
          } : {}),
          updatedAt: nowIso(),
        });
        if (queueMissing && (rebuildPlayerSummary || ['missing', 'failed'].includes(current.status))) this.enqueue(floorIndex);
      } else if (queueMissing && ['missing', 'failed'].includes(current.status)) {
        this.enqueue(floorIndex);
      }
    }

    for (const record of existing) {
      if (record.floorIndex >= chat.length) await this.storage.deleteSummary(record.key);
    }
    await this.refreshRollup({ allowCompression: false });
    await this.onChange();
  }

  enqueue(floorIndex) {
    if (!Number.isInteger(floorIndex) || floorIndex < 0 || this.queue.includes(floorIndex) || this.currentFloor === floorIndex) return;
    this.queue.push(floorIndex);
    this.queue.sort((left, right) => left - right);
    void this.processQueue();
  }

  async backfill() {
    await this.reconcile({ queueMissing: false });
    const summaries = await this.storage.listSummaries(this.chatKey);
    for (const record of summaries) {
      if (['missing', 'failed'].includes(record.status)) this.enqueue(record.floorIndex);
    }
  }

  async regenerate(floorIndex) {
    const context = this.getContext();
    const message = context.chat?.[floorIndex];
    if (!message) throw new Error('这个楼层已经不存在。');
    const metadata = messageMetadata(message);
    await this.storage.putSummary({
      key: summaryKey(this.chatKey, floorIndex),
      chatKey: this.chatKey,
      floorIndex,
      messageFingerprint: fingerprintMessage(message, floorIndex),
      ...metadata,
      status: 'missing',
      summary: '',
      characters: [],
      relationships: [],
      clues: [],
      timeline: [],
      error: '',
      updatedAt: nowIso(),
    });
    this.enqueue(floorIndex);
    await this.onChange();
  }

  async processQueue() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const floorIndex = this.queue.shift();
        this.currentFloor = floorIndex;
        await this.summarizeFloor(floorIndex);
        this.currentFloor = null;
      }
    } finally {
      this.currentFloor = null;
      this.running = false;
      for (const resolve of this.idleWaiters.splice(0)) resolve();
    }
  }

  makeProvider(source) {
    const context = this.getContext();
    this.abortController = new AbortController();
    return createProvider({
      source,
      context,
      extra: this.getExtraCredentials(),
      signal: this.abortController.signal,
    });
  }

  async summarizeFloor(floorIndex) {
    const context = this.getContext();
    const chatKey = this.chatKey;
    const message = context.chat?.[floorIndex];
    if (!message || !chatKey) return;
    const settings = this.getSettings();
    const key = summaryKey(chatKey, floorIndex);
    const messageFingerprint = fingerprintMessage(message, floorIndex);
    const metadata = messageMetadata(message);
    await this.storage.putSummary({
      key,
      chatKey,
      floorIndex,
      messageFingerprint,
      ...metadata,
      status: 'processing',
      summary: '',
      characters: [],
      relationships: [],
      clues: [],
      timeline: [],
      error: '',
      updatedAt: nowIso(),
    });
    await this.onChange();

    try {
      const rollup = await this.storage.getRollup(chatKey);
      const payload = buildPrivacyPayload({
        chat: context.chat,
        targetFloorIndex: floorIndex,
        rollingSummary: rollup?.text ?? '',
        rawFloorLimit: settings.remoteRawFloorLimit,
        includeTargetFloor: true,
      });
      const result = await requestFloorSummary(this.makeProvider(settings.summarySource), payload);
      const latest = this.getContext().chat?.[floorIndex];
      if (!latest || this.chatKey !== chatKey) return;
      if (fingerprintMessage(latest, floorIndex) !== messageFingerprint) {
        if (!this.queue.includes(floorIndex)) this.queue.push(floorIndex);
        return;
      }
      await this.storage.putSummary({
        key,
        chatKey,
        floorIndex,
        messageFingerprint,
        ...metadata,
        status: 'ready',
        ...result,
        error: '',
        updatedAt: nowIso(),
      });
      await this.refreshRollup({ allowCompression: true });
    } catch (error) {
      if (this.chatKey !== chatKey) return;
      await this.storage.putSummary({
        key,
        chatKey,
        floorIndex,
        messageFingerprint,
        ...metadata,
        status: 'failed',
        summary: '',
        characters: [],
        relationships: [],
        clues: [],
        timeline: [],
        error: errorText(error),
        updatedAt: nowIso(),
      });
    }
    await this.onChange();
  }

  async refreshRollup({ allowCompression = true, forceCompression = false } = {}) {
    const chatKey = this.chatKey;
    if (!chatKey) return null;
    const settings = this.getSettings();
    const ready = (await this.storage.listSummaries(chatKey))
      .filter((record) => record.status === 'ready')
      .sort((left, right) => left.floorIndex - right.floorIndex);
    const checkpoints = (await this.storage.listCheckpoints(chatKey))
      .filter((checkpoint) => checkpoint.status === 'ready')
      .sort((left, right) => right.throughFloor - left.throughFloor);
    const validCheckpoint = checkpoints.find((checkpoint) => {
      const source = ready.filter((record) => record.floorIndex <= checkpoint.throughFloor);
      return checkpoint.formatVersion === 4 && checkpoint.sourceFingerprint === fingerprintSummaries(source);
    });
    const afterCheckpoint = validCheckpoint
      ? ready.filter((record) => record.floorIndex > validCheckpoint.throughFloor)
      : ready;
    const parts = [];
    if (validCheckpoint?.summary) parts.push(formatCheckpoint(validCheckpoint));
    parts.push(...afterCheckpoint.map(formatFloorRecord));
    const text = parts.join('\n').trim();
    const throughFloor = ready.at(-1)?.floorIndex ?? -1;
    const tokenEstimate = estimateTokens(text);
    const rollup = {
      chatKey,
      text,
      throughFloor,
      readyFloors: ready.length,
      tokenEstimate,
      checkpointFloor: validCheckpoint?.throughFloor ?? -1,
      status: 'ready',
      error: '',
      updatedAt: nowIso(),
    };
    await this.storage.putRollup(rollup);

    const reachesHundred = throughFloor >= 0 && (throughFloor + 1) % 100 === 0 && validCheckpoint?.throughFloor !== throughFloor;
    const reachesTokenLimit = tokenEstimate >= Number(settings.rollupTokenLimit || 6000) && validCheckpoint?.throughFloor !== throughFloor;
    if (allowCompression && ready.length && (forceCompression || reachesHundred || reachesTokenLimit)) {
      return this.compressRollup(rollup, ready);
    }
    return rollup;
  }

  async compressNow() {
    return this.refreshRollup({ allowCompression: true, forceCompression: true });
  }

  async compressRollup(rollup, ready) {
    const settings = this.getSettings();
    const throughFloor = rollup.throughFloor;
    const key = checkpointKey(this.chatKey, throughFloor);
    const source = ready.filter((record) => record.floorIndex <= throughFloor);
    await this.storage.putCheckpoint({
      key,
      chatKey: this.chatKey,
      throughFloor,
      status: 'processing',
      summary: '',
      timeline: [],
      characters: [],
      relationships: [],
      clues: [],
      continuityRules: [],
      sourceFingerprint: fingerprintSummaries(source),
      formatVersion: 4,
      error: '',
      updatedAt: nowIso(),
    });
    await this.onChange();
    try {
      const compressed = await requestCompression(this.makeProvider(settings.summarySource), rollup.text, throughFloor + 1);
      await this.storage.putCheckpoint({
        key,
        chatKey: this.chatKey,
        throughFloor,
        status: 'ready',
        ...compressed,
        sourceFingerprint: fingerprintSummaries(source),
        formatVersion: 4,
        error: '',
        updatedAt: nowIso(),
      });
      return this.refreshRollup({ allowCompression: false });
    } catch (error) {
      await this.storage.putCheckpoint({
        key,
        chatKey: this.chatKey,
        throughFloor,
        status: 'failed',
        summary: '',
        timeline: [],
        characters: [],
        relationships: [],
        clues: [],
        continuityRules: [],
        sourceFingerprint: fingerprintSummaries(source),
        formatVersion: 4,
        error: errorText(error),
        updatedAt: nowIso(),
      });
      await this.storage.putRollup({ ...rollup, status: 'failed', error: errorText(error), updatedAt: nowIso() });
      await this.onChange();
      return rollup;
    }
  }

  async getSnapshot() {
    if (!this.chatKey) return { summaries: [], rollup: null, checkpoints: [] };
    const [summaries, rollup, checkpoints] = await Promise.all([
      this.storage.listSummaries(this.chatKey),
      this.storage.getRollup(this.chatKey),
      this.storage.listCheckpoints(this.chatKey),
    ]);
    return {
      summaries: summaries.sort((left, right) => left.floorIndex - right.floorIndex),
      rollup,
      checkpoints: checkpoints.sort((left, right) => right.throughFloor - left.throughFloor),
    };
  }

  waitForIdle() {
    if (!this.running && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  destroy() {
    this.queue = [];
    for (const resolve of this.idleWaiters.splice(0)) resolve();
    this.abortController?.abort();
    this.storage.close?.();
  }
}
