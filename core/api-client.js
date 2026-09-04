import {
  estimateTokens,
  REMOTE_INPUT_TOKEN_LIMIT,
  truncateToTokenBudget,
} from './privacy-payload.js';

function stripCodeFence(value) {
  return String(value ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
}

export function parseJsonEnvelope(value) {
  if (value && typeof value === 'object') return value;
  const text = stripCodeFence(value);
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
    throw new Error('模型没有返回可识别的 JSON。');
  }
}

function ensureEndpoint(endpoint) {
  const value = String(endpoint ?? '').trim();
  if (!value) throw new Error('请先填写额外 API 地址。');
  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol)) throw new Error('额外 API 仅支持 http 或 https 地址。');
  return url.href;
}

export function modelsEndpointForChatEndpoint(endpoint) {
  const url = new URL(ensureEndpoint(endpoint));
  const normalizedPath = url.pathname.replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(normalizedPath)) {
    url.pathname = normalizedPath.replace(/\/chat\/completions$/i, '/models');
  } else if (/\/responses$/i.test(normalizedPath)) {
    url.pathname = normalizedPath.replace(/\/responses$/i, '/models');
  } else {
    url.pathname = `${normalizedPath}/models`.replace(/\/{2,}/g, '/');
  }
  url.search = '';
  url.hash = '';
  return url.href;
}

export async function listOpenAiCompatibleModels({ endpoint, apiKey, signal, fetchImpl = fetch }) {
  const response = await fetchImpl(modelsEndpointForChatEndpoint(endpoint), {
    method: 'GET',
    headers: String(apiKey ?? '').trim() ? { Authorization: `Bearer ${String(apiKey).trim()}` } : {},
    signal,
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(`模型列表返回 ${response.status}${detail ? `：${detail}` : ''}`);
  }
  const payload = await response.json();
  const rows = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [];
  const models = rows
    .map((item) => typeof item === 'string' ? item : item?.id ?? item?.name)
    .map((item) => String(item ?? '').trim())
    .filter(Boolean);
  return [...new Set(models)].sort((left, right) => left.localeCompare(right));
}

export async function callOpenAiCompatible({ endpoint, apiKey, model, messages, maxTokens = 700, signal, fetchImpl = fetch }) {
  const response = await fetchImpl(ensureEndpoint(endpoint), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(String(apiKey ?? '').trim() ? { Authorization: `Bearer ${String(apiKey).trim()}` } : {}),
    },
    body: JSON.stringify({
      model: String(model ?? '').trim(),
      messages,
      temperature: 0.25,
      max_tokens: maxTokens,
      stream: false,
    }),
    signal,
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(`额外 API 返回 ${response.status}${detail ? `：${detail}` : ''}`);
  }
  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw new Error('额外 API 没有返回正文。');
  return content;
}

export function createProvider({ source, context, extra, signal }) {
  return async ({ messages, maxTokens }) => {
    if (source === 'current') {
      if (typeof context?.generateRaw !== 'function') throw new Error('当前 SillyTavern 不提供 generateRaw。');
      const systemPrompt = messages
        .filter((message) => message.role === 'system')
        .map((message) => String(message.content ?? ''))
        .join('\n\n');
      const prompt = messages
        .filter((message) => message.role !== 'system')
        .map((message) => `${message.role === 'assistant' ? 'assistant' : 'user'}:\n${String(message.content ?? '')}`)
        .join('\n\n');
      return context.generateRaw({ prompt, systemPrompt, responseLength: maxTokens, trimNames: false });
    }
    if (source === 'extra') {
      return callOpenAiCompatible({ ...extra, messages, maxTokens, signal });
    }
    throw new Error(`未知 API 来源：${source}`);
  };
}

function payloadText(payload) {
  const serialized = JSON.stringify(payload, null, 2);
  if (estimateTokens(serialized) <= REMOTE_INPUT_TOKEN_LIMIT) return serialized;
  return JSON.stringify({
    policy: {
      maxInputTokens: REMOTE_INPUT_TOKEN_LIMIT,
      contentTruncated: true,
      note: '输入过长，已保留开头与结尾并省略中段。',
    },
    condensedPayload: truncateToTokenBudget(serialized, REMOTE_INPUT_TOKEN_LIMIT - 350),
  }, null, 2);
}

function normalizeFloorSummary(parsed, floor) {
  const summary = String(parsed?.summary ?? '').trim();
  if (!summary) return null;
  return {
    floor,
    summary,
    characters: Array.isArray(parsed.characters) ? parsed.characters.map(String).filter(Boolean).slice(0, 12) : [],
    relationships: Array.isArray(parsed.relationships) ? parsed.relationships.map(String).filter(Boolean).slice(0, 12) : [],
    clues: Array.isArray(parsed.clues) ? parsed.clues.map(String).filter(Boolean).slice(0, 12) : [],
    timeline: Array.isArray(parsed.timeline) ? parsed.timeline.map(String).filter(Boolean).slice(0, 12) : [],
  };
}

export async function requestFloorSummaries(provider, payload) {
  const expectedFloors = (Array.isArray(payload?.targetFloors) ? payload.targetFloors : [])
    .map((item) => Number(item?.floor))
    .filter((floor) => Number.isInteger(floor) && floor > 0);
  if (!expectedFloors.length) throw new Error('批量摘要没有可处理的目标楼层。');
  const raw = await provider({
    maxTokens: Math.min(6000, Math.max(900, expectedFloors.length * 320)),
    messages: [
      {
        role: 'system',
        content: `你是长篇角色扮演档案员。一次处理 ${expectedFloors.length} 个目标楼层，每一楼都必须按原楼号分别返回，不得合并或漏楼。只依据提供的滚动摘要与 targetFloors 概括各目标楼层。玩家 user 的原话必须准确记录，并附带楼层顺序，不得用角色回复稀释或改写玩家意图。同一主题出现后续明确更新时，以更晚楼层作为当前状态；旧决定、拒绝、同意、偏好或边界只保留为当时发生过的历史，不继续当作当前约束，不得把任何单次表态永久化。时间线必须按楼层顺序记录：明确区分已发生、正在发生和计划中的事，不得无故跳时、回溯、换地点或改变人物关系。不得补写剧情。只输出 JSON：{"floors":[{"floor":楼号,"summary":"80到180字摘要","characters":["人物状态或变化"],"relationships":["人物关系及变化"],"clues":["伏笔或线索"],"timeline":["时间 · 地点 · 已发生事件"]}]}。floors 必须恰好覆盖 ${expectedFloors.join('、')} 楼；没有内容的数组保持为空。`,
      },
      { role: 'user', content: payloadText(payload) },
    ],
  });
  const parsed = parseJsonEnvelope(raw);
  const rows = Array.isArray(parsed?.floors) ? parsed.floors : [];
  const expected = new Set(expectedFloors);
  const results = [];
  const seen = new Set();
  for (const row of rows) {
    const floor = Number(row?.floor);
    if (!expected.has(floor) || seen.has(floor)) continue;
    const normalized = normalizeFloorSummary(row, floor);
    if (!normalized) continue;
    seen.add(floor);
    results.push(normalized);
  }
  if (!results.length) throw new Error('模型没有返回可用的逐楼摘要。');
  return results.sort((left, right) => left.floor - right.floor);
}

export async function requestFloorSummary(provider, payload) {
  const { recentFloors = [], targetFloor, ...safePayload } = payload ?? {};
  const floor = Number(targetFloor ?? recentFloors.at(-1)?.floor ?? 1);
  const target = recentFloors.find((item) => Number(item?.floor) === floor)
    ?? recentFloors.at(-1);
  const [result] = await requestFloorSummaries(provider, {
    ...safePayload,
    targetFloors: target ? [{ ...target, floor }] : [{ floor, text: '' }],
  });
  if (!result) throw new Error('模型返回的楼层摘要为空。');
  const { floor: ignored, ...summary } = result;
  return summary;
}

export async function requestCompression(provider, rollingText, throughFloor) {
  const raw = await provider({
    maxTokens: 1200,
    messages: [
      {
        role: 'system',
        content: '你是长篇剧情总档案员。把给出的既有档案压缩为一份可供后续续写使用的总档案。玩家原话必须准确保留并附带楼层顺序。同一主题出现后续明确更新时，以更晚楼层作为当前状态；旧决定、拒绝、同意、偏好或边界只保留为当时发生过的历史，不继续当作当前约束，不得把任何单次表态永久化。时间线顺序以楼层编号为准，不得改变事件先后、地点、已知人物关系或事件状态。可以合并重复信息，不得添加原档案中不存在的信息。只输出 JSON：{"summary":"压缩后的总摘要","timeline":["按时间顺序保留的事件锚点"],"characters":["人物当前状态"],"relationships":["已确认的人物关系"],"clues":["未解决线索"],"continuityRules":["后续续写不得违反的已知事实"]}。',
      },
      { role: 'user', content: payloadText({ throughFloor, rollingSummary: rollingText, rawFloors: [] }) },
    ],
  });
  const parsed = parseJsonEnvelope(raw);
  const summary = String(parsed.summary ?? '').trim();
  if (!summary) throw new Error('模型返回的大总结为空。');
  return {
    summary,
    timeline: Array.isArray(parsed.timeline) ? parsed.timeline.map(String).filter(Boolean).slice(0, 80) : [],
    characters: Array.isArray(parsed.characters) ? parsed.characters.map(String).filter(Boolean).slice(0, 40) : [],
    relationships: Array.isArray(parsed.relationships) ? parsed.relationships.map(String).filter(Boolean).slice(0, 40) : [],
    clues: Array.isArray(parsed.clues) ? parsed.clues.map(String).filter(Boolean).slice(0, 40) : [],
    continuityRules: Array.isArray(parsed.continuityRules) ? parsed.continuityRules.map(String).filter(Boolean).slice(0, 40) : [],
  };
}

const MODE_LABELS = {
  guided: '玩家行动（代入）：每个选项直接写玩家下一步可做的事、目标与可能代价，不替玩家决定内心。',
  scene: '场景入口：每个选项通往一个可立即进入的具体场景，写清地点、事件入口和冲突。',
  third: '第三人称叙事：每个选项用角色名或第三人称描述主角接下来可能采取的行动。',
  mixed: '混合表达：根据当前情境在玩家行动、场景入口和第三人称叙事之间合理分配，三种表达至少各出现一次，并保持每个选项本身表达清楚。',
};

export async function requestStoryOptions(provider, payload, { mode = 'guided', count = 6, playerProfile = null } = {}) {
  const safeCount = Math.max(4, Math.min(12, Number(count) || 6));
  const raw = await provider({
    maxTokens: Math.max(500, safeCount * 100),
    messages: [
      {
        role: 'system',
        content: `你是互动叙事选项设计者。玩家原话必须结合楼层顺序理解；同一主题出现后续明确更新时，以更晚楼层作为当前状态，旧表态只作为历史，不得把任何单次决定、拒绝、同意、偏好或边界永久化。${MODE_LABELS[mode] ?? MODE_LABELS.guided} 生成恰好 ${safeCount} 个彼此明显不同、能继续当前剧情的选项。不得破坏档案里的时间先后、当前地点和人物关系。只输出 JSON：{"options":["选项"]}。`,
      },
      { role: 'user', content: payloadText({ ...payload, playerPreferenceProfile: playerProfile }) },
    ],
  });
  const options = parseJsonEnvelope(raw).options;
  if (!Array.isArray(options)) throw new Error('模型没有返回剧情选项数组。');
  const clean = options.map((item) => String(item).trim()).filter(Boolean).slice(0, safeCount);
  if (clean.length < safeCount) throw new Error(`模型只返回了 ${clean.length} 个选项，需要 ${safeCount} 个。`);
  return clean;
}

export async function requestPlayerPreferenceProfile(provider, payload, answers) {
  const raw = await provider({
    maxTokens: 900,
    messages: [
      {
        role: 'system',
        content: '你是玩家人格倾向与剧情偏好分析器。综合玩家主动填写的非诊断性测试、可多选的剧情体验、补充说明、总摘要与获准发送的近期上下文（可能没有楼层原文），分析互动方式、人物关系、连续性、冲突承受度、新奇偏好，以及玩家想要的剧情体验。多选项只是线索，必须与聊天中的真实表达共同判断，不得逐个标签机械拼接。测试可以被跳过；跳过时只依据聊天中玩家明确表达的内容，证据不足就保持保守。不得进行心理诊断或将玩家定型。聊天中的明确表达必须按楼层顺序判断；同一主题以后有新表态时，以更晚楼层为当前状态，旧表态只保留为历史，不得永久化。玩家当前明确表达优先于测试推断。只输出 JSON：{"summary":"一段直接的玩家剧情偏好说明","personalityTendencies":["与角色扮演有关的人格和互动倾向"],"storyNeeds":["玩家想从剧情中得到的体验"],"preferredDevelopments":["适合的发展方向"],"avoidPatterns":["应避免的叙事方式"],"directorRules":["自主推进时必须遵守的规则"]}。',
      },
      { role: 'user', content: payloadText({ ...payload, preferenceTestAnswers: answers }) },
    ],
  });
  const parsed = parseJsonEnvelope(raw);
  const summary = String(parsed.summary ?? '').trim();
  if (!summary) throw new Error('模型没有返回玩家偏好分析。');
  return {
    summary,
    personalityTendencies: Array.isArray(parsed.personalityTendencies) ? parsed.personalityTendencies.map(String).filter(Boolean).slice(0, 12) : [],
    storyNeeds: Array.isArray(parsed.storyNeeds) ? parsed.storyNeeds.map(String).filter(Boolean).slice(0, 12) : [],
    preferredDevelopments: Array.isArray(parsed.preferredDevelopments) ? parsed.preferredDevelopments.map(String).filter(Boolean).slice(0, 12) : [],
    avoidPatterns: Array.isArray(parsed.avoidPatterns) ? parsed.avoidPatterns.map(String).filter(Boolean).slice(0, 12) : [],
    directorRules: Array.isArray(parsed.directorRules) ? parsed.directorRules.map(String).filter(Boolean).slice(0, 12) : [],
  };
}

function normalizeNpcProfile(parsed) {
  const name = String(parsed?.name ?? '').trim();
  if (!name) throw new Error('模型没有返回 NPC 姓名。');
  const plotFunction = String(parsed?.plotFunction ?? '').trim();
  if (!plotFunction) throw new Error('模型没有判断 NPC 的剧情功能。');
  const list = (key, limit = 12) => Array.isArray(parsed?.[key]) ? parsed[key].map(String).filter(Boolean).slice(0, limit) : [];
  return {
    name,
    age: String(parsed.age ?? '').trim(),
    lifeStage: String(parsed.lifeStage ?? '').trim(),
    occupation: String(parsed.occupation ?? '').trim(),
    plotFunction,
    currentGoal: String(parsed.currentGoal ?? '').trim(),
    objectiveFacts: list('objectiveFacts'),
    biography: list('biography', 20),
    personality: String(parsed.personality ?? '').trim(),
    contradictions: list('contradictions'),
    personalityFormation: list('personalityFormation'),
    independentWill: list('independentWill'),
    relationships: list('relationships'),
    growthState: list('growthState'),
    playerMemory: list('playerMemory'),
  };
}

function normalizeNpcUpdates(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const update = { id: String(item?.id ?? '').trim() };
    for (const key of ['age', 'lifeStage', 'occupation', 'currentGoal']) {
      const text = String(item?.[key] ?? '').trim();
      if (text) update[key] = text;
    }
    for (const key of ['objectiveFacts', 'relationships', 'growthState', 'playerMemory']) {
      const entries = Array.isArray(item?.[key])
        ? item[key].map(String).map((entry) => entry.trim()).filter(Boolean).slice(0, 12)
        : [];
      if (entries.length) update[key] = entries;
    }
    return update;
  }).filter((item) => item.id && Object.keys(item).length > 1);
}

export async function requestNpcProfile(provider, payload, { brief = '', playerProfile = null, existingNpcs = [] } = {}) {
  const raw = await provider({
    maxTokens: 1300,
    messages: [
      {
        role: 'system',
        content: '你是长篇角色扮演的 NPC 人物档案设计者。先依据滚动总摘要、获准发送的近期上下文（可能没有楼层原文）和现有 NPC 档案，自行判断当前剧情真正缺少且尚未被现有人物承担的功能，再把判断写入 plotFunction；玩家不负责选择人物功能。用户补充要求只作为世界观事实、内容边界或避雷信息，不得直接替代你的剧情判断。NPC 必须对当前剧情有明确功能，同时是一个有自己愿望、恐惧、边界、判断和利益的真实人物，不是只为玩家服务的工具人。先记录客观的人生事实：年龄或合理年龄范围、人生阶段、当前工作、身份、住处、责任、资源限制和当前处境。再详细写出真正塑造其性格的过去经历，明确经历造成的信念、敏感点、能力、缺陷与人物内部矛盾；由这些经历自然推出性格，但不要输出“他以后一定会怎样做”的预设行为。禁止设计固定口癖、固定小动作、招牌反应和重复行为脚本，它们会使模型复读。NPC 可以拒绝、误解、隐瞒或为自己行动，但不得无故破坏时间线和已有人物关系。为 NPC 生成一份仅基于获准上下文和总摘要的短期玩家记录，并标明表态发生的楼层或阶段；同一主题若有后续明确更新，以更晚楼层为当前状态，旧拒绝、同意、偏好或边界只作为历史，不得永久化。只输出 JSON：{"name":"姓名","age":"年龄或年龄范围","lifeStage":"人生阶段","occupation":"当前工作","plotFunction":"AI 根据当前剧情判断的功能","currentGoal":"当前目标","objectiveFacts":["当前可验证的客观事实"],"biography":["详细的人生经历及当时造成的现实后果"],"personality":"由经历形成的性格概括","contradictions":["人物内部相互拉扯的矛盾面"],"personalityFormation":["某段经历如何形成某种性格或信念"],"independentWill":["不会随意让步的愿望、利益或底线"],"relationships":["与现有人物的已知关系"],"growthState":["当前人生阶段中仍在变化的部分"],"playerMemory":["对玩家的短期事实记录"]}。',
      },
      { role: 'user', content: payloadText({ ...payload, userBrief: brief, playerPreferenceProfile: playerProfile, existingNpcArchive: existingNpcs }) },
    ],
  });
  return normalizeNpcProfile(parseJsonEnvelope(raw));
}

export async function requestNpcGenerationDecision(provider, payload, { playerProfile = null, existingNpcs = [], brief = '' } = {}) {
  const raw = await provider({
    maxTokens: 1500,
    messages: [
      {
        role: 'system',
        content: '你是长篇角色扮演的 NPC 建档导演。玩家不选择 NPC 的剧情功能；你必须依据滚动总摘要、获准发送的近期上下文（可能没有楼层原文）、现有 NPC 档案和玩家偏好，自行判断当前是否缺少某种剧情功能。用户补充要求只作为世界观事实、内容边界或避雷信息。先核对现有 NPC 档案：只有剧情明确推进了年龄、人生阶段、工作、当前目标、客观状态、关系、成长状态或对玩家的事实记忆时，才在 updates 中更新对应字段；玩家记忆必须按楼层顺序更新，同一主题以更晚明确表态为当前状态，旧拒绝、同意、偏好或边界只作为历史，不得永久化。不得根据气氛猜测，不得无依据改年龄或工作，不得改写玩家手工编辑的历史经历。然后判断是否真的需要新增 NPC：只有出现明确且尚未被现有人物承担的剧情功能、社会角色、信息来源或阻力时才新增；现有人物可以承担、只是为了热闹、或当前尚未需要时，必须返回 needed=false。需要新增时，由你把判断出的功能写入 plotFunction，再写年龄、人生阶段、当前工作和客观处境，并用详细经历解释形成的性格、信念和内部矛盾。不要输出预设行为，不要设计固定口癖、固定小动作、招牌反应或重复行为脚本。NPC 可以拒绝、误解、隐瞒或按自己的利益行动。不得破坏时间线、替玩家决定行动或复制已有 NPC。只输出 JSON：{"updates":[{"id":"既有档案 id","age":"仅明确变化时提供","lifeStage":"仅明确变化时提供","occupation":"仅明确变化时提供","currentGoal":"仅明确变化时提供","objectiveFacts":["更新后的客观状态"],"relationships":["更新后的已知关系"],"growthState":["更新后的成长状态"],"playerMemory":["更新后的玩家事实记录"]}],"needed":true或false,"reason":"判断理由","npc":null或{"name":"姓名","age":"年龄或年龄范围","lifeStage":"人生阶段","occupation":"当前工作","plotFunction":"AI 根据当前剧情判断的功能","currentGoal":"当前目标","objectiveFacts":["当前可验证的客观事实"],"biography":["详细的人生经历及现实后果"],"personality":"由经历形成的性格概括","contradictions":["人物内部矛盾"],"personalityFormation":["经历如何形成性格或信念"],"independentWill":["愿望、利益或底线"],"relationships":["已知人物关系"],"growthState":["仍在变化的成长状态"],"playerMemory":["对玩家的短期事实记录"]}}。',
      },
      {
        role: 'user',
        content: payloadText({
          ...payload,
          userBrief: brief,
          playerPreferenceProfile: playerProfile,
          existingNpcArchive: existingNpcs,
        }),
      },
    ],
  });
  const parsed = parseJsonEnvelope(raw);
  const needed = parsed.needed === true || String(parsed.needed).toLowerCase() === 'true';
  const updates = normalizeNpcUpdates(parsed.updates);
  if (!needed) return { needed: false, reason: String(parsed.reason ?? '').trim(), npc: null, updates };
  return {
    needed: true,
    reason: String(parsed.reason ?? '').trim(),
    npc: normalizeNpcProfile(parsed.npc),
    updates,
  };
}

export async function requestAdvanceDirective(provider, payload, { playerProfile = null, npcProfiles = [] } = {}) {
  const raw = await provider({
    maxTokens: 600,
    messages: [
      {
        role: 'system',
        content: '你是隐藏运行的剧情推进导演。依据总档案、获准发送的近期上下文（可能没有楼层原文）、玩家剧情偏好和已生成 NPC，为下一次角色回复提出一条具体且克制的推进指令。玩家原话必须按楼层顺序理解；同一主题以后有新表态时，以更晚楼层为当前状态，旧决定、拒绝、同意、偏好或边界只作为历史，不得永久化。不得替玩家决定行动。在提出指令前先校对时间、地点、已发生事件、人物状态和人物关系；如果档案没有支持，不得跳时、回溯、瞬移或改变关系。NPC 必须保持自己的目标和底线，不得变成工具人。不要直接写成完整回复。只输出 JSON：{"continuityCheck":"时间、地点和人物状态校对结果","directive":"推进指令"}。',
      },
      { role: 'user', content: payloadText({ ...payload, playerPreferenceProfile: playerProfile, availableNpcs: npcProfiles }) },
    ],
  });
  const parsed = parseJsonEnvelope(raw);
  const directive = String(parsed.directive ?? '').trim();
  if (!directive) throw new Error('模型返回的推进指令为空。');
  return {
    directive,
    continuityCheck: String(parsed.continuityCheck ?? '').trim(),
  };
}
