import { ADVANCE_MODULES } from '../core/play-prompts.js?v=0.7.2';
import { DEFAULT_CLICHE_RULES } from '../core/cliche-filter.js?v=0.7.2';
import { GENRE_GROUPS, TASTE_QUESTIONS, MBTI_TYPES } from '../core/preference-quiz.js?v=0.7.2';
import {
  PREFERENCE_QUIZ_ITEMS,
  PREFERENCE_QUIZ_SCALE,
  PREFERENCE_QUIZ_SOURCE,
  PREFERENCE_TRAIT_LABELS,
  STORY_EXPERIENCE_OPTIONS,
} from '../core/preference-quiz.js?v=0.7.2';

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

function tasteMarkup() {
  const genres = GENRE_GROUPS.map((group) => `
    <div class="ssa-genre-group">
      <span class="ssa-genre-group-label">${group.label}</span>
      <div class="ssa-genre-chips">
        ${group.genres.map((genre) => `<label class="ssa-genre-chip"><input type="checkbox" data-genre-id="${genre.id}"><span>${genre.label}</span></label>`).join('')}
      </div>
    </div>`).join('');
  const questions = TASTE_QUESTIONS.map((question) => `
    <fieldset class="ssa-taste-question">
      <legend>${question.label}</legend>
      <div class="ssa-genre-chips">
        ${question.choices.map((choice) => `<label class="ssa-genre-chip"><input type="radio" name="ssa-taste-${question.id}" value="${choice}" data-taste-id="${question.id}"><span>${choice}</span></label>`).join('')}
      </div>
    </fieldset>`).join('');
  return { genres, questions };
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

import { renderHero, applyHeroArt, watchHeroScroll, HERO_ARTS } from './hero.js?v=0.7.2';

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
      <header class="ssa-header ssa-hero">
        <div class="ssa-hero-art" aria-hidden="true">
          <svg class="ssa-hero-mist" viewBox="0 0 390 200" preserveAspectRatio="none">
            <path d="M0 96 C60 62 110 80 160 54 C210 30 260 62 310 42 C350 28 375 40 390 34 V200 H0Z" style="fill:var(--ssa-olive)" opacity=".55"/>
            <path d="M0 128 C50 106 100 120 150 98 C200 78 240 108 300 90 C340 80 370 90 390 82 V200 H0Z" style="fill:var(--ssa-mist)" opacity=".8"/>
            <path d="M0 158 C40 142 90 150 130 134 C180 116 230 144 280 128 C330 114 360 126 390 120 V200 H0Z" style="fill:var(--ssa-mid)"/>
            <path d="M0 184 C70 170 120 178 190 164 C250 154 320 172 390 162 V200 H0Z" style="fill:var(--ssa-deep)"/>
          </svg>
        </div>
        <div class="ssa-hero-text">
          <p class="ssa-hero-kicker" data-role="hero-kicker">春序</p>
          <h1 class="ssa-hero-title" data-role="hero-title">春序档案</h1>
          <p class="ssa-hero-sub" data-role="hero-sub"></p>
        </div>
        <button class="ssa-icon-button" type="button" data-action="close" aria-label="关闭">×</button>
        <button class="ssa-grip" type="button" data-role="grip" aria-label="下拉关闭"></button>
      </header>

      <nav class="ssa-tabs" aria-label="档案页面">
        <button type="button" data-tab="database">数据库</button>
        <button type="button" data-tab="people">人物</button>
        <button class="is-active" type="button" data-tab="sending">楼层发送</button>
        <button type="button" data-tab="player">玩家</button>
        <button type="button" data-tab="settings">设置</button>
      </nav>

      <main class="ssa-main">
        <section class="ssa-page" data-page="database">
          <div class="ssa-page-heading"><div><h2>数据库</h2><p class="ssa-page-note">剧情里发生过的事，按类别整理</p></div><button type="button" class="ssa-secondary-button" data-action="backfill">整理旧楼层</button></div>
          <article class="ssa-memory-panel">
            <label>记忆表格<select data-role="memory-table-select"></select></label>
            <label class="ssa-search"><span class="ssa-visually-hidden">查找记忆</span><input type="search" data-role="memory-search" placeholder="搜索名字或内容"></label>
            <p class="ssa-muted" data-role="memory-status">等待读取当前聊天记忆</p>
            <div data-role="memory-rows"></div>
            <button class="ssa-secondary-button" type="button" data-action="add-memory-row">添加条目</button>
          </article>
<details class="ssa-settings-group"><summary><span>逐楼记录</span><small>每一楼的整理状态、摘要和长篇总结</small></summary><div class="ssa-group-body">          <details class="ssa-rollup-card">
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
          <p class="ssa-muted">多楼一起整理，结果按楼分开保存。</p>
          <div class="ssa-floor-list" data-role="floor-list"></div>
        </div></details>        </section>
        <section class="ssa-page" data-page="people">
          <div class="ssa-page-heading"><div><h2>人物</h2><p class="ssa-page-note">剧情里的每个人，包括插件生成的 NPC</p></div></div>
          <article class="ssa-memory-panel">
            <label class="ssa-search"><span class="ssa-visually-hidden">查找</span><input type="search" data-role="table-search" data-table="characters" placeholder="搜索名字或内容"></label>
            <p class="ssa-muted" data-role="table-status" data-table="characters"></p>
            <div class="ssa-table-rows" data-role="table-rows" data-table="characters"></div>
            <button class="ssa-secondary-button" type="button" data-action="add-table-row" data-table="characters">添加人物</button>
          </article>
          <h3 class="ssa-section-title">插件生成的 NPC</h3>
          <div class="ssa-npc-list" data-role="npc-list">
            <div class="ssa-empty-state"><p>当前聊天还没有由本插件生成的 NPC。</p></div>
          </div>
        </section>
        <section class="ssa-page" data-page="player">
          <div class="ssa-page-heading"><div><h2>玩家</h2><p class="ssa-page-note">你本人说过的喜好、雷点、要求和决定，每轮最先发送</p></div></div>
          <article class="ssa-memory-panel">
            <label class="ssa-search"><span class="ssa-visually-hidden">查找</span><input type="search" data-role="table-search" data-table="player" placeholder="搜索名字或内容"></label>
            <p class="ssa-muted" data-role="table-status" data-table="player"></p>
            <div class="ssa-table-rows" data-role="table-rows" data-table="player"></div>
            <button class="ssa-secondary-button" type="button" data-action="add-table-row" data-table="player">添加一条</button>
          </article>
          <h3 class="ssa-section-title">偏好测试</h3>
          <p class="ssa-muted" data-role="taste-summary"></p>
          <div class="ssa-player-preference">
          <article class="ssa-advance-hero">
            <div class="ssa-hero-mark" aria-hidden="true">春</div>
            <div>
              <h2>偏好测试</h2>
              <p>10 道题和几项剧情体验，推进会按结果安排剧情。</p>
            </div>
          </article>

          <section class="ssa-preference-entry" data-role="preference-entry">
            <div>
              <strong>还没有玩家偏好档案</strong>
              <p>做一次测试，或直接按当前聊天分析。</p>
            </div>
            <div class="ssa-entry-actions">
              <button class="ssa-primary-button" type="button" data-action="open-preference-test">开始首次测试</button>
              <button class="ssa-secondary-button" type="button" data-action="skip-preference-quiz">跳过测试</button>
            </div>
          </section>
          <div class="ssa-result-card ssa-profile-card" data-role="preference-profile" hidden></div>
          </div>
        </section>
        <section class="ssa-page is-active" data-page="sending">
          <section class="ssa-setup" data-role="setup-card" hidden aria-label="连接整理接口">
            <h3 class="ssa-setup-title">先连上整理用的接口</h3>
            <p class="ssa-setup-note">春序每楼整理一次剧情，用这里的接口。连上之后就不用再管了。</p>
            <label>接口地址<input type="url" inputmode="url" autocomplete="off" placeholder="https://…/v1" data-setting="extraEndpoint"></label>
            <label>API Key<input type="password" autocomplete="new-password" placeholder="sk-…" data-secret="extraApiKey"></label>
            <label>模型<input type="text" list="ssa-extra-model-list" autocomplete="off" placeholder="填好上面两项后自动读取" data-setting="extraModel"></label>
            <p class="ssa-setup-error" data-role="setup-error" hidden></p>
            <div class="ssa-setup-actions">
              <button class="ssa-primary-button" type="button" data-action="setup-connect">连接</button>
              <button class="ssa-text-button" type="button" data-action="setup-skip">先用酒馆当前的 API</button>
            </div>
          </section>
          <section class="ssa-overview" data-role="overview" aria-label="当前状态" aria-live="polite"></section>
          <section class="ssa-push" data-role="push-card" aria-label="下一轮推进" hidden></section>
          <section class="ssa-round" data-role="prompt-viewer" aria-label="实际发出的提示词"></section>
          <div class="ssa-page-heading"><div><h2>全部发送记录</h2><p class="ssa-page-note">每次生成都单独记一条，重新生成的也在</p></div><button type="button" class="ssa-secondary-button" data-action="refresh-send-records">刷新</button></div>
          <div data-role="send-records"><p class="ssa-empty-state">还没有发送记录。下次在酒馆生成回复时自动记录。</p></div>
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
            <p>选完点“完成测试并生成分析”。</p>
            <p>结果用来调节互动多少、冲突强弱和新鲜感。</p>
          </div>
          <div class="ssa-quiz-questions">${preferenceQuizMarkup()}</div>
          <section class="ssa-test-section">
            <div class="ssa-section-heading">
              <div><p class="ssa-kicker">可多选</p><h2>想要的剧情体验</h2></div>
            </div>
            <p class="ssa-muted">和测试结果、你在聊天里说的话一起分析。</p>
            <div class="ssa-experience-grid">${storyExperienceMarkup()}</div>
          </section>
          <section class="ssa-test-section">
            <div class="ssa-section-heading">
              <div><p class="ssa-kicker">可多选</p><h2>喜欢的题材</h2></div>
            </div>
            <p class="ssa-muted">可以多选。</p>
            ${tasteMarkup().genres}
          </section>
          <section class="ssa-test-section">
            <div class="ssa-section-heading">
              <div><p class="ssa-kicker">单选，可不答</p><h2>口味</h2></div>
            </div>
            ${tasteMarkup().questions}
            <label>你的 MBTI（知道就选，不知道就跳过）
              <select data-setting="preferenceMbti">
                <option value="">不知道 / 不填</option>
                ${MBTI_TYPES.map((type) => `<option value="${type}">${type}</option>`).join('')}
              </select>
              <small>选你自己的类型，推进时参考。</small>
            </label>
          </section>
          <section class="ssa-test-section">
            <label>其他想要或需要避免的内容
              <textarea rows="3" data-setting="preferenceNotes" placeholder="例如：想要慢热友情；避免强制玩家表态。"></textarea>
            </label>
            <button class="ssa-primary-button ssa-wide-button" type="button" data-action="analyze-preferences">完成测试并生成分析</button>
            <p class="ssa-quiz-source">${PREFERENCE_QUIZ_SOURCE.note} <a href="${PREFERENCE_QUIZ_SOURCE.permissionUrl}" target="_blank" rel="noopener noreferrer">公共领域说明</a></p>
          </section>
        </section>

        <section class="ssa-page" data-page="settings">
          <div class="ssa-page-heading"><div><h2>设置</h2><p class="ssa-page-note">修改后自动保存</p></div></div>
<details class="ssa-settings-group" data-group="api"><summary><span>API 接口</span><small>整理用一个，向量用一个</small></summary><div class="ssa-group-body">          <article class="ssa-paper-card ssa-slot-card">
            <div class="ssa-slot-grid">
              <label>整理用
                <select data-setting="organizeProfileId"><option value="">酒馆当前 API</option></select>
                <small>每楼一次：摘要、人物物品、你的话、NPC</small>
              </label>
              <label>向量用
                <select data-setting="vectorProfileId"></select>
                <small>生成嵌入、查找往事</small>
              </label>
            </div>
          </article>
          <article class="ssa-paper-card ssa-api-editor">
            <p class="ssa-api-bar-label">编辑配置</p>
            <div class="ssa-api-profile-bar">
              <select data-api-profile="select" aria-label="选择配置"><option value="">默认配置</option></select>
              <button class="ssa-secondary-button" type="button" data-action="add-api-profile">新建</button>
              <button class="ssa-secondary-button" type="button" data-action="delete-api-profile">删除</button>
            </div>
            <div data-role="delete-api-confirm" hidden>
              <p>删除当前配置及其保存的密钥？</p>
              <div class="ssa-api-profile-actions">
                <button class="ssa-secondary-button" type="button" data-action="confirm-delete-api">确认删除</button>
                <button class="ssa-secondary-button" type="button" data-action="cancel-delete-api">取消</button>
              </div>
            </div>
            <label>名称
              <input type="text" autocomplete="off" placeholder="例如 主用接口" data-api-profile="name">
            </label>
            <label>接口地址
              <input type="url" autocomplete="off" inputmode="url" placeholder="https://…/v1" data-setting="extraEndpoint">
              <small>和酒馆里填的一样，填到 /v1 就行。</small>
            </label>
            <label>API Key
              <input type="password" autocomplete="new-password" placeholder="sk-…" data-secret="extraApiKey">
            </label>
            <label>模型
              <div class="ssa-input-action-row">
                <input type="text" list="ssa-extra-model-list" autocomplete="off" placeholder="填好地址和 Key 后自动读取" data-setting="extraModel">
                <button class="ssa-secondary-button" type="button" data-action="refresh-models">读取</button>
              </div>
              <datalist id="ssa-extra-model-list" data-role="extra-model-list"></datalist>
              <small data-role="model-list-status">填好地址和 Key 后自动读取可用模型。</small>
            </label>
            <label>嵌入模型（向量用）
              <input type="text" list="ssa-embedding-model-list" autocomplete="off" placeholder="例如 text-embedding-3-small" data-setting="recallEmbeddingModel">
              <datalist id="ssa-embedding-model-list" data-role="embedding-model-list"></datalist>
              <small>选为“向量用”的配置才需要填。</small>
            </label>
            <button class="ssa-secondary-button" type="button" data-action="test-extra-api">测试连接</button>
            <small class="ssa-muted">配置和密钥保存在这个浏览器里。</small>
          </article>

</div></details><details class="ssa-settings-group"><summary><span>外观</span><small>换一套色卡</small></summary><div class="ssa-group-body">
          <fieldset class="ssa-theme-picker">
            <legend class="ssa-visually-hidden">色卡</legend>
            ${UI_THEMES.map((theme) => `
            <label class="ssa-theme-option">
              <input type="radio" name="ssa-ui-theme" value="${theme.id}" data-setting="uiTheme">
              <span class="ssa-theme-swatches">${theme.colors.map((color) => `<i style="background:${color}"></i>`).join('')}</span>
              <span class="ssa-theme-name"><strong>${theme.name}</strong><small>${theme.note}</small></span>
            </label>`).join('')}
          </fieldset>
          <fieldset class="ssa-hero-picker">
            <legend>顶部图片</legend>
            ${HERO_ARTS.map((art) => `
            <label class="ssa-hero-option" data-art="${art.id}">
              <input type="radio" name="ssa-hero-art" value="${art.id}" data-setting="heroArt">
              <span class="ssa-hero-thumb"${art.url ? ` style="background-image:url('${art.url}')"` : ''}></span>
              <span class="ssa-theme-name"><strong>${art.name}</strong><small>${art.note}</small></span>
            </label>`).join('')}
          </fieldset>
          <label data-role="hero-url" hidden>图片链接
            <input type="url" data-setting="heroImageUrl" placeholder="https://… 填一张横图的地址">
          </label>
</div></details><details class="ssa-settings-group"><summary><span>自动记忆</span><small>什么时候整理新剧情，用哪个接口</small></summary><div class="ssa-group-body">
          <article class="ssa-paper-card">
            <p class="ssa-kicker">摘要与大总结</p>
            <h2>摘要方式</h2>
            <div class="ssa-summary-control-grid">
              <label>自动同步频率<select data-setting="memoryUpdateEvery"><option value="1">每轮回复</option><option value="2">每 2 轮</option><option value="3">每 3 轮</option><option value="5">每 5 轮</option></select></label>
              <label>积累多少内容后同步<input type="number" min="0" max="10000" step="100" data-setting="memoryMinTokens"><small>新内容攒到这么多 token 再整理；填 0 每楼都整理。</small></label>
            </div>
            <label>春序每轮最多带入（token）
              <input type="number" min="1000" max="1000000" step="1000" inputmode="numeric" data-setting="memoryTokenLimit">
              <small>每轮带入的玩家记录、剧情状态、小结和回忆总量，最多 1,000,000。超出时先少带回忆，再少带早期小结。</small>
            </label>
            <label>摘要格式（可选）
              <textarea rows="3" data-setting="summaryFormat" placeholder="留空用默认写法：谁在何时何地做了什么、结果如何，一两句。&#10;例：【时间｜地点】人物：做了什么 → 结果"></textarea>
              <small>每楼小结按这里的格式写，可以是模板，也可以是要求，比如“保留对白原话”“每条不超过 40 字”。</small>
              <span class="ssa-format-presets">
                <button type="button" class="ssa-text-button" data-action="summary-format-preset" data-format="">默认</button>
                <button type="button" class="ssa-text-button" data-action="summary-format-preset" data-format="【时间｜地点】人物：做了什么 → 结果">时间地点人物</button>
                <button type="button" class="ssa-text-button" data-action="summary-format-preset" data-format="一句话写清发生了什么；人物说过的关键台词用原话加引号保留。">保留原话</button>
                <button type="button" class="ssa-text-button" data-action="summary-format-preset" data-format="事件：…&#10;变化：人物关系、物品或状态的变化&#10;伏笔：留下的悬念（没有就省略）">事件／变化／伏笔</button>
              </span>
            </label>
            <label class="ssa-switch-row">
              <span class="ssa-switch-copy"><strong>自动记录新楼层</strong><small>新回复、编辑过或重新生成的楼层自动整理。</small></span>
              ${switchControlMarkup('autoSummarize', '自动记录新楼层')}
            </label>
            <label class="ssa-switch-row">
              <span class="ssa-switch-copy"><strong>自动整理旧楼层</strong><small>打开没整理过的聊天时，在后台分批补上旧楼层。</small></span>
              ${switchControlMarkup('autoBackfill', '自动整理旧楼层')}
            </label>
            <label>自动压缩阈值（token）
              <input type="number" min="1000" max="200000" step="1000" data-setting="rollupTokenLimit">
              <small>达到阈值后整理长期剧情。</small>
            </label>
          </article>

</div></details><details class="ssa-settings-group"><summary><span>剧情选项</span><small>回复末尾附几个下一步选项</small></summary><div class="ssa-group-body">
          <article class="ssa-paper-card">
            <p class="ssa-kicker">正文下方显示</p>
            <h2>选择选项的表达方式和数量</h2>
            <p class="ssa-muted">主模型写完正文后附上几个选项，显示成卡片，点一下填进输入框。</p>
            <label class="ssa-switch-row">
              <span class="ssa-switch-copy"><strong>剧情选项功能</strong><small>在回复末尾显示选项卡片。</small></span>
              ${switchControlMarkup('optionsEnabled', '剧情选项功能')}
            </label>
            <div class="ssa-slot-editor">
              <div class="ssa-slot-editor-head">
                <span>选项类别</span>
                <small data-role="option-slot-total"></small>
              </div>
              <p class="ssa-muted">名字、数量和要求都可以改，一共最多 12 个，按从上到下的顺序出现。</p>
              <div data-role="option-slots"></div>
              <div class="ssa-slot-actions">
                <button class="ssa-secondary-button" type="button" data-action="add-option-slot">添加一类</button>
                <span class="ssa-format-presets">从预设开始：
                  ${[4, 6, 8, 12].map((count) => `<button type="button" class="ssa-text-button" data-action="option-preset" data-count="${count}">${count} 个</button>`).join('')}
                </span>
              </div>
            </div>
            <label class="ssa-switch-row">
              <span class="ssa-switch-copy"><strong>用正则美化显示</strong><small>在酒馆正则里加三条“春序 · 剧情选项”脚本，负责排成卡片、发送时去掉选项。样式可以在正则面板里改。</small></span>
              ${switchControlMarkup('optionRegexEnabled', '用正则美化显示')}
            </label>
            <button class="ssa-secondary-button" type="button" data-action="reset-option-regex">恢复默认美化正则</button>
            <label>所有选项都要遵守的要求
              <textarea rows="3" data-setting="optionWritingNotes" placeholder="每行一条。留空就不加通用要求。"></textarea>
              <small>选项块的格式由插件加上。</small>
            </label>
          </article>
</div></details><details class="ssa-settings-group" data-group="cliche"><summary><span>八股删除器</span><small>回复里的套话自动删改，可以撤销</small></summary><div class="ssa-group-body">
          <article class="ssa-paper-card">
            <label class="ssa-switch-row">
              <span class="ssa-switch-copy"><strong>清理回复里的八股</strong><small>删掉“命运的齿轮”“比哭还难看”“说实话，”这类套话。填充词直接删，整句套话在整理时改写。</small></span>
              ${switchControlMarkup('clicheEnabled', '清理回复里的八股')}
            </label>
            <fieldset class="ssa-mode-fieldset">
              <legend>处理方式</legend>
              <div class="ssa-mode-options">
                <label><input type="radio" name="ssa-cliche-mode" value="auto" data-setting="clicheMode"><span>直接清理（可撤销）</span></label>
                <label><input type="radio" name="ssa-cliche-mode" value="mark" data-setting="clicheMode"><span>只标出来</span></label>
              </div>
            </fieldset>
            <p class="ssa-muted">每条回复下面显示删改了几处，点“撤销”恢复原文。</p>
            <label>自己加的规则
              <textarea rows="4" data-setting="clicheCustomRules" placeholder="每行一条。&#10;删:总而言之    本地直接删&#10;改:眸光        交给整理 API 改写&#10;标:叹了口气    只标出来&#10;/眸[光色]/      斜杠包起来是正则"></textarea>
              <small>内置 ${DEFAULT_CLICHE_RULES.length} 条规则来自“八股”清单，“似乎”“一丝”这类常用词，一条回复里反复出现才算。</small>
            </label>
          </article>
        </div></details><details class="ssa-settings-group"><summary><span>自主推进</span><small>每轮安排一件推动剧情的事</small></summary><div class="ssa-group-body">

          <article class="ssa-paper-card ssa-advance-card">
            <p class="ssa-kicker">自主推进剧情</p>
            <h2>后台推进</h2>
            <label class="ssa-switch-row">
              <span class="ssa-switch-copy"><strong>开启自主推进</strong><small>整理时安排下一轮推什么，随回复一起发出。首页可以改、换一个或跳过。</small></span>
              ${switchControlMarkup('autoAdvanceEnabled', '自主推进剧情')}
            </label>
            <label>推进力度
              <select data-setting="advanceStrength">
                <option value="light">轻：回应之后加一两句变化</option>
                <option value="normal">中：不超过一个场景（默认）</option>
                <option value="strong">强：让一件事真正发生</option>
              </select>
            </label>
            <fieldset class="ssa-advance-modules">
              <legend>推进方式（可多选）</legend>
              ${ADVANCE_MODULES.map((module) => `
              <label class="ssa-advance-module">
                <input type="checkbox" data-advance-module="${module.id}">
                <span><strong>${module.label}</strong><small>${module.description}</small></span>
              </label>`).join('')}
            </fieldset>
            <label>自定义事件池
              <textarea rows="3" data-setting="advanceEventPool" placeholder="每行一件可能发生的事，勾选“自定义事件池”后生效。&#10;例：门外有人敲门&#10;旧宅突然停电"></textarea>
            </label>
            <p class="ssa-notice">每轮挑一两种方式，最近用过的先轮空。做过偏好测试会参考你的题材口味。</p>
          </article>
          
        </div></details><details class="ssa-settings-group"><summary><span>NPC</span><small>按剧情需要自动建立配角档案</small></summary><div class="ssa-group-body">
          <article class="ssa-paper-card ssa-npc-archive-intro">
            <p class="ssa-kicker">当前聊天</p>
            <h2>NPC 人物档案</h2>
            <p class="ssa-muted">按剧情需要建立配角：年龄、职业、经历和目标，用经历解释性格。</p>
            <label class="ssa-switch-row">
              <span class="ssa-switch-copy"><strong>按剧情需要自动建档与更新</strong><small>剧情需要新人物时自动建档，人物成长时更新。</small></span>
              ${switchControlMarkup('autoNpcEnabled', 'NPC 自动建档与更新')}
            </label>
            <label>补充要求（可选）
              <textarea rows="3" data-setting="npcBrief" placeholder="可补充必须遵守的世界观事实或需要避开的设定；人物的剧情功能由 AI 判断。"></textarea>
            </label>
            <button class="ssa-primary-button ssa-wide-button" type="button" data-action="generate-npc">立即生成 NPC 并存入档案</button>
          </article>
</div></details><details class="ssa-settings-group" data-group="advanced"><summary><span>高级</span><small>发送范围、压缩阈值和向量回忆</small></summary><div class="ssa-group-body">


          <article class="ssa-summary-controls-card">
            <h2>让 AI 读取剧情总摘要</h2>
            <label class="ssa-switch-row">
              <span class="ssa-switch-copy"><strong>每次回复前发送总摘要</strong><small>回复前带上剧情总摘要和当前状态。</small></span>
              ${switchControlMarkup('summaryContextEnabled', '每次回复前发送总摘要')}
            </label>
            <label class="ssa-switch-row">
              <span class="ssa-switch-copy"><strong>过滤已摘要的旧楼层原文</strong><small>只发最近 5 楼原文，更早的用摘要代替。聊天记录本身不变。</small></span>
              ${switchControlMarkup('filterArchivedFloors', '过滤已摘要的旧楼层原文')}
            </label>
            <p class="ssa-muted" data-role="story-context-status" role="status">等待下次回复前读取剧情总摘要</p>
          </article>
          <article class="ssa-summary-controls-card">
            <div>
              <p class="ssa-kicker">自动整理</p>
              <h2>摘要压缩与楼层显示</h2>
            </div>
            <div class="ssa-summary-control-grid">
              <label>自动压缩阈值（token）
                <input type="number" min="1000" max="200000" step="1000" data-setting="rollupTokenLimit">
                <small>总摘要到这个长度或每满 100 楼时压缩一次。</small>
              </label>
              <label>默认展开最近楼层
                <select data-setting="expandedFloorCount">
                  <option value="3">最近 3 楼</option>
                  <option value="5">最近 5 楼</option>
                  <option value="10">最近 10 楼</option>
                </select>
                <small>更早的楼层折叠显示。</small>
              </label>
              <label class="ssa-summary-remote-control">发送给剧情辅助接口的历史原文
                <select data-setting="remoteRawFloorLimit">
                  <option value="0">不发送历史原文</option>
                  <option value="1">最近 1 楼</option>
                  <option value="3">最近 3 楼</option>
                  <option value="5">最近 5 楼</option>
                </select>
                <small>整理时发给接口的上下文范围。</small>
              </label>
            </div>
          </article>

          <article class="ssa-paper-card ssa-recall-card" data-role="recall-card">
            <p class="ssa-kicker">找回相关往事</p>
            <h2>回忆</h2>
            <label>回忆方式
              <select data-setting="recallMode">
                <option value="auto">自动（默认）：配了嵌入接口就用向量，没配就用关键词</option>
                <option value="keyword">只用关键词（不需要接口）</option>
                <option value="vector">只用向量（失败时临时改用关键词）</option>
                <option value="off">关闭</option>
              </select>
              <small>回复前从旧楼层里找出和眼下有关的几段一起发送。关键词方式按人名、物品、地点匹配；向量方式按意思找，需要配好“向量用”接口。</small>
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

</div></details>        </section>
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
        <span data-role="status" role="status">本地档案待命</span>
        <span>档案保存在这个浏览器</span>
      </footer>
    </section>
  `;
  document.body.append(root);
  bindLauncherSwipe(root);
  watchHeroScroll(root);
  renderHero(root, {});
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

// Used by the player profile and NPC cards; strings and empty values are tolerated
// because older saved profiles store some of these fields as plain text.
function appendResultList(parent, title, items) {
  const list = Array.isArray(items) ? items.filter(Boolean) : items ? [String(items)] : [];
  const group = makeFactGroup(title, list);
  if (group) parent.append(group);
}

function makeFloorCard(record, expanded) {
  const article = document.createElement('details');
  article.className = `ssa-floor-card is-${record.status}${record.isUser ? ' is-player' : ''}`;
  article.dataset.floor = String(record.floorIndex);
  article.open = expanded;
  const header = document.createElement('summary');
  header.className = 'ssa-floor-header';
  const title = document.createElement('div');
  title.innerHTML = `<span class="ssa-floor-number">${record.floorIndex + 1}</span><div><p>第 ${record.floorIndex + 1} 楼 · ${record.isUser ? '玩家输入' : '角色回复'}</p><small>${record.status === 'skipped' ? '操作指令 · 本地保留' : record.status === 'ready' ? '剧情已入档' : record.status === 'processing' ? '正在更新记忆' : record.status === 'failed' ? '整理失败' : '等待入档'}</small></div>`;
  header.append(title);
  const badge = document.createElement('span');
  badge.className = 'ssa-state-badge';
  badge.textContent = record.status === 'skipped' ? '免总结' : record.status === 'ready' ? (record.inputComplete === true ? '已摘要' : '待核对覆盖') : record.status === 'processing' ? '处理中' : record.status === 'failed' ? '失败' : '缺失';
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
  if (record.status !== 'skipped') content.append(body);

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

  if (!['processing', 'skipped'].includes(record.status)) {
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
  const skippedCount = snapshot.summaries.filter((record) => record.status === 'skipped').length;
  root.querySelector('[data-role="rollup-floor"]').textContent = `已摘要 ${rollup?.readyFloors ?? 0} / ${(snapshot.totalFloors ?? snapshot.summaries.length) - skippedCount} 楼${skippedCount ? ` · ${skippedCount} 条操作指令免总结` : ''}`;
  root.querySelector('[data-role="rollup-token"]').textContent = `约 ${rollup?.tokenEstimate ?? 0} token`;
  const missingCount = snapshot.summaries.filter((record) => ['missing', 'failed'].includes(record.status) || (record.status === 'ready' && (record.inputComplete !== true || record.memoryVersion !== 1))).length;
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
    if (npc.surprise) appendResultList(card, '意外之处', [npc.surprise]);
    appendResultList(card, '对人对事的看法', npc.opinions);
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
  if (['options', 'advance'].includes(legacy)) {
    const label = legacy === 'options' ? '剧情选项' : '自主推进';
    for (const group of root.querySelectorAll('.ssa-settings-group')) if (group.firstElementChild.textContent.startsWith(label)) group.open = true;
  }
  const main = root.querySelector('.ssa-main');
  if (main) main.scrollTop = 0;
  root.classList.remove('is-hero-compact');
  renderHero(root, { tab });
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

export const UI_THEMES = [
  { id: 'chunlai', name: '春来', note: '跟随春来美化主题', colors: ['#3b584b', '#52796c', '#819b85', '#c3c0aa', '#efeada'] },
  { id: 'dew', name: '晨雾', note: '雾蓝与松绿', colors: ['#22393c', '#46707e', '#6b8b81', '#afbb98', '#cecdb9'] },
  { id: 'sprout', name: '新芽', note: '浅嫩的春绿', colors: ['#55703d', '#9db476', '#bbcca0', '#d0ddbb', '#f2f8ec'] },
  { id: 'celadon', name: '宋瓷青绿', note: '青瓷与素绢', colors: ['#2e6a67', '#5e8c87', '#a9c8be', '#d7e6db', '#f1f0e8'] },
  { id: 'willow', name: '柳岸', note: '莫奈的水边柳色', colors: ['#314c35', '#356b43', '#74b16c', '#bddd43', '#f9f7ee'] },
  { id: 'bamboo', name: '竹林', note: '竹影与暖米色', colors: ['#2d4c34', '#4a6a3d', '#79933d', '#bac882', '#e2ded3'] },
  { id: 'cliff', name: '海崖', note: '草绿加一点海蓝', colors: ['#2a472f', '#839d45', '#92ab76', '#77aad7', '#e8e9c0'] },
];

export function syncSettings(root, settings, apiKey = '') {
  applyHeroArt(root, settings);
  const heroUrl = root.querySelector('[data-role="hero-url"]');
  if (heroUrl) heroUrl.hidden = settings.heroArt !== 'custom';
  root.dataset.ssaTheme = UI_THEMES.some((theme) => theme.id === settings.uiTheme) ? settings.uiTheme : 'chunlai';
  for (const input of root.querySelectorAll('[data-setting]')) {
    const key = input.dataset.setting;
    const value = settings[key];
    if (input.type === 'checkbox') input.checked = Boolean(value);
    else if (input.type === 'radio') input.checked = input.value === String(value ?? '');
    else if (document.activeElement !== input) input.value = String(value ?? '');
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
  const genres = new Set(settings.preferenceGenres ?? []);
  for (const input of root.querySelectorAll('[data-genre-id]')) input.checked = genres.has(input.dataset.genreId);
  for (const input of root.querySelectorAll('[data-taste-id]')) input.checked = settings.preferenceTastes?.[input.dataset.tasteId] === input.value;
  const tasteSummary = root.querySelector('[data-role="taste-summary"]');
  if (tasteSummary) tasteSummary.textContent = settings.tasteLine || '还没选题材和口味。点“开始首次测试”可以补上，不做也不影响使用。';
  const modules = new Set(settings.advanceModules ?? []);
  for (const input of root.querySelectorAll('[data-advance-module]')) input.checked = modules.has(input.dataset.advanceModule);
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

// SillyTavern themes change the top bar's height, so measure it on open.
function measureTopBar(root) {
  const bar = document.querySelector('#top-bar');
  const bottom = bar ? Math.round(bar.getBoundingClientRect().bottom) : 0;
  if (bottom > 0 && bottom < window.innerHeight / 3) root.style.setProperty('--ssa-top', `${bottom + 4}px`);
  else root.style.removeProperty('--ssa-top');
}

export function setOpen(root, open) {
  if (open) {
    setLauncherDocked(root, false);
    measureTopBar(root);
    const app = root.querySelector('.ssa-app');
    app.classList.remove('is-entering');
    void app.offsetWidth;
    app.classList.add('is-entering');
    app.addEventListener('animationend', () => app.classList.remove('is-entering'), { once: true });
  }
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
  const legacy = tab;
  tab = ({summary:'database', options:'settings', advance:'settings', npc:'people'})[tab] ?? tab;
  const subpage = tab === 'preference-test';
  root.classList.toggle('is-subpage', subpage);
  for (const button of root.querySelectorAll('[data-tab]')) button.classList.toggle('is-active', button.dataset.tab === tab);
  for (const page of root.querySelectorAll('[data-page]')) page.classList.toggle('is-active', page.dataset.page === tab);
  if (['options', 'advance'].includes(legacy)) {
    const label = legacy === 'options' ? '剧情选项' : '自主推进';
    for (const group of root.querySelectorAll('.ssa-settings-group')) if (group.firstElementChild.textContent.startsWith(label)) group.open = true;
  }
  const main = root.querySelector('.ssa-main');
  if (main) main.scrollTop = 0;
  root.classList.remove('is-hero-compact');
  renderHero(root, { tab });
}
