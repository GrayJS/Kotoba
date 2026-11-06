import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
// This real-component test intentionally requires the model to exist. It must never
// download a second runtime/model merely to validate reuse on the developer's PC.
const tags = await (await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(3000) })).json();
assert(tags.models.some(m => m.name === 'hf.co/IndexTeam/Index-Translate-2B-GGUF:Q4_K_M'), 'Start existing Ollama with Index before running this test');
const profile = path.resolve('build/local-reuse-' + Date.now()); await mkdir(profile, { recursive: true });
const config = JSON.parse(await readFile('config.json', 'utf8'));
config.ollama.baseUrl = 'http://localhost:11434';
config.asr.modelPath = path.resolve('models/whisper-large-v3-turbo');
const file = path.join(profile, 'config.json'); await writeFile(file, JSON.stringify(config));
const env = { ...process.env, KOTOBA_USER_DATA: profile }; delete env.ELECTRON_RUN_AS_NODE;
const instance = await electron.launch({ executablePath: process.env.KOTOBA_TEST_EXE || electronPath, args: [...(process.env.KOTOBA_TEST_EXE ? [] : ['.']), '--config=' + file], env });
try {
  let page;
  for (let i = 0; i < 100; i++) { page = instance.windows().find(p => p.url().includes('view=control')); if (page) break; await new Promise(r => setTimeout(r, 50)); }
  assert(page); await page.getByRole('heading', { name: '听见声音，看懂每一句。' }).waitFor();
  for (let i = 0; i < 100 && (await page.evaluate(() => window.kotoba.getState())).localSetup.busy; i++) await new Promise(r => setTimeout(r, 50));
  const detected = await page.evaluate(() => window.kotoba.getState());
  assert.equal(detected.localSetup.status, 'ready');
  await page.evaluate(() => { window.__setupStages = []; window.kotoba.onState(s => window.__setupStages.push(s.localSetup.stage)); });
  await page.evaluate(() => window.kotoba.prepareLocalSetup());
  let ready;
  for (let i = 0; i < 1300; i++) { ready = await page.evaluate(() => window.kotoba.getState()); if (ready.ready || ready.setup.stage === 'error') break; await new Promise(r => setTimeout(r, 100)); }
  assert(ready.ready, JSON.stringify(ready.setup));
  const stages = await page.evaluate(() => window.__setupStages);
  assert(!stages.includes('runtime-download') && !stages.includes('model-pull'));
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(saved.ollama.baseUrl, 'http://127.0.0.1:11434'); assert.equal(saved.ollama.model, config.ollama.model);
  assert.deepEqual(saved.asr, config.asr); assert.deepEqual(saved.languages, config.languages || { source: 'ja', target: 'zh-CN' });
  const result = { actualComponents: true, existingRuntimeAndIndexReused: true, noRuntimeOrModelDownload: true, autoConfigured: true, inferenceChecked: true, device: ready.deviceChecked };
  await mkdir('artifacts', { recursive: true }); await writeFile('artifacts/local-reuse-result.json', JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} finally { await instance.close(); }
