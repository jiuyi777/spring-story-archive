import test from 'node:test';
import assert from 'node:assert/strict';
import {
  callOpenAiCompatible,
  createProvider,
  listOpenAiCompatibleModels,
  modelsEndpointForChatEndpoint,
  parseJsonEnvelope,
  requestAdvanceDirective,
  requestCompression,
  requestFloorSummary,
  requestNpcGenerationDecision,
  requestNpcProfile,
  requestPlayerPreferenceProfile,
  requestStoryOptions,
} from '../core/api-client.js';
import { estimateTokens, REMOTE_INPUT_TOKEN_LIMIT } from '../core/privacy-payload.js';

test('JSON parser accepts fenced model output', () => {
  assert.deepEqual(parseJsonEnvelope('```json\n{"summary":"春雨"}\n```'), { summary: '春雨' });
});

test('OpenAI-compatible client sends the supplied messages without adding chat data', async () => {
  let captured;
  const result = await callOpenAiCompatible({
    endpoint: 'https://example.test/v1/chat/completions',
    apiKey: 'secret-for-test',
    model: 'test-model',
    messages: [{ role: 'user', content: 'SAFE_PAYLOAD_ONLY' }],
    fetchImpl: async (url, init) => {
      captured = { url, init, body: JSON.parse(init.body) };
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'OK' } }] }),
      };
    },
  });
  assert.equal(result, 'OK');
  assert.equal(captured.url, 'https://example.test/v1/chat/completions');
  assert.deepEqual(captured.body.messages, [{ role: 'user', content: 'SAFE_PAYLOAD_ONLY' }]);
  assert.equal(captured.init.headers.Authorization, 'Bearer secret-for-test');
});

test('model discovery derives the models endpoint and returns unique model ids', async () => {
  assert.equal(modelsEndpointForChatEndpoint('https://example.test/v1/chat/completions'), 'https://example.test/v1/models');
  let captured;
  const models = await listOpenAiCompatibleModels({
    endpoint: 'https://example.test/v1/chat/completions',
    apiKey: 'session-key',
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return {
        ok: true,
        json: async () => ({ data: [{ id: 'model-b' }, { id: 'model-a' }, { id: 'model-a' }] }),
      };
    },
  });
  assert.equal(captured.url, 'https://example.test/v1/models');
  assert.equal(captured.init.headers.Authorization, 'Bearer session-key');
  assert.deepEqual(models, ['model-a', 'model-b']);
});

test('story options enforce the requested 4 to 12 count contract', async () => {
  const provider = async () => JSON.stringify({ options: Array.from({ length: 12 }, (_, index) => `选项${index + 1}`) });
  const options = await requestStoryOptions(provider, { rollingSummary: '', recentFloors: [] }, { mode: 'third', count: 12 });
  assert.equal(options.length, 12);
  assert.equal(options.at(-1), '选项12');
});

test('API request payload stays within the remote input budget even with oversized profile data', async () => {
  let userPrompt = '';
  await requestStoryOptions(async ({ messages }) => {
    userPrompt = messages[1].content;
    return JSON.stringify({ options: Array.from({ length: 6 }, (_, index) => `选项${index + 1}`) });
  }, { rollingSummary: '摘要', recentFloors: [] }, {
    playerProfile: { summary: '非常长的偏好'.repeat(12000) },
  });
  assert.ok(estimateTokens(userPrompt) <= REMOTE_INPUT_TOKEN_LIMIT);
  assert.match(userPrompt, /contentTruncated/);
});

test('mixed story option mode asks for all three narrative expressions', async () => {
  let systemPrompt = '';
  await requestStoryOptions(async ({ messages }) => {
    systemPrompt = messages[0].content;
    return JSON.stringify({ options: Array.from({ length: 6 }, (_, index) => `选项${index + 1}`) });
  }, { rollingSummary: '', recentFloors: [] }, { mode: 'mixed', count: 6 });
  assert.match(systemPrompt, /混合表达/);
  assert.match(systemPrompt, /三种表达至少各出现一次/);
});

test('current SillyTavern provider converts chat messages to generateRaw string fields', async () => {
  let captured;
  const provider = createProvider({
    source: 'current',
    context: {
      generateRaw: async (options) => {
        captured = options;
        return 'OK';
      },
    },
    extra: {},
  });
  await provider({
    maxTokens: 321,
    messages: [
      { role: 'system', content: '系统规则' },
      { role: 'user', content: '仅安全负载' },
    ],
  });
  assert.equal(captured.systemPrompt, '系统规则');
  assert.equal(captured.prompt, 'user:\n仅安全负载');
  assert.equal(captured.responseLength, 321);
});

test('summary prompts preserve player statements without making old statements permanent', async () => {
  const prompts = [];
  const provider = async ({ messages }) => {
    prompts.push(messages[0].content);
    return prompts.length === 1
      ? JSON.stringify({ summary: '玩家选择留下。', characters: [], relationships: [], clues: [], timeline: [] })
      : JSON.stringify({ summary: '压缩总摘要。' });
  };
  await requestFloorSummary(provider, { rollingSummary: '', recentFloors: [] });
  await requestCompression(provider, '【玩家原文记录】玩家选择留下。', 7);
  assert.match(prompts[0], /玩家 user 的原话必须准确记录/);
  assert.match(prompts[0], /以更晚楼层作为当前状态/);
  assert.match(prompts[1], /不得把任何单次表态永久化/);
  assert.doesNotMatch(prompts.join('\n'), /最高优先级/);
  assert.match(prompts[1], /时间线顺序以楼层编号为准/);
});

test('preference, NPC and advance prompts keep player control and continuity', async () => {
  const prompts = [];
  const provider = async ({ messages }) => {
    prompts.push(messages[0].content);
    if (prompts.length === 1) return JSON.stringify({ summary: '玩家偏好调查与慢热关系。', storyNeeds: [], preferredDevelopments: [], avoidPatterns: [], directorRules: [] });
    if (prompts.length === 2) return JSON.stringify({ name: '林素', age: '34 岁', lifeStage: '重建职业信誉', occupation: '档案保管人', plotFunction: '情报源', currentGoal: '保住旧宅', objectiveFacts: ['持有旧登记簿'], biography: ['错误证词曾伤害无辜者'], personality: '谨慎', contradictions: ['希望被信任，却难以相信口头证词'], personalityFormation: ['错误证词使她重视证据链'], independentWill: ['不出卖家人'], relationships: [], growthState: ['正在决定是否公开旧案'], playerMemory: ['玩家拒绝被代替决定'] });
    return JSON.stringify({ continuityCheck: '时间仍为暮春傍晚', directive: '让门外的访客提及旧地图。' });
  };
  const payload = { rollingSummary: '', recentFloors: [] };
  const profile = await requestPlayerPreferenceProfile(provider, payload, { pace: 'slow' });
  const npc = await requestNpcProfile(provider, payload, { brief: '', playerProfile: profile, existingNpcs: [] });
  const advance = await requestAdvanceDirective(provider, payload, { playerProfile: profile, npcProfiles: [npc] });
  assert.match(prompts[0], /不得进行心理诊断/);
  assert.match(prompts[1], /不是只为玩家服务的工具人/);
  assert.match(prompts[1], /禁止设计固定口癖、固定小动作/);
  assert.match(prompts[1], /玩家不负责选择人物功能/);
  assert.doesNotMatch(prompts[1], /玩家选择.*剧情功能/);
  assert.equal(npc.occupation, '档案保管人');
  assert.deepEqual(npc.biography, ['错误证词曾伤害无辜者']);
  assert.match(prompts[2], /先校对时间、地点/);
  assert.equal(advance.continuityCheck, '时间仍为暮春傍晚');
});

test('automatic NPC director can decide that no new NPC is needed', async () => {
  let systemPrompt = '';
  const decision = await requestNpcGenerationDecision(async ({ messages }) => {
    systemPrompt = messages[0].content;
    return JSON.stringify({
      updates: [{ id: 'npc-1', age: '35 岁', occupation: '', objectiveFacts: ['已离开旧宅'] }],
      needed: false,
      reason: '现有人物已经承担情报功能',
      npc: null,
    });
  }, { rollingSummary: '', recentFloors: [] }, { existingNpcs: [{ name: '林素' }] });
  assert.equal(decision.needed, false);
  assert.deepEqual(decision.updates, [{ id: 'npc-1', age: '35 岁', objectiveFacts: ['已离开旧宅'] }]);
  assert.match(systemPrompt, /现有人物可以承担.*必须返回 needed=false/);
  assert.match(systemPrompt, /不得无依据改年龄或工作/);
});

test('NPC creation requires the AI to provide its own plot function', async () => {
  await assert.rejects(
    requestNpcProfile(async () => JSON.stringify({ name: '林素' }), { rollingSummary: '', recentFloors: [] }),
    /没有判断 NPC 的剧情功能/,
  );
});
