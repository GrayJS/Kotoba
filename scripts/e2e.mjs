import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import assert from 'node:assert/strict';
const artifacts = path.resolve('artifacts'); await mkdir(artifacts, { recursive: true });
const env = { ...process.env, KOTOBA_USER_DATA: path.resolve('build/e2e-profile') }; delete env.ELECTRON_RUN_AS_NODE;
if (process.env.KOTOBA_TEST_CLEAN_PATH) {
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
  env.Path = path.join(process.env.WINDIR, 'System32');
}
const executablePath = process.env.KOTOBA_TEST_EXE || electronPath;
const testConfig = path.resolve(process.env.KOTOBA_TEST_CONFIG || 'config.json');
const args = [...(process.env.KOTOBA_TEST_EXE ? [] : ['.']), '--config=' + testConfig];
const instance = await electron.launch({ executablePath, args, env, timeout: 30000,
  ...(process.env.KOTOBA_RECORD_VIDEO ? { recordVideo: { dir: path.join(artifacts, 'video'), size: { width: 1160, height: 820 } } } : {}) });
let player;
let video;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function poll(page, predicate, timeout = 120000) {
  const start = Date.now(); let state;
  do {
    state = await page.evaluate(() => window.kotoba.getState());
    if (predicate(state)) return state;
    await pause(100);
  } while (Date.now() - start < timeout);
  throw new Error('Timed out: ' + JSON.stringify({ status: state.status, setup: state.setup, warning: state.warning }));
}
try {
  let page;
  for (let i = 0; i < 100; i++) { page = instance.windows().find(p => p.url().includes('view=control')); if (page) break; await pause(100); }
  assert(page, 'Control window missing');
  video = page.video();
  await page.getByRole('heading', { name: '听见声音，看懂每一句。' }).waitFor();
  if (process.env.KOTOBA_TEST_SOURCE) await page.evaluate(source => window.kotoba.saveLanguages({ source, target: 'zh-CN' }), process.env.KOTOBA_TEST_SOURCE);
  await page.evaluate(() => window.kotoba.checkDevice());
  const checked = await poll(page, s => s.ready || s.setup.stage === 'error');
  assert(checked.ready, JSON.stringify(checked.setup));
  await page.evaluate(() => window.kotoba.updateSettings({ liveSubtitles: true }));
  const playerFile = path.resolve('build/speech-test/kotoba-test-speech.exe');
  const compiled = spawnSync(path.join(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'), ['/nologo', '/target:exe', '/out:' + playerFile, path.resolve('tests/tone-player.cs')], { windowsHide: true });
  assert.equal(compiled.status, 0, String(compiled.stderr));
  player = spawn(playerFile, [path.resolve('build/speech-test/japanese-playback.wav'), '90000'], { windowsHide: true, stdio: 'ignore' });
  await pause(400);
  await page.getByRole('button', { name: '刷新应用列表' }).click();
  await page.getByRole('option', { name: /kotoba-test-speech/ }).click();
  await page.evaluate(() => {
    window.__observed = [];
    window.__liveUpdates = [];
    window.__firstSources = {};
    window.kotoba.onState(s => {
      const sub = s.subtitle;
      if (!sub) return;
      if (!window.__firstSources[sub.id]) window.__firstSources[sub.id] = { id: sub.id, firstTextMs: sub.firstTextMs, provisional: sub.isFinal === false };
      if (sub.chinese && !sub.translationPending) {
        const index = window.__observed.findIndex(x => x.session === sub.session && x.id === sub.id);
        if (index < 0) window.__observed.push(sub); else window.__observed[index] = sub;
        if (!window.__liveUpdates.some(x => x.id === sub.id && x.revision === sub.revision)) window.__liveUpdates.push(sub);
      }
    });
  });
  await page.getByRole('button', { name: /开始监听/ }).click();
  await poll(page, s => s.subtitle?.isFinal === false && !!s.subtitle.chinese && !s.subtitle.translationPending, 30000);
  await page.screenshot({ path: path.join(artifacts, 'kotoba-provisional.png') });
  await poll(page, s => s.metrics.count >= 5, 90000);
  await page.evaluate(() => { document.querySelector('.main-content').scrollTop = 0; });
  await page.screenshot({ path: path.join(artifacts, 'kotoba-live.png') });
  const overlay = instance.windows().find(p => p.url().includes('view=overlay'));
  await overlay.screenshot({ path: path.join(artifacts, 'kotoba-overlay.png'), omitBackground: true });
  const observed = await page.evaluate(() => window.__observed);
  const updates = await page.evaluate(() => window.__liveUpdates);
  const firstSources = await page.evaluate(() => Object.values(window.__firstSources));
  assert(firstSources.some(s => s.provisional), 'No text appeared before the sentence was finalized');
  assert(updates.some(s => s.isFinal === false), 'No provisional Chinese translation was displayed');
  assert(updates.some(s => updates.some(other => other.id === s.id && other.revision > s.revision)), 'No rolling revisions were displayed');
  const firstTextMedian = [...firstSources.map(s => s.firstTextMs)].sort((a, b) => a - b)[Math.floor(firstSources.length / 2)];
  if (checked.deviceChecked === 'cuda') assert(firstTextMedian < 2000, `First-text latency too high: ${firstTextMedian} ms`);
  assert(observed.some(s => /[ぁ-んァ-ヶ]/.test(s.japanese)), 'No Japanese transcript received');
  if (process.env.KOTOBA_TEST_SOURCE === 'auto') assert(observed.some(s => s.sourceLanguage === 'ja'), 'No confident Japanese auto-detection received');
  assert(observed.every(s => s.chinese && !s.error), 'Some subtitles were not translated');
  const measured = await page.evaluate(() => window.kotoba.getState());
  await page.getByRole('button', { name: /暂停监听/ }).click();
  await poll(page, s => !s.running);
  assert.equal((await page.evaluate(() => window.kotoba.getState())).subtitle, null);
  await page.getByRole('button', { name: /开始监听/ }).click();
  await poll(page, s => s.running);
  player.kill();
  const exited = await poll(page, s => !s.running, 10000);
  assert(exited.status.includes('退出') || exited.status.includes('结束'), exited.status);
  const chineseTimes = observed.filter(s => Number.isFinite(s.firstChineseMs)).map(s => s.firstChineseMs).sort((a, b) => a - b);
  assert(chineseTimes.length > 0, 'Chinese first-caption timing was not recorded');
  const firstChineseMedian = chineseTimes[Math.floor(chineseTimes.length / 2)];
  if (checked.deviceChecked === 'cuda') assert(firstChineseMedian < 2000, `First Chinese caption too late: ${firstChineseMedian} ms`);
  await writeFile(path.join(artifacts, 'e2e-result.json'), JSON.stringify({ device: checked.deviceChecked, source: 'public JSUT test samples', firstTextMedian, firstChineseMedian, firstSources, revisions: updates, metrics: measured.metrics, subtitles: observed, pause: 'passed', targetExit: 'passed' }, null, 2));
  console.log(JSON.stringify({ result: 'passed', subtitles: observed.length, rollingUpdates: updates.length, firstTextMedian, firstChineseMedian, metrics: measured.metrics, pause: 'passed', targetExit: 'passed' }));
} finally { player?.kill(); await instance.close(); if (video) await video.saveAs(path.join(artifacts, 'kotoba-streaming.webm')); }
