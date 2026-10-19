// Which parts of a reply are story. Presets often make the model think first
// (<planing>, <thinking> …) and wrap the story in <content>; the plugin's own
// options block is not story either. Organizing, recall and the cliché cleaner
// read only the story parts; everything else is kept as it is.

export const THINKING_TAGS = ['planing', 'planning', 'plan', 'thinking', 'think', 'thought', 'cot', 'reasoning', 'analysis', 'draft', 'scratchpad', '思考', '构思', '思维链'];
// Blocks that sit in a reply but are not the story: image prompts from image
// extensions, a preset's own choices, collapsible summaries and status bars.
export const NON_STORY_TAGS = ['image', 'imgthink', 'img', 'pic', 'choice', 'choices', 'option', 'options', 'details', 'summary', 'status', 'statusbar', 'status_bar', 'state', '状态栏'];
const CONTENT_TAGS = ['content', '正文'];
const OPTIONS_TAG = 'chunxu-options';

const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A block opens with <tag ...> and runs to </tag>, or to the end when the
// reply was cut off before closing it.
function blockPattern(tags) {
  const names = tags.map(escape).join('|');
  return new RegExp(`<(${names})(?:\\s[^>]*)?>[\\s\\S]*?(?:<\\/\\1\\s*>|$)`, 'gi');
}

const OPTIONS = blockPattern([OPTIONS_TAG]);
// Any closed <tag>…</tag> block, for the "text outside tags" mode.
const ANY_BLOCK = /<([A-Za-z\u4e00-\u9fff][\w\-\u4e00-\u9fff]*)(?:\s[^>]*)?>[\s\S]*?<\/\1\s*>/g;

// mode: 'auto' (drop thinking blocks; inside <content> only when present),
// 'content' (inside <content> only), 'untagged' (only text outside any tag
// block). extraTags: more thinking tags to drop, from the settings.
let config = { mode: 'auto', thinking: blockPattern([...THINKING_TAGS, ...NON_STORY_TAGS]) };
export function configureStorySegments({ mode = 'auto', extraTags = '' } = {}) {
  const extra = String(extraTags ?? '').split(/[\s,，、;；|]+/).map((tag) => tag.replace(/[<>/]/g, '').trim()).filter((tag) => /^[\w\-\u4e00-\u9fff]{1,30}$/.test(tag));
  config = { mode: ['auto', 'content', 'untagged'].includes(mode) ? mode : 'auto', thinking: blockPattern([...new Set([...THINKING_TAGS, ...NON_STORY_TAGS, ...extra])]) };
}
const CONTENT_OPEN = new RegExp(`<(${CONTENT_TAGS.map(escape).join('|')})(?:\\s[^>]*)?>`, 'i');

function hiddenRanges(text, pattern) {
  const ranges = [];
  for (const match of text.matchAll(pattern)) ranges.push([match.index, match.index + match[0].length]);
  return ranges;
}

// [{ text, story }] in order; joining every text gives back the reply exactly.
export function segmentReply(value) {
  const text = String(value ?? '');
  const hidden = [
    ...hiddenRanges(text, config.thinking),
    ...hiddenRanges(text, OPTIONS),
    ...(config.mode === 'untagged' ? hiddenRanges(text, ANY_BLOCK) : []),
  ].sort((a, b) => a[0] - b[0]);
  // Merge overlaps (an options block inside an unclosed thinking block, say).
  const merged = [];
  for (const range of hidden) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }
  const outside = [];
  let cursor = 0;
  for (const [start, end] of merged) {
    if (start > cursor) outside.push([cursor, start, true]);
    outside.push([start, end, false]);
    cursor = end;
  }
  if (cursor < text.length) outside.push([cursor, text.length, true]);

  // With a <content> wrapper, only what is inside it is story. 'untagged'
  // never looks for one; 'content' without a wrapper (the player's own
  // messages, say) falls back to the text outside tag blocks.
  const visible = outside.filter(([, , story]) => story).map(([s, e]) => text.slice(s, e)).join('');
  const wrapped = config.mode !== 'untagged' && CONTENT_OPEN.test(visible);
  if (!wrapped) {
    if (config.mode === 'content') {
      const saved = config;
      config = { ...config, mode: 'untagged' };
      try { return segmentReply(text); } finally { config = saved; }
    }
    return outside.map(([s, e, story]) => ({ text: text.slice(s, e), story }));
  }
  const segments = [];
  let inside = false;
  const closeTag = new RegExp(`<\\/(${CONTENT_TAGS.map(escape).join('|')})\\s*>`, 'i');
  for (const [start, end, story] of outside) {
    if (!story) { segments.push({ text: text.slice(start, end), story: false }); continue; }
    let rest = text.slice(start, end);
    while (rest) {
      const marker = inside ? rest.match(closeTag) : rest.match(CONTENT_OPEN);
      if (!marker) { segments.push({ text: rest, story: inside }); break; }
      if (marker.index > 0) segments.push({ text: rest.slice(0, marker.index), story: inside });
      segments.push({ text: marker[0], story: false });
      rest = rest.slice(marker.index + marker[0].length);
      inside = !inside;
    }
  }
  return segments;
}

// The story alone, as one text.
export function storyOnly(value) {
  return segmentReply(value).filter((part) => part.story).map((part) => part.text).join('').replace(/\n{3,}/g, '\n\n').trim();
}

// Change only the story parts; thinking, wrappers and options stay byte for byte.
export function mapStory(value, change) {
  return segmentReply(value).map((part) => (part.story ? change(part.text) : part.text)).join('');
}
