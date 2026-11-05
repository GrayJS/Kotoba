import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkerClient } from '../electron/worker-client';
const program = `console.log(JSON.stringify({type:'worker_ready'}));
const rl = require('node:readline').createInterface({input:process.stdin});
rl.on('line', line => { const command=JSON.parse(line); if(command.action==='quit') process.exit(0); console.log(JSON.stringify({type:'ack',value:command.action})); });`;
test('worker handshake, command delivery and process crash are handled without breaking the host', async () => {
  let ack!: () => void; let crashed!: (message: string) => void;
  const received = new Promise<void>(resolve => { ack = resolve; });
  const ended = new Promise<string>(resolve => { crashed = resolve; });
  const client = new WorkerClient(process.execPath, ['-e', program], process.env, event => { if (event.type === 'ack' && event.value === 'start') ack(); }, crashed);
  try {
    await client.send({ action: 'start' }); await received;
    client.child!.kill();
    assert.match(await ended, /退出/);
    assert.equal(client.child, null);
  } finally { client.dispose(); }
});
test('missing worker executable produces an actionable startup error', async () => {
  const client = new WorkerClient('Z:\\nonexistent-kotoba-worker.exe', [], process.env, () => {}, () => {});
  try { await assert.rejects(client.send({ action: 'check' }), /无法启动/); }
  finally { client.dispose(); }
});
