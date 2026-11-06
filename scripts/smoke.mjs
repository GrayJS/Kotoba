import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const artifacts = path.resolve('artifacts'); await mkdir(artifacts, { recursive: true });
const env = { ...process.env, KOTOBA_USER_DATA: path.resolve('build/smoke-profile') }; delete env.ELECTRON_RUN_AS_NODE;
if (process.env.KOTOBA_TEST_CLEAN_PATH) {
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
  env.Path = path.join(process.env.WINDIR, 'System32');
}
const executablePath = process.env.KOTOBA_TEST_EXE || electronPath;
const args = process.env.KOTOBA_TEST_EXE ? ['--config=' + path.resolve('config.json')] : ['.'];
const instance = await electron.launch({ executablePath, args, env, timeout: 30000 });
const consoleErrors = [];
try {
  let page;
  for (let i = 0; i < 100; i++) {
    page = instance.windows().find(p => p.url().includes('view=control'));
    if (page) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!page) throw new Error('Control window missing');
  page.on('pageerror', error => consoleErrors.push(error.message));
  await page.getByRole('heading', { name: '听见声音，看懂每一句。' }).waitFor();
  const initial = await page.evaluate(() => window.kotoba.getState());
  const liveToggle = page.getByRole('switch', { name: '边听边显示' });
  await liveToggle.click();
  const toggled = await page.evaluate(() => window.kotoba.getState());
  assert.equal(toggled.settings.liveSubtitles, !initial.settings.liveSubtitles);
  await liveToggle.click();
  if (await page.evaluate(() => typeof window.require !== 'undefined')) throw new Error('Node unexpectedly exposed in renderer');
  await page.getByRole('switch', { name: '双语字幕' }).click();
  await page.waitForFunction(() => document.querySelector('[role="switch"][aria-label="双语字幕"]')?.getAttribute('aria-checked') === 'false');
  await page.getByRole('switch', { name: '双语字幕' }).click();
  await page.getByRole('button', { name: '预览桌面位置' }).click();
  const overlay = instance.windows().find(p => p.url().includes('view=overlay'));
  if (!overlay) throw new Error('Overlay window missing');
  await overlay.getByRole('button', { name: '完成', exact: true }).waitFor();
  await overlay.getByRole('button', { name: '完成', exact: true }).click();
  for (let i = 0; i < 150 && (await page.evaluate(() => window.kotoba.getState())).localSetup?.busy; i++) await new Promise(resolve => setTimeout(resolve, 50));
  await page.evaluate(() => window.kotoba.checkDevice());
  let checked;
  for (let i = 0; i < 1300; i++) {
    checked = await page.evaluate(() => window.kotoba.getState());
    if (checked.ready || checked.setup.stage === 'error') break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!checked.ready) throw new Error('Device check failed: ' + JSON.stringify({ setup: checked.setup, warning: checked.warning, status: checked.status }));
  const displayChecks = [];
  const displays = await instance.evaluate(({ screen }) => screen.getAllDisplays().map(d => ({ id: d.id, area: d.workArea, scale: d.scaleFactor })));
  await page.evaluate(() => window.kotoba.updateSettings({ editMode: true, width: 400, fontSize: 28 }));
  for (const display of displays) {
    const desired = { x: display.area.x + 20, y: display.area.y + 20 };
    await instance.evaluate(({ BrowserWindow }, p) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('view=overlay')).setPosition(p.x, p.y), desired);
    for (let i = 0; i < 50; i++) {
      const s = await page.evaluate(() => window.kotoba.getState());
      if (s.settings.bounds?.x === desired.x && s.settings.bounds?.y === desired.y) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    await page.evaluate(() => window.kotoba.updateSettings({ width: 400 }));
    const actual = await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('view=overlay')).getBounds());
    assert.equal(actual.x, desired.x, 'Dragged X position was not retained');
    assert.equal(actual.y, desired.y, 'Dragged Y position was not retained');
    assert(actual.x >= display.area.x && actual.x + actual.width <= display.area.x + display.area.width);
    assert(actual.y >= display.area.y && actual.y + actual.height <= display.area.y + display.area.height);
    displayChecks.push({ ...display, bounds: actual });
  }
  await page.evaluate(() => window.kotoba.updateSettings({ editMode: false, overlayVisible: false }));
  assert.equal(await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('view=overlay')).isVisible()), false);
  await page.evaluate(s => window.kotoba.updateSettings({ ...s, editMode: false, overlayVisible: true }), initial.settings);
  await page.evaluate(() => window.kotoba.resetPosition());
  assert.equal(await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('view=overlay')).isFocusable()), false);
  assert.equal(await instance.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('CommandOrControl+Alt+S') && globalShortcut.isRegistered('CommandOrControl+Alt+H')), true);
  await page.evaluate(() => { document.querySelector('.main-content').scrollTop = 0; });
  await page.screenshot({ path: path.join(artifacts, 'kotoba-ready.png') });
  const windows = await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => ({ alwaysOnTop: w.isAlwaysOnTop(), bounds: w.getBounds(), webPreferences: { sandbox: w.webContents.getLastWebPreferences().sandbox, contextIsolation: w.webContents.getLastWebPreferences().contextIsolation } })));
  await writeFile(path.join(artifacts, 'smoke-result.json'), JSON.stringify({ ready: checked.ready, device: checked.deviceChecked, windows, displayChecks, hideOverlay: 'passed', clickThroughFocusable: 'passed', shortcutsRegistered: true, consoleErrors }, null, 2));
  if (consoleErrors.length) throw new Error(consoleErrors.join('\n'));
  console.log(JSON.stringify({ ready: checked.ready, device: checked.deviceChecked, windows: windows.length, screenshot: path.join(artifacts, 'kotoba-ready.png') }));
  await page.evaluate(s => window.kotoba.updateSettings(s), initial.settings);
} finally { await instance.close(); }
