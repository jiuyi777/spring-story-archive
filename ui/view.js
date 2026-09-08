import {
  PREFERENCE_QUIZ_ITEMS,
  PREFERENCE_QUIZ_SCALE,
  PREFERENCE_QUIZ_SOURCE,
  PREFERENCE_TRAIT_LABELS,
  STORY_EXPERIENCE_OPTIONS,
} from '../core/preference-quiz.js?v=0.5.6';

const MODE_NAMES = {
  guided: '玩家行动（代入）',
  scene: '场景入口',
  third: '第三人称叙事',
  mixed: '混合表达',
};

const LAUNCHER_POSITION_KEY = 'spring-story-archive:launcher-position';
const LAUNCHER_VIEWPORT_MARGIN = 6;
const LAUNCHER_DRAG_THRESHOLD = 4;
const LAUNCHER_DOCK_OVERSHOOT = 8;
const EXPERIENCE_NAMES = Object.fromEntries(STORY_EXPERIENCE_OPTIONS.map((option) => [option.id, option.label]));

function switchControlMarkup(setting, label) {
  return `
    <span class="ssa-switch-control">
      <span class="ssa-switch-state" data-switch-state-for="${setting}" data-state="off">已关闭</span>
      <input type="checkbox" data-setting="${setting}" aria-label="${label}">
    </span>
  `;
}

function storyExperienceMarkup() {
  return STORY_EXPERIENCE_OPTIONS.map((option) => `
    <label class="ssa-experience-option">
      <input type="checkbox" value="${option.id}" data-experience-id="${option.id}">
      <span><strong>${option.label}</strong><small>${option.description}</small></span>
    </label>
  `).join('');
}

function preferenceQuizMarkup() {
  return PREFERENCE_QUIZ_ITEMS.map((item, index) => `
    <fieldset class="ssa-quiz-question">
      <legend><span>${String(index + 1).padStart(2, '0')}</span>${item.text}</legend>
      <div class="ssa-quiz-scale-labels" aria-hidden="true">
        <span>不同意</span>
        <span>中立 / 不知道</span>
        <span>同意</span>
      </div>
      <div class="ssa-quiz-scale">
        ${PREFERENCE_QUIZ_SCALE.map((choice) => `
          <label>
            <input type="radio" name="ssa-quiz-${item.id}" value="${choice.value}" data-quiz-id="${item.id}" aria-label="${choice.label}">
            <span aria-hidden="true"><i></i></span>
          </label>
        `).join('')}
      </div>
    </fieldset>
  `).join('');
}

export function createArchiveShell() {
  const root = document.createElement('div');
  root.id = 'spring_story_archive_root';
  root.dataset.extensionId = 'spring-story-archive';
  root.innerHTML = `
    <button class="ssa-launcher" type="button" data-action="open" aria-label="打开春序档案">
      <span class="ssa-launcher-flower" aria-hidden="true">✿</span>
      <span class="ssa-launcher-label">春序</span>
    </button>
    <div class="ssa-backdrop" data-action="close" hidden></div>
    <section class="ssa-app" role="dialog" aria-modal="true" aria-label="春序档案" hidden>
      <header class="ssa-header">
        <div>
          <p class="ssa-eyebrow">逐楼摘要 · 时间线 · 剧情辅助</p>
          <h1><span aria-hidden="true">❀</span> 春序档案</h1>
        </div>
        <button class="ssa-icon-button" type="button" data-action="close" aria-label="关闭">×</button>
      </header>

      <div class="ssa-privacy-ribbon">
        <span class="ssa-leaf-dot" aria-hidden="true"></span>
        <strong>远端原文边界</strong>
        <span data-role="remote-floor-boundary">默认不发送历史楼层原文</span>
        <span class="ssa-local-badge">更早原文只留本机</span>
      </div>

      <nav class="ssa-tabs" aria-label="档案页面">
        <button class="is-active" type="button" data-tab="summary">楼层摘要</button>
        <button type="button" data-tab="options">剧情选项</button>
        <button type="button" data-tab="advance">自主推进</button>
        <button type="button" data-tab="npc">NPC</button>
        <button type="button" data-tab="settings">设置</button>
      </nav>

      <main class="ssa-main">
        <section class="ssa-page is-active" data-page="summary">
          <article class="ssa-summary-controls-card">
            <div>
              <p class="ssa-kicker">自动整理</p>
              <h2>摘要压缩与楼层显示</h2>
            </div>
            <div class="ssa-summary-control-grid">
              <label>自动压缩阈值（token）
                <input type="number" min="1000" max="30000" step="500" data-setting="rollupTokenLimit">
                <small>总摘要达到此值或每满 100 楼时自动压缩。</small>
              </label>
              <label>默认展开最近楼层
                <select data-setting="expandedFloorCount">
                  <option value="3">最近 3 楼</option>
                  <option value="5">最近 5 楼</option>
                  <option value="10">最近 10 楼</option>
                </select>
                <small>更早楼层默认折叠，点击楼层标题即可查看。</small>
              </label>
              <label class="ssa-summary-remote-control">发送给剧情辅助接口的历史原文
                <select data-setting="remoteRawFloorLimit">
                  <option value="0">不发送历史原文</option>
                  <option value="1">最近 1 楼</option>
                  <option value="3">最近 3 楼</option>
                  <option value="5">最近 5 楼</option>
                </select>
                <small>默认不发送。批量逐楼摘要只发送正在整理的本批楼层，否则无法生成这些摘要；所有请求另有约 6500 token 的硬上限。</small>
              </label>
            </div>
          </article>

          <details class="ssa-rollup-card">
            <summary class="ssa-rollup-summary">
              <div>
                <p class="ssa-kicker">长篇记忆</p>
                <h2>当前大总结</h2>
              </div>
              <span class="ssa-rollup-summary-end">
                <span data-role="rollup-floor">已覆盖 0 楼</span>
                <span class="ssa-rollup-disclosure" aria-hidden="true">⌄</span>
              </span>
            </summary>
            <div class="ssa-rollup-body">
              <p class="ssa-rollup-text" data-role="rollup-text">还没有可用摘要。</p>
              <div class="ssa-rollup-meta">
                <span data-role="rollup-token">约 0 token</span>
                <span>每 100 楼或达到上限自动压缩</span>
                <button class="ssa-secondary-button" type="button" data-action="compress">现在大总结</button>
              </div>
            </div>
          </details>

          <div class="ssa-list-heading">
            <div>
              <p class="ssa-kicker">每一楼都单独记录</p>
              <h2>逐楼摘要与档案</h2>
            </div>
            <div class="ssa-backfill-actions">
              <span data-role="backfill-status">待补全 0 楼</span>
              <label>每批
                <select data-setting="backfillBatchSize">
                  <option value="10">10 楼</option>
                  <option value="20">20 楼</option>
                </select>
              </label>
              <button class="ssa-primary-button" type="button" data-action="backfill">补全下一批</button>
            </div>
          </div>
          <p class="ssa-muted">同一批楼层只调用一次摘要 API，返回后仍分别保存为逐楼摘要；内容过长时会自动拆批。</p>
          <div class="ssa-floor-list" data-role="floor-list"></div>
        </section>

        <section class="ssa-page" data-page="options">
          <article class="ssa-paper-card">
            <p class="ssa-kicker">生成剧情选项</p>
            <h2>选择选项的表达方式和数量</h2>
            <p class="ssa-muted">点击选项只会填入当前 SillyTavern 输入框，不会自动发送给 AI。</p>
            <label class="ssa-switch-row">
              <span class="ssa-switch-copy"><strong>剧情选项功能</strong><small>由玩家决定是否开启；默认关闭。</small></span>
              ${switchControlMarkup('optionsEnabled', '剧情选项功能')}
            </label>
            <fieldset class="ssa-mode-fieldset">
              <legend>表达方式</legend>
              <div class="ssa-mode-options">
                <label><input type="radio" name="ssa-option-mode" value="guided" data-setting="optionMode"><span>玩家行动（代入）</span></label>
                <label><input type="radio" name="ssa-option-mode" value="scene" data-setting="optionMode"><span>场景入口</span></label>
                <label><input type="radio" name="ssa-option-mode" value="third" data-setting="optionMode"><span>第三人称叙事</span></label>
                <label><input type="radio" name="ssa-option-mode" value="mixed" data-setting="optionMode"><span>混合</span></label>
              </div>
            </fieldset>
            <div class="ssa-inline-fields is-two-columns">
              <label>选项数量
                <select data-setting="optionCount">
                  ${Array.from({ length: 9 }, (_, index) => `<option value="${index + 4}">${index + 4} 个</option>`).join('')}
                </select>
              </label>
              <label>使用接口
                <select data-setting="optionSource">
                  <option value="current">酒馆当前 API</option>
                  <option value="extra">额外 API</option>
                </select>
              </label>
            </div>
            <button class="ssa-primary-button ssa-wide-button" type="button" data-action="generate-options">生成剧情选项</button>
          </article>
          <div class="ssa-options-list" data-role="options-list">
            <div class="ssa-empty-state"><p>尚未生成剧情选项。</p></div>
          </div>
        </section>

        <section class="ssa-page" data-page="advance">
          <article class="ssa-advance-hero">
            <div class="ssa-hero-mark" aria-hidden="true">春</div>
            <div>
              <p class="ssa-kicker">玩家偏好只建立一次</p>
              <h2>让导演先理解你想怎样体验故事</h2>
              <p>测试会在独立页面完成。以后这里只保留结果摘要，不再铺开整套题目。</p>
            </div>
          </article>

          <section class="ssa-preference-entry" data-role="preference-entry">
            <div>
              <strong>还没有玩家偏好档案</strong>
              <p>可完成 10 题测试和剧情体验多选，也可以直接依据当前聊天进行保守分析。</p>
            </div>
            <div class="ssa-entry-actions">
              <button class="ssa-primary-button" type="button" data-action="open-preference-test">开始首次测试</button>
              <button class="ssa-secondary-button" type="button" data-action="skip-preference-quiz">跳过测试</button>
            </div>
          </section>
          <div class="ssa-result-card ssa-profile-card" data-role="preference-profile" hidden></div>

          <article class="ssa-paper-card ssa-advance-card">
            <p class="ssa-kicker">自主推进剧情</p>
            <h2>后台推进</h2>
            <label class="ssa-switch-row">
              <span class="ssa-switch-copy"><strong>由玩家主动开启</strong><small>在角色回复后后台生成下一步指令；默认关闭。</small></span>
              ${switchControlMarkup('autoAdvanceEnabled', '自主推进剧情')}
            </label>
            <div class="ssa-inline-fields is-two-columns">
              <label>导演接口
                <select data-setting="advanceSource">
                  <option value="extra">额外 API</option>
                  <option value="current">酒馆当前 API</option>
                </select>
              </label>
              <label>最多追加
                <select data-setting="advanceRounds">
                  <option value="1">1 轮</option>
                  <option value="2">2 轮</option>
                  <option value="3">3 轮</option>
                </select>
              </label>
            </div>
            <p class="ssa-notice">自主推进会先校对时间、地点、人物状态和玩家边界。有未发送草稿时立即停止。</p>
          </article>
          <div class="ssa-result-card" data-role="advance-state">尚未执行自主推进。</div>
        </section>

        <section class="ssa-page" data-page="npc">
          <article class="ssa-paper-card ssa-npc-archive-intro">
            <p class="ssa-kicker">当前聊天</p>
            <h2>NPC 人物档案</h2>
            <p class="ssa-muted">AI 根据剧情自行判断人物功能，再记录年龄、人生阶段、工作与客观状态，并用具体经历解释性格和矛盾。档案不预设固定口癖、小动作或行为模板。</p>
            <label class="ssa-switch-row">
              <span class="ssa-switch-copy"><strong>按剧情需要自动建档与更新</strong><small>AI 自行判断当前缺少的剧情功能；剧情明确推进年龄、工作或人生阶段时更新，默认关闭。</small></span>
              ${switchControlMarkup('autoNpcEnabled', 'NPC 自动建档与更新')}
            </label>
            <label>生成接口
              <select data-setting="npcSource">
                <option value="current">酒馆当前 API</option>
                <option value="extra">额外 API</option>
              </select>
            </label>
            <label>补充要求（可选）
              <textarea rows="3" data-setting="npcBrief" placeholder="可补充必须遵守的世界观事实或需要避开的设定；人物的剧情功能由 AI 判断。"></textarea>
            </label>
            <button class="ssa-primary-button ssa-wide-button" type="button" data-action="generate-npc">立即生成 NPC 并存入档案</button>
          </article>
          <div class="ssa-npc-list" data-role="npc-list">
            <div class="ssa-empty-state"><p>当前聊天还没有由本插件生成的 NPC。</p></div>
          </div>
        </section>

        <section class="ssa-page ssa-test-page" data-page="preference-test">
          <header class="ssa-test-header">
            <button class="ssa-icon-button ssa-back-button" type="button" data-action="close-preference-test" aria-label="返回自主推进">‹</button>
            <div>
              <p class="ssa-kicker">首次建立玩家偏好</p>
              <h2>人格与剧情体验测试</h2>
            </div>
            <span>约 2 分钟</span>
          </header>
          <div class="ssa-test-intro">
            <strong>没有正确答案</strong>
            <p>点选答案只保存在当前页面，不会请求 AI。只有点击“完成测试并生成分析”才会调用接口。</p>
            <p>用于调整互动、连续性、冲突强度与新奇程度，不作心理诊断。聊天里后来明确说出的选择和边界始终优先。</p>
          </div>
          <div class="ssa-quiz-questions">${preferenceQuizMarkup()}</div>
          <section class="ssa-test-section">
            <div class="ssa-section-heading">
              <div><p class="ssa-kicker">可多选</p><h2>想要的剧情体验</h2></div>
            </div>
            <p class="ssa-muted">AI 会把这些选择与测试、聊天中的实际表达一起分析，不会按单个标签套模板。</p>
            <div class="ssa-experience-grid">${storyExperienceMarkup()}</div>
          </section>
          <section class="ssa-test-section">
            <label>其他想要或需要避免的内容
              <textarea rows="3" data-setting="preferenceNotes" placeholder="例如：想要慢热友情；避免强制玩家表态。"></textarea>
            </label>
            <label>分析接口
              <select data-setting="preferenceSource">
                <option value="current">酒馆当前 API</option>
                <option value="extra">额外 API</option>
              </select>
            </label>
            <button class="ssa-primary-button ssa-wide-button" type="button" data-action="analyze-preferences">完成测试并生成分析</button>
            <p class="ssa-quiz-source">${PREFERENCE_QUIZ_SOURCE.note} <a href="${PREFERENCE_QUIZ_SOURCE.permissionUrl}" target="_blank" rel="noopener noreferrer">公共领域说明</a></p>
          </section>
        </section>

        <section class="ssa-page" data-page="settings">
          <article class="ssa-paper-card">
            <p class="ssa-kicker">摘要与大总结</p>
            <h2>摘要方式</h2>
            <label class="ssa-switch-row">
              <span class="ssa-switch-copy"><strong>自动记录新楼层</strong><small>只摘要之后新增、编辑或重选的楼层；旧楼层由“补全下一批”分批处理。</small></span>
              ${switchControlMarkup('autoSummarize', '自动记录新楼层')}
            </label>
            <label>摘要使用接口
              <select data-setting="summarySource">
                <option value="current">酒馆当前 API</option>
                <option value="extra">额外 API</option>
              </select>
            </label>
            <label>自动压缩阈值（token）
              <input type="number" min="1000" max="30000" step="500" data-setting="rollupTokenLimit">
              <small>与摘要页顶部为同一设置。</small>
            </label>
          </article>

          <article class="ssa-paper-card ssa-recall-card">
            <p class="ssa-kicker">摘要语义检索</p>
            <h2>语义回忆</h2>
            <label class="ssa-switch-row">
              <span class="ssa-switch-copy"><strong>自动找回相关往事</strong><small>只向量化楼层摘要；默认关闭。生成前召回相关旧摘要并注入真实提示词。</small></span>
              ${switchControlMarkup('semanticRecallEnabled', '自动找回相关往事')}
            </label>
            <p class="ssa-notice">不会把某次拒绝、同意或边界永久化。同一主题后来有新表态时，以更晚楼层为当前状态，旧表态只保留为历史。</p>
            <label>嵌入模型（优先自动读取）
              <input type="text" list="ssa-embedding-model-list" autocomplete="off" placeholder="例如 text-embedding-3-small，也可手动输入" data-setting="recallEmbeddingModel">
              <datalist id="ssa-embedding-model-list" data-role="embedding-model-list"></datalist>
              <small>复用下方额外 API 地址和本次会话 Key；模型列表中含 embed 的型号会优先自动选中。</small>
            </label>
            <div class="ssa-inline-fields is-three-columns">
              <label>召回数量
                <select data-setting="recallTopK">
                  ${Array.from({ length: 6 }, (_, index) => `<option value="${index + 3}">${index + 3} 条</option>`).join('')}
                </select>
              </label>
              <label>相似度门槛
                <select data-setting="recallThreshold">
                  ${[0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8].map((value) => `<option value="${value}">${value.toFixed(2)}</option>`).join('')}
                </select>
              </label>
              <label>注入深度
                <select data-setting="recallDepth">
                  ${[2, 3, 4, 5, 6].map((value) => `<option value="${value}">${value} 层</option>`).join('')}
                </select>
              </label>
            </div>
            <div class="ssa-recall-status" data-role="recall-status">索引尚未建立 · 本轮未召回</div>
            <button class="ssa-secondary-button" type="button" data-action="rebuild-recall">重建语义索引</button>
          </article>

          <article class="ssa-paper-card">
            <p class="ssa-kicker">可选的额外接口</p>
            <h2>额外 OpenAI-compatible API</h2>
            <label>Chat Completions 完整地址
              <input type="url" autocomplete="off" placeholder="https://example.com/v1/chat/completions" data-setting="extraEndpoint">
            </label>
            <label>模型（优先从接口自动读取）
              <div class="ssa-input-action-row">
                <input type="text" list="ssa-extra-model-list" autocomplete="off" placeholder="填写接口后自动读取，也可手动输入" data-setting="extraModel">
                <button class="ssa-secondary-button" type="button" data-action="refresh-models">读取模型</button>
              </div>
              <datalist id="ssa-extra-model-list" data-role="extra-model-list"></datalist>
              <small data-role="model-list-status">填写接口地址和 Key 后会自动读取可用模型。</small>
            </label>
            <label>API Key
              <input type="password" autocomplete="new-password" placeholder="仅保留到本次浏览器会话" data-secret="extraApiKey">
              <small>Key 仅放在 sessionStorage，不写入酒馆设置和档案数据库。同页扩展仍可能读取它。</small>
            </label>
            <button class="ssa-secondary-button" type="button" data-action="test-extra-api">测试额外 API</button>
          </article>

        </section>
      </main>

      <div class="ssa-confirm-layer" data-role="retest-confirm" hidden>
        <section class="ssa-confirm-card" role="alertdialog" aria-modal="true" aria-labelledby="ssa-retest-title">
          <p class="ssa-kicker">重新测试</p>
          <h2 id="ssa-retest-title">覆盖当前玩家偏好档案？</h2>
          <p>完成新测试后，旧结果会被替换。当前档案在提交前保持不变。</p>
          <div class="ssa-entry-actions">
            <button class="ssa-secondary-button" type="button" data-action="cancel-retest">取消</button>
            <button class="ssa-primary-button" type="button" data-action="confirm-retest">继续并覆盖</button>
          </div>
        </section>
      </div>

      <footer class="ssa-footer">
        <span data-role="status">本地档案待命</span>
        <span>IndexedDB · 按聊天隔离</span>
      </footer>
    </section>
  `;
  document.body.append(root);
  bindLauncherSwipe(root);
  return root;
}

export function isRightSwipeGesture(start, end, minDistance = 18) {
  const deltaX = Number(end?.x) - Number(start?.x);
  const deltaY = Math.abs(Number(end?.y) - Number(start?.y));
  return deltaX >= minDistance && deltaX > deltaY * 1.35;
}

export function clampLauncherPosition(position, viewport, launcherSize, margin = LAUNCHER_VIEWPORT_MARGIN) {
  const safeMargin = Math.max(0, Number(margin) || 0);
  const maxLeft = Math.max(safeMargin, Number(viewport?.width) - Number(launcherSize?.width) - safeMargin);
  const maxTop = Math.max(safeMargin, Number(viewport?.height) - Number(launcherSize?.height) - safeMargin);
  const left = Math.min(maxLeft, Math.max(safeMargin, Number(position?.left) || 0));
  const top = Math.min(maxTop, Math.max(safeMargin, Number(position?.top) || 0));
  return { left, top, maxLeft, maxTop };
}

export function isLauncherDockGesture(start, end, rawLeft, maxLeft, overshoot = LAUNCHER_DOCK_OVERSHOOT) {
  return isRightSwipeGesture(start, end)
    && Number(rawLeft) >= Number(maxLeft) + Math.max(0, Number(overshoot) || 0);
}

function readLauncherPosition() {
  try {
    const value = JSON.parse(localStorage.getItem(LAUNCHER_POSITION_KEY) ?? 'null');
    if (!Number.isFinite(value?.left) || !Number.isFinite(value?.top)) return null;
    return { left: value.left, top: value.top };
  } catch {
    return null;
  }
}

function saveLauncherPosition(position) {
  try {
    localStorage.setItem(LAUNCHER_POSITION_KEY, JSON.stringify({ left: position.left, top: position.top }));
  } catch {}
}

function measureLauncher(launcher) {
  const rect = launcher.getBoundingClientRect();
  return {
    rect,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    size: { width: rect.width, height: rect.height },
  };
}

function applyLauncherPosition(launcher, position) {
  launcher.style.left = `${position.left}px`;
  launcher.style.top = `${position.top}px`;
  launcher.style.right = 'auto';
  launcher.style.bottom = 'auto';
}

function bindLauncherSwipe(root) {
  const launcher = root.querySelector('.ssa-launcher');
  const savedPosition = readLauncherPosition();
  if (savedPosition) {
    const { viewport, size } = measureLauncher(launcher);
    const position = clampLauncherPosition(savedPosition, viewport, size);
    applyLauncherPosition(launcher, position);
    saveLauncherPosition(position);
  }

  let gesture = null;
  let pendingPosition = null;
  let animationFrame = 0;
  let suppressClick = false;

  const renderPendingPosition = () => {
    animationFrame = 0;
    if (!pendingPosition) return;
    applyLauncherPosition(launcher, pendingPosition);
    pendingPosition = null;
  };

  const queuePosition = (position) => {
    pendingPosition = position;
    if (!animationFrame) animationFrame = window.requestAnimationFrame(renderPendingPosition);
  };

  const finishGesture = (event, cancelled = false) => {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    launcher.releasePointerCapture?.(event.pointerId);
    if (animationFrame) {
      window.cancelAnimationFrame(animationFrame);
      animationFrame = 0;
    }
    renderPendingPosition();

    const finished = gesture;
    gesture = null;
    launcher.classList.remove('is-dragging');
    if (!finished.dragging) return;

    suppressClick = true;
    window.setTimeout(() => { suppressClick = false; }, 350);
    const position = clampLauncherPosition(
      { left: finished.rawLeft, top: finished.rawTop },
      finished.viewport,
      finished.size,
    );
    applyLauncherPosition(launcher, position);
    saveLauncherPosition(position);

    if (!cancelled && isLauncherDockGesture(
      { x: finished.startX, y: finished.startY },
      { x: finished.lastX, y: finished.lastY },
      finished.rawLeft,
      position.maxLeft,
    )) {
      setLauncherDocked(root, true);
    }
  };

  launcher.addEventListener('pointerdown', (event) => {
    if (event.isPrimary === false || (Number.isInteger(event.button) && event.button !== 0)) return;
    if (root.classList.contains('is-launcher-docked')) return;
    const { rect, viewport, size } = measureLauncher(launcher);
    gesture = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      rawLeft: rect.left,
      rawTop: rect.top,
      viewport,
      size,
      dragging: false,
    };
    launcher.setPointerCapture?.(event.pointerId);
  });
  launcher.addEventListener('pointermove', (event) => {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    gesture.lastX = event.clientX;
    gesture.lastY = event.clientY;
    if (!gesture.dragging && Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) < LAUNCHER_DRAG_THRESHOLD) return;
    gesture.dragging = true;
    launcher.classList.add('is-dragging');
    gesture.rawLeft = event.clientX - gesture.offsetX;
    gesture.rawTop = event.clientY - gesture.offsetY;
    queuePosition(clampLauncherPosition(
      { left: gesture.rawLeft, top: gesture.rawTop },
      gesture.viewport,
      gesture.size,
    ));
  });
  launcher.addEventListener('pointerup', (event) => finishGesture(event));
  launcher.addEventListener('pointercancel', (event) => finishGesture(event, true));
  launcher.addEventListener('click', (event) => {
    if (suppressClick) {
      event.preventDefault();
      event.stopPropagation();
      suppressClick = false;
      return;
    }
    if (root.classList.contains('is-launcher-docked')) {
      event.preventDefault();
      event.stopPropagation();
      setLauncherDocked(root, false);
    }
  }, true);
}

export function setLauncherDocked(root, docked) {
  const launcher = root.querySelector('.ssa-launcher');
  root.classList.toggle('is-launcher-docked', docked);
  launcher.setAttribute('aria-label', docked ? '显示春序悬浮球' : '打开春序档案');
}

function makeFactGroup(title, items) {
  if (!items?.length) return null;
  const section = document.createElement('section');
  section.className = 'ssa-fact-group';
  const heading = document.createElement('strong');
  heading.textContent = title;
  const list = document.createElement('ul');
  for (const item of items) {
    const row = document.createElement('li');
    row.textContent = item;
    list.append(row);
  }
  section.append(heading, list);
  return section;
}

function makeFloorCard(record, expanded) {
  const article = document.createElement('details');
  article.className = `ssa-floor-card is-${record.status}${record.isUser ? ' is-player' : ''}`;
  article.dataset.floor = String(record.floorIndex);
  article.open = expanded;
  const header = document.createElement('summary');
  header.className = 'ssa-floor-header';
  const title = document.createElement('div');
  title.innerHTML = `<span class="ssa-floor-number">${record.floorIndex + 1}</span><div><p>第 ${record.floorIndex + 1} 楼 · ${record.isUser ? '玩家输入' : '角色回复'}</p><small>${record.isUser ? '玩家原文记录 · ' : ''}${record.status === 'ready' ? '摘要已入档' : record.status === 'processing' ? '正在整理' : record.status === 'failed' ? '整理失败' : '等待摘要'}</small></div>`;
  header.append(title);
  const badge = document.createElement('span');
  badge.className = 'ssa-state-badge';
  badge.textContent = record.status === 'ready' ? '已摘要' : record.status === 'processing' ? '处理中' : record.status === 'failed' ? '失败' : '缺失';
  const disclosure = document.createElement('span');
  disclosure.className = 'ssa-floor-disclosure';
  disclosure.setAttribute('aria-hidden', 'true');
  disclosure.textContent = '⌄';
  const headerEnd = document.createElement('span');
  headerEnd.className = 'ssa-floor-header-end';
  headerEnd.append(badge, disclosure);
  header.append(headerEnd);
  article.append(header);

  const content = document.createElement('div');
  content.className = 'ssa-floor-content';

  const body = document.createElement('p');
  body.className = 'ssa-floor-summary';
  body.textContent = record.status === 'ready'
    ? record.summary
    : record.status === 'processing'
      ? '正在调用摘要接口，请稍候……'
      : record.error || '这一楼还没有摘要。';
  content.append(body);

  if (record.isUser && record.userText) {
    const source = document.createElement('section');
    source.className = 'ssa-user-source';
    const sourceTitle = document.createElement('strong');
    sourceTitle.textContent = '玩家原文 · 本地完整记录';
    const sourceText = document.createElement('p');
    sourceText.textContent = record.userText;
    source.append(sourceTitle, sourceText);
    content.append(source);
  }

  const detailsRow = document.createElement('div');
  detailsRow.className = 'ssa-detail-row';
  for (const detail of [
    makeFactGroup('时间线', record.timeline),
    makeFactGroup('人物状态', record.characters),
    makeFactGroup('人物关系', record.relationships),
    makeFactGroup('伏笔与线索', record.clues),
  ]) if (detail) detailsRow.append(detail);
  content.append(detailsRow);

  if (record.status !== 'processing') {
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'ssa-text-button';
    retry.dataset.action = 'regenerate-floor';
    retry.dataset.floor = String(record.floorIndex);
    retry.textContent = record.status === 'missing' ? '生成摘要' : '重新生成';
    content.append(retry);
  }
  article.append(content);
  return article;
}

export function isFloorExpandedByDefault(index, expandedFloorCount = 5) {
  const safeCount = Math.max(1, Number(expandedFloorCount) || 5);
  return Number(index) >= 0 && Number(index) < safeCount;
}

export function renderSnapshot(root, snapshot, { expandedFloorCount = 5, resetDisclosure = false } = {}) {
  const list = root.querySelector('[data-role="floor-list"]');
  const renderedFloors = new Set([...list.querySelectorAll('.ssa-floor-card')].map((card) => card.dataset.floor));
  const openFloors = new Set([...list.querySelectorAll('.ssa-floor-card[open]')].map((card) => card.dataset.floor));
  list.replaceChildren();
  if (!snapshot.summaries.length) {
    const empty = document.createElement('div');
    empty.className = 'ssa-empty-state';
    empty.innerHTML = '<span>❀</span><p>当前聊天还没有楼层。</p>';
    list.append(empty);
  } else {
    const newestFirst = [...snapshot.summaries].reverse();
    newestFirst.forEach((record, index) => {
      const floor = String(record.floorIndex);
      const expanded = !resetDisclosure && renderedFloors.has(floor)
        ? openFloors.has(floor)
        : isFloorExpandedByDefault(index, expandedFloorCount);
      list.append(makeFloorCard(record, expanded));
    });
  }
  const rollup = snapshot.rollup;
  root.querySelector('[data-role="rollup-text"]').textContent = rollup?.text || '还没有可用摘要。';
  root.querySelector('[data-role="rollup-floor"]').textContent = `已摘要 ${rollup?.readyFloors ?? 0} / ${snapshot.totalFloors ?? snapshot.summaries.length} 楼`;
  root.querySelector('[data-role="rollup-token"]').textContent = `约 ${rollup?.tokenEstimate ?? 0} token`;
  const missingCount = snapshot.summaries.filter((record) => ['missing', 'failed'].includes(record.status)).length;
  const backfillStatus = root.querySelector('[data-role="backfill-status"]');
  if (backfillStatus) backfillStatus.textContent = `待补全 ${missingCount} 楼`;
}

export function focusLatestFloor(root, { behavior = 'smooth' } = {}) {
  const main = root.querySelector('.ssa-main');
  const latestFloor = root.querySelector('.ssa-floor-list .ssa-floor-card');
  if (!main || !latestFloor) return;
  const offset = latestFloor.getBoundingClientRect().top - main.getBoundingClientRect().top - 12;
  const top = Math.max(0, main.scrollTop + offset);
  if (typeof main.scrollTo === 'function') main.scrollTo({ top, behavior });
  else main.scrollTop = top;
}

export function renderOptions(root, options, mode) {
  const list = root.querySelector('[data-role="options-list"]');
  list.replaceChildren();
  options.forEach((option, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ssa-option-card';
    button.dataset.action = 'choose-option';
    button.dataset.option = option;
    const number = document.createElement('span');
    number.textContent = String(index + 1).padStart(2, '0');
    const copy = document.createElement('span');
    const label = document.createElement('small');
    label.textContent = MODE_NAMES[mode] ?? MODE_NAMES.guided;
    const text = document.createElement('strong');
    text.textContent = option;
    copy.append(label, text);
    button.append(number, copy);
    list.append(button);
  });
}

function appendResultList(container, title, items) {
  if (!items?.length) return;
  const section = document.createElement('section');
  const heading = document.createElement('strong');
  heading.textContent = title;
  const list = document.createElement('ul');
  for (const item of items) {
    const row = document.createElement('li');
    row.textContent = item;
    list.append(row);
  }
  section.append(heading, list);
  container.append(section);
}

export function renderPlayerProfile(root, profile) {
  const container = root.querySelector('[data-role="preference-profile"]');
  const entry = root.querySelector('[data-role="preference-entry"]');
  container.replaceChildren();
  if (!profile?.summary) {
    container.hidden = true;
    if (entry) entry.hidden = false;
    root.dataset.hasPreferenceProfile = 'false';
    return;
  }
  container.hidden = false;
  if (entry) entry.hidden = true;
  root.dataset.hasPreferenceProfile = 'true';
  const title = document.createElement('h3');
  title.textContent = '已建立玩家剧情偏好';
  const summary = document.createElement('p');
  summary.textContent = profile.summary;
  container.append(title, summary);
  const pills = document.createElement('div');
  pills.className = 'ssa-trait-scores';
  const labels = [
    ...(profile.selectedExperiences ?? []).slice(0, 4).map((id) => EXPERIENCE_NAMES[id] ?? id),
    ...Object.entries(profile.quizScores ?? {}).slice(0, 2).map(([trait]) => PREFERENCE_TRAIT_LABELS[trait] ?? trait),
  ];
  for (const label of [...new Set(labels)].slice(0, 6)) {
    const pill = document.createElement('span');
    pill.textContent = label;
    pills.append(pill);
  }
  if (pills.childElementCount) container.append(pills);

  const details = document.createElement('details');
  details.className = 'ssa-profile-details';
  const detailsSummary = document.createElement('summary');
  detailsSummary.textContent = '查看完整分析';
  const body = document.createElement('div');
  appendResultList(body, '人格与互动倾向', profile.personalityTendencies);
  appendResultList(body, '想要的体验', profile.storyNeeds);
  appendResultList(body, '适合的发展', profile.preferredDevelopments);
  appendResultList(body, '应避免的方式', profile.avoidPatterns);
  appendResultList(body, '推进规则', profile.directorRules);
  details.append(detailsSummary, body);
  container.append(details);

  const actions = document.createElement('div');
  actions.className = 'ssa-profile-actions';
  const retest = document.createElement('button');
  retest.type = 'button';
  retest.className = 'ssa-secondary-button';
  retest.dataset.action = 'open-preference-test';
  retest.textContent = '重新测试';
  actions.append(retest);
  container.append(actions);
}

export function renderAdvanceState(root, state) {
  const container = root.querySelector('[data-role="advance-state"]');
  container.replaceChildren();
  if (!state?.directive) {
    container.textContent = '尚未执行自主推进。';
    return;
  }
  const title = document.createElement('h3');
  title.textContent = '最近一次后台推进';
  const check = document.createElement('p');
  check.innerHTML = '<strong>连续性校对</strong>';
  check.append(document.createTextNode(state.continuityCheck || '已按当前档案校对。'));
  const directive = document.createElement('p');
  directive.innerHTML = '<strong>推进指令</strong>';
  directive.append(document.createTextNode(state.directive));
  container.append(title, check, directive);
}

export function renderNpcs(root, npcs) {
  const list = root.querySelector('[data-role="npc-list"]');
  list.replaceChildren();
  if (!npcs?.length) {
    const empty = document.createElement('div');
    empty.className = 'ssa-empty-state';
    empty.textContent = '当前聊天还没有由本插件生成的 NPC。';
    list.append(empty);
    return;
  }
  for (const npc of [...npcs].reverse()) {
    const card = document.createElement('article');
    card.className = 'ssa-npc-card';
    const heading = document.createElement('header');
    heading.className = 'ssa-npc-heading';
    const titleWrap = document.createElement('div');
    const title = document.createElement('h3');
    title.textContent = npc.name;
    const functionText = document.createElement('p');
    functionText.className = 'ssa-npc-meta';
    functionText.textContent = `AI 判断功能：${npc.plotFunction || '剧情人物'}`;
    titleWrap.append(title, functionText);
    const stage = document.createElement('span');
    stage.className = 'ssa-npc-stage';
    stage.textContent = [npc.age, npc.lifeStage].filter(Boolean).join(' · ') || '阶段待确认';
    heading.append(titleWrap, stage);
    card.append(heading);

    const recordLine = document.createElement('p');
    recordLine.className = 'ssa-npc-record-line';
    const recordCode = String(npc.id ?? '').split('::').at(-1) || '未编号';
    recordLine.textContent = `档案编号 ${recordCode} · ${npc.generatedAutomatically ? '自动建档' : '手动建档'}${npc.editedByPlayer ? ' · 玩家已修订' : ''}`;
    card.append(recordLine);

    const facts = document.createElement('dl');
    facts.className = 'ssa-npc-facts';
    for (const [label, value] of [
      ['当前工作', npc.occupation],
      ['当前目标', npc.currentGoal],
    ]) {
      const wrap = document.createElement('div');
      const term = document.createElement('dt');
      term.textContent = label;
      const description = document.createElement('dd');
      description.textContent = value || '尚未确认';
      wrap.append(term, description);
      facts.append(wrap);
    }
    card.append(facts);
    appendResultList(card, '当前客观状态', npc.objectiveFacts);
    appendResultList(card, '塑造其性格的经历', npc.biography ?? npc.formativePast);
    if (npc.personality) appendResultList(card, '由经历形成的性格', [npc.personality]);
    appendResultList(card, '人物内部矛盾', npc.contradictions ?? npc.contrasts);
    appendResultList(card, '经历与性格的因果', npc.personalityFormation);
    appendResultList(card, '愿望、利益与底线', npc.independentWill);
    appendResultList(card, '人物关系', npc.relationships);
    appendResultList(card, '随剧情推进的成长状态', npc.growthState);
    appendResultList(card, '对玩家的短期记录', npc.playerMemory);
    const editor = document.createElement('details');
    editor.className = 'ssa-npc-editor';
    const editorSummary = document.createElement('summary');
    editorSummary.textContent = npc.editedByPlayer ? '继续编辑档案' : '编辑 NPC 档案';
    const form = document.createElement('div');
    form.className = 'ssa-npc-editor-fields';
    form.dataset.npcId = npc.id;
    for (const [key, label, multiline] of [
      ['name', '姓名', false],
      ['age', '年龄或年龄范围', false],
      ['lifeStage', '人生阶段', false],
      ['occupation', '当前工作', false],
      ['plotFunction', '剧情功能（AI 初次判断，可修订）', false],
      ['currentGoal', '当前目标', false],
      ['objectiveFacts', '当前客观状态（每行一项）', true],
      ['biography', '塑造性格的详细经历（每行一项）', true],
      ['personality', '由经历形成的性格', true],
      ['contradictions', '人物内部矛盾（每行一项）', true],
      ['personalityFormation', '经历与性格的因果（每行一项）', true],
      ['independentWill', '愿望、利益与底线（每行一项）', true],
      ['relationships', '人物关系（每行一项）', true],
      ['growthState', '随剧情推进的成长状态（每行一项）', true],
      ['playerMemory', '对玩家的短期记录（每行一项）', true],
    ]) {
      const labelNode = document.createElement('label');
      labelNode.textContent = label;
      const input = multiline ? document.createElement('textarea') : document.createElement('input');
      if (!multiline) input.type = 'text';
      if (multiline) input.rows = 3;
      input.dataset.npcField = key;
      const rawValue = key === 'biography'
        ? (npc.biography ?? npc.formativePast)
        : key === 'contradictions'
          ? (npc.contradictions ?? npc.contrasts)
          : npc[key];
      input.value = Array.isArray(rawValue) ? rawValue.join('\n') : String(rawValue ?? '');
      labelNode.append(input);
      form.append(labelNode);
    }
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'ssa-primary-button';
    save.dataset.action = 'save-npc';
    save.dataset.npcId = npc.id;
    save.textContent = '保存修改';
    form.append(save);
    editor.append(editorSummary, form);
    card.append(editor);
    list.append(card);
  }
}

export function collectNpcEdits(root, npcId) {
  const form = [...root.querySelectorAll('[data-npc-id]')].find((node) => node.dataset.npcId === npcId);
  if (!form) throw new Error('没有找到这份 NPC 档案。');
  const listFields = new Set(['objectiveFacts', 'biography', 'contradictions', 'personalityFormation', 'independentWill', 'relationships', 'growthState', 'playerMemory']);
  const values = {};
  for (const input of form.querySelectorAll('[data-npc-field]')) {
    const key = input.dataset.npcField;
    values[key] = listFields.has(key)
      ? input.value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)
      : input.value.trim();
  }
  if (!values.name) throw new Error('NPC 姓名不能为空。');
  return values;
}

export function collectPreferenceQuiz(root) {
  const answers = {};
  for (const input of root.querySelectorAll('[data-quiz-id]:checked')) answers[input.dataset.quizId] = Number(input.value);
  return answers;
}

export function collectStoryExperiences(root) {
  return [...root.querySelectorAll('[data-experience-id]:checked')].map((input) => input.dataset.experienceId);
}

export function resetPreferenceTest(root) {
  for (const input of root.querySelectorAll('[data-quiz-id], [data-experience-id]')) input.checked = false;
  const main = root.querySelector('.ssa-main');
  if (main) main.scrollTop = 0;
}

export function setRetestConfirmOpen(root, open) {
  const layer = root.querySelector('[data-role="retest-confirm"]');
  if (layer) layer.hidden = !open;
}

export function renderModelOptions(root, models, message = '') {
  const list = root.querySelector('[data-role="extra-model-list"]');
  if (list) {
    list.replaceChildren();
    for (const model of models ?? []) {
      const option = document.createElement('option');
      option.value = model;
      list.append(option);
    }
  }
  const embeddingList = root.querySelector('[data-role="embedding-model-list"]');
  if (embeddingList) {
    embeddingList.replaceChildren();
    for (const model of models ?? []) {
      const option = document.createElement('option');
      option.value = model;
      embeddingList.append(option);
    }
  }
  const status = root.querySelector('[data-role="model-list-status"]');
  if (status && message) status.textContent = message;
}

export function renderRecallState(root, { indexedCount = 0, recalledFloors = [], error = '', phase = 'disabled' } = {}) {
  const status = root.querySelector('[data-role="recall-status"]');
  if (!status) return;
  if (error) {
    status.textContent = `注入失败：${error}`;
    status.dataset.tone = 'error';
    return;
  }
  const floorText = recalledFloors.map((floor) => floor + 1).join('、');
  const messages = {
    disabled: '注入已关闭',
    armed: `已开启，等待下一次酒馆生成 · 已索引 ${indexedCount} 楼`,
    preparing: '正在检索并准备本轮注入……',
    injected: `本轮已注入 ${recalledFloors.length} 条摘要${floorText ? ` · 第 ${floorText} 楼` : ''}`,
    empty: `本轮没有匹配内容 · 已索引 ${indexedCount} 楼`,
    feature: recalledFloors.length
      ? `本次功能请求已检索 ${recalledFloors.length} 条摘要`
      : `本次功能请求没有匹配内容 · 已索引 ${indexedCount} 楼`,
    indexed: `语义索引已建立 · 共 ${indexedCount} 楼 · 等待下一次酒馆生成`,
    matched: `已检索 ${recalledFloors.length} 条摘要 · 尚未注入`,
  };
  status.textContent = messages[phase] ?? messages.armed;
  status.dataset.tone = 'normal';
}

export function syncSettings(root, settings, apiKey = '') {
  for (const input of root.querySelectorAll('[data-setting]')) {
    const key = input.dataset.setting;
    const value = settings[key];
    if (input.type === 'checkbox') input.checked = Boolean(value);
    else if (input.type === 'radio') input.checked = input.value === String(value ?? '');
    else input.value = String(value ?? '');
  }
  for (const state of root.querySelectorAll('[data-switch-state-for]')) {
    const enabled = Boolean(settings[state.dataset.switchStateFor]);
    state.textContent = enabled ? '已开启' : '已关闭';
    state.dataset.state = enabled ? 'on' : 'off';
  }
  const optionsButton = root.querySelector('[data-action="generate-options"]');
  if (optionsButton) {
    optionsButton.disabled = !settings.optionsEnabled;
    optionsButton.textContent = settings.optionsEnabled ? '生成剧情选项' : '剧情选项已关闭';
  }
  const optionsList = root.querySelector('[data-role="options-list"]');
  if (optionsList) optionsList.hidden = !settings.optionsEnabled;
  const secret = root.querySelector('[data-secret="extraApiKey"]');
  if (secret && document.activeElement !== secret) secret.value = apiKey;
  for (const input of root.querySelectorAll('[data-quiz-id]')) {
    input.checked = Number(settings.preferenceQuizAnswers?.[input.dataset.quizId]) === Number(input.value);
  }
  const selectedExperiences = new Set(settings.storyExperiencePreferences ?? []);
  for (const input of root.querySelectorAll('[data-experience-id]')) {
    input.checked = selectedExperiences.has(input.dataset.experienceId);
  }
  const limit = root.querySelector('[data-role="rollup-limit-value"]');
  if (limit) limit.textContent = String(settings.rollupTokenLimit ?? 6000);
  const boundary = root.querySelector('[data-role="remote-floor-boundary"]');
  if (boundary) {
    const rawLimit = Number(settings.remoteRawFloorLimit) || 0;
    boundary.textContent = rawLimit > 0
      ? `滚动总摘要 + 最近 ${rawLimit} 楼原文`
      : '不发送历史楼层原文 · 批量摘要只发送本批楼层';
  }
}

export function setOpen(root, open) {
  if (open) setLauncherDocked(root, false);
  root.querySelector('.ssa-app').hidden = !open;
  root.querySelector('.ssa-backdrop').hidden = !open;
  root.classList.toggle('is-open', open);
}

export function setStatus(root, message, tone = 'normal') {
  const status = root.querySelector('[data-role="status"]');
  status.textContent = message;
  status.dataset.tone = tone;
}

export function switchTab(root, tab) {
  const subpage = tab === 'preference-test';
  root.classList.toggle('is-subpage', subpage);
  for (const button of root.querySelectorAll('[data-tab]')) button.classList.toggle('is-active', button.dataset.tab === tab);
  for (const page of root.querySelectorAll('[data-page]')) page.classList.toggle('is-active', page.dataset.page === tab);
  const main = root.querySelector('.ssa-main');
  if (main) main.scrollTop = 0;
}
