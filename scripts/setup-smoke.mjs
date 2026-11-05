import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import { mkdir, writeFile, readFile, link, copyFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';

const profile = path.resolve('build/setup-smoke-' + Date.now());
const file = path.join(profile, 'config.json');
const models = path.join(profile, 'models/whisper-large-v3-turbo');
const source = path.resolve('models/whisper-large-v3-turbo');
await mkdir(profile, { recursive: true }); await mkdir('artifacts', { recursive: true });
const original = JSON.parse(await readFile('config.example.json', 'utf8'));
await writeFile(file, JSON.stringify({ ...original, ollama: { ...original.ollama, baseUrl: 'http://127.0.0.1:59997' }, asr: { ...original.asr, modelPath: 'missing-model' } }));
const env = { ...process.env, KOTOBA_USER_DATA: profile, HF_HUB_OFFLINE: '1' }; delete env.ELECTRON_RUN_AS_NODE;
if (process.env.KOTOBA_TEST_CLEAN_PATH) {
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
  env.Path = path.join(process.env.WINDIR, 'System32');
}
const executablePath = process.env.KOTOBA_TEST_EXE || electronPath;
const args = [...(process.env.KOTOBA_TEST_EXE ? [] : ['.']), '--config=' + file];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let requests = 0;
const server = createServer((req, res) => {
  let text = ''; req.on('data', c => { text += c; }); req.on('end', () => {
    assert.equal(req.url, '/v1/chat/completions'); assert.equal(req.headers.authorization, 'Bearer mock-key-for-test');
    const body = JSON.parse(text); assert.equal(body.model, 'mock-translator'); requests++;
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: 'Hello.' } }] }));
  });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let instance;
const errors = [];
async function wait(page, predicate, timeout = 30000) {
  const start = Date.now(); let state;
  do { state = await page.evaluate(() => window.kotoba.getState()); if (predicate(state)) return state; await pause(80); } while (Date.now() - start < timeout);
  throw new Error('Timed out: ' + JSON.stringify({ setup: state.setup, download: state.download, status: state.status }));
}
async function launch() {
  instance = await electron.launch({ executablePath, args, env });
  let page;
  for (let i = 0; i < 100; i++) { page = instance.windows().find(p => p.url().includes('view=control')); if (page) break; await pause(100); }
  assert(page); page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('heading', { name: '听见声音，看懂每一句。' }).waitFor(); return page;
}
try {
  let page = await launch();
  const conflicts = await page.evaluate(async () => {
    const result = await Promise.allSettled([window.kotoba.downloadModel(), window.kotoba.downloadModel(), window.kotoba.checkDevice(), window.kotoba.saveLanguages({ source: 'en', target: 'en' })]);
    return result.map(r => r.status);
  });
  assert.deepEqual(conflicts, ['fulfilled', 'rejected', 'rejected', 'rejected']);
  let state = await wait(page, s => s.download.stage === 'error');
  assert.match(state.download.error, /offline|network|cache|disabled/i);
  assert.equal(state.settings.device, 'cuda'); assert.equal(state.download.busy, false);
  await page.getByRole('button', { name: '重试下载识别模型' }).click();
  await wait(page, s => s.download.stage === 'error');
  // Real completed model files, hard-linked to avoid duplicating 1.6 GB. This exercises the
  // packaged worker's download-complete IPC and cache skip without a fresh network download.
  await mkdir(models, { recursive: true });
  for (const name of ['.complete', 'config.json', 'model.bin', 'preprocessor_config.json', 'tokenizer.json', 'vocabulary.json']) {
    try { await link(path.join(source, name), path.join(models, name)); } catch { await copyFile(path.join(source, name), path.join(models, name)); }
  }
  await page.getByRole('button', { name: '重试下载识别模型' }).click();
  state = await wait(page, s => s.download.prepared && s.setup.stage === 'error');
  assert.equal(state.download.error, undefined); assert.match(state.setup.error, /Ollama/);
  const downloadedConfig = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(downloadedConfig.asr.modelPath, models);
  assert.deepEqual(downloadedConfig.ollama, { ...original.ollama, baseUrl: 'http://127.0.0.1:59997' });
  await page.getByLabel('源语音语言').selectOption('auto'); await wait(page, s => s.languages.source === 'auto');
  await page.getByLabel('译文语言', { exact: true }).selectOption('en'); await wait(page, s => s.languages.target === 'en');
  await page.getByLabel('源语音语言').selectOption('en'); await wait(page, s => s.languages.source === 'en');
  await page.getByLabel('源语音语言').selectOption('auto'); await wait(page, s => s.languages.source === 'auto');
  await page.locator('.service-panel summary').click();
  await page.getByLabel('翻译服务', { exact: true }).selectOption('compatible');
  await page.getByLabel('服务地址', { exact: true }).fill(`http://127.0.0.1:${server.address().port}/v1`);
  await page.getByLabel('模型名称', { exact: true }).fill('mock-translator');
  await page.getByLabel('API 密钥', { exact: true }).fill('mock-key-for-test');
  await page.getByRole('button', { name: '保存服务配置', exact: true }).click();
  await wait(page, s => s.service.provider === 'compatible' && s.service.hasKey);
  assert.equal(await page.getByLabel('API 密钥', { exact: true }).inputValue(), '');
  assert.equal(JSON.stringify(await page.evaluate(() => window.kotoba.getState())).includes('mock-key-for-test'), false);
  assert.equal((await readFile(path.join(profile, 'credentials.bin'))).includes(Buffer.from('mock-key-for-test')), false);
  await page.getByRole('button', { name: '检查已保存的连接', exact: true }).click();
  state = await wait(page, s => s.ready || s.setup.stage === 'error', 130000);
  assert(state.ready, JSON.stringify(state.setup)); assert.equal(state.deviceChecked, 'cuda'); assert(requests > 0);
  const overlay = instance.windows().find(p => p.url().includes('view=overlay')); assert(overlay);
  // Inject a subtitle through the same main-process event channel; no edit-mode transition.
  await instance.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('view=overlay'));
    win.setPosition(200, 200);
  });
  const subtitleState = structuredClone(state);
  subtitleState.subtitle = { session: 'visual-test', id: 1, japanese: 'こんにちは。', chinese: 'Hello.', sourceLanguage: 'ja', targetLanguage: 'en', endedAt: Date.now(), latencyMs: 500 };
  await instance.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows().forEach(w => w.webContents.send('state:changed', s)), subtitleState);
  await overlay.locator('.overlay-subtitle').waitFor();
  assert.equal(await overlay.locator('.overlay-subtitle').evaluate(el => getComputedStyle(el).cursor), 'move');
  assert.equal(state.settings.editMode, false);
  // Windows native drag is driven by SendInput; browser synthetic mouse events do not move native windows.
  const { execFile } = await import('node:child_process'); const { promisify } = await import('node:util');
  const rect = await overlay.locator('.overlay-subtitle').boundingBox();
  await overlay.screenshot({ path: 'artifacts/setup-drag-before.png', omitBackground: true });
  const native = await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('view=overlay')).getBounds());
  const x = native.x + Math.round(rect.x + rect.width / 2), y = native.y + Math.round(rect.y + rect.height / 2);
  const nativeDrag = `$signature = '[DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y); [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint x,uint y,uint d,UIntPtr e);'; Add-Type -MemberDefinition $signature -Name Input -Namespace KotobaTest; [KotobaTest.Input]::SetCursorPos(${x},${y}); Start-Sleep -Milliseconds 150; [KotobaTest.Input]::mouse_event(2,0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 100; [KotobaTest.Input]::SetCursorPos(${x + 90},${y + 65}); Start-Sleep -Milliseconds 250; [KotobaTest.Input]::mouse_event(4,0,0,0,[UIntPtr]::Zero);`;
  await promisify(execFile)(path.join(process.env.WINDIR, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-Command', nativeDrag], { windowsHide: true });
  const dragged = await wait(page, s => s.settings.bounds?.x > 250);
  assert(Math.abs(dragged.settings.bounds.x - 290) < 10); assert(Math.abs(dragged.settings.bounds.y - 265) < 10);
  await pause(300);
  for (const theme of ['light', 'dark']) {
    await page.getByLabel('主题', { exact: true }).selectOption(theme);
    await page.waitForFunction(t => document.documentElement.dataset.theme === t, theme);
    await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('view=control')).setSize(1160, 820));
    await page.screenshot({ path: `artifacts/setup-${theme}.png` });
    await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('view=control')).setSize(960, 720));
    await page.screenshot({ path: `artifacts/setup-${theme}-960.png` });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert(await page.getByRole('button', { name: /开始监听/ }).isVisible());
    await page.locator('.service-panel summary').click();
    await page.evaluate(() => { document.querySelector('.main-content').scrollTop = 0; });
    await page.screenshot({ path: `artifacts/setup-${theme}-default-960.png` });
    await page.locator('.service-panel summary').click();
  }
  await page.getByLabel('主题', { exact: true }).selectOption('system');
  await instance.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'light'; });
  await wait(page, s => s.resolvedTheme === 'light' && s.settings.theme === 'system');
  await instance.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'dark'; });
  await wait(page, s => s.resolvedTheme === 'dark' && s.settings.theme === 'system');
  await page.getByLabel('主题', { exact: true }).selectOption('light');
  await instance.close(); instance = null;
  page = await launch(); state = await page.evaluate(() => window.kotoba.getState());
  assert.deepEqual(state.languages, { source: 'auto', target: 'en' }); assert.equal(state.service.hasKey, true);
  assert.equal(state.settings.theme, 'light'); assert.equal(state.resolvedTheme, 'light');
  assert.equal(state.download.prepared, true); assert.equal(state.modelPath, models);
  assert(Math.abs(state.settings.bounds.x - 290) < 10); assert.equal(state.settings.editMode, false);
  assert.equal(errors.length, 0, errors.join('\n'));
  const result = { downloadFailureRetry: true, conflictingOperationsBlocked: true, completedRealModelCacheUsed: true, autoModelPath: true, ollamaFailureSeparate: true, languagePersistence: true, compatibleApiMock: true, encryptedCredentialPersistence: true, gpuSelfCheck: true, nativeDragWithoutEditMode: true, lightDark960And1160: true, themeChangesAndPersistence: true, consoleErrors: errors, requests };
  await writeFile('artifacts/setup-result.json', JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} finally { if (instance) await instance.close(); await new Promise(resolve => server.close(resolve)); }
