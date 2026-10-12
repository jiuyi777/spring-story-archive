import test from 'node:test';
import assert from 'node:assert/strict';
import { API_PROFILES_KEY, openApiProfiles } from '../core/api-profiles.js';
import { createProvider } from '../core/api-client.js';
import { createMemoryStorage } from '../core/storage.js';
import { SemanticRecallService } from '../core/semantic-recall.js';

function webStorage() {
  const data = new Map();
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: (key) => data.delete(key) };
}

test('migrates the original connection once and restores multiple complete profiles after reopening', () => {
  const storage = webStorage(), session = webStorage();
  session.setItem('spring-story-archive:extra-api-key', 'demo-original');
  const legacy = { extraEndpoint: 'https://a.invalid/v1/chat/completions', extraModel: 'model-a', recallEmbeddingModel: 'embed-a' };
  const store = openApiProfiles({ storage, session, legacy });
  const original = store.active();
  assert.equal(original.apiKey, 'demo-original');
  assert.equal(session.getItem('spring-story-archive:extra-api-key'), null);
  store.add();
  assert.equal(store.active().apiKey, '');
  store.update({ name: '备用', endpoint: 'https://b.invalid/v1/chat/completions', model: 'model-b', apiKey: 'demo-b', embeddingModel: 'embed-b' });
  const second = store.active();
  const reopened = openApiProfiles({ storage, session, legacy });
  assert.deepEqual(reopened.active(), second);
  reopened.select(original.id);
  assert.deepEqual(reopened.active(), original);
  reopened.select(second.id);
  reopened.remove();
  assert.deepEqual(reopened.active(), original);
  assert.equal(storage.getItem(API_PROFILES_KEY).includes('demo-b'), false);
  reopened.remove();
  assert.equal(reopened.list().length, 1);
  assert.equal(reopened.active().apiKey, '');
  assert.equal(openApiProfiles({ storage, session, legacy }).active().endpoint, '');
});

test('failed persistence preserves the selected profile and original session key', () => {
  const storage = webStorage(), session = webStorage();
  session.setItem('spring-story-archive:extra-api-key', 'demo-original');
  const writable = storage.setItem;
  storage.setItem = () => { throw new Error('quota'); };
  assert.throws(() => openApiProfiles({ storage, session }), /未能保存/);
  assert.equal(session.getItem('spring-story-archive:extra-api-key'), 'demo-original');
  storage.setItem = writable;
  const store = openApiProfiles({ storage, session });
  const before = store.active();
  storage.setItem = () => { throw new Error('quota'); };
  assert.throws(() => store.update({ apiKey: 'replacement' }), /未能保存/);
  assert.deepEqual(store.active(), before);
});

test('corrupt saved data is reported without overwriting it', () => {
  const storage = webStorage();
  storage.setItem(API_PROFILES_KEY, '{broken');
  assert.throws(() => openApiProfiles({ storage }), /原数据已保留/);
  assert.equal(storage.getItem(API_PROFILES_KEY), '{broken');
});

test('outgoing requests use the selected endpoint, model and matching key', async () => {
  const store = openApiProfiles({ storage: webStorage() });
  store.update({ endpoint: 'https://a.invalid/v1/chat/completions', model: 'a', apiKey: 'demo-a' });
  const first = store.active();
  store.add();
  store.update({ endpoint: 'https://b.invalid/v1/chat/completions', model: 'b', apiKey: 'demo-b' });
  const second = store.active();
  const calls = [];
  for (const profile of [first, second, first]) {
    store.select(profile.id);
    const provider = createProvider({ source: 'extra', extra: { ...store.active(), fetchImpl: async (url, init) => {
      calls.push({ url, model: JSON.parse(init.body).model, authorization: init.headers.Authorization });
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'OK' } }] }) };
    } } });
    await provider({ messages: [], maxTokens: 20 });
  }
  assert.deepEqual(calls, [first, second, first].map((profile) => ({ url: profile.endpoint, model: profile.model, authorization: `Bearer ${profile.apiKey}` })));
});

test('same embedding model on a different profile rebuilds vectors; stale responses are discarded', async (t) => {
  const storage = createMemoryStorage();
  let credentials = { profileId: 'a', endpoint: 'https://a.invalid/v1/chat/completions', embeddingModel: 'embed', apiKey: 'demo-a' };
  const service = new SemanticRecallService({ storage, getCredentials: () => ({ ...credentials }) });
  const summary = { floorIndex: 0, status: 'ready', summary: 'summary', messageFingerprint: 'fp' };
  let calls = 0;
  let switchDuringRequest = false;
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    if (switchDuringRequest) credentials = { ...credentials, profileId: 'c' };
    return { ok: true, json: async () => ({ data: [{ index: 0, embedding: [1, 0] }] }) };
  });
  await service.sync('chat', [summary]);
  await service.sync('chat', [summary]);
  assert.equal(calls, 1);
  credentials = { ...credentials, profileId: 'b', endpoint: 'https://b.invalid/v1/chat/completions' };
  const vectors = await service.sync('chat', [summary]);
  assert.equal(calls, 2);
  assert.equal(vectors[0].profileId, 'b');
  switchDuringRequest = true;
  await assert.rejects(service.sync('chat', [summary], { force: true }), /配置已变化/);
  assert.equal((await storage.listVectors('chat'))[0].profileId, 'b');
});
