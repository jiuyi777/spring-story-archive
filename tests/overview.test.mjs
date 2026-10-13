import test from 'node:test';
import assert from 'node:assert/strict';
import { recallSummary } from '../ui/overview-view.js';

test('recall row: keyword works without any API; vector without an API says it falls back', () => {
  assert.match(recallSummary({ recallMode: 'keyword' }, null).text, /关键词回忆/);
  assert.equal(recallSummary({ recallMode: 'off' }, null).action, 'goto-recall');
  const vectorNoApi = recallSummary({ recallMode: 'vector' }, null);
  assert.equal(vectorNoApi.action, 'goto-api');
  assert.match(vectorNoApi.text, /先用关键词回忆/);
});

test('recall row reports what happened, including a fallback', () => {
  assert.match(recallSummary({ recallMode: 'vector' }, { phase: 'injected', mode: 'vector', recalledFloors: [1, 2] }).text, /向量回忆，这次找回了 2 段/);
  const fell = recallSummary({ recallMode: 'vector' }, { phase: 'injected', mode: 'keyword', recalledFloors: [1], note: '向量回忆失败' });
  assert.match(fell.text, /关键词回忆.*向量回忆失败/);
  assert.equal(fell.tone, 'warning');
});

test('auto recall picks vectors only when an embedding interface is set', () => {
  assert.match(recallSummary({ recallMode: 'auto' }, null).text, /自动：关键词/);
  assert.match(recallSummary({ recallMode: 'auto', vectorEndpoint: 'https://x', vectorEmbeddingModel: 'emb' }, null).text, /自动：向量/);
});
