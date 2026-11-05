import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { DEFAULT_CONFIG } from '../electron/config';
import { checkOllama, translate } from '../electron/ollama';
test('Ollama adapter validates availability and sends bounded subtitle-only context', async () => {
  let payload: any; let broken = false;
  const server = createServer((req, res) => {
    if (broken) { res.writeHead(503); res.end(); return; }
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/tags') { res.end(JSON.stringify({ models: [{ name: DEFAULT_CONFIG.ollama.model }] })); return; }
    let text = ''; req.on('data', chunk => { text += chunk; }); req.on('end', () => { payload = JSON.parse(text); res.end(JSON.stringify({ message: { content: '今天去哪里？' } })); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as any;
  const config = { ...DEFAULT_CONFIG, ollama: { ...DEFAULT_CONFIG.ollama, baseUrl: `http://127.0.0.1:${address.port}` } };
  try {
    await checkOllama(config);
    assert.equal(await translate(config, '今日はどこへ行く？', [{ japanese: '昨日', chinese: '昨天' }], new AbortController().signal), '今天去哪里？');
    assert.equal(payload.stream, false); assert.equal(payload.options.num_ctx, 4096); assert.equal(payload.messages.length, 4);
    await assert.rejects(checkOllama({ ...config, ollama: { ...config.ollama, model: 'missing:4b' } }), /找不到/);
    broken = true; await assert.rejects(translate(config, '日文', [], new AbortController().signal), /503/);
  } finally { await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
});
