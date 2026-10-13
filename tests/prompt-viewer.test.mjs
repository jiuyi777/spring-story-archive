import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeFinalPrompt, pruneFinalPrompts } from '../core/send-history.js';
import { locateFloors, sourceOf } from '../ui/prompt-view.js';
import { createMemoryStorage } from '../core/storage.js';

test('chat-completion and text-completion prompts are both captured as messages', () => {
  assert.deepEqual(normalizeFinalPrompt([{ role: 'system', content: 'a' }, { role: 'user', content: [{ type: 'text', text: 'b' }, { type: 'image_url' }] }]),
    [{ role: 'system', name: undefined, content: 'a' }, { role: 'user', name: undefined, content: 'b\n[图片]' }]);
  assert.deepEqual(normalizeFinalPrompt('整段文本'), [{ role: 'prompt', content: '整段文本' }]);
  assert.equal(normalizeFinalPrompt(undefined), null);
});

test('each message is labelled with where it came from', () => {
  const messages = [
    { role: 'system', content: '你是林素。' },
    { role: 'system', content: '【春序档案 · 剧情总摘要】\n……' },
    { role: 'user', content: '玩家: 问她登记簿里少了哪一页。' },
    { role: 'system', content: '【剧情选项】\n每次写完正文后……' },
  ];
  const floors = locateFloors(messages, ['推门进了旧宅。', '林素抬头。', '问她登记簿里少了哪一页。']);
  assert.deepEqual(floors, [null, null, 2, null]);
  assert.deepEqual(messages.map((message, i) => sourceOf(message, floors[i])[0].kind), ['host', 'story', 'floor', 'options']);
});

test('only the newest sends keep their full prompt', async () => {
  const storage = createMemoryStorage();
  for (let i = 0; i < 12; i += 1) await storage.putSendRecord({ key: `A::send:${i}`, chatKey: 'A', startedAt: `2026-10-13T10:${String(i).padStart(2, '0')}:00Z`, finalPrompt: [{ role: 'user', content: String(i) }] });
  await pruneFinalPrompts(storage, 'A', 10);
  const records = await storage.listSendRecords('A');
  assert.equal(records.filter((record) => record.finalPrompt).length, 10);
  assert.ok(records.find((record) => record.key === 'A::send:0').finalPromptPruned);
});
