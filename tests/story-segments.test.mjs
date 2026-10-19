import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { storyOnly, mapStory, segmentReply, configureStorySegments } from '../core/story-segments.js';
import { storyText } from '../core/privacy-payload.js';

const reply = '<planing>\n我是战锤40k的福根，按格式生成。\n</planing>\n半颗柠檬挞\n<content>\n林栀拉着你穿过斑马线。命运的齿轮开始转动。\n</content>\n<chunxu-options>\n<co>【行动】跟上</co>\n</chunxu-options>';

test('thinking blocks, titles outside <content> and options are not story', () => {
  configureStorySegments({ mode: 'auto' });
  const story = storyOnly(reply);
  assert.equal(story, '林栀拉着你穿过斑马线。命运的齿轮开始转动。');
  assert.equal(storyText(reply), '林栀拉着你穿过斑马线。命运的齿轮开始转动。');
  assert.equal(segmentReply(reply).map((part) => part.text).join(''), reply);
});

test('cleaning touches the story only; thinking and options stay byte for byte', () => {
  configureStorySegments({ mode: 'auto' });
  const cleaned = mapStory(reply, (text) => text.replace('命运的齿轮开始转动。', ''));
  assert.match(cleaned, /<planing>\n我是战锤40k的福根，按格式生成。\n<\/planing>/);
  assert.doesNotMatch(cleaned, /命运的齿轮/);
  assert.match(cleaned, /<chunxu-options>\n<co>【行动】跟上<\/co>\n<\/chunxu-options>/);
});

test('an unclosed thinking block (cut off reply) hides the rest', () => {
  configureStorySegments({ mode: 'auto' });
  assert.equal(storyOnly('正文在前。<thinking>写到一半'), '正文在前。');
});

test('reading modes: content only, untagged only, and extra tags', () => {
  const text = '<think>想</think>标题<content>正文</content><status>HP 10</status>尾声';
  configureStorySegments({ mode: 'content' });
  assert.equal(storyOnly(text), '正文');
  assert.equal(storyOnly('我推门进去'), '我推门进去', 'player messages without a wrapper are kept');
  configureStorySegments({ mode: 'untagged' });
  assert.equal(storyOnly(text), '标题尾声');
  configureStorySegments({ mode: 'auto', extraTags: 'status, 小剧场' });
  assert.equal(storyOnly('甲<status>HP</status>乙<小剧场>番外</小剧场>丙'), '甲乙丙');
  configureStorySegments({ mode: 'auto' });
});

test('the real 林栀 reply: only the story inside <content> is organized', () => {
  const lines = fs.readFileSync(new URL('./fixtures/linzhi-chat.jsonl', import.meta.url), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  configureStorySegments({ mode: 'auto' });
  const story = storyOnly(lines[3].mes);
  assert.ok(story.startsWith('等待回答向来不是林栀的习惯'));
  assert.doesNotMatch(story, /planing|福根|字数严格控制/);
  assert.ok(story.length < lines[3].mes.length * 0.7);
});
