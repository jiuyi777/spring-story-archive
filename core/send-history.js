import { fingerprintMessage } from './privacy-payload.js?v=0.7.1';

export function createSendHistory({ storage, chatKey, chat, promptChat, type, onChange = () => {} }) {
  const rows = chat.map((message, floorIndex) => ({ message, floorIndex })).filter(({ message }) => !message.is_system || message.extra?.tool_invocations);
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
