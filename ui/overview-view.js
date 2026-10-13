// Home page figures under the picture: how far the archive is organized, what
// needs the player, and what recall found. A figure needing action is a button.
let last = { summaries: [], sends: [], settings: {}, recall: null };

const make = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const SEND_STATE = { prepared: '正在准备', verified: '等待模型回复', received: '已收到回复', stopped: '被停止', ended: '没有确认收到回复', interrupted: '没有确认收到回复' };

export function recallSummary(settings, recall) {
  const mode = settings.recallMode ?? (settings.semanticRecallEnabled ? 'vector' : 'off');
  if (mode === 'off') return { text: '已关闭', tone: 'muted', action: 'goto-recall', actionLabel: '去开启' };
  if (recall?.error) return { text: `出错：${recall.error}`, tone: 'error', action: 'goto-recall', actionLabel: '查看' };
  const way = recall?.mode === 'vector' ? '向量' : '关键词';
  const ready = Boolean(String(settings.vectorEndpoint ?? settings.extraEndpoint ?? '').trim() && String(settings.vectorEmbeddingModel ?? settings.recallEmbeddingModel ?? '').trim());
  const found = recall?.recalledFloors?.length ?? 0;
  const note = recall?.note ? `（${recall.note}）` : '';
  if (recall?.phase === 'injected') return { text: `${way}回忆，这次找回了 ${found} 段相关往事${note}`, tone: recall?.note ? 'warning' : 'ok' };
  if (recall?.phase === 'preparing') return { text: `${way}回忆，正在查找`, tone: 'busy' };
  if (recall?.phase === 'empty') return { text: `${way}回忆，这次没有找到相关往事${note}`, tone: recall?.note ? 'warning' : 'ok' };
  if (mode === 'vector') {
    const endpoint = settings.vectorEndpoint ?? settings.extraEndpoint;
    const model = settings.vectorEmbeddingModel ?? settings.recallEmbeddingModel;
    if (!String(endpoint ?? '').trim() || !String(model ?? '').trim()) return { text: '选了向量，但“向量用”的接口还没配好，先用关键词回忆', tone: 'warning', action: 'goto-api', actionLabel: '去设置' };
    return { text: '向量回忆，下次回复时自动查找', tone: 'ok' };
  }
  if (mode === 'auto') return { text: ready ? '自动：向量回忆，下次回复时查找' : '自动：关键词回忆，下次回复时查找', tone: 'ok' };
  return { text: '关键词回忆，下次回复时自动查找', tone: 'ok' };
}

function features(settings) {
  const on = [
    settings.optionsEnabled && '剧情选项',
    settings.autoAdvanceEnabled && '剧情推进',
    settings.autoNpcEnabled && 'NPC 建档',
  ].filter(Boolean);
  return on.length ? `已开 ${on.join('、')}` : '选项、推进、NPC 都没开';
}

// One figure with a short caption; a figure that needs the player is a button.
function stat(value, unit, caption, { tone = 'normal', action } = {}) {
  const node = make(action ? 'button' : 'div', 'ssa-stat');
  if (action) { node.type = 'button'; node.dataset.action = action; }
  node.dataset.tone = tone;
  const figure = make('span', 'ssa-stat-value', value);
  if (unit) figure.append(make('small', '', unit));
  node.append(figure, make('span', 'ssa-stat-caption', caption));
  return node;
}

function memoryStats(summaries) {
  const counted = summaries.filter((record) => record.status !== 'skipped');
  const ready = counted.filter((record) => record.status === 'ready');
  const latest = ready.length ? Math.max(...ready.map((record) => record.floorIndex)) + 1 : 0;
  const first = latest ? stat(String(latest), '楼', '已整理') : stat('—', '', counted.length ? '还没整理好' : '开始聊天后自动整理', { tone: 'muted' });
  const failed = counted.filter((record) => record.status === 'failed').length;
  const busy = counted.filter((record) => record.status === 'processing').length;
  const waiting = counted.filter((record) => !['ready', 'failed', 'processing'].includes(record.status)).length;
  if (failed) return [first, stat(String(failed), '楼', '失败 · 点此重试', { tone: 'error', action: 'backfill' })];
  if (busy) return [first, stat(String(busy), '楼', '正在整理', { tone: 'busy' })];
  if (waiting) return [first, stat(String(waiting), '楼', '待整理 · 点此整理', { tone: 'warning', action: 'backfill' })];
  return [first, null];
}

function lastSendText(sends) {
  const latest = [...sends].sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  if (!latest) return { text: '还没有发送记录', count: null };
  const memories = latest.memories?.length ?? 0;
  return { text: `上一次：第 ${latest.targetFloor} 楼${latest.type === 'swipe' ? '重新生成' : ''}，${SEND_STATE[latest.status] ?? '状态未知'}`, count: memories, tone: latest.status === 'received' ? 'ok' : ['ended', 'interrupted'].includes(latest.status) ? 'error' : 'normal' };
}

function recallStat(settings, recall) {
  const summary = recallSummary(settings, recall);
  if (summary.tone === 'muted') return stat('关', '', '回忆没开 · 去开', { tone: 'muted', action: summary.action });
  if (summary.tone === 'error') return stat('出错', '', '回忆出错 · 查看', { tone: 'error', action: summary.action });
  if (recall?.phase === 'injected' || recall?.phase === 'empty') return stat(String(recall.recalledFloors?.length ?? 0), '段', '这次找回的旧事', { tone: summary.tone });
  return stat('待', '', recall?.mode === 'vector' || /向量/.test(summary.text) ? '下次回复时向量查找' : '下次回复时查找', summary);
}

export function renderOverview(root, update = {}) {
  last = { ...last, ...update };
  const box = root.querySelector('[data-role="overview"]');
  if (!box) return;
  const [memory, issue] = memoryStats(last.summaries ?? []);
  const send = lastSendText(last.sends ?? []);
  const middle = issue ?? (send.count === null ? stat('—', '', '还没发送过', { tone: 'muted' }) : stat(String(send.count), '条', '上次带入的记忆'));
  const stats = make('div', 'ssa-stats');
  stats.append(memory, middle, recallStat(last.settings ?? {}, last.recall));
  const note = make('p', 'ssa-overview-note');
  note.dataset.tone = send.tone ?? 'normal';
  note.append(make('span', '', send.text), make('span', '', features(last.settings ?? {})));
  box.replaceChildren(stats, note);
}
