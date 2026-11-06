import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const profile = path.resolve('build/local-setup-smoke-' + Date.now()); await mkdir(profile, { recursive: true }); await mkdir('artifacts', { recursive: true });
const original = JSON.parse(await readFile('config.example.json', 'utf8'));
original.ollama.baseUrl = 'http://localhost:11434'; original.asr.modelPath = 'not-downloaded-yet'; original.ollama.timeoutMs = 17000;
const file = path.join(profile, 'config.json'); await writeFile(file, JSON.stringify(original));
const env = { ...process.env, KOTOBA_USER_DATA: profile }; delete env.ELECTRON_RUN_AS_NODE;
const instance = await electron.launch({ executablePath: process.env.KOTOBA_TEST_EXE || electronPath, args: [...(process.env.KOTOBA_TEST_EXE ? [] : ['.']), '--config=' + file], env });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(page, predicate) {
  for (let i = 0; i < 200; i++) { const state = await page.evaluate(() => window.kotoba.getState()); if (predicate(state)) return state; await pause(40); }
  throw new Error('Local setup transition timed out');
}
try {
  let page;
  for (let i = 0; i < 100; i++) { page = instance.windows().find(p => p.url().includes('view=control')); if (page) break; await pause(50); }
  assert(page); await page.getByRole('heading', { name: '听见声音，看懂每一句。' }).waitFor();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await wait(page, s => !s.localSetup.busy);
  await instance.evaluate(() => {
    globalThis.__setupRealFetch = globalThis.fetch; globalThis.__setupModel = false; globalThis.__setupFail = true; globalThis.__setupPulls = 0;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (!url.startsWith('http://127.0.0.1:11434/')) return globalThis.__setupRealFetch(input, init);
      if (url.endsWith('/api/version')) return new Response(JSON.stringify({ version: 'mock' }));
      if (url.endsWith('/api/tags')) return new Response(JSON.stringify({ models: globalThis.__setupModel ? [{ name: 'hf.co/IndexTeam/Index-Translate-2B-GGUF:Q4_K_M' }] : [] }));
      if (!url.endsWith('/api/pull')) throw new Error('Unexpected setup request');
      globalThis.__setupPulls++;
      if (JSON.parse(init.body).model !== 'hf.co/IndexTeam/Index-Translate-2B-GGUF:Q4_K_M') throw new Error('Wrong model');
      return new Response(new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder(); let step = 0;
          const timer = setInterval(() => {
            if (init.signal.aborted) { clearInterval(timer); controller.error(new DOMException('Cancelled', 'AbortError')); return; }
            step++;
            if (step <= 3) controller.enqueue(encoder.encode(JSON.stringify({ status: 'downloading', total: 400, completed: step * 100 }) + '\n'));
            else {
              clearInterval(timer);
              if (globalThis.__setupFail) controller.enqueue(encoder.encode('{"error":"network interrupted"}\n'));
              else { globalThis.__setupModel = true; controller.enqueue(encoder.encode('{"status":"success"}\n')); }
              controller.close();
            }
          }, 350);
        },
      }));
    };
  });
  await page.evaluate(() => window.kotoba.detectLocalSetup());
  await wait(page, s => s.localSetup.status === 'missing-model');
  assert.equal(await page.locator('.service-panel').getAttribute('open'), '');
  const card = page.locator('.service-panel').getByRole('region', { name: '本机翻译环境' });
  await card.getByRole('button', { name: '一键准备 Index 并自动配置' }).click();
  await wait(page, s => s.localSetup.percent === 25);
  assert.equal(await card.getByRole('progressbar').getAttribute('value'), '25');
  const conflicts = await page.evaluate(async () => {
    const result = await Promise.allSettled([window.kotoba.prepareLocalSetup(), window.kotoba.downloadModel(), window.kotoba.checkDevice(), window.kotoba.saveLanguages({ source: 'en', target: 'en' })]);
    return result.map(r => r.status);
  });
  assert(conflicts.every(s => s === 'rejected'));
  await wait(page, s => s.localSetup.status === 'error');
  assert.equal((JSON.parse(await readFile(file, 'utf8'))).ollama.baseUrl, 'http://localhost:11434');
  await instance.evaluate(() => { globalThis.__setupFail = false; });
  await card.getByRole('button', { name: '重试一键安装并自动配置' }).click();
  await wait(page, s => s.localSetup.percent === 50);
  for (const theme of ['light', 'dark']) {
    await page.getByLabel('主题', { exact: true }).selectOption(theme);
    await page.screenshot({ path: `artifacts/local-setup-${theme}.png` });
  }
  await wait(page, s => s.localSetup.status === 'ready');
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(saved.ollama.baseUrl, 'http://127.0.0.1:11434'); assert.equal(saved.ollama.model, original.ollama.model);
  assert.equal(saved.ollama.timeoutMs, 17000); assert.deepEqual(saved.asr, original.asr); assert.deepEqual(saved.languages, original.languages);
  assert.match((await page.evaluate(() => window.kotoba.getState())).setup.label, /Whisper/);
  await page.evaluate(() => window.kotoba.prepareLocalSetup());
  assert.equal(await instance.evaluate(() => globalThis.__setupPulls), 2, 'Existing model must not be pulled twice');
  const overlay = instance.windows().find(p => p.url().includes('view=overlay')); assert(overlay);
  assert(await overlay.evaluate(() => window.kotoba.prepareLocalSetup().then(() => false, () => true)));
  // Exercise the runtime download presentation using a read-only state fixture. The
  // actual verified downloader and missing-runtime orchestration are covered by unit tests.
  const state = await page.evaluate(() => window.kotoba.getState());
  state.localSetup = { status: 'installing', busy: true, eligible: true, hasRuntime: false, hasModel: false, stage: 'runtime-download', label: '下载官方 Ollama 安装包', percent: 35, completedBytes: 350, totalBytes: 1000 };
  await instance.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows().forEach(w => w.webContents.send('state:changed', s)), state);
  await card.getByRole('progressbar').waitFor(); assert.equal(await card.getByRole('progressbar').getAttribute('value'), '35');
  assert(await card.getByRole('button', { name: '取消下载' }).isVisible());
  await page.screenshot({ path: 'artifacts/local-runtime-download.png' });
  await page.evaluate(() => window.kotoba.detectLocalSetup());
  const current = await page.evaluate(() => window.kotoba.getState());
  await page.evaluate(service => window.kotoba.saveService(service), { ...current.service, provider: 'compatible', compatible: { ...current.service.compatible, model: 'custom-online', baseUrl: 'https://example.invalid/v1' } });
  await wait(page, s => s.localSetup.status === 'custom');
  assert.equal(await card.getByRole('button', { name: /一键/ }).count(), 0);
  assert.equal(errors.length, 0, errors.join('\n'));
  const result = { detectsMissingModel: true, modelByteProgress: true, runtimeProgressUi: true, failureRetry: true, conflictingOperationsBlocked: true, autoConfigured: true, existingModelReused: true, customServicePreserved: true, controllerOnlyIpc: true, lightDarkUi: true, consoleErrors: errors };
  await writeFile('artifacts/local-setup-result.json', JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} finally { await instance.close(); }
