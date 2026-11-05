import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const execute = promisify(execFile);
const env = { ...process.env, KOTOBA_USER_DATA: path.resolve('build/host-exit-profile') }; delete env.ELECTRON_RUN_AS_NODE;
const executablePath = process.env.KOTOBA_TEST_EXE || electronPath;
const instance = await electron.launch({ executablePath, args: [...(process.env.KOTOBA_TEST_EXE ? [] : ['.']), '--config=' + path.resolve('config.json')], env });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let workerPid;
try {
  let page;
  for (let i = 0; i < 100; i++) { page = instance.windows().find(p => p.url().includes('view=control')); if (page) break; await pause(100); }
  assert(page); await page.getByRole('heading', { name: '听见声音，看懂每一句。' }).waitFor();
  await page.evaluate(() => window.kotoba.checkDevice());
  let state;
  for (let i = 0; i < 1300; i++) { state = await page.evaluate(() => window.kotoba.getState()); if (state.ready || state.setup.stage === 'error') break; await pause(100); }
  assert(state.ready, state.setup.error);
  const hostPid = await instance.evaluate(() => process.pid);
  const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'python.exe' -or $_.Name -eq 'kotoba-worker.exe') -and $_.CommandLine -like '*--host-pid ${hostPid}*' } | Sort-Object PrivatePageCount -Descending | Select-Object -First 1 -ExpandProperty ProcessId`], { windowsHide: true });
  workerPid = Number(stdout.trim()); assert(workerPid > 0);
  process.kill(hostPid);
  let ended = false;
  for (let i = 0; i < 100; i++) {
    try { process.kill(workerPid, 0); } catch { ended = true; break; }
    await pause(100);
  }
  assert(ended, 'Worker remained alive after its host exited');
  await writeFile('artifacts/host-exit-result.json', JSON.stringify({ hostCrashCleanup: 'passed' }, null, 2));
  console.log(JSON.stringify({ hostCrashCleanup: 'passed' }));
} finally {
  await instance.close().catch(() => {});
  if (workerPid) { try { process.kill(workerPid, 0); process.kill(workerPid); } catch { /* already stopped */ } }
}
