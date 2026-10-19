import test from 'node:test';
import assert from 'node:assert/strict';
import { chatCompletionsUrl, apiBaseUrl, callOpenAiCompatible } from '../core/api-client.js';

test('the address SillyTavern takes works, as does the full one', () => {
  assert.equal(chatCompletionsUrl('https://api.commandcode.ai/provider/v1'), 'https://api.commandcode.ai/provider/v1/chat/completions');
  assert.equal(chatCompletionsUrl('https://x.com/v1/'), 'https://x.com/v1/chat/completions');
  assert.equal(chatCompletionsUrl('https://x.com/v1/chat/completions'), 'https://x.com/v1/chat/completions');
  assert.equal(apiBaseUrl('https://x.com/v1/chat/completions'), 'https://x.com/v1');
});

test('a request the browser cannot make goes through SillyTavern with the key as a header', async () => {
  let sent = null;
  const reply = { choices: [{ message: { content: 'OK' } }] };
  const text = await callOpenAiCompatible({
    endpoint: 'https://api.example.com/v1', apiKey: 'sk-1', model: 'm', messages: [{ role: 'user', content: 'hi' }],
    fetchImpl: async () => { throw new TypeError('Failed to fetch'); },
    proxy: async (url, init) => { sent = { url, body: JSON.parse(init.body) }; return new Response(JSON.stringify(reply), { status: 200 }); },
  });
  assert.equal(text, 'OK');
  assert.equal(sent.url, '/api/backends/chat-completions/generate');
  assert.equal(sent.body.chat_completion_source, 'custom');
  assert.equal(sent.body.custom_url, 'https://api.example.com/v1');
  assert.equal(sent.body.custom_include_headers, 'Authorization: "Bearer sk-1"');
  assert.equal(sent.body.stream, false);
});

test('a real error from the API is reported, not retried elsewhere', async () => {
  let proxied = false;
  await assert.rejects(callOpenAiCompatible({
    endpoint: 'https://api.example.com/v1', model: 'm', messages: [],
    fetchImpl: async () => new Response('{"message":"bad key"}', { status: 401 }),
    proxy: async () => { proxied = true; },
  }), /401/);
  assert.equal(proxied, false);
});

test('the big summary follows the custom format and has room to write', async () => {
  const { requestCompression } = await import('../core/api-client.js');
  const seen = [];
  const result = await requestCompression(async (request) => { seen.push(request); return JSON.stringify({ summary: '【主线】雨夜，林栀拉着猫头鹰去甜品店。', timeline: [], characters: [], relationships: [], clues: [], continuityRules: [] }); },
    '林栀与猫头鹰在长椅上。林栀带猫头鹰去甜品店。', 3, { format: '分成【主线】【人物关系】两段' });
  assert.match(seen[0].messages[0].content, /summary 字段按指定的格式写.*分成【主线】【人物关系】两段/);
  assert.ok(seen[0].maxTokens >= 4000);
  assert.match(result.summary, /【主线】/);
  const plain = [];
  await requestCompression(async (request) => { plain.push(request); return JSON.stringify({ summary: 'x' }); }, '甲', 1);
  assert.doesNotMatch(plain[0].messages[0].content, /按指定的格式写/);
});
