import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const env = { ...process.env, KOTOBA_USER_DATA: path.resolve('build/updates-profile-' + Date.now()) }; delete env.ELECTRON_RUN_AS_NODE;
const currentVersion = JSON.parse(await readFile('package.json', 'utf8')).version;
const args = [...(process.env.KOTOBA_TEST_EXE ? [] : ['.']), '--config=' + path.resolve('config.json')];
const instance = await electron.launch({ executablePath: process.env.KOTOBA_TEST_EXE || electronPath, args, env });
const errors = [];
try {
  let page;
  for (let i = 0; i < 100; i++) { page = instance.windows().find(p => p.url().includes('view=control')); if (page) break; await new Promise(r => setTimeout(r, 50)); }
  assert(page); await page.getByRole('heading', { name: '听见声音，看懂每一句。' }).waitFor();
  page.on('pageerror', error => errors.push(error.message));
  const initial = await page.evaluate(() => window.kotoba.getState());
  assert.equal(initial.update.currentVersion, currentVersion);
  assert.equal(initial.update.status, 'idle');
  await instance.evaluate(({ shell }, version) => {
    globalThis.__installedVersion = version;
    globalThis.__realUpdateFetch = globalThis.fetch; globalThis.__realUpdateOpen = shell.openExternal;
    globalThis.__updateMode = 'future'; globalThis.__updateCalls = 0; globalThis.__updateOpened = [];
    shell.openExternal = async url => { globalThis.__updateOpened.push(url); };
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (!url.startsWith('https://api.github.com/repos/GrayJS/Kotoba/releases?')) return globalThis.__realUpdateFetch(input, init);
      globalThis.__updateCalls++;
      if (init.headers.Authorization || init.headers.authorization) throw new Error('Unexpected credentials');
      await new Promise(resolve => setTimeout(resolve, 250));
      if (globalThis.__updateMode === 'offline') throw new Error('private-network-details');
      const tag = globalThis.__updateMode === 'future' ? 'v0.3.0-beta.99' : 'v' + globalThis.__installedVersion;
      const name = `Kotoba-Setup-${tag.slice(1)}-x64.exe`;
      return new Response(JSON.stringify([{ tag_name: tag, draft: false, prerelease: true, published_at: '2026-11-05T00:00:00Z',
        html_url: `https://github.com/GrayJS/Kotoba/releases/tag/${tag}`,
        assets: [{ name, state: 'uploaded', size: 100, browser_download_url: `https://github.com/GrayJS/Kotoba/releases/download/${tag}/${name}` }] }]), { status: 200 });
    };
  }, currentVersion);
  const panel = page.getByRole('region', { name: '版本与更新' });
  await panel.getByRole('button', { name: '检查更新', exact: true }).click();
  await panel.getByRole('button', { name: '正在检查更新…' }).waitFor();
  assert(await panel.getByRole('button', { name: '正在检查更新…' }).isDisabled());
  await page.evaluate(() => window.kotoba.checkUpdates());
  await panel.getByText('发现新版本 v0.3.0-beta.99（测试版）', { exact: true }).waitFor();
  assert.equal(await instance.evaluate(() => globalThis.__updateCalls), 1);
  await panel.getByRole('button', { name: '查看发布页', exact: true }).click();
  await panel.getByRole('button', { name: '下载安装包', exact: true }).click();
  const opened = await instance.evaluate(() => globalThis.__updateOpened);
  assert.deepEqual(opened, ['https://github.com/GrayJS/Kotoba/releases/tag/v0.3.0-beta.99', 'https://github.com/GrayJS/Kotoba/releases/download/v0.3.0-beta.99/Kotoba-Setup-0.3.0-beta.99-x64.exe']);
  const rejected = await page.evaluate(() => window.kotoba.openUpdate('https://evil.example').then(() => false, () => true)); assert(rejected);
  const overlay = instance.windows().find(p => p.url().includes('view=overlay')); assert(overlay);
  await overlay.waitForFunction(() => !!window.kotoba);
  assert(await overlay.evaluate(() => window.kotoba.checkUpdates().then(() => false, () => true)));
  await mkdir('artifacts', { recursive: true });
  for (const theme of ['light', 'dark']) {
    await page.getByLabel('主题', { exact: true }).selectOption(theme);
    await panel.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `artifacts/updates-${theme}.png` });
  }
  await instance.evaluate(() => { globalThis.__updateMode = 'offline'; });
  await panel.getByRole('button', { name: '检查更新', exact: true }).click();
  await panel.getByRole('button', { name: '重试检查更新', exact: true }).waitFor();
  const failed = await page.evaluate(() => window.kotoba.getState());
  assert.equal(failed.update.status, 'error'); assert(!failed.update.message.includes('private-network'));
  assert.equal(await panel.getByRole('button', { name: '下载安装包' }).count(), 0);
  await instance.evaluate(() => { globalThis.__updateMode = 'latest'; });
  await panel.getByRole('button', { name: '重试检查更新', exact: true }).click();
  await panel.getByText(`当前 v${currentVersion} 已是最新版本`, { exact: true }).waitFor();
  await instance.evaluate(({ shell }) => { globalThis.fetch = globalThis.__realUpdateFetch; shell.openExternal = globalThis.__realUpdateOpen; });
  await page.evaluate(() => window.kotoba.checkUpdates());
  const actual = await page.evaluate(() => window.kotoba.getState());
  assert(actual.update.status === 'latest' || actual.update.status === 'error' && /GitHub 请求受限|无法连接 GitHub 或检查超时/.test(actual.update.message), actual.update.message);
  assert.equal(actual.modelPath, initial.modelPath); assert.deepEqual(actual.service, initial.service); assert.deepEqual(actual.languages, initial.languages);
  assert.equal(errors.length, 0, errors.join('\n'));
  const result = { currentVersion: actual.update.currentVersion, manualOnly: true, newerBetaMock: true, safeBrowserLinks: true, duplicateRequestCoalescing: true, controllerOnlyIpc: true, networkFailureAndRetry: true, lightDarkUi: true, liveGitHub: actual.update.status === 'latest' ? 'latest' : /受限/.test(actual.update.message) ? 'anonymous-api-rate-limit-reported' : 'network-timeout-reported', settingsUnchanged: true, consoleErrors: errors };
  await writeFile('artifacts/updates-result.json', JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} finally { await instance.close(); }
