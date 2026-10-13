import {
  estimateTokens,
  REMOTE_INPUT_TOKEN_LIMIT,
  splitInputText,
  truncateToTokenBudget,
} from './privacy-payload.js?v=0.7.2';
import { validateMemoryChanges, MEMORY_VERSION } from './memory-database.js?v=0.7.2';

function stripCodeFence(value) {
  return String(value ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
}

export function parseJsonEnvelope(value) {
  if (value && typeof value === 'object') return value;
  const text = stripCodeFence(String(value ?? '').replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, ''));
  try {
    return JSON.parse(text);
  } catch {
    // Read balanced JSON blocks, including braces inside quoted strings.
    const candidates = [];
    for (let start = 0; start < text.length; start += 1) {
      if (!'{['.includes(text[start])) continue;
      let depth = 0, quoted = false, escaped = false;
      for (let end = start; end < text.length; end += 1) {
        const char = text[end];
        if (quoted) {
          if (escaped) escaped = false;
          else if (char === '\\') escaped = true;
          else if (char === '"') quoted = false;
        } else if (char === '"') quoted = true;
        else if ('{['.includes(char)) depth += 1;
        else if ('}]'.includes(char) && --depth === 0) {
          try { candidates.push(JSON.parse(text.slice(start, end + 1))); start = end; } catch {}
          break;
        }
      }
    }
    if (candidates.length) return candidates.at(-1);
    throw new Error('接口返回的内容不是完整的结构化结果。');
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

// Accept the same address SillyTavern takes (…/v1) as well as the full
// …/chat/completions address.
export function chatCompletionsUrl(endpoint) {
  const url = new URL(ensureEndpoint(endpoint));
  const path = url.pathname.replace(/\/+$/, '');
  if (!/\/chat\/completions$/i.test(path)) url.pathname = `${path}/chat/completions`.replace(/\/{2,}/g, '/');
  return url.href;
}

export function apiBaseUrl(endpoint) {
  return chatCompletionsUrl(endpoint).replace(/\/chat\/completions(?=$|[?#])/i, '');
}

// When the browser cannot reach the API directly (blocked by CORS), send the
// same request through SillyTavern's own server, as SillyTavern does.
async function viaSillyTavern(proxy, { endpoint, apiKey, body, signal }) {
  const key = String(apiKey ?? '').trim();
  return proxy('/api/backends/chat-completions/generate', {
    method: 'POST',
    body: JSON.stringify({
      ...body,
      chat_completion_source: 'custom',
      custom_url: apiBaseUrl(endpoint),
      ...(key ? { custom_include_headers: `Authorization: ${JSON.stringify(`Bearer ${key}`)}` } : {}),
    }),
    signal,
  });
}

export async function callOpenAiCompatible({ endpoint, apiKey, model, messages, maxTokens = 700, signal, fetchImpl = fetch, proxy = null }) {
  const body = {
    model: String(model ?? '').trim(),
    messages,
    temperature: 0.25,
    max_tokens: maxTokens,
    stream: false,
  };
  let response;
  try {
    response = await fetchImpl(chatCompletionsUrl(endpoint), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(String(apiKey ?? '').trim() ? { Authorization: `Bearer ${String(apiKey).trim()}` } : {}),
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (!proxy || error?.name === 'AbortError') throw error;
    response = await viaSillyTavern(proxy, { endpoint, apiKey, body, signal });
  }
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(`额外 API 返回 ${response.status}${detail ? `：${detail}` : ''}`);
  }
  const data = await response.json();
  if (data?.choices?.[0]?.finish_reason === 'length') throw new Error('接口输出达到长度上限，记忆结果被截断；请提高接口输出上限后重试。');
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw new Error('额外 API 没有返回正文。');
  return content;
}

function sillyTavernProxy(context) {
  if (typeof context?.getRequestHeaders !== 'function') return null;
  return (url, init) => fetch(url, { ...init, headers: { ...context.getRequestHeaders(), 'Content-Type': 'application/json' } });
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
      signal?.throwIfAborted();
      const result = await context.generateRaw({ prompt, systemPrompt, responseLength: maxTokens, trimNames: false });
      signal?.throwIfAborted();
      return result;
    }
    if (source === 'extra') {
      return callOpenAiCompatible({ ...extra, messages, maxTokens, signal, proxy: sillyTavernProxy(context) });
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

function normalizeFloorSummary(parsed, floor, structuredMemory = false) {
  const summary = String(parsed?.summary ?? '').trim();
  if (!summary) return null;
  return {
    floor,
    summary,
    characters: Array.isArray(parsed.characters) ? parsed.characters.map(String).filter(Boolean).slice(0, 12) : [],
    relationships: Array.isArray(parsed.relationships) ? parsed.relationships.map(String).filter(Boolean).slice(0, 12) : [],
    clues: Array.isArray(parsed.clues) ? parsed.clues.map(String).filter(Boolean).slice(0, 12) : [],
    timeline: Array.isArray(parsed.timeline) ? parsed.timeline.map(String).filter(Boolean).slice(0, 12) : [],
    ...(structuredMemory ? { memoryVersion: MEMORY_VERSION, memoryChanges: validateMemoryChanges(parsed.changes) } : {}),
    ...(Array.isArray(parsed?.rewrites) && parsed.rewrites.length
      ? { rewrites: parsed.rewrites.filter((item) => typeof item?.from === 'string' && typeof item?.to === 'string').slice(0, 12).map(({ from, to }) => ({ from, to })) }
      : {}),
    ...(parsed?.npc && typeof parsed.npc.needed === 'boolean'
      ? { npcSignal: { needed: parsed.npc.needed, reason: String(parsed.npc.reason ?? '').trim().slice(0, 300) } }
      : {}),
  };
}

// Folded into the single per-floor organizing call so that judging "does the
// story need a new person" never costs a request of its own.
// Sentence rewording for the 八股删除器 rides in the same call as well.
function clicheInstruction(items) {
  if (!items?.length) return '';
  return '另外改写套话：clicheRewrite 列出了部分楼层里写得像套话的句子。对这些楼层返回 "rewrites":[{"from":"原句，一字不改","to":"改写后的句子"}]。改写要求：保留原意、人物动作、对话内容和人称时态；删掉空洞的比喻、命运感叹、伪精确数字和堆叠的修饰，改成具体的动作、神态或直接陈述；不新增情节；长度与原句相近或更短。原句本身没问题就不要返回它。';
}

function npcWatchInstruction(watch) {
  if (!watch) return '';
  return `另外判断 NPC：每个角色回复楼层都返回 "npc":{"needed":true或false,"reason":"一句话理由"}。只有剧情出现了明确的空位、且现有人物（${(watch.existingNpcs ?? []).join('、') || '暂无'}）和主要角色都承担不了时才写 true，例如需要一个新的阻力、信息来源或能牵动主角的关系；只是热闹、气氛需要或可有可无时写 false。玩家楼层可以省略 npc。`;
}

// Planning the next round's push rides in the same organizing call.
const NEXT_PLAN_RULES = '要求：ways 只能从 advanceWatch.ways 里挑 1 到 2 个 id；plan 写具体：谁、做什么、发生什么事，一两句话，不写成正文；接着 recentPushes 往下发展，不重复催同一件事，换一个角度或推进到下一步；有 mainGoal 时朝它慢慢靠近，但不要一步到位；刚经历紧张段落就安排喘息；符合 strength 和 tastes；只能依据已经发生的剧情，不跳时、不瞬移、不改变已有关系的事实；用了 eventPool 里的事件时把原文抄进 event，否则 event 留空。';

function advanceInstruction(watch) {
  if (!watch) return '';
  return `另外安排下一轮的剧情推进：读完这批楼层后，在 JSON 顶层返回 "next":{"ways":["方式id"],"plan":"下一轮具体推什么","event":""}。${NEXT_PLAN_RULES}`;
}

export async function requestNextPlan(provider, payload, { watch, avoid = '' } = {}) {
  const raw = await provider({
    maxTokens: 500,
    messages: [
      {
        role: 'system',
        content: `你为长篇角色扮演安排下一轮的剧情推进。依据总档案、近期剧情和 advanceWatch，只输出 JSON：{"ways":["方式id"],"plan":"下一轮具体推什么","event":""}。${NEXT_PLAN_RULES}${avoid ? `玩家想换一个，不要再用这个安排：${avoid}` : ''}`,
      },
      { role: 'user', content: payloadText({ ...payload, advanceWatch: watch }) },
    ],
  });
  const parsed = parseJsonEnvelope(raw);
  if (!String(parsed?.plan ?? '').trim()) throw new Error('模型没有给出推进安排。');
  return parsed;
}

export async function requestFloorSummaries(provider, payload) {
  const input = JSON.stringify(payload, null, 2);
  if (estimateTokens(input) > REMOTE_INPUT_TOKEN_LIMIT) throw new Error('逐楼摘要输入超过完整读取预算，需要分批或分段。');
  const expectedFloors = (Array.isArray(payload?.targetFloors) ? payload.targetFloors : [])
    .map((item) => Number(item?.floor))
    .filter((floor) => Number.isInteger(floor) && floor > 0);
  if (!expectedFloors.length) throw new Error('批量摘要没有可处理的目标楼层。');
  const structuredMemory = Boolean(payload.memorySchema);
  const request = {
    maxTokens: Math.min(6000, Math.max(1400, expectedFloors.length * 650)),
    messages: [
      {
        role: 'system',
        content: `你维护长篇剧情记忆数据库。按原楼号处理 ${expectedFloors.join('、')} 楼。${payload.summaryFormat ? `summary 按玩家指定的格式写（summaryFormat）：${payload.summaryFormat}。格式里没提到的内容不要硬凑。` : 'summary 直接写谁在何时何地做了什么、产生什么结果；一两句够用就停止，不设最低字数。'}记录真实剧情事实，略过关于楼层、写作过程、用户指令、是否展开剧情的解说。时间地点不明就省略，数组无事实就留空。准确保留玩家 user 的原话含义及楼层顺序；不得用角色回复稀释或改写玩家意图。同一主题以更晚楼层的明确更新为当前状态，旧决定、拒绝、同意、偏好或边界只保留为当时发生过的历史，不得把角色的单次表态永久化；玩家本人明确说出的喜好和要求见 player 表规则。区分已发生、当前状态与计划，不补写剧情。只输出 JSON：{"floors":[{"floor":楼号,"summary":"精简事实","characters":[],"relationships":[],"clues":[],"timeline":[]${structuredMemory ? ',"changes":[{"table":"characters","id":"人物姓名","values":{"name":"人物姓名","state":"本楼明确的新状态"}}]' : ''}}]}。每楼分别返回，空数组仍保留。${structuredMemory ? '同时用 changes 增量更新 memorySchema 中的表格。currentMemory 仅作身份与已有状态参考，每条变更须有本楼原文的明确依据。人物按姓名、新物品和技能按首次拥有者/名称建立 id，关系按两端人物、任务与线索按名称建立 id；同一实体沿用已有 id。物品转交后沿用原 id：借出、交给他人保管或被拿走只更新 holder 与 place；只有赠与、买卖、继承等明确的所有权转移才更新 owner。holder 同时只能有一人；消耗、转交、归还必须在本楼实际发生，角色口头声称（如“我已经还了”）、计划与猜测都不改变归属或数量。scene 的 id 固定为 current。只填写本楼发生变化且有依据的字段；未变的旧字段由程序保留。资源消耗写剩余数量，任务完成写完成状态。没有状态变化时 changes=[]。人物别名须有明确指代依据；同名身份不明时保持分开。knowledge 只记该人物明确知晓的信息，秘密与推测注明范围，不能当作所有人都知道。未经证实的说法、猜测、传闻和计划不写进人物、物品、任务的当前状态；需要保留时写入 clues，basis 注明“某人说法”“猜测”或“计划”，knownBy 写明谁知道。tasks 记录任务与约定，participants 写参与者，deadline 写期限，完成或取消时把 state 改为“已完成”“已取消”。relationships 变化时在 cause 写原因。skills 受伤、封印、冷却等导致暂时无法使用时更新 available。事件表由程序从 summary 自动生成。player 表单独整理玩家（speaker 为 player 的楼层）本人的话：明确说出的喜欢、讨厌、雷点、对故事或写法的要求，以及做出的重要决定。按原意记录，不要美化、概括成性格或猜测没说出口的喜好；角色在剧情里的台词和动作不算玩家本人的话。同一主题沿用同一 id（用主题命名）。玩家后来改口时更新 content，并把旧说法写进 previous；没有改口的旧条目保持有效，不因时间久远失效。没有新内容时不要改 player 表。' : ''}${npcWatchInstruction(payload.npcWatch)}${clicheInstruction(payload.clicheRewrite)}${advanceInstruction(payload.advanceWatch)}`,
      },
      { role: 'user', content: input },
    ],
  };
  const read = (raw) => {
  const parsed = parseJsonEnvelope(raw);
  const rows = Array.isArray(parsed?.floors) ? parsed.floors : Array.isArray(parsed) ? parsed : expectedFloors.length === 1 && parsed?.summary ? [{ ...parsed, floor: parsed.floor ?? expectedFloors[0] }] : [];
  const expected = new Set(expectedFloors);
  const results = [];
  const seen = new Set();
  for (const row of rows) {
    const floor = Number(row?.floor);
    if (!expected.has(floor) || seen.has(floor)) continue;
    const normalized = normalizeFloorSummary(row, floor, structuredMemory);
    if (!normalized) continue;
    seen.add(floor);
    results.push(normalized);
  }
  if (!results.length) throw new Error('模型没有返回可用的逐楼摘要。');
  results.sort((left, right) => left.floor - right.floor);
  if (payload.advanceWatch && parsed?.next && typeof parsed.next === 'object') results.next = parsed.next;
  return results;
  };
  const raw = await provider(request);
  try { return read(raw); }
  catch (error) {
    if (!structuredMemory) throw error;
    // One bounded retry from the original input; never treat prose as verified table data.
    const repaired = await provider({ ...request, messages: [
      { ...request.messages[0], content: request.messages[0].content + '\n上一响应未通过结构校验。直接返回完整 JSON 对象，floors 中每楼必须包含 summary 和 changes 数组；保持字符串闭合，省去解释与代码围栏。' },
      request.messages[1],
    ] });
    try { return read(repaired); }
    catch { throw new Error('记忆整理结果仍不完整，自动修复未成功；已保留原文与上一份有效档案，请重试或更换摘要接口。'); }
  }
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
  const serialize = (text) => JSON.stringify({ throughFloor, rollingSummary: text, rawFloors: [] }, null, 2);
  let text = rollingText;
  for (let round = 0; round < 4; round += 1) {
    const parts = splitInputText(text, serialize, REMOTE_INPUT_TOKEN_LIMIT - 300);
    if (parts.length <= 1) return requestCompressionPart(provider, text, throughFloor);
    const results = [];
    for (const part of parts) results.push(await requestCompressionPart(provider, part, throughFloor));
    const next = results.map((result, index) => `【按时间顺序的分段档案 ${index + 1}】\n${JSON.stringify(result)}`).join('\n\n');
    if (estimateTokens(next) >= estimateTokens(text)) throw new Error('分段压缩没有缩短档案，已保留原摘要，请调整模型后重试。');
    text = next;
  }
  throw new Error('总摘要仍超过完整读取预算，已保留逐楼摘要。');
}

async function requestCompressionPart(provider, rollingText, throughFloor) {
  const raw = await provider({
    maxTokens: 1200,
    messages: [
      {
        role: 'system',
        content: '你是长篇剧情总档案员。把给出的既有档案压缩为一份可供后续续写使用的总档案。玩家原话必须准确保留并附带楼层顺序。同一主题出现后续明确更新时，以更晚楼层作为当前状态；旧决定、拒绝、同意、偏好或边界只保留为当时发生过的历史，不继续当作当前约束，不得把任何单次表态永久化。时间线顺序以楼层编号为准，不得改变事件先后、地点、已知人物关系或事件状态。可以合并重复信息，不得添加原档案中不存在的信息。只输出 JSON：{"summary":"压缩后的总摘要","timeline":["按时间顺序保留的事件锚点"],"characters":["人物当前状态"],"relationships":["已确认的人物关系"],"clues":["未解决线索"],"continuityRules":["后续续写不得违反的已知事实"]}。',
      },
      { role: 'user', content: JSON.stringify({ throughFloor, rollingSummary: rollingText, rawFloors: [] }, null, 2) },
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

export const MODE_LABELS = {
  guided: '玩家行动（代入）：每个选项直接写玩家下一步可做的事、目标与可能代价，不替玩家决定内心。',
  scene: '场景入口：每个选项通往一个可立即进入的具体场景，写清地点、事件入口和冲突。',
  third: '第三人称叙事：每个选项用角色名或第三人称描述主角接下来可能采取的行动。',
  mixed: '混合表达：根据当前情境在玩家行动、场景入口和第三人称叙事之间合理分配，三种表达至少各出现一次，并保持每个选项本身表达清楚。',
};

export async function requestStoryOptions(provider, payload, { mode = 'guided', count = 6, playerProfile = null, writingNotes = '', instruction = '' } = {}) {
  const safeCount = Math.max(4, Math.min(12, Number(count) || 6));
  const raw = await provider({
    maxTokens: Math.max(500, safeCount * 100),
    messages: [
      {
        role: 'system',
        content: instruction ? `你根据当前剧情写下一步的剧情选项。规则如下（其中的格式说明只用来确定类型、数量和顺序）：\n${instruction}\n这次不写正文，只输出 JSON：{"options":["【行动】……","【他人】……"]}，每个选项保留开头的【类型】。` : `你是互动叙事选项设计者。玩家原话必须结合楼层顺序理解；同一主题出现后续明确更新时，以更晚楼层作为当前状态，旧表态只作为历史，不得把任何单次决定、拒绝、同意、偏好或边界永久化。${MODE_LABELS[mode] ?? MODE_LABELS.guided} 生成恰好 ${safeCount} 个彼此明显不同、能继续当前剧情的选项。不得破坏档案里的时间先后、当前地点和人物关系。只输出 JSON：{"options":["选项"]}。`,
      },
      { role: 'user', content: payloadText({ ...payload, playerPreferenceProfile: playerProfile, optionWritingRequirements: String(writingNotes).slice(0, 4000) }) },
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
        content: '你是玩家人格倾向与剧情偏好分析器。综合玩家主动填写的非诊断性测试、可多选的剧情体验、补充说明、总摘要与获准发送的近期上下文（可能没有楼层原文），分析互动方式、人物关系、连续性、冲突承受度、新奇偏好，以及玩家想要的剧情体验。多选项只是线索，必须与聊天中的真实表达共同判断，不得逐个标签机械拼接。genresAndTastes 是玩家自己选的题材和口味（男频、女频、无限流、甜虐、感情线等）以及自述的 MBTI：题材和口味要直接体现在 storyNeeds、preferredDevelopments 和 directorRules 里；MBTI 只是自述的参考，不能据此给玩家贴标签，也不能压过玩家在聊天里的明确表达。测试可以被跳过；跳过时只依据聊天中玩家明确表达的内容，证据不足就保持保守。不得进行心理诊断或将玩家定型。聊天中的明确表达必须按楼层顺序判断；同一主题以后有新表态时，以更晚楼层为当前状态，旧表态只保留为历史，不得永久化。玩家当前明确表达优先于测试推断。只输出 JSON：{"summary":"一段直接的玩家剧情偏好说明","personalityTendencies":["与角色扮演有关的人格和互动倾向"],"storyNeeds":["玩家想从剧情中得到的体验"],"preferredDevelopments":["适合的发展方向"],"avoidPatterns":["应避免的叙事方式"],"directorRules":["自主推进时必须遵守的规则"]}。',
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
    opinions: list('opinions'),
    surprise: String(parsed.surprise ?? '').trim(),
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

const NPC_DESIGN_RULES = [
  '你是长篇角色扮演的配角设计者，目标是设计一个能让故事更好看的人。依据剧情档案、近期剧情和现有 NPC 判断，玩家不负责选择人物功能；用户补充要求只作为世界观事实、内容边界或避雷信息。',
  '先判断当前剧情缺什么样的人：一股阻力、一个信息来源、一段能牵动主角的关系，或一个让世界更真实的普通人。把判断写进 plotFunction。',
  '这个人必须做到六点。',
  '一、有自己的经历：biography 写 2 到 4 段具体经历，写清什么时候、在哪里、发生了什么、留下了什么后果；personalityFormation 说明这些经历怎样形成他的性格、信念、本事和缺陷。不写空泛的形容词。',
  '二、有自己的想法：opinions 写他对当前发生的事、对主角、对至少一个现有人物的看法和判断。可以和别人不同，也可以是错的。',
  '三、有自己想要的东西：currentGoal 写正在追求的目标；independentWill 写害怕失去的东西和不会让步的底线。他的目标不以帮助主角为中心，可以合作、交易，也可以冲突。',
  '四、有意思：surprise 写至少一处让人意外但合理的地方，比如一个反差、一个秘密、一样和身份不符的爱好或本事、一件放不下的旧事。必须具体，不要用“神秘的过去”这类空话。',
  '五、和现有 NPC 不一样：对照 existingNpcs，在年龄段、身份处境、说话方式、对主角的态度、最想要的东西这五项中至少三项明显不同；不要再造温柔可靠型、冷淡神秘型或热情活泼型的变体。',
  '六、是这个世界里的人：年龄、人生阶段、工作、住处、手头资源和限制都符合世界观和时间线，写进 objectiveFacts。',
  '禁止设计固定口癖、固定小动作、招牌反应和固定反应模板；禁止“他总是会……”这类行为预设；他不是只为玩家服务的工具人；不得替玩家做决定；不得违背已有时间线和人物关系。',
].join('\n');
const NPC_PROFILE_SHAPE = '{"name":"姓名","age":"年龄或年龄范围","lifeStage":"人生阶段","occupation":"当前工作","plotFunction":"剧情需要他承担的位置","currentGoal":"正在追求的目标","objectiveFacts":["当前可验证的客观事实"],"biography":["具体经历及后果"],"personality":"由经历形成的性格概括","contradictions":["人物内部相互拉扯的矛盾面"],"personalityFormation":["某段经历如何形成某种性格或信念"],"opinions":["对某事或某人的看法"],"surprise":"让人意外但合理的地方","independentWill":["害怕失去的东西与不会让步的底线"],"relationships":["与现有人物的已知关系"],"growthState":["仍在变化的部分"],"playerMemory":["对玩家的短期事实记录"]}';

export async function requestNpcProfile(provider, payload, { brief = '', playerProfile = null, existingNpcs = [] } = {}) {
  const raw = await provider({
    maxTokens: 1300,
    messages: [
      {
        role: 'system',
        content: `${NPC_DESIGN_RULES}\n为 NPC 生成一份仅基于获准上下文和总摘要的短期玩家记录，并标明表态发生的楼层或阶段；同一主题若有后续明确更新，以更晚楼层为当前状态。只输出 JSON：${NPC_PROFILE_SHAPE}。`,
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
        content: `${NPC_DESIGN_RULES}\n先核对现有 NPC 档案：只有剧情明确推进了年龄、人生阶段、工作、当前目标、客观状态、关系、成长状态或对玩家的事实记忆时，才在 updates 中更新对应字段；不得根据气氛猜测，不得无依据改年龄或工作，不得改写玩家手工编辑的历史经历。然后判断是否真的需要新增 NPC：只有出现明确且尚未被现有人物承担的剧情位置时才新增；现有人物可以承担、只是为了热闹、或当前尚未需要时，必须返回 needed=false。只输出 JSON：{"updates":[{"id":"既有档案 id","age":"仅明确变化时提供","lifeStage":"仅明确变化时提供","occupation":"仅明确变化时提供","currentGoal":"仅明确变化时提供","objectiveFacts":["更新后的客观状态"],"relationships":["更新后的已知关系"],"growthState":["更新后的成长状态"],"playerMemory":["更新后的玩家事实记录"]}],"needed":true或false,"reason":"判断理由","npc":null或${NPC_PROFILE_SHAPE}}。`,
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
