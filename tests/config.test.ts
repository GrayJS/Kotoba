import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DEFAULT_CONFIG, modelDirectory, parseConfig } from '../electron/config';
test('accepts local configuration, normalizes trailing slashes, resolves relative model directory', () => {
  const c = parseConfig({ ...DEFAULT_CONFIG, ollama: { ...DEFAULT_CONFIG.ollama, baseUrl: 'http://localhost:11434/' } });
  assert.equal(c.ollama.baseUrl, 'http://localhost:11434');
  assert.equal(modelDirectory(path.resolve('config.json'), c), path.resolve('models/whisper-large-v3-turbo'));
});
test('rejects unsafe or unusable configuration before spawning runtime', () => {
  for (const baseUrl of ['file:///C:/', 'http://name:password@localhost', 'http://localhost/#fragment']) assert.throws(() => parseConfig({ ...DEFAULT_CONFIG, ollama: { ...DEFAULT_CONFIG.ollama, baseUrl } }));
  for (const timeoutMs of [0, NaN, 120001, 1.5]) assert.throws(() => parseConfig({ ...DEFAULT_CONFIG, ollama: { ...DEFAULT_CONFIG.ollama, timeoutMs } }));
  assert.throws(() => parseConfig({ ...DEFAULT_CONFIG, asr: { ...DEFAULT_CONFIG.asr, device: 'automatic' } }));
  assert.throws(() => parseConfig({ ...DEFAULT_CONFIG, asr: { ...DEFAULT_CONFIG.asr, modelPath: '' } }));
});
