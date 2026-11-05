import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { compareVersions, newestRelease, trustedProjectUrl, UpdateChecker } from '../electron/updates';

function release(tag: string, extra: Record<string, unknown> = {}) {
  const name = `Kotoba-Setup-${tag.replace(/^v/, '')}-x64.exe`;
  return { tag_name: tag, draft: false, prerelease: tag.includes('-'), published_at: '2026-11-05T00:00:00Z',
    html_url: `https://github.com/GrayJS/Kotoba/releases/tag/${encodeURIComponent(tag)}`,
    assets: [{ name, state: 'uploaded', size: 123, browser_download_url: `https://github.com/GrayJS/Kotoba/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}` }], ...extra };
}
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });

test('SemVer compares numeric beta identifiers, stable versions and build metadata correctly', () => {
  const ordered = ['0.2.99', '0.3.0-alpha', '0.3.0-alpha.1', '0.3.0-alpha.beta', '0.3.0-beta', '0.3.0-beta.2', '0.3.0-beta.11', '0.3.0-rc.1', '0.3.0', '0.4.0-beta.1', '1.0.0'];
  for (let i = 1; i < ordered.length; i++) {
    assert.equal(compareVersions(ordered[i], ordered[i - 1]), 1);
    assert.equal(compareVersions(ordered[i - 1], ordered[i]), -1);
  }
  assert.equal(compareVersions('v0.3.0-beta.2+build.42', '0.3.0-beta.2'), 0);
  for (const invalid of ['latest', '0.3', '0.03.0', '0.3.0-beta.02', '0.3.0-', '0.3.0-beta..1']) assert.throws(() => compareVersions(invalid, '0.3.0'));
});
test('release selection includes beta, excludes drafts, ignores creation order and untrusted URLs/assets', () => {
  const candidates = [release('v0.3.0-beta.2'), release('v9.0.0', { draft: true }), release('v0.3.0'), release('v0.3.0-beta.10')];
  assert.equal(newestRelease(candidates)?.version, '0.3.0');
  assert.equal(newestRelease(candidates.filter(r => r.tag_name !== 'v0.3.0'))?.version, '0.3.0-beta.10');
  assert.equal(newestRelease([release('v99.0.0', { html_url: 'https://evil.example/update' }), release('v0.3.0-beta.2')])?.version, '0.3.0-beta.2');
  assert.equal(newestRelease([release('v99.0.0', { published_at: null })]), undefined);
  assert.equal(newestRelease([release('v0.3.0', { assets: [{ name: 'Kotoba-Setup-0.3.0-x64.exe', state: 'uploaded', size: 100, browser_download_url: 'https://evil.example/setup.exe' }] })])?.downloadUrl, undefined);
  for (const bad of ['http://github.com/GrayJS/Kotoba/releases/tag/v1.0.0', 'https://github.com.evil.example/GrayJS/Kotoba/releases/tag/v1.0.0', 'https://github.com/Other/Kotoba/releases/tag/v1.0.0', 'https://user:secret@github.com/GrayJS/Kotoba/releases/tag/v1.0.0', 'https://github.com/GrayJS/Kotoba/releases/tag/v1.0.0?token=secret', 'file:///C:/setup.exe']) assert.equal(trustedProjectUrl(bad), false);
});
test('checker finds newer beta and stable releases, reports no update, and opens only selected trusted targets', async () => {
  const opened: string[] = []; let latest = 'v0.3.0-beta.2';
  const checker = new UpdateChecker('0.3.0-beta.1', () => {}, async url => { opened.push(url); }, async () => json([release(latest)]));
  await checker.check(); assert.equal(checker.value.status, 'available'); assert.equal(checker.value.prerelease, true);
  await checker.open('release'); await checker.open('download'); assert.equal(opened.length, 2);
  await assert.rejects(checker.open('https://evil.example' as any));
  latest = 'v0.3.0'; await checker.check(); assert.equal(checker.value.status, 'available'); assert.equal(checker.value.prerelease, false);
  latest = 'v0.3.0-beta.1'; await checker.check(); assert.equal(checker.value.status, 'latest'); await assert.rejects(checker.open('release'));
  latest = 'v0.2.0'; await checker.check(); assert.equal(checker.value.status, 'latest');
});
test('checker paginates the releases endpoint without credentials, coalesces clicks, and retries HTTP/network failures', async () => {
  let mode = 'pages'; let calls = 0; const statuses: string[] = [];
  const server = createServer((req, res) => {
    calls++; assert.equal(req.headers.authorization, undefined); assert.equal(req.headers.cookie, undefined);
    assert.match(req.headers.accept || '', /github\+json/);
    if (mode === 'rate') { res.writeHead(403); res.end(); return; }
    res.setHeader('Content-Type', 'application/json');
    if (mode === 'invalid') { res.end('{}'); return; }
    if (mode === 'pages' && new URL(req.url!, 'http://localhost').searchParams.get('page') === '1') res.end(JSON.stringify(Array.from({ length: 100 }, () => release('v0.3.0-beta.1'))));
    else res.end(JSON.stringify([release('v0.3.0-beta.2')]));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const realFetch = fetch;
  const checker = new UpdateChecker('0.3.0-beta.1', s => statuses.push(s.status), async () => {}, async (input, init) => {
    const url = new URL(String(input)); assert.equal(url.origin, 'https://api.github.com'); assert.equal(url.pathname, '/repos/GrayJS/Kotoba/releases');
    assert.equal(init?.redirect, 'error'); assert.equal(init?.credentials, 'omit'); assert(init?.signal);
    if (mode === 'network') throw new Error('private-proxy-password DO NOT EXPOSE');
    if (mode === 'timeout') throw new DOMException('mock timeout', 'TimeoutError');
    return realFetch(`http://127.0.0.1:${(server.address() as any).port}${url.search}`, init);
  });
  try {
    const one = checker.check(); const two = checker.check(); assert.equal(one, two); await one;
    assert.equal(calls, 2); assert.equal(checker.value.status, 'available'); assert.equal(statuses[0], 'checking');
    mode = 'rate'; await checker.check(); assert.equal(checker.value.status, 'error'); assert.match(checker.value.message, /受限/);
    assert.equal(checker.value.downloadUrl, undefined); await assert.rejects(checker.open('download'));
    for (mode of ['invalid', 'network', 'timeout']) { await checker.check(); assert.equal(checker.value.status, 'error'); assert(!checker.value.message.includes('password')); }
    mode = 'ok'; await checker.check(); assert.equal(checker.value.status, 'available');
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
