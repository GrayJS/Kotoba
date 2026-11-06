import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { DEFAULT_CONFIG } from '../electron/config';
import { LocalSetup, defaultLocalConfiguration, INDEX_MODEL, type LocalSetupDependencies } from '../electron/local-setup';
import { downloadVerifiedFile } from '../electron/setup-download';
import { pullIndex } from '../electron/ollama-setup-runtime';

function fixture() {
  let running = false, model = false, installed = false, configured = 0;
  const events: any[] = []; const calls: string[] = [];
  const deps: LocalSetupDependencies = {
    configuration: () => structuredClone(DEFAULT_CONFIG),
    probe: async () => { if (!running) throw new Error('offline'); return { hasModel: model }; },
    findRuntime: async () => installed ? 'installed-ollama.exe' : null,
    installRuntime: async progress => { calls.push('install'); progress({ stage: 'runtime-download', label: 'download', percent: 50, completedBytes: 50, totalBytes: 100 }); installed = true; return 'installed-ollama.exe'; },
    startRuntime: async () => { calls.push('start'); running = true; },
    pullModel: async progress => { calls.push('pull'); progress({ stage: 'model-pull', label: 'pull', percent: 75, completedBytes: 75, totalBytes: 100 }); model = true; },
    configure: async () => { configured++; },
  };
  const setup = new LocalSetup(deps, s => events.push(s));
  return { setup, deps, events, calls, configured: () => configured, existing: () => { installed = true; running = true; model = true; } };
}
test('first-run missing environment is detected; one click installs, reports real progress, verifies and configures', async () => {
  const f = fixture(); await f.setup.detect(); assert.equal(f.setup.value.status, 'missing-runtime');
  const preparing = f.setup.prepare(); await assert.rejects(f.setup.prepare(), /稍候/); await preparing;
  assert.deepEqual(f.calls, ['install', 'start', 'pull']); assert.equal(f.configured(), 1);
  assert.equal(f.setup.value.status, 'ready'); assert.equal(f.setup.value.hasModel, true); assert.equal(f.setup.value.busy, false);
  assert(f.events.some(s => s.stage === 'runtime-download' && s.percent === 50 && s.completedBytes === 50));
  assert(f.events.some(s => s.stage === 'model-pull' && s.percent === 75 && s.totalBytes === 100));
});
test('existing service and model skip installation/download; custom services and models are preserved', async () => {
  const f = fixture(); f.existing(); await f.setup.detect(); assert.equal(f.setup.value.status, 'ready');
  await f.setup.prepare(); assert.deepEqual(f.calls, []); assert.equal(f.configured(), 1);
  for (const config of [
    { ...DEFAULT_CONFIG, ollama: { ...DEFAULT_CONFIG.ollama, model: 'my-custom-model' } },
    { ...DEFAULT_CONFIG, ollama: { ...DEFAULT_CONFIG.ollama, baseUrl: 'http://127.0.0.1:12345' } },
    { ...DEFAULT_CONFIG, translation: { ...DEFAULT_CONFIG.translation, provider: 'compatible' as const } },
  ]) {
    assert.equal(defaultLocalConfiguration(config), false); f.deps.configuration = () => config;
    await f.setup.detect(); assert.equal(f.setup.value.status, 'custom'); await assert.rejects(f.setup.prepare(), /自定义/);
  }
});
test('failed model pull can retry; missing success verification never configures; cancellation leaves retry available', async () => {
  const f = fixture(); const original = f.deps.pullModel;
  f.deps.pullModel = async () => { throw new Error('download interrupted'); };
  await f.setup.prepare(); assert.equal(f.setup.value.status, 'error'); assert.equal(f.configured(), 0);
  f.deps.pullModel = original; await f.setup.prepare(); assert.equal(f.setup.value.status, 'ready');
  const g = fixture(); g.deps.pullModel = async () => {};
  await g.setup.prepare(); assert.equal(g.setup.value.status, 'error'); assert.equal(g.configured(), 0);
  g.deps.pullModel = async (progress, signal) => {
    progress({ stage: 'model-pull', label: 'download' });
    await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
  };
  const pending = g.setup.prepare();
  for (let i = 0; i < 20 && g.setup.value.stage !== 'model-pull'; i++) await new Promise(resolve => setTimeout(resolve, 1));
  g.setup.cancel(); await pending; assert.equal(g.setup.value.status, 'error'); assert.equal(g.setup.value.busy, false); assert.match(g.setup.value.label, /取消/);
});
test('verified installer download resumes partial bytes, emits progress, skips cache and rejects wrong digest', async () => {
  const payload = Buffer.from('official-installer-fixture'.repeat(5000)); let requests = 0; let range = '';
  const server = createServer((req, res) => {
    requests++; range = req.headers.range || ''; const offset = range ? Number(range.match(/bytes=(\d+)-/)?.[1]) : 0;
    res.writeHead(offset ? 206 : 200, { 'Content-Length': payload.length - offset, ...(offset ? { 'Content-Range': `bytes ${offset}-${payload.length - 1}/${payload.length}` } : {}) }); res.end(payload.subarray(offset));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const dir = await mkdtemp(path.join(tmpdir(), 'kotoba-runtime-')); const file = path.join(dir, 'OllamaSetup.exe'); const events: any[] = [];
  const manifest = { url: `http://127.0.0.1:${(server.address() as any).port}/installer`, size: payload.length, sha256: createHash('sha256').update(payload).digest('hex') };
  try {
    await writeFile(file + '.part', payload.subarray(0, 1024));
    await downloadVerifiedFile(manifest, file, p => events.push(p), new AbortController().signal);
    assert.equal(range, 'bytes=1024-'); assert.deepEqual(await readFile(file), payload);
    assert(events.some(e => e.stage === 'runtime-download' && e.completedBytes === payload.length && e.percent === 100));
    assert(events.some(e => e.stage === 'runtime-verify'));
    await downloadVerifiedFile(manifest, file, () => {}, new AbortController().signal); assert.equal(requests, 1);
    await assert.rejects(downloadVerifiedFile({ ...manifest, sha256: '0'.repeat(64) }, path.join(dir, 'invalid.exe'), () => {}, new AbortController().signal), /SHA-256/);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); }
});
test('Index pull parses streamed NDJSON and bytes, rejects errors/truncation, and requires explicit success', async () => {
  const states: any[] = [];
  const request: typeof fetch = async (input, init) => {
    assert.equal(String(input), 'http://127.0.0.1:11434/api/pull');
    assert.deepEqual(JSON.parse(String(init?.body)), { model: INDEX_MODEL, stream: true });
    assert.equal(init?.redirect, 'error'); assert.equal(init?.credentials, 'omit');
    const data = '{"status":"pulling manifest"}\n{"status":"downloading","total":400,"completed":100}\n{"status":"success"}';
    return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(data.slice(0, 45))); c.enqueue(new TextEncoder().encode(data.slice(45))); c.close(); } }));
  };
  await pullIndex(s => states.push(s), new AbortController().signal, request);
  assert(states.some(s => s.percent === 25 && s.completedBytes === 100 && s.totalBytes === 400));
  for (const text of ['{"status":"pulling manifest"}\n', '{"error":"private server path"}\n', 'invalid\n']) await assert.rejects(pullIndex(() => {}, new AbortController().signal, async () => new Response(text)));
});
