const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable, Readable } = require('node:stream');
const ts = require('typescript');
const checks = [];
const tick = () => new Promise(resolve => setImmediate(resolve));
function load(file, overrides = {}, globals = {}) {
  const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, esModuleInterop: true } }).outputText;
  const exports = {};
  vm.runInNewContext(js, { exports, require: id => overrides[id] ?? require(id), Buffer, URL, process, console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, ...globals }, { filename: file });
  return exports;
}
async function check(name, fn) { await fn(); checks.push(name); console.log('PASS ' + name); }
(async () => {
  const children = [];
  const timers = new Map(); let nextTimer = 1;
  function spawn() {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.sent = []; child.closed = false;
    child.stdin = new Writable({ write(chunk, encoding, callback) {
      const msg = JSON.parse(chunk.toString()); child.sent.push(msg); callback();
      if (msg.method === 'initialize') queueMicrotask(() => child.stdout.write(JSON.stringify({ id: msg.id, result: { userAgent: 'test' } }) + '\n'));
    } });
    child.kill = () => { child.killed = true; child.closed = true; child.emit('close', null, 'SIGTERM'); }; children.push(child); return child;
  }
  const { createAppServer } = load('src/main/appServer.ts', { 'node:child_process': { spawn } }, {
    setTimeout: (fn, ms) => { const id = nextTimer++; timers.set(id, {fn, ms}); return id; }, clearTimeout: id => timers.delete(id),
  });
  const notifications = []; let exits = 0; let respond = () => ({});
  const server = createAppServer({ codexPath: 'test-only', codeHome: 'test-only', onNotification: n => notifications.push(n), onExit: () => exits++, onServerRequest: req => respond(req) });
  await server.start(); const child = children.at(-1);
  await check('initialize handshake completes and cancels its timeout', async () => {
    assert.equal(child.sent[0].method, 'initialize'); assert.equal(child.sent[1].method, 'initialized'); assert.equal(timers.size, 0);
  });
  await check('UTF-8 Chinese and emoji survive every byte split in JSONL', async () => {
    const delta = '糖果盒中文😀';
    const line = Buffer.from(JSON.stringify({ method: 'item/agentMessage/delta', params: { itemId: 'a', delta } }) + '\n');
    for (const byte of line) child.stdout.write(Buffer.from([byte]));
    await tick(); assert.equal(notifications.at(-1).params.delta, delta);
  });
  await check('concurrent RPC replies are paired by id and release timers', async () => {
    const one = server.request('turn/start', { threadId: 'one' }); const two = server.request('thread/read', { threadId: 'two' });
    const a = child.sent.at(-2); const b = child.sent.at(-1);
    child.stdout.write(JSON.stringify({id: b.id, result: 'two'})+'\n'+JSON.stringify({id: a.id, result: 'one'})+'\n');
    assert.equal(await one, 'one'); assert.equal(await two, 'two'); assert.equal(timers.size, 0);
  });
  await check('RPC errors use readable server messages and clear timers', async () => {
    const result = server.request('thread/read', {});
    child.stdout.write(JSON.stringify({id: child.sent.at(-1).id, error: { code: -1, message: 'Readable failure' }})+'\n');
    await assert.rejects(result, /Readable failure/); assert.equal(timers.size, 0);
  });
  await check('synchronous approval-handler exceptions return JSON-RPC errors', async () => {
    respond = () => { throw new Error('Approval callback failed'); };
    child.stdout.write(JSON.stringify({ id: 'approval-id', method: 'item/tool/requestUserInput', params: {} })+'\n');
    await tick(); assert.equal(child.sent.at(-1).id, 'approval-id'); assert.equal(child.sent.at(-1).error.code, -32603);
  });
  let release; respond = () => new Promise(resolve => { release = resolve; });
  child.stdout.write(JSON.stringify({ id: 500, method: 'item/tool/requestUserInput', params: {} })+'\n'); await tick();
  await check('stop rejects in-flight RPCs immediately and cancels timers', async () => {
    const request = server.request('turn/start', {});
    const stopped = server.stop();
    await assert.rejects(request, /已停止/); await stopped;
    assert.equal(timers.size, 0); assert.equal(child.killed, true);
  });
  await server.start(); const restarted = children.at(-1);
  await check('restarting cannot receive an old process approval response or exit', async () => {
    release({ answers: {} }); child.emit('exit', 0); await tick();
    assert.equal(restarted.sent.some(msg => msg.id === 500), false); assert.equal(exits, 0);
    const request = server.request('model/list', {}); restarted.stdout.write(JSON.stringify({ id: restarted.sent.at(-1).id, result: [] })+'\n'); await request;
  });
  await check('actual process exit rejects pending calls exactly once', async () => {
    const request = server.request('thread/read', {}); restarted.emit('exit', 1); restarted.emit('close', 1);
    await assert.rejects(request, /已退出/); assert.equal(exits, 1); assert.equal(timers.size, 0);
  });
  await server.start();
  await check('broken stdin rejects pending RPCs without an unhandled stream error', async () => {
    const latest = children.at(-1); const request = server.request('turn/start', {});
    latest.stdin.emit('error', new Error('EPIPE')); await assert.rejects(request, /输入管道已断开/);
    latest.emit('exit', 1); latest.emit('close', 1); assert.equal(exits, 2); assert.equal(timers.size, 0); assert.equal(latest.killed, true);
  });
  let handler; const upstreamRequests = [];
  const fakeHttp = { createServer(fn) { handler = fn; const server = new EventEmitter(); server.listen = (port, host, cb) => cb(); server.address = () => ({ port: 18991 }); server.close = () => {}; return server; } };
  const fakeNet = { request(options) {
    const request = new EventEmitter(); request.options = options; request.headers = {}; request.chunks = []; request.aborted = false;
    request.setHeader = (key, value) => { request.headers[key] = value; }; request.write = value => request.chunks.push(Buffer.from(value)); request.end = () => {}; request.abort = () => { request.aborted = true; };
    upstreamRequests.push(request); return request;
  } };
  const relay = load('src/main/relayCompat.ts', { 'node:http': fakeHttp, electron: { net: fakeNet } });
  await relay.startRelayCompatServer(); relay.setRelayCompatUpstream('https://example.invalid/v1');
  async function invoke(body) {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]); req.method = 'POST'; req.url = '/v1/responses'; req.headers = {'content-type':'application/json'};
    const res = new EventEmitter(); res.destroyed = false; res.writableEnded = false; res.headersSent = false; res.chunks = [];
    res.writeHead = (status, headers) => { res.status = status; res.headersSent = true; }; res.write = chunk => { res.chunks.push(Buffer.from(chunk)); return true; };
    res.end = chunk => { if(chunk) res.write(chunk); res.writableEnded = true; res.emit('close'); }; res.destroy = () => { res.destroyed = true; res.emit('close'); };
    handler(req, res); await tick(); await tick(); return { res, upstream: upstreamRequests.at(-1) };
  }
  const body = { input: [{type:'reasoning',id:'r'}, {type:'message',role:'assistant',phase:'commentary',content:'Checking'}, {type:'function_call_output',call_id:'x',output:'ok'}], tools:[{type:'namespace',name:'test',tools:[{type:'function',name:'read',parameters:{type:'object'}}]}] };
  const request = await invoke(body);
  await check('relay retains commentary and tool outputs while adapting known gateway types', async () => {
    const sent = JSON.parse(Buffer.concat(request.upstream.chunks));
    assert.equal(sent.input.length,2); assert.equal(sent.input[0].phase,'commentary'); assert.equal(sent.input[1].call_id,'x'); assert.equal(sent.tools[0].name,'read');
    assert.equal(request.upstream.options.url,'https://example.invalid/v1/responses');
  });
  await check('SSE output is relayed byte for byte without rewriting phases', async () => {
    const response = new EventEmitter(); response.statusCode=200; response.headers={'content-type':'text/event-stream'};
    request.upstream.emit('response',response);
    const chunks = [Buffer.from('data: {"phase":"final_answer",'),Buffer.from('"text":"中文😀"}\n\n')];
    chunks.forEach(chunk=>response.emit('data',chunk)); response.emit('end');
    assert.deepEqual(Buffer.concat(request.res.chunks),Buffer.concat(chunks)); assert.equal(request.upstream.aborted,false);
  });
  await check('downstream cancellation aborts the upstream generation request', async () => {
    const { res, upstream }=await invoke({input:[]}); res.destroy(); assert.equal(upstream.aborted,true);
  });
  await check('mid-stream errors close the stream instead of appending invalid JSON', async () => {
    const {res,upstream}=await invoke({input:[]}); const response=new EventEmitter(); response.statusCode=200; response.headers={}; upstream.emit('response',response);
    response.emit('data',Buffer.from('data: partial')); upstream.emit('error',new Error('broken stream'));
    assert.equal(res.destroyed,true); assert.equal(Buffer.concat(res.chunks).toString(),'data: partial');
  });
  relay.stopRelayCompatServer();
  fs.mkdirSync('artifacts/flow-observation/transport', { recursive: true });
  fs.writeFileSync('artifacts/flow-observation/transport/results.json', JSON.stringify({ checks, modelCalls:0, screenshots:0, timestamp:new Date().toISOString() },null,2));
  console.log('All '+checks.length+' transport checks passed.');
})().catch(e=>{console.error(e);process.exitCode=1;});
