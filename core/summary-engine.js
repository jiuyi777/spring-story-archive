import {
  buildSummaryBatchPayload,
  estimateTokens,
  fingerprintMessage,
  fingerprintSummaries,
  validSummaries,
  splitInputText,
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

export function formatCheckpoint(checkpoint) {
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

export function formatFloorRecord(record) {
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
    this.chatRevision = 0;
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
    this.chatRevision += 1;
    this.queue = [];
    this.currentBatch = [];
    this.abortController?.abort();
    this.abortController = null;
  }

  async reconcile({ queueMissing = false } = {}) {
    const context = this.getContext();
    const chat = Array.isArray(context.chat) ? context.chat : [];
    const chatKey = this.chatKey;
    const revision = this.chatRevision;
    if (!chatKey) return;
    const existing = await this.storage.listSummaries(chatKey);
    const byFloor = new Map(existing.map((record) => [record.floorIndex, record]));
    const floorsToQueue = [];

    for (let floorIndex = 0; floorIndex < chat.length; floorIndex += 1) {
      if (revision !== this.chatRevision) return;
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
      if (revision !== this.chatRevision) return;
      if (record.floorIndex >= chat.length) await this.storage.deleteSummary(record.key);
    }
    if (revision !== this.chatRevision) return;
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
    const revision = this.chatRevision;
    await this.reconcile({ queueMissing: false });
    const summaries = await this.storage.listSummaries(this.chatKey);
    if (revision !== this.chatRevision) return { busy: false, queuedCount: 0, remainingCount: 0, totalMissing: 0 };
    const missing = summaries
      .filter((record) => ['missing', 'failed'].includes(record.status) || (record.status === 'ready' && record.inputComplete !== true))
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
    const revision = this.chatRevision;
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
    if (revision !== this.chatRevision) return;
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
      if (batch.length) {
        try { buildSummaryBatchPayload({ chat: context.chat, floorIndexes: [...batch, floorIndex] }); }
        catch { break; }
      }
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
    const chat = context.chat.map((message) => ({ ...message }));
    const chatKey = this.chatKey;
    const revision = this.chatRevision;
    const isCurrent = () => this.chatRevision === revision;
    const batch = floorIndexes
      .filter((floorIndex) => Number.isInteger(floorIndex) && chat[floorIndex])
      .sort((left, right) => left - right);
    if (!batch.length || !chatKey) return { skipped: true };
    const settings = this.getSettings();
    const records = batch.map((floorIndex) => {
      const message = chat[floorIndex];
      return {
        key: summaryKey(chatKey, floorIndex),
        chatKey,
        floorIndex,
        messageFingerprint: fingerprintMessage(message, floorIndex),
        ...messageMetadata(message),
      };
    });
    for (const record of records) {
      if (!isCurrent()) return { skipped: true };
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
      const rollup = await this.refreshRollup({ allowCompression: false });
      if (!isCurrent()) return { skipped: true };
      const provider = this.makeProvider(settings.summarySource);
      const results = await this.requestCompleteSummaries(provider, chat, batch, rollup?.text ?? '', isCurrent);
      const byFloor = new Map(results.map((result) => [result.floor - 1, result]));
      if (!isCurrent()) return { skipped: true };
      let readyCount = 0;
      for (const record of records) {
        if (!isCurrent()) return { skipped: true };
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
          inputComplete: true,
          ...summary,
          error: '',
          updatedAt: nowIso(),
        });
        readyCount += 1;
      }
      if (!isCurrent()) return { skipped: true };
      const rollupResult = await this.refreshRollup({ allowCompression: true });
      await this.onChange();
      return { ready: readyCount > 0, readyCount, rateLimited: rollupResult?.rateLimited };
    } catch (error) {
      if (!isCurrent()) return { skipped: true };
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

  async requestCompleteSummaries(provider, chat, batch, rollingSummary, isCurrent) {
    const makePayload = (inputChat, indexes) => buildSummaryBatchPayload({ chat: inputChat, floorIndexes: indexes, rollingSummary });
    let payload;
    try { payload = makePayload(chat, batch); } catch { /* Full oversized floors are read in parts below. */ }
    if (payload) return requestFloorSummaries(provider, payload);
    const results = [];
    for (const floorIndex of batch) {
      const text = String(chat[floorIndex].mes ?? '');
      const parts = splitInputText(text, (part) => JSON.stringify({ text: part }), 3500);
      const summaries = [];
      const segments = parts.length ? parts : [''];
      for (const [partIndex, part] of segments.entries()) {
        if (!isCurrent()) throw new Error('聊天已切换，本次摘要已停止。');
        const inputChat = [...chat];
        inputChat[floorIndex] = { ...chat[floorIndex], mes: part };
        const payload = buildSummaryBatchPayload({ chat: inputChat, floorIndexes: [floorIndex], rollingSummary, inputTokenLimit: 6200 });
        Object.assign(payload.targetFloors[0], { part: partIndex + 1, parts: segments.length });
        const [summary] = await requestFloorSummaries(provider, payload);
        summaries.push(summary);
      }
      results.push({
        floor: floorIndex + 1,
        summary: summaries.map((item) => item.summary).join('\n'),
        ...Object.fromEntries(['timeline', 'characters', 'relationships', 'clues'].map((field) => [field, summaries.flatMap((item) => item[field])])),
      });
    }
    return results;
  }

  async refreshRollup({ allowCompression = true, forceCompression = false } = {}) {
    const chatKey = this.chatKey;
    const revision = this.chatRevision;
    if (!chatKey) return null;
    const settings = this.getSettings();
    const ready = validSummaries(await this.storage.listSummaries(chatKey), this.getContext().chat);
    const checkpoints = (await this.storage.listCheckpoints(chatKey))
      .filter((checkpoint) => checkpoint.status === 'ready')
      .sort((left, right) => right.throughFloor - left.throughFloor);
    const validCheckpoint = checkpoints.find((checkpoint) => {
      const source = ready.filter((record) => record.floorIndex <= checkpoint.throughFloor);
      return checkpoint.formatVersion === 5 && checkpoint.sourceFingerprint === fingerprintSummaries(source);
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
    if (revision !== this.chatRevision) return null;
    await this.storage.putRollup(rollup);
    if (revision !== this.chatRevision) return null;

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
    const chatKey = rollup.chatKey;
    const revision = this.chatRevision;
    const isCurrent = () => this.chatKey === chatKey && this.chatRevision === revision;
    if (!isCurrent()) return null;
    const settings = this.getSettings();
    const throughFloor = rollup.throughFloor;
    const key = checkpointKey(chatKey, throughFloor);
    const source = ready.filter((record) => record.floorIndex <= throughFloor);
    await this.storage.putCheckpoint({
      key,
      chatKey,
      throughFloor,
      status: 'processing',
      summary: '',
      timeline: [],
      characters: [],
      relationships: [],
      clues: [],
      continuityRules: [],
      sourceFingerprint: fingerprintSummaries(source),
      formatVersion: 5,
      error: '',
      updatedAt: nowIso(),
    });
    await this.onChange();
    try {
      if (!isCurrent()) return null;
      const compressed = await requestCompression(this.makeProvider(settings.summarySource), rollup.text, throughFloor + 1);
      if (!isCurrent()) return null;
      const latest = validSummaries(await this.storage.listSummaries(chatKey), this.getContext().chat)
        .filter((record) => record.floorIndex <= throughFloor);
      if (!isCurrent() || fingerprintSummaries(latest) !== fingerprintSummaries(source)) return null;
      await this.storage.putCheckpoint({
        key,
        chatKey,
        throughFloor,
        status: 'ready',
        ...compressed,
        sourceFingerprint: fingerprintSummaries(source),
        formatVersion: 5,
        error: '',
        updatedAt: nowIso(),
      });
      return isCurrent() ? this.refreshRollup({ allowCompression: false }) : null;
    } catch (error) {
      if (!isCurrent()) return null;
      await this.storage.putCheckpoint({
        key,
        chatKey,
        throughFloor,
        status: 'failed',
        summary: '',
        timeline: [],
        characters: [],
        relationships: [],
        clues: [],
        continuityRules: [],
        sourceFingerprint: fingerprintSummaries(source),
        formatVersion: 5,
        error: errorText(error),
        updatedAt: nowIso(),
      });
      await this.storage.putRollup({ ...rollup, status: 'failed', error: errorText(error), updatedAt: nowIso() });
      await this.onChange();
      return { ...rollup, status: 'failed', error: errorText(error), rateLimited: isRateLimitError(error) };
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
    this.chatRevision += 1;
    this.queue = [];
    for (const resolve of this.idleWaiters.splice(0)) resolve();
    this.abortController?.abort();
    this.storage.close?.();
  }
}
