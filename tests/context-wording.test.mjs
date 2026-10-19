import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStoryContext, injectStoryContext, STORY_PROMPT_ID } from '../core/story-context.js';
import { fingerprintMessage, resolveUserName, buildSummaryBatchPayload, estimateTokens } from '../core/privacy-payload.js';
import { MEMORY_VERSION, memorySchemaForPrompt } from '../core/memory-database.js';
import { requestFloorSummaries, requestCompression } from '../core/api-client.js';

function fixture() {
  const sourceChat = Array.from({ length: 8 }, (_, index) => ({
    name: index % 2 ? '旁白' : (index < 4 ? '旧名' : '林青'), is_user: index % 2 === 0, mes: `正文${index}`,
  }));
  const summaries = sourceChat.map((message, floorIndex) => ({
    floorIndex, status: 'ready', inputComplete: true, memoryVersion: MEMORY_VERSION,
    messageFingerprint: fingerprintMessage(message, floorIndex), summary: floorIndex === 0 ? '我说：“玩家这个词留在引号里。”' : `往事${floorIndex}`,
    memoryChanges: floorIndex === 2 ? [{ table: 'player', id: '剧情节奏', values: { topic: '剧情节奏', content: '允许短暂追逐，不要长时间逃亡' } }] : [],
  }));
  return { sourceChat, promptChat: sourceChat.map((row, index) => ({ ...row, index })), summaries, checkpoints: [], contextSize: 32000 };
}

test('current user name labels wishes while historical speakers and quoted text stay intact', () => {
  const data = fixture();
  const before = structuredClone(data);
  const plan = buildStoryContext({ ...data, userName: '苏棠' });
  assert.match(plan.prompt, /【苏棠的偏好与要求】\n【苏棠】主题：剧情节奏/);
  assert.match(plan.prompt, /【旧名 · 往事】我说：“玩家这个词留在引号里。”/);
  assert.doesNotMatch(plan.prompt, /原文记录|角色回复|专表|起记录|第\s*\d+\s*楼|永久命令|按楼层顺序/);
  assert.deepEqual(data, before);
  assert.ok(plan.usedTokens <= plan.budget);
  assert.ok(Math.abs(plan.usedTokens - estimateTokens(plan.prompt)) <= plan.includedFloors.length + 2);
  assert.match(buildStoryContext(data).prompt, /【林青的偏好与要求】/);
  assert.equal(resolveUserName('', []), 'User');
});

test('injection reads the current SillyTavern persona for each request', async () => {
  const data = fixture();
  const prompts = new Map();
  const context = { chat: data.sourceChat, name1: '苏棠', setExtensionPrompt: (key, value) => prompts.set(key, value) };
  const args = { context, storage: { listSummaries: async () => data.summaries, listCheckpoints: async () => [] },
    chatKey: 'test', contextSize: 32000, enabled: true, filter: false, isCurrent: () => true };
  await injectStoryContext({ ...args, promptChat: data.promptChat });
  assert.match(prompts.get(STORY_PROMPT_ID), /【苏棠的偏好与要求】/);
  context.name1 = '阿青';
  await injectStoryContext({ ...args, promptChat: data.promptChat });
  assert.match(prompts.get(STORY_PROMPT_ID), /【阿青的偏好与要求】/);
  assert.doesNotMatch(prompts.get(STORY_PROMPT_ID), /苏棠/);
});

test('organizing receives actual speaker names and the same narration rule on repair', async () => {
  const payload = buildSummaryBatchPayload({ chat: [{ name: '林青', is_user: true, mes: '我喜欢安静调查。' }], floorIndexes: [0] });
  payload.memorySchema = memorySchemaForPrompt();
  assert.equal(payload.targetFloors[0].speakerName, '林青');
  assert.equal(payload.targetFloors[0].speaker, 'player');
  let calls = 0;
  await requestFloorSummaries(async ({ messages }) => {
    calls += 1;
    assert.match(messages[0].content, /直接使用 speakerName 中的姓名/);
    assert.match(messages[0].content, /保留引用原话/);
    return calls === 1 ? 'broken JSON' : { floors: [{ floor: 1, summary: '林青喜欢安静调查。', changes: [] }] };
  }, payload);
  assert.equal(calls, 2);
});

test('compression sends named history in order and preserves literal quotes and game players', async () => {
  const history = [
    '【旧名 · 往事】旧名说：“玩家这个词留在引号里。”',
    '【林青 · 往事】林青要求允许短暂追逐，不要长时间逃亡。',
    '【旁白 · 往事】沈砚向两位游戏玩家解释规则。',
  ].join('\n');
  const compressed = {
    summary: '旧名说：“玩家这个词留在引号里。”林青要求允许短暂追逐，不要长时间逃亡。沈砚向两位游戏玩家解释规则。',
    timeline: [], characters: ['旧名', '林青', '沈砚'], relationships: [], clues: [], continuityRules: [],
  };
  let captured;
  const result = await requestCompression(async (request) => {
    captured = request;
    return compressed;
  }, history, 3);

  assert.deepEqual(JSON.parse(captured.messages[1].content), { throughFloor: 3, rollingSummary: history, rawFloors: [] });
  const instruction = captured.messages[0].content;
  assert.match(instruction, /保留各段已有姓名与身份/);
  assert.match(instruction, /不同人物和历史发言者/);
  assert.match(instruction, /原话含义与引用原文保持准确/);
  assert.match(instruction, /按输入档案的排列顺序/);
  assert.match(instruction, /以后面的更新作为当前状态/);
  assert.match(instruction, /剧情中真实存在的游戏玩家/);
  assert.match(instruction, /不把有姓名的发言者改称“玩家”/);
  assert.match(instruction, /不添加“第几楼”“本楼未展开”“专表优先”/);
  assert.doesNotMatch(instruction, /附带楼层顺序|时间线顺序以楼层编号为准/);
  assert.deepEqual(result, compressed);
});
