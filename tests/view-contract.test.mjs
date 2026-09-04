import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { isFloorExpandedByDefault } from '../ui/view.js';

test('the latest five floors expand by default and older floors stay folded', () => {
  assert.deepEqual(
    Array.from({ length: 8 }, (_, index) => isFloorExpandedByDefault(index, 5)),
    [true, true, true, true, true, false, false, false],
  );
});

test('preference quiz is a secondary page and NPC has its own navigation page', async () => {
  const source = await readFile(new URL('../ui/view.js', import.meta.url), 'utf8');
  assert.match(source, /data-tab="npc"/);
  assert.match(source, /data-page="npc"/);
  assert.match(source, /data-page="preference-test"/);
  assert.match(source, /data-role="retest-confirm"/);
  assert.doesNotMatch(source, /data-page="advance"[\s\S]*?<details class="ssa-quiz-panel">/);
});

test('large summary is folded by default and mixed option mode is available', async () => {
  const source = await readFile(new URL('../ui/view.js', import.meta.url), 'utf8');
  assert.match(source, /<details class="ssa-rollup-card">/);
  assert.doesNotMatch(source, /<details class="ssa-rollup-card" open>/);
  assert.match(source, /value="mixed" data-setting="optionMode"/);
});

test('NPC editor uses objective life fields and removes entrance and story hooks', async () => {
  const source = await readFile(new URL('../ui/view.js', import.meta.url), 'utf8');
  for (const field of ['age', 'lifeStage', 'occupation', 'objectiveFacts', 'biography', 'contradictions', 'growthState']) {
    assert.match(source, new RegExp(`\\['${field}'`));
  }
  assert.doesNotMatch(source, /\['entrance'/);
  assert.doesNotMatch(source, /\['storyHooks'/);
  assert.match(source, /NPC 人物档案/);
  assert.doesNotMatch(source, /data-setting="npcFunction"/);
});

test('summary controls use normal document flow and the mobile backfill action stays compact', async () => {
  const [source, view] = await Promise.all([
    readFile(new URL('../style.css', import.meta.url), 'utf8'),
    readFile(new URL('../ui/view.js', import.meta.url), 'utf8'),
  ]);
  const controls = source.match(/\.ssa-summary-controls-card \{([\s\S]*?)\}/)?.[1] ?? '';
  assert.doesNotMatch(controls, /position:\s*sticky/);
  assert.match(source, /\[data-action="backfill"\][\s\S]*?white-space:\s*nowrap/);
  assert.match(view, /data-setting="backfillBatchSize"/);
  assert.match(view, /补全下一批/);
  assert.doesNotMatch(view, /补全全部缺失摘要/);
});

test('automatic summary never queues all old floors from lifecycle paths', async () => {
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /queueMissing:\s*getSettings\(\)\.autoSummarize/);
  assert.doesNotMatch(source, /queueMissing:\s*true/);
  assert.match(source, /switchCurrentChat\(\{ queueMissing: false \}\)/);
});

test('story options have an explicit master switch and choosing only fills the input', async () => {
  const [view, index] = await Promise.all([
    readFile(new URL('../ui/view.js', import.meta.url), 'utf8'),
    readFile(new URL('../index.js', import.meta.url), 'utf8'),
  ]);
  assert.match(view, /switchControlMarkup\('optionsEnabled'/);
  assert.match(view, /不会自动发送给 AI/);
  assert.match(index, /if \(!settings\.optionsEnabled\) throw new Error/);
  const chooseOption = index.match(/function chooseOption\(text\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  assert.match(chooseOption, /#send_textarea/);
  assert.doesNotMatch(chooseOption, /\.generate\(|#send_but|click\(/);
});

test('quiz choices stay local until the explicit analysis button is clicked', async () => {
  const [view, index] = await Promise.all([
    readFile(new URL('../ui/view.js', import.meta.url), 'utf8'),
    readFile(new URL('../index.js', import.meta.url), 'utf8'),
  ]);
  assert.match(view, /点选答案只保存在当前页面，不会请求 AI/);
  assert.match(index, /if \(quizInput \|\| event\.target\.closest\('\[data-experience-id\]'\)\) return/);
});

test('every feature toggle displays an explicit on or off label', async () => {
  const [view, style] = await Promise.all([
    readFile(new URL('../ui/view.js', import.meta.url), 'utf8'),
    readFile(new URL('../style.css', import.meta.url), 'utf8'),
  ]);
  for (const setting of ['autoSummarize', 'optionsEnabled', 'autoAdvanceEnabled', 'autoNpcEnabled', 'semanticRecallEnabled']) {
    assert.match(view, new RegExp(`switchControlMarkup\\('${setting}'`));
  }
  assert.match(view, /state\.textContent = enabled \? '已开启' : '已关闭'/);
  assert.match(style, /\.ssa-switch-state\[data-state="on"\]/);
});

test('summary page exposes a zero-history remote floor mode', async () => {
  const source = await readFile(new URL('../ui/view.js', import.meta.url), 'utf8');
  assert.match(source, /data-setting="remoteRawFloorLimit"/);
  assert.match(source, /<option value="0">不发送历史原文<\/option>/);
  assert.match(source, /单楼摘要仅发送当前一楼/);
  assert.match(source, /约 6500 token 的硬上限/);
});

test('player preference profile uses one global storage key with legacy chat migration', async () => {
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  assert.match(source, /PLAYER_PROFILE_KEY = `\$\{MODULE_ID\}::player-preference`/);
  assert.match(source, /migratedFromChatKey/);
  assert.match(source, /之后不需要重复测试/);
});

test('semantic recall UI and generation interceptor are wired without permanent player weighting', async () => {
  const [view, index, manifest, style] = await Promise.all([
    readFile(new URL('../ui/view.js', import.meta.url), 'utf8'),
    readFile(new URL('../index.js', import.meta.url), 'utf8'),
    readFile(new URL('../manifest.json', import.meta.url), 'utf8'),
    readFile(new URL('../style.css', import.meta.url), 'utf8'),
  ]);
  assert.match(view, /自动找回相关往事/);
  assert.match(view, /data-action="rebuild-recall"/);
  assert.match(index, /setExtensionPrompt/);
  assert.match(index, /phase: result\.prompt \? 'injected' : 'empty'/);
  assert.match(view, /本轮已注入/);
  const interceptor = index.match(/async function semanticRecallInterceptor[\s\S]*?\n\}\n\nfunction scheduleReconcile/)?.[0] ?? '';
  assert.doesNotMatch(interceptor, /waitForIdle/);
  assert.equal(JSON.parse(manifest).generate_interceptor, 'springStoryArchiveSemanticRecallInterceptor');
  assert.match(style, /\.ssa-switch-row input \{[\s\S]*?padding:\s*0;[\s\S]*?border:\s*0;/);
  assert.doesNotMatch(`${view}\n${index}`, /高优先级记录/);
});

test('mobile archive uses continuous floor rows, a solid single-line nav, and a labeled quiz scale', async () => {
  const [view, style] = await Promise.all([
    readFile(new URL('../ui/view.js', import.meta.url), 'utf8'),
    readFile(new URL('../style.css', import.meta.url), 'utf8'),
  ]);
  assert.match(view, /<span>不同意<\/span>[\s\S]*?<span>中立 \/ 不知道<\/span>[\s\S]*?<span>同意<\/span>/);
  assert.match(view, /data-tab="npc">NPC<\/button>/);
  assert.match(style, /\.ssa-floor-card \{[\s\S]*?border-radius:\s*0;[\s\S]*?background:\s*transparent;/);
  assert.match(style, /@media \(max-width: 720px\)[\s\S]*?\.ssa-tabs \{[\s\S]*?background:\s*#f8f4e8;/);
  assert.match(style, /\.ssa-tabs button \{[\s\S]*?font-family:\s*var\(--ssa-kai-font\);[\s\S]*?white-space:\s*nowrap;/);
  assert.match(style, /--ssa-kai-font:[^;]*"KaiTi"/);
  assert.match(style, /\.ssa-floor-list \{[\s\S]*?rgba\(59, 88, 75, \.08\)/);
});
