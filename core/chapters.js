// The big summary as chapters. Each time the newest stretch of floor
// summaries reaches the threshold, that stretch alone becomes one chapter;
// earlier chapters are never rewritten, so detail does not wear away. When
// the chapters together grow too long, the oldest few are merged into a
// volume. A checkpoint from before chapters existed (format 5, covering
// everything from the start) is read as the first chapter.
import { estimateTokens, fingerprintSummaries } from './privacy-payload.js?v=0.7.3';

export const CHAPTER_FORMAT = 6;

const listLine = (label, items) => (items?.length ? `\n${label}：${items.join('；')}` : '');

export function chapterRange(item) {
  return { from: item.formatVersion === CHAPTER_FORMAT ? Number(item.fromFloor ?? 0) : 0, through: Number(item.throughFloor) };
}

export function chapterSource(ready, item) {
  const { from, through } = chapterRange(item);
  return ready.filter((record) => record.floorIndex >= from && record.floorIndex <= through);
}

function isValid(item, ready) {
  if (item.status !== 'ready' || !String(item.summary ?? '').trim()) return false;
  if (item.formatVersion !== CHAPTER_FORMAT && item.formatVersion !== 5) return false;
  const source = chapterSource(ready, item);
  return source.length > 0 && item.sourceFingerprint === fingerprintSummaries(source);
}

export function formatChapter(item, { brief = false } = {}) {
  const label = item.formatVersion === CHAPTER_FORMAT ? (item.kind === 'volume' ? '卷' : '章') : '往事';
  const title = String(item.title ?? '').trim();
  const head = `【${label}${title ? `·${title}` : ''}】`;
  if (brief) {
    const synopsis = String(item.synopsis ?? '').trim() || String(item.summary ?? '').slice(0, 160);
    return `${head}${synopsis}`;
  }
  return [
    `${head}${item.summary}`,
    listLine('【转折】', item.turningPoints),
    listLine('【原话】', item.keyQuotes),
    listLine('【时间线】', item.timeline),
    listLine('【人物变化】', item.characters),
    listLine('【关系变化】', item.relationships),
    listLine('【伏笔与未解决】', item.clues),
    listLine('【既定事实】', item.continuityRules),
  ].join('').trim();
}

// The chapters and volumes in force: valid, non-overlapping, in story order.
// A volume is preferred over the chapters it replaces.
export function selectChapters(checkpoints, ready) {
  const candidates = (checkpoints ?? []).filter((item) => isValid(item, ready))
    .map((item) => ({ item, ...chapterRange(item) }))
    .sort((a, b) => a.from - b.from || b.through - a.through);
  const chosen = [];
  let end = -1;
  for (const candidate of candidates) {
    if (candidate.from <= end) continue;
    chosen.push(candidate);
    end = candidate.through;
  }
  return chosen.map(({ item }) => item);
}

// Ready floors no chapter covers, grouped into runs. A run with a chapter
// after it is a hole (a chapter whose floors changed) and is rebuilt at once;
// the last run grows until the threshold.
export function uncoveredRuns(chapters, ready) {
  const covered = new Set();
  for (const chapter of chapters) for (const record of chapterSource(ready, chapter)) covered.add(record.floorIndex);
  const runs = [];
  let run = [];
  for (const record of ready) {
    if (covered.has(record.floorIndex)) {
      if (run.length) { runs.push({ records: run, closed: true }); run = []; }
      continue;
    }
    run.push(record);
  }
  if (run.length) runs.push({ records: run, closed: false });
  return runs;
}

// Oldest adjacent chapters to merge when all of them together pass the limit:
// enough to free about a third, at least two.
export function chaptersToMerge(chapters, ready, limit) {
  const costs = chapters.map((item) => estimateTokens(formatChapter(item)));
  const total = costs.reduce((sum, cost) => sum + cost, 0);
  if (chapters.length < 3 || total <= limit) return [];
  const picked = [];
  let freed = 0;
  for (let index = 0; index < chapters.length - 1; index += 1) {
    if (picked.length) {
      const previous = chapterRange(picked.at(-1));
      const next = chapterRange(chapters[index]);
      const between = ready.some((record) => record.floorIndex > previous.through && record.floorIndex < next.from);
      if (between) break;
    }
    picked.push(chapters[index]);
    freed += costs[index];
    if (picked.length >= 2 && freed >= total / 3) break;
  }
  return picked.length >= 2 ? picked : [];
}
