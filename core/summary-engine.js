import {
  buildSummaryBatchPayload,
  estimateTokens,
  fingerprintMessage,
  fingerprintSummaries,
} from './privacy-payload.js';
import { createProvider, requestCompression, requestFloorSummaries } from './api-client.js';

function nowIso() {
  return new Date().toISOString();
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function isRateLimitError(error) {
  return /(?:\b429\b|too many requests|rate[\s_-]*limit|请求过多|限流)/i.test(errorText(error));
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
  constructor({
    storage,
    getContext,
    getSettings,
    getExtraCredentials,
    onChange = () => {},
    requestDelayMs = 1800,
    wait = (delay) => new Promise((resolve) => setTimeout(resolve, delay)),
  }) {
    this.storage = storage;
    this.getContext = getContext;
    this.getSettings = getSettings;
    this.getExtraCredentials = getExtraCredentials;
    this.onChange = onChange;
    this.chatKey = '';
    this.queue = [];
    this.running = false;
    this.currentFloor = null;
    this.currentBatch = [];
    this.idleWaiters = [];
    this.abortController = null;
    this.requestDelayMs = Math.max(0, Number(requestDelayMs) || 0);
    this.wait = wait;
  }

  setChat(chatKey) {
    if (this.chatKey === chatKey) return;
    this.chatKey = chatKey;
    this.queue = [];
    this.currentBatch = [];
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
    const floorsToQueue = [];

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
        if (queueMissing) floorsToQueue.push(floorIndex);
      } else if (current.status === 'processing' && !this.currentBatch.includes(floorIndex)) {
        await this.storage.putSummary({ ...current, ...metadata, status: 'missing', error: '', updatedAt: nowIso() });
        if (queueMissing) floorsToQueue.push(floorIndex);
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
        if (queueMissing && (rebuildPlayerSummary || ['missing', 'failed'].includes(current.status))) floorsToQueue.push(floorIndex);
      } else if (queueMissing && ['missing', 'failed'].includes(current.status)) {
        floorsToQueue.push(floorIndex);
      }
    }

    for (const record of existing) {
      if (record.floorIndex >= chat.length) await this.storage.deleteSummary(record.key);
    }
    if (floorsToQueue.length) this.enqueueBatch(floorsToQueue);
    await this.refreshRollup({ allowCompression: false });
    await this.onChange();
  }

  enqueue(floorIndex) {
    this.enqueueBatch([floorIndex]);
  }

  enqueueBatch(floorIndexes) {
    for (const floorIndex of floorIndexes) {
      if (!Number.isInteger(floorIndex) || floorIndex < 0 || this.queue.includes(floorIndex) || this.currentBatch.includes(floorIndex)) continue;
      this.queue.push(floorIndex);
    }
    this.queue.sort((left, right) => left - right);
    if (this.queue.length) void this.processQueue();
  }

  async backfill(limit = 10) {
    if (this.running || this.queue.length) return { busy: true, queuedCount: 0, remainingCount: 0, totalMissing: 0 };
    await this.reconcile({ queueMissing: false });
    const summaries = await this.storage.listSummaries(this.chatKey);
    const missing = summaries
      .filter((record) => ['missing', 'failed'].includes(record.status))
      .filter((record) => !this.currentBatch.includes(record.floorIndex) && !this.queue.includes(record.floorIndex))
      .sort((left, right) => left.floorIndex - right.floorIndex);
    const batchSize = Math.min(20, Math.max(1, Number(limit) || 10));
    const batch = missing.slice(0, batchSize);
    this.enqueueBatch(batch.map((record) => record.floorIndex));
    return {
      busy: false,
      queuedCount: batch.length,
      remainingCount: Math.max(0, missing.length - batch.length),
      totalMissing: missing.length,
    };
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
        const batch = this.takeNextRequestBatch();
        this.currentBatch = batch;
        this.currentFloor = batch[0] ?? null;
        const result = await this.summarizeBatch(batch);
        this.currentBatch = [];
        this.currentFloor = null;
        if (result?.rateLimited) {
          this.queue = [];
          break;
        }
        if (this.queue.length && this.requestDelayMs > 0) await this.wait(this.requestDelayMs);
      }
    } finally {
      this.currentBatch = [];
      this.currentFloor = null;
      this.running = false;
      for (const resolve of this.idleWaiters.splice(0)) resolve();
    }
  }

  takeNextRequestBatch() {
    const context = this.getContext();
    const maxFloors = Math.min(20, Math.max(1, Number(this.getSettings().backfillBatchSize) || 10));
    const rawTokenBudget = 4300;
    const batch = [];
    let usedTokens = 0;
    while (this.queue.length && batch.length < maxFloors) {
      const floorIndex = this.queue[0];
      const messageTokens = estimateTokens(context.chat?.[floorIndex]?.mes ?? '');
      if (batch.length && usedTokens + Math.min(messageTokens, rawTokenBudget) > rawTokenBudget) break;
      this.queue.shift();
      batch.push(floorIndex);
      usedTokens += Math.min(messageTokens, rawTokenBudget);
      if (usedTokens >= rawTokenBudget) break;
    }
    return batch;
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
    return this.summarizeBatch([floorIndex]);
  }

  async summarizeBatch(floorIndexes) {
    const context = this.getContext();
    const chatKey = this.chatKey;
    const batch = floorIndexes
      .filter((floorIndex) => Number.isInteger(floorIndex) && context.chat?.[floorIndex])
      .sort((left, right) => left - right);
    if (!batch.length || !chatKey) return { skipped: true };
    const settings = this.getSettings();
    const records = batch.map((floorIndex) => {
      const message = context.chat[floorIndex];
      return {
        key: summaryKey(chatKey, floorIndex),
        chatKey,
        floorIndex,
        messageFingerprint: fingerprintMessage(message, floorIndex),
        ...messageMetadata(message),
      };
    });
    for (const record of records) {
      await this.storage.putSummary({
        ...record,
        status: 'processing',
        summary: '',
        characters: [],
        relationships: [],
        clues: [],
        timeline: [],
        error: '',
        updatedAt: nowIso(),
      });
    }
    await this.onChange();

    try {
      const rollup = await this.storage.getRollup(chatKey);
      const payload = buildSummaryBatchPayload({
        chat: context.chat,
        floorIndexes: batch,
        rollingSummary: rollup?.text ?? '',
      });
      const results = await requestFloorSummaries(this.makeProvider(settings.summarySource), payload);
      const byFloor = new Map(results.map((result) => [result.floor - 1, result]));
      if (this.chatKey !== chatKey) return { skipped: true };
      let readyCount = 0;
      for (const record of records) {
        const latest = this.getContext().chat?.[record.floorIndex];
        if (!latest) continue;
        if (fingerprintMessage(latest, record.floorIndex) !== record.messageFingerprint) {
          if (!this.queue.includes(record.floorIndex)) this.queue.push(record.floorIndex);
          this.queue.sort((left, right) => left - right);
          continue;
        }
        const result = byFloor.get(record.floorIndex);
        if (!result) {
          await this.storage.putSummary({
            ...record,
            status: 'failed',
            summary: '',
            characters: [],
            relationships: [],
            clues: [],
            timeline: [],
            error: '模型漏掉了这一楼，请重新生成。',
            updatedAt: nowIso(),
          });
          continue;
        }
        const { floor: ignored, ...summary } = result;
        await this.storage.putSummary({
          ...record,
          status: 'ready',
          ...summary,
          error: '',
          updatedAt: nowIso(),
        });
        readyCount += 1;
      }
      await this.refreshRollup({ allowCompression: true });
      await this.onChange();
      return { ready: readyCount > 0, readyCount };
    } catch (error) {
      if (this.chatKey !== chatKey) return { skipped: true };
      for (const record of records) {
        await this.storage.putSummary({
          ...record,
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
      return { failed: true, failedCount: records.length, rateLimited: isRateLimitError(error) };
    }
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
