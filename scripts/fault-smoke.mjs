import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import assert from 'node:assert/strict';
const execute = promisify(execFile);
const original = JSON.parse(await readFile('config.json', 'utf8'));
const modelPath = path.resolve(original.asr.modelPath);
const file = path.resolve('build/fault-config.json');
await mkdir('build', { recursive: true });
await writeFile(file, JSON.stringify({ ...original, ollama: { ...original.ollama, baseUrl: 'http://127.0.0.1:59997' }, asr: { ...original.asr, modelPath } }));
const env = { ...process.env, KOTOBA_USER_DATA: path.resolve('build/fault-profile') }; delete env.ELECTRON_RUN_AS_NODE;
const executablePath = process.env.KOTOBA_TEST_EXE || electronPath;
const instance = await electron.launch({ executablePath, args: [...(process.env.KOTOBA_TEST_EXE ? [] : ['.']), '--config=' + file], env });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitState(page, predicate) {
  for (let i = 0; i < 1300; i++) { const s = await page.evaluate(() => window.kotoba.getState()); if (predicate(s)) return s; await pause(100); }
  throw new Error('State transition timed out');
}
try {
  let page;
  for (let i = 0; i < 100; i++) { page = instance.windows().find(p => p.url().includes('view=control')); if (page) break; await pause(100); }
  assert(page);
  await page.getByRole('heading', { name: '听见声音，看懂每一句。' }).waitFor();
  await page.evaluate(() => window.kotoba.checkDevice());
  let state = await waitState(page, s => s.setup.stage === 'error');
  assert.match(state.setup.error, /无法连接 Ollama/); assert(!state.ready);
  await writeFile(file, JSON.stringify({ ...original, asr: { ...original.asr, modelPath: path.resolve('build/missing-model') } }));
  await page.evaluate(() => window.kotoba.checkDevice());
  state = await waitState(page, s => s.setup.stage === 'error');
  assert.match(state.setup.error, /模型目录缺少/); assert(!state.ready);
  await writeFile(file, JSON.stringify({ ...original, asr: { ...original.asr, modelPath } }));
  await page.evaluate(() => window.kotoba.checkDevice());
  state = await waitState(page, s => s.ready || s.setup.stage === 'error'); assert(state.ready, state.setup.error);
  const hostPid = await instance.evaluate(() => process.pid);
  const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'python.exe' -or $_.Name -eq 'kotoba-worker.exe') -and $_.CommandLine -like '*--host-pid ${hostPid}*' } | Sort-Object PrivatePageCount -Descending | Select-Object -First 1 -ExpandProperty ProcessId`], { windowsHide: true });
  const workerPid = Number(stdout.trim()); assert(workerPid > 0, 'Worker process not found');
  process.kill(workerPid);
  state = await waitState(page, s => s.setup.stage === 'error'); assert(!state.ready); assert(!state.running);
  await page.evaluate(() => window.kotoba.checkDevice());
  state = await waitState(page, s => s.ready || s.setup.stage === 'error'); assert(state.ready, state.setup.error);
  await page.evaluate(() => window.kotoba.updateSettings({ device: 'cpu' }));
  await page.evaluate(() => window.kotoba.checkDevice());
  state = await waitState(page, s => s.ready || s.setup.stage === 'error');
  assert(state.ready && state.deviceChecked === 'cpu', state.setup.error);
  const result = { missingOllama: 'passed', missingAsrModel: 'passed', workerCrash: 'passed', recovery: 'passed', cpuFallback: 'passed' };
  await writeFile('artifacts/fault-result.json', JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} finally { await instance.close(); }
