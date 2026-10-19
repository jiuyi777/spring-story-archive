import { fingerprintMessage } from './privacy-payload.js?v=0.7.3';

export function createSendHistory({ storage, chatKey, chat, promptChat, type, onChange = () => {} }) {
  const includesTools = promptChat.some((message) => message.is_system && Array.isArray(message.extra?.tool_invocations));
  const rows = chat.map((message, floorIndex) => ({ message, floorIndex }))
    .filter(({ message }) => !message.is_system || (includesTools && Array.isArray(message.extra?.tool_invocations)));
  const record = {
    key: `${chatKey}::send:${crypto.randomUUID()}`, chatKey, type: type || 'normal',
    targetFloor: type === 'swipe' || type === 'continue' ? chat.length : chat.length + 1,
    startedAt: new Date().toISOString(), status: 'prepared', verified: false,
    signature: chat.map(fingerprintMessage).join('|'), summaryPrompt: '', recallPrompt: '',
    memories: [], includedFloors: [], removedFloors: [],
    rawFloors: promptChat.map((message) => ({ floorIndex: rows[message.index]?.floorIndex ?? null,
      role: message.is_user ? '玩家' : message.is_system ? '系统' : '角色', text: String(message.mes ?? '') })),
  };
  let chain = Promise.resolve();
  let terminal = false;
  const persist = () => {
    const snapshot = structuredClone(record);
    chain = chain.then(() => storage.putSendRecord(snapshot)).then(() => onChange()).catch((error) => onChange(error));
    return chain;
  };
  persist();
  return {
    plan(plan, filter) {
      if (terminal) return;
      record.summaryPrompt = plan.prompt;
      record.memories = plan.memories ?? [];
      record.includedFloors = plan.includedFloors;
      const removed = filter ? new Set(plan.removeIndexes) : new Set();
      record.removedFloors = [...removed].map((index) => record.rawFloors[index]?.floorIndex).filter(Number.isInteger);
      record.rawFloors = record.rawFloors.filter((_, index) => !removed.has(index));
      persist();
    },
    // The exact request the host assembled: every message, in order.
    final(messages) {
      if (terminal || !Array.isArray(messages)) return;
      record.finalPrompt = messages;
      record.finalAt = new Date().toISOString();
      persist();
    },
    budget(value) {
      if (terminal) return;
      record.budget = value;
      persist();
    },
    recall(prompt, records) {
      if (terminal) return;
      record.recallPrompt = prompt || '';
      record.recalledFloors = records.map((row) => row.floorIndex);
      persist();
    },
    evidence(event) {
      if (terminal) return;
      if (event.status === 'verified') { record.verified = true; record.status = 'verified'; }
      if (event.status === 'cancelled') { record.status = 'stopped'; terminal = true; }
      if (event.reason) record.note = event.reason;
      persist();
    },
    finish(status = 'ended', floorIndex) {
      if (terminal) return chain;
      terminal = true;
      record.status = status;
      if (Number.isInteger(floorIndex)) record.targetFloor = floorIndex + 1;
      record.finishedAt = new Date().toISOString();
      return persist();
    },
    idle: () => chain,
  };
}

// The host hands over either a message list (chat completion) or one string
// (text completion). Both become [{ role, content }] for the viewer.
export function normalizeFinalPrompt(prompt) {
  const text = (content) => {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map((part) => (typeof part === 'string' ? part : part?.text ?? (part?.type === 'image_url' ? '[图片]' : ''))).filter(Boolean).join('\n');
    if (content && typeof content === 'object') return String(content.text ?? content.content ?? '');
    return '';
  };
  if (typeof prompt === 'string') return [{ role: 'prompt', content: prompt }];
  if (!Array.isArray(prompt)) return null;
  return prompt.filter((item) => item && typeof item === 'object').map((item) => ({ role: String(item.role ?? 'system'), name: item.name ? String(item.name) : undefined, content: text(item.content) }));
}

// Full prompts are large; only the newest few sends of a chat keep theirs.
export async function pruneFinalPrompts(storage, chatKey, keep = 10) {
  const records = (await storage.listSendRecords(chatKey)).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  for (const record of records.slice(keep)) {
    if (!record.finalPrompt) continue;
    const { finalPrompt, ...rest } = record;
    void finalPrompt;
    await storage.putSendRecord({ ...rest, finalPromptPruned: true });
  }
}
