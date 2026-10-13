// Recall without an embedding API. Old floor summaries are scored against the
// latest text by the names the archive already knows (people, aliases, items,
// places, clues, agreements), weighted so rare names count more, plus a light
// overlap of two-character phrases for chats whose archive is still thin.

const COMMON_PAIRS = new Set(['一个', '自己', '什么', '没有', '我们', '你们', '他们', '她们', '这个', '那个', '已经', '还是', '就是', '不是', '可以', '知道', '时候', '起来', '一下', '这样', '那样', '因为', '所以', '但是', '如果', '只是', '现在', '然后', '一样', '这里', '那里']);

function pairs(text) {
  const found = new Set();
  const source = String(text ?? '');
  for (let index = 0; index < source.length - 1; index += 1) {
    const pair = source.slice(index, index + 2);
    if (/^[一-鿿]{2}$/.test(pair) && !COMMON_PAIRS.has(pair)) found.add(pair);
  }
  return found;
}

// Every name the archive knows, with aliases split out.
export function archiveNames(database) {
  const tables = database?.tables ?? {};
  const names = new Set();
  const add = (value) => String(value ?? '').split(/[、,，;；/\n]/).map((item) => item.trim()).filter((item) => item.length >= 2 && item.length <= 16).forEach((item) => names.add(item));
  for (const row of tables.characters ?? []) { add(row.values.name); add(row.values.aliases); add(row.values.location); }
  for (const row of tables.inventory ?? []) { add(row.values.name); add(row.values.place); }
  for (const row of tables.scene ?? []) add(row.values.location);
  for (const row of tables.clues ?? []) add(row.values.name);
  for (const row of tables.tasks ?? []) add(row.values.name);
  for (const row of tables.skills ?? []) add(row.values.name);
  return [...names];
}

export function keywordRecall(summaries, { query = '', names = [], topK = 4, latestFloorIndex = Infinity, recentFloorLimit = 5 } = {}) {
  const firstExcluded = Number(latestFloorIndex) - Math.max(1, Number(recentFloorLimit) || 5) + 1;
  const pool = (summaries ?? []).filter((record) => record.floorIndex < firstExcluded && String(record.summary ?? '').trim());
  if (!pool.length || !String(query).trim()) return [];
  const wanted = names.filter((name) => query.includes(name));
  const docs = pool.map((record) => ({ record, text: String(record.summary), pairs: pairs(record.summary) }));
  const total = docs.length;
  const idf = (count) => Math.log(1 + total / Math.max(1, count));
  const nameDf = new Map(wanted.map((name) => [name, docs.filter((doc) => doc.text.includes(name)).length]));
  const queryPairs = pairs(query);
  const pairDf = new Map();
  for (const pair of queryPairs) pairDf.set(pair, docs.filter((doc) => doc.pairs.has(pair)).length);
  const scored = docs.map((doc) => {
    const matched = wanted.filter((name) => doc.text.includes(name));
    const nameScore = matched.reduce((sum, name) => sum + idf(nameDf.get(name)), 0);
    let pairScore = 0;
    let shared = 0;
    for (const pair of queryPairs) {
      if (!doc.pairs.has(pair) || pairDf.get(pair) >= total) continue;
      pairScore += idf(pairDf.get(pair));
      shared += 1;
    }
    pairScore /= Math.max(4, Math.sqrt(doc.pairs.size) * 2);
    return { ...doc.record, sourceText: doc.text, similarity: nameScore + pairScore * 0.5, matched, shared };
  });
  return scored
    .filter((row) => row.matched.length > 0 || row.shared >= 2)
    .sort((left, right) => right.similarity - left.similarity || right.floorIndex - left.floorIndex)
    .slice(0, Math.max(1, Number(topK) || 4))
    .sort((left, right) => left.floorIndex - right.floorIndex);
}
