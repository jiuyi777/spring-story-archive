// 八股删除器 · rule engine.
// Rules come from the author's "这不能" catalogue of AI-prose clichés, turned
// around into detectors. Three actions:
//   delete  - filler that can be cut locally without breaking the sentence;
//   rewrite - the sentence needs rewording; it is sent to the organizing call;
//   mark    - common enough in real prose that we only count it.
// Density rules (minCount) fire only when a reply leans on the habit.

export const DEFAULT_CLICHE_RULES = [
  // delete: pure filler
  { id: 'filler-honest', label: '“说实话”类口头填充', action: 'delete', pattern: '(?:说实话|说真的|说实在的)[，,]?' },
  { id: 'filler-reason', label: '“不知为何”类空泛前缀', action: 'delete', pattern: '(?:不知为何|没来由地)[，,]?' },
  { id: 'filler-reflex', label: '“下意识地／不由自主地”', action: 'delete', pattern: '(?:下意识|不由自主|不易察觉|几不可察)地' },
  { id: 'filler-aside', label: '“——我是说”插入语', action: 'delete', pattern: '——(?:我是说|也就是说)[，,]?' },

  // rewrite: fixed images and stock structures
  { id: 'fate-gear', label: '命运的齿轮／洪流／棋局', action: 'rewrite', pattern: '(?:命运|时光|宿命)的(?:齿轮|洪流|獠牙|棋局|轨迹|安排)' },
  { id: 'knuckles', label: '骨节分明', action: 'rewrite', pattern: '骨节分明' },
  { id: 'worse-than-cry', label: '比哭还难看', action: 'rewrite', pattern: '比哭还难看' },
  { id: 'stone-lake', label: '石子投入湖面', action: 'rewrite', pattern: '石子?投(?:入|进)[^，。！？]{0,6}湖' },
  { id: 'puppet', label: '提线木偶', action: 'rewrite', pattern: '提线木偶' },
  { id: 'scalpel', label: '手术刀般', action: 'rewrite', pattern: '(?:如|像)手术刀(?:般|一样)' },
  { id: 'curve', label: '嘴角的弧度', action: 'rewrite', pattern: '(?:不易察觉|几不可察|微不可察)的弧度|嘴角[^，。！？]{0,6}弧度' },
  { id: 'omniscient', label: '“他不知道的是”', action: 'rewrite', pattern: '(?:他|她|它|他们|她们)不知道的是|在[^，。]{0,4}看不见的(?:地方|角落)' },
  { id: 'bei-suo', label: '被……所……', action: 'rewrite', pattern: '被[^，。！？]{1,14}所(?:笼罩|刺痛|吞没|淹没|占据|击中|填满|包裹|攫住)' },
  { id: 'rather-than', label: '与其说……不如说', action: 'rewrite', pattern: '与其说[^。！？]{1,30}不如说' },
  { id: 'triple-not', label: '不是……也不是……而是', action: 'rewrite', pattern: '不是[^，。！？]{1,16}[，,]也不是[^，。！？]{1,16}[，,]而是' },
  { id: 'as-if-or', label: '像是在……又像是在', action: 'rewrite', pattern: '像是在[^，。！？]{1,16}[，,]又像是在' },
  { id: 'between-face', label: '介于……之间的表情', action: 'rewrite', pattern: '介于[^，。！？]{1,16}之间的(?:表情|神情|笑|情绪)' },
  { id: 'defense-line', label: '心理防线崩塌', action: 'rewrite', pattern: '(?:心理|最后一道)?防线(?:崩塌|瓦解|被击垮|碎裂|彻底失守)|最后一道防线' },
  { id: 'all-of-it', label: '“一切的一切／一切，都”', action: 'rewrite', pattern: '一切的一切|一切，都' },
  { id: 'maybe-but', label: '“也许吧。但”', action: 'rewrite', pattern: '也许吧。但' },
  { id: 'always-seems', label: '“似乎总是”', action: 'rewrite', pattern: '似乎总是' },
  { id: 'angle', label: '精确角度', action: 'rewrite', pattern: '(?:偏|转|侧|歪|抬|仰|低|倾|弯)[^，。！？]{0,6}\\d+(?:\\.\\d+)?\\s*(?:度|°)' },
  { id: 'seconds', label: '精确秒数', action: 'rewrite', pattern: '\\d+\\.\\d+\\s*秒|零点[一二三四五六七八九\\d]秒' },
  { id: 'heart-rate', label: '心跳数字', action: 'rewrite', pattern: '心跳[^，。！？]{0,6}\\d{2,3}' },

  // density: only when a reply leans on the habit
  { id: 'measure-words', label: '一丝／一缕／一抹堆叠', action: 'rewrite', minCount: 3, pattern: '一(?:丝|缕|抹|股)' },
  { id: 'intensifiers', label: '极其／极为／深深地堆叠', action: 'rewrite', minCount: 3, pattern: '极其|极为|极度|深深地|深刻地' },
  { id: 'vague-words', label: '似乎／仿佛／某种堆叠', action: 'rewrite', minCount: 4, pattern: '似乎|仿佛|某种|隐约|近乎' },
  { id: 'not-but', label: '“不是……而是”堆叠', action: 'rewrite', minCount: 2, pattern: '不是[^，。！？]{1,16}[，,]而是' },

  // mark: legit in dialogue, only counted
  { id: 'resigned-ending', label: '“这样也好”式收尾', action: 'mark', pattern: '这样也好|那就算了吧' },
];

const SENTENCE = /[^。！？!?…\n]+[。！？!?…]*["”」』]?/g;

// Custom rules: one per line. "删:词" deletes, "改:词" rewrites, "标:词" only marks.
// A word wrapped in /slashes/ is a regular expression.
export function parseCustomRules(text) {
  const rules = [];
  for (const [index, raw] of String(text ?? '').split('\n').entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(删|改|标)[:：](.+)$/);
    const action = match ? { 删: 'delete', 改: 'rewrite', 标: 'mark' }[match[1]] : 'rewrite';
    const body = (match ? match[2] : line).trim();
    const regex = body.length > 2 && body.startsWith('/') && body.endsWith('/');
    const pattern = regex ? body.slice(1, -1) : body.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    try { new RegExp(pattern, 'g'); } catch { continue; }
    rules.push({ id: `custom-${index}`, label: body, action, pattern, custom: true });
  }
  return rules;
}

export function compileRules(customText = '', disabledIds = []) {
  const off = new Set(disabledIds);
  return [...DEFAULT_CLICHE_RULES, ...parseCustomRules(customText)]
    .filter((rule) => !off.has(rule.id))
    .map((rule) => ({ ...rule, regex: new RegExp(rule.pattern, 'g') }));
}

export function scanCliches(text, rules) {
  const source = String(text ?? '');
  const hits = [];
  for (const rule of rules) {
    const found = [...source.matchAll(rule.regex)].map((match) => ({ rule: rule.id, label: rule.label, action: rule.action, index: match.index, text: match[0] }));
    if (rule.minCount && found.length < rule.minCount) continue;
    hits.push(...found);
  }
  return hits.sort((a, b) => a.index - b.index);
}

export function summarizeHits(hits) {
  const byRule = new Map();
  for (const hit of hits) byRule.set(hit.label, (byRule.get(hit.label) ?? 0) + 1);
  return [...byRule].map(([label, count]) => ({ label, count }));
}

// Local, deterministic cleanup. Only "delete" rules touch the text.
export function cleanLocally(text, rules) {
  let output = String(text ?? '');
  let removed = 0;
  for (const rule of rules.filter((item) => item.action === 'delete')) {
    output = output.replace(rule.regex, () => { removed += 1; return ''; });
  }
  // Tidy punctuation left behind by deletions.
  output = output.replace(/([，,])\s*([，,。！？])/g, '$2').replace(/^[，,]\s*/gm, '').replace(/([“「])[，,]\s*/g, '$1');
  return { text: output, removed };
}

// Sentences that need a rewrite, in reading order, de-duplicated and capped so
// the organizing call stays small.
export function sentencesToRewrite(text, rules, limit = 12) {
  const source = String(text ?? '');
  const hits = scanCliches(source, rules).filter((hit) => hit.action === 'rewrite');
  if (!hits.length) return [];
  const sentences = [...source.matchAll(SENTENCE)].map((match) => ({ start: match.index, end: match.index + match[0].length, text: match[0].trim() }));
  const picked = [];
  for (const hit of hits) {
    const sentence = sentences.find((item) => hit.index >= item.start && hit.index < item.end);
    if (sentence && sentence.text.length >= 4 && !picked.includes(sentence.text)) picked.push(sentence.text);
    if (picked.length >= limit) break;
  }
  return picked;
}

// Apply rewrites only where the original sentence is still present verbatim,
// so a reply edited in the meantime is never mangled.
export function applyRewrites(text, rewrites) {
  let output = String(text ?? '');
  let applied = 0;
  for (const item of rewrites ?? []) {
    const from = String(item?.from ?? '');
    const to = String(item?.to ?? '').trim();
    if (!from || !to || from === to || to.length > from.length * 1.6 + 20) continue;
    const at = output.indexOf(from);
    if (at < 0) continue;
    output = output.slice(0, at) + to + output.slice(at + from.length);
    applied += 1;
  }
  return { text: output, applied };
}

// ---- Per-version notes -----------------------------------------------------
// Cleaning writes into the reply; the original is kept in message.extra, keyed
// by a hash of the exact current text so every swipe and edit has its own entry.

const OPTIONS_BLOCK = /\s*<chunxu-options>[\s\S]*?(?:<\/chunxu-options>|$)/i;

export function textHash(text) {
  let hash = 5381;
  const source = String(text ?? '');
  for (let index = 0; index < source.length; index += 1) hash = ((hash << 5) + hash + source.charCodeAt(index)) | 0;
  return `${source.length.toString(36)}-${(hash >>> 0).toString(36)}`;
}

// Story part and the options block are handled apart: the block is never cleaned.
export function splitOptionsBlock(text) {
  const source = String(text ?? '');
  const match = source.match(OPTIONS_BLOCK);
  if (!match) return { story: source, block: '' };
  return { story: source.slice(0, match.index) + source.slice(match.index + match[0].length), block: match[0] };
}
