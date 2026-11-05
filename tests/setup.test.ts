import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { DEFAULT_CONFIG, parseConfig } from '../electron/config';
import { modelPrepared } from '../electron/model-files';
import { SecretStore } from '../electron/secrets';
import { translate } from '../electron/ollama';

test('old user config keeps custom Ollama and ASR while acquiring language/provider defaults', () => {
  const input = { ollama: { ...DEFAULT_CONFIG.ollama, model: 'user-model', baseUrl: 'http://localhost:11435' }, asr: { ...DEFAULT_CONFIG.asr, modelPath: 'D:/custom/model' } };
  const result = parseConfig(input);
  assert.deepEqual(result.ollama, input.ollama); assert.equal(result.asr.modelPath, input.asr.modelPath);
  assert.deepEqual(result.languages, { source: 'ja', target: 'zh-CN' });
  assert.equal(result.translation.provider, 'ollama');
  for (const languages of [{ source: 'auto', target: 'en' }, { source: 'en', target: 'ja' }]) assert.deepEqual(parseConfig({ ...input, languages }).languages, languages);
  assert.throws(() => parseConfig({ ...input, languages: { source: 'invalid', target: 'en' } }));
  assert.throws(() => parseConfig({ ...input, translation: { provider: 'compatible', compatible: { baseUrl: 'http://remote.example/v1', model: 'demo' } } }));
});
test('existing nonempty CTranslate2 model is reusable without download marker; partial files are rejected', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'kotoba-model-'));
  try {
    assert.equal(modelPrepared(dir), false);
    for (const file of ['config.json', 'model.bin', 'tokenizer.json', 'vocabulary.json']) writeFileSync(path.join(dir, file), 'fixture');
    assert.equal(modelPrepared(dir), true);
    writeFileSync(path.join(dir, 'model.bin'), ''); assert.equal(modelPrepared(dir), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('secret storage encrypts at rest, binds keys to endpoint, and refuses insecure storage', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'kotoba-secret-'));
  const file = path.join(dir, 'credentials.bin');
  const crypto = { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(Buffer.from(s).map(b => b ^ 0xa5)), decryptString: (b: Buffer) => Buffer.from(Buffer.from(b).map(v => v ^ 0xa5)).toString() };
  try {
    const store = new SecretStore(file, crypto); store.set('https://one.test/v1', 'test-secret');
    assert.equal(readFileSync(file).includes(Buffer.from('test-secret')), false);
    assert.equal(store.get('https://one.test/v1'), 'test-secret'); assert.equal(store.get('https://two.test/v1'), '');
    store.set('https://one.test/v1', ''); assert.equal(store.get('https://one.test/v1'), '');
    assert.throws(() => new SecretStore(file, { ...crypto, isEncryptionAvailable: () => false }).set('x', 'secret'), /加密不可用/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('compatible API uses chosen languages, bounded context, optional bearer, and safe error messages', async () => {
  let payload: any; let authorization: string | undefined; let status = 200;
  const server = createServer((req, res) => {
    assert.equal(req.url, '/v1/chat/completions'); authorization = req.headers.authorization;
    let text = ''; req.on('data', c => { text += c; }); req.on('end', () => {
      payload = JSON.parse(text); res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(status === 200 ? { choices: [{ message: { content: 'Hello' } }] } : { error: 'test-secret MUST NOT LEAK' }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const baseUrl = `http://127.0.0.1:${(server.address() as any).port}/v1`;
    const config = parseConfig({ ...DEFAULT_CONFIG, languages: { source: 'auto', target: 'en' }, translation: { provider: 'compatible', compatible: { baseUrl, model: 'mock-model', timeoutMs: 1000 } } });
    const context = Array.from({ length: 5 }, () => ({ japanese: 'a', chinese: 'b' }));
    assert.equal(await translate(config, 'こんにちは', context, new AbortController().signal, 'test-secret', 'ja'), 'Hello');
    assert.equal(authorization, 'Bearer test-secret'); assert.equal(payload.model, 'mock-model'); assert.equal(payload.messages.length, 6);
    assert.match(payload.messages[0].content, /English/); assert.match(payload.messages[0].content, /代码为 ja/);
    assert.equal(payload.stream, false); assert.equal(payload.max_tokens, 384); assert.equal(payload.keep_alive, undefined);
    await translate(config, 'bonjour', [], new AbortController().signal); assert.equal(authorization, undefined);
    status = 401;
    await assert.rejects(translate(config, 'x', [], new AbortController().signal, 'test-secret'), error => /401/.test(String(error)) && !String(error).includes('test-secret'));
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
