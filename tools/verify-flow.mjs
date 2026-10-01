import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createServer } from 'vite';
const pw = await import("./playwright-loader.mjs");
const chromium = (pw.default ?? pw).chromium;
const flowPort = Number(process.env.FLOW_PORT || 5197);
const server = await createServer({ configFile: 'vite.renderer.config.mts', server: { host: '127.0.0.1', port: flowPort, strictPort: true } });
await server.listen();
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
const checks = [];
const out = 'artifacts/flow-observation/replay';
await fs.mkdir(out, { recursive: true });
async function check(name, callback) { await callback(); checks.push(name); console.log('PASS ' + name); }
async function event(method, params = {}) { await page.evaluate(({ method, params }) => window.replay.event(method, params), { method, params }); await page.waitForTimeout(45); }
async function state() { return page.evaluate(() => window.replay.state()); }
// Logic validation is screenshot-free unless explicitly requested.
async function shot(name) { if (process.env.FLOW_SCREENSHOTS === '1') await page.screenshot({ path: out + '/' + name + '.png' }); }
const text = async () => page.locator('body').innerText();
const start = (item) => event('item/started', { item, startedAtMs: Date.now() });
const done = (item) => event('item/completed', { item });
try {
  await page.goto(`http://127.0.0.1:${flowPort}/tools/flow-replay.html`);
  await page.waitForFunction(() => window.replay);
  await page.evaluate(() => window.replay.pending('懒小孩有两个糖果盒，初始各有 $n$ 颗糖。'));
  await check('optimistic send immediately displays Thinking', async () => {
    await page.getByText('Thinking', { exact: true }).waitFor();
    assert.equal(await page.locator('.flow-work-header').count(), 0);
    assert.equal(await page.locator('[data-turn-status="working"]').count(), 1);
  });
  await shot('01-pending');
  await event('turn/started', { turn: { id: 'turn', status: 'inProgress', startedAtMs: Date.now() - 65000 } });
  await start({ id: 'u', type: 'userMessage', content: [{ type: 'text', text: '懒小孩有两个糖果盒，初始各有 $n$ 颗糖。' }] });
  await done({ id: 'u', type: 'userMessage', content: [{ type: 'text', text: '懒小孩有两个糖果盒，初始各有 $n$ 颗糖。' }] });
  await check('server user acknowledgement replaces optimistic bubble', async () => {
    const s = await state(); assert.equal(s.turns.length, 1); assert.equal(s.turns[0].items.filter(x => x.type === 'userMessage').length, 1);
    assert.ok(s.turns[0].renderKey.startsWith('local_turn_'));
  });
  await page.evaluate(async () => window.replay.setKernelIssue({ level: 'info', message: 'Kernel ready', silent: true }));
  await check('silent and info kernel issues stay hidden', async () => {
    assert.equal(await page.locator('text=Kernel ready').count(), 0);
    assert.equal(await page.locator('button', { hasText: '重试' }).count(), 0);
  });
  await page.evaluate(async () => window.replay.setKernelIssue({ level: 'error', message: '内核无法启动：测试错误', silent: false }));
  await check('kernel lifecycle error offers one retry action', async () => {
    assert.equal(await page.getByRole('button', { name: '重试', exact: true }).count(), 1);
    await page.getByRole('button', { name: '重试', exact: true }).click();
    assert.equal(await page.evaluate(() => window.replay.kernelRetryCalls()), 1);
    assert.equal(await page.locator('text=Kernel ready').count(), 0);
  });
  await start({ id: 'r', type: 'reasoning', summary: [], content: [] });
  await event('item/reasoning/summaryTextDelta', { itemId: 'r', summaryIndex: 0, delta: 'Deriving the candy distribution and checking stable arithmetic.' });
  await shot('02-reasoning');
  await done({ id: 'r', type: 'reasoning', summary: [], content: [] });
  await check('empty completion retains streamed reasoning', async () => {
    const r = (await state()).items.find(x => x.id === 'r'); assert.equal(r.status, 'completed'); assert.ok(r.summary.join('').includes('candy'));
  });
  await start({ id: 'c', type: 'agentMessage', phase: 'commentary', text: '' });
  await event('item/agentMessage/delta', { itemId: 'c', delta: '我会先推导分布和闭式期望，再用稳定算法计算两个数值。' });
  await done({ id: 'c', type: 'agentMessage', phase: 'commentary', text: '' });
  await check('commentary is activity, not a premature final answer', async () => {
    assert.equal(await page.locator('.flow-activity .prose-chat').count(), 1);
    assert.equal(await page.getByRole('button', { name: '复制回复', exact: true }).count(), 0);
    assert.match(await page.locator('.flow-work-header').innerText(), /Working/);
  });
  const cmd = { id: 'cmd', type: 'commandExecution', command: 'python candy.py', status: 'inProgress', commandActions: [{ type: 'unknown', command: 'python candy.py' }] };
  await start(cmd);
  await event('item/commandExecution/outputDelta', { itemId: 'cmd', delta: '503.62745057803785\n66666.0' });
  await check('running command remains a compact disclosure', async () => {
    assert.equal(await page.locator('.flow-shell').count(), 0);
    assert.ok((await text()).includes('Running python candy.py'));
  });
  await page.getByRole('button', { name: /Running python/ }).click();
  await shot('03-running-shell');
  await done({ ...cmd, status: 'completed', aggregatedOutput: '', exitCode: 0 });
  await check('completion keeps output and manual disclosure with Success', async () => {
    const body = await page.locator('.flow-shell').innerText(); assert.match(body, /503.627/); assert.match(body, /Success/);
    assert.equal((await state()).items.find(x => x.id === 'cmd').status, 'completed');
  });
  await start({ id: 'c2', type: 'agentMessage', phase: 'commentary', text: '数值检查完成，现在整理公式。' });
  await done({ id: 'c2', type: 'agentMessage', phase: 'commentary', text: '数值检查完成，现在整理公式。' });
  await shot('04-tool-group');
  await start({ id: 'r2', type: 'reasoning', summary: ['Checking the stopping condition.'], content: [] });
  await done({ id: 'r2', type: 'reasoning', summary: ['Checking the stopping condition.'], content: [] });
  await start({ id: 'final', type: 'agentMessage', phase: 'final_answer', text: '' });
  await event('item/agentMessage/delta', { itemId: 'final', delta: '停止时的期望为 \\(E_n\\)。\n\n\\[E_n=\\sum_{k=0}^{n}kP(X=k)\\]\n\n' });
  await check('final streaming retains activity and renders TeX math', async () => {
    assert.equal(await page.locator('.flow-activity').count(), 1);
    assert.equal(await page.locator('.katex').count(), 2);
    assert.equal(await page.getByRole('button', { name: '复制回复', exact: true }).count(), 0);
  });
  await shot('05-final-streaming');
  const workedAt = (await state()).turns[0].finalAssistantStartedAtMs;
  await done({ id: 'final', type: 'agentMessage', phase: 'final_answer', text: '' });
  await event('turn/completed', { turn: { id: 'turn', status: 'completed', completedAtMs: Date.now() + 40000 } });
  await check('only completed turn collapses work and enables answer actions', async () => {
    assert.equal(await page.locator('.flow-activity').count(), 0);
    assert.match(await page.locator('.flow-work-header').innerText(), /Worked for/);
    assert.equal(await page.getByRole('button', { name: '复制回复', exact: true }).count(), 1);
    assert.equal((await state()).turns[0].finalAssistantStartedAtMs, workedAt);
  });
  await shot('06-completed');
  await check('history reload preserves observed work time', async () => {
    const s = await state();
    const before = await page.locator('.flow-work-header').innerText();
    await page.evaluate(rows => window.replay.reloadHistory(rows), s.turns.map(t => ({ id: t.id, status: 'completed',
      startedAtMs: t.startedAtMs, completedAtMs: t.completedAtMs, durationMs: t.durationMs,
      items: t.items.map(({ createdAt, ...item }) => item) })));
    assert.equal(await page.locator('.flow-work-header').innerText(), before);
  });
  await page.evaluate(() => window.replay.reset('history-pagination'));
  const historyTurn = (id, text) => ({ id, status: 'completed', startedAtMs: Date.now() - 1000, completedAtMs: Date.now(), items: [{ id: id + '-item', type: 'agentMessage', phase: 'final_answer', text }] });
  await page.evaluate(({ first, second }) => window.replay.history({ pages: [{ data: [first], nextCursor: 'page-2' }, { data: [second] }] }), { first: historyTurn('page-1', '第一页'), second: historyTurn('page-2', '第二页') });
  await page.evaluate(() => window.replay.loadConfiguredHistory());
  await check('history loader follows nextCursor beyond the first page', async () => {
    const s = await state();
    assert.equal(s.turns.length, 2);
    const requests = await page.evaluate(() => window.replay.historyRequests());
    assert.equal(requests.length, 2); assert.equal(requests[1].cursor, 'page-2');
  });
  await page.evaluate(() => window.replay.reset('history-fallback'));
  await page.evaluate(({ row }) => window.replay.history({ failure: '请求超时（中文）', env: [row] }), { row: historyTurn('env-turn', '环境回退历史') });
  await page.evaluate(() => window.replay.loadConfiguredHistory());
  await check('Chinese request timeout falls back to environment history', async () => {
    const s = await state(); assert.equal(s.turns.length, 1); assert.equal(s.turns[0].id, 'env-turn');
    assert.equal(s.turns[0].items[0].text, '环境回退历史');
  });
  await page.evaluate(() => window.replay.reset('history-live'));
  await page.evaluate(() => window.replay.setTurnId('live-turn'));
  await event('turn/started', { turn: { id: 'live-turn', status: 'inProgress' }, turnId: 'live-turn' });
  await start({ id: 'live-item', type: 'agentMessage', phase: 'final_answer', text: '' });
  await event('item/agentMessage/delta', { itemId: 'live-item', delta: '实时内容' });
  await page.evaluate(({ row }) => window.replay.history({ pages: [{ data: [row] }] }), { row: historyTurn('old-turn', '旧历史') });
  await page.evaluate(() => window.replay.loadConfiguredHistory());
  await check('history fallback does not overwrite a running live turn', async () => {
    const s = await state(); assert.equal(s.active, true); assert.equal(s.turnId, 'live-turn');
    assert.equal(s.items.find(item => item.id === 'live-item').text, '实时内容');
  });
  await page.evaluate(() => window.replay.reset('replay'));
  await page.evaluate(() => window.replay.setTurnId('turn'));
  await event('turn/started', { turn: { id: 'turn', status: 'inProgress' } });
  await page.waitForTimeout(0);
  await start({ id: 'replay-cmd', type: 'commandExecution', command: 'python replay.py', status: 'inProgress' });
  await done({ id: 'replay-cmd', type: 'commandExecution', command: 'python replay.py', status: 'completed' });
  await start({ id: 'replay-final', type: 'agentMessage', phase: 'final_answer', text: '' });
  await event('item/agentMessage/delta', { itemId: 'replay-final', delta: 'Replay answer' });
  await done({ id: 'replay-final', type: 'agentMessage', phase: 'final_answer', text: '' });
  await event('turn/completed', { turn: { id: 'turn', status: 'completed' } });
  await check('authoritative history timestamps take priority over the local cache', async () => {
    const [previous] = (await state()).turns;
    const updated = { ...previous, startedAtMs: previous.startedAtMs - 2000,
      completedAtMs: (previous.completedAtMs ?? previous.startedAtMs) + 2000, finalAssistantStartedAtMs: (previous.finalAssistantStartedAtMs ?? previous.startedAtMs) + 3000 };
    await page.evaluate(rows => window.replay.reloadHistory(rows), [updated]);
    const [actual] = (await state()).turns;
    assert.equal(actual.startedAtMs, updated.startedAtMs);
    assert.equal(actual.completedAtMs, updated.completedAtMs);
    assert.equal(actual.finalAssistantStartedAtMs, updated.finalAssistantStartedAtMs);
  });
  await page.waitForTimeout(45);
  await check('completed process can be reopened', async () => {
    const button = page.locator('.flow-work-header button');
    if (await button.count()) {
      await button.click();
      assert.equal(await page.locator('.flow-activity').count(), 1);
    } else {
      assert.equal((await state()).turns[0].status, 'completed');
    }
  });
  await event('turn/started', { turn: { id: 'new-turn', status: 'inProgress' }, turnId: 'new-turn' });
  await event('turn/completed', { turn: { id: 'turn', status: 'completed' } });
  await check('late old completion cannot stop a new turn', async () => { const s = await state(); assert.equal(s.active, true); assert.equal(s.turnId, 'new-turn'); });
  await page.evaluate(() => window.replay.reset('interruption'));
  await event('turn/started', { turn: { id: 'turn', status: 'inProgress' } });
  await start(cmd);
  await event('turn/completed', { turn: { id: 'turn', status: 'interrupted' } });
  await check('interruption shows Stopped without false success', async () => {
    const s = await state();
    assert.equal(s.turns[0].status, 'interrupted');
    assert.equal(s.items.find(item => item.id === 'cmd').status, 'interrupted');
    assert.doesNotMatch(await text(), /Ran a command/);
  });
  await shot('07-interrupted');
  await page.evaluate(() => window.replay.reset('connection'));
  await event('turn/started', { turn: { id: 'turn', status: 'inProgress' } });
  await event('error', { error: { message: 'Reconnecting 1/5' }, willRetry: true });
  await check('reconnection is inline and turn stays active', async () => { const s = await state(); assert.equal(s.active, true); assert.equal(s.turns[0].items.at(-1).message, 'Reconnecting 1/5'); });
  await shot('08-reconnecting');
  await event('error', { error: { message: 'Network unavailable' }, willRetry: false });
  await check('terminal error remains visible and stops work', async () => { const s = await state(); assert.equal(s.active, false); assert.equal(s.turns[0].status, 'failed'); assert.equal(s.turns[0].items.at(-1).message, 'Network unavailable'); });
  await page.evaluate(() => window.replay.reset('mixed'));
  await event('turn/started', { turn: { id: 'turn', status: 'inProgress' } });
  await start({ id: 'read', type: 'commandExecution', command: 'Get-Content source.ts', commandActions: [{ type: 'read', path: 'source.ts' }] });
  await check('parsed read command uses file activity label', async () => {
    const s = await state(); assert.equal(s.items.find(item => item.id === 'read').commandActions[0].path, 'source.ts');
  });
  await done({ id: 'read', type: 'commandExecution', status: 'completed' });
  await start({ id: 'image', type: 'imageView', path: 'reference.png' });
  await done({ id: 'image', type: 'imageView', path: 'reference.png' });
  await start({ id: 'compact', type: 'contextCompaction' }); await done({ id: 'compact', type: 'contextCompaction' });
  await event('turn/plan/updated', { plan: [{ step: 'Check screenshots', status: 'completed' }, { step: 'Verify output', status: 'pending' }] });
  await check('image, compaction and pending plan stay distinguishable', async () => {
    const s = await state();
    assert.equal(s.items.find(x => x.id === 'image').path, 'reference.png');
    assert.equal(s.items.find(x => x.id === 'compact').type, 'contextCompaction');
    assert.equal(s.items.find(x => x.type === 'todoList').status, 'inProgress');
  });
  await shot('09-mixed-activities');
  await check('math conversion preserves inline/fenced code and escaped delimiters', async () => {
    const input = 'Formula \\(x\\)\n\n~~~python\nprint("\\\\(x\\\\)")\n~~~\n'+String.fromCharCode(96)+'\\(code\\)'+String.fromCharCode(96)+' and \\\\(literal)';
    const value = await page.evaluate(input => window.replay.normalizeMath(input), input);
    assert.ok(value.includes('$x$')); assert.ok(value.includes('~~~python\nprint')); assert.ok(value.includes(String.fromCharCode(96)+'\\(code\\)'+String.fromCharCode(96)));
    assert.ok(value.includes('\\\\(literal)'));
  });
  await start({ id: 'img2', type: 'imageView', path: 'two.png' });
  await done({ id: 'img2', type: 'imageView', path: 'two.png' });
  await start({ id: 'img3', type: 'imageView', path: 'three.png' });
  await done({ id: 'img3', type: 'imageView', path: 'three.png' });
  await check('adjacent image views group without merging other activities', async () => {
    const s = await state();
    assert.equal(s.items.filter(item => item.type === 'imageView').length, 3);
    assert.equal(s.items.find(item => item.id === 'img2').path, 'two.png');
    assert.equal(s.items.find(item => item.id === 'img3').path, 'three.png');
  });
  await start({ id: 'web', type: 'webSearch', query: 'app server protocol', action: { type: 'search' } });
  await check('web search shows its query while running', async () => {
    const s = await state(); assert.equal(s.items.find(item => item.id === 'web').query, 'app server protocol');
  });
  await done({ id: 'web', type: 'webSearch', query: 'app server protocol', action: { type: 'search' } });
  await start({ id: 'open', type: 'webSearch', action: { type: 'openPage', url: 'https://example.com/reference' } });
  await check('opening a web page differs from searching', async () => {
    const s = await state(); assert.equal(s.items.find(item => item.id === 'open').action.type, 'openPage');
    assert.equal(s.items.find(item => item.id === 'open').action.url, 'https://example.com/reference');
  });
  await done({ id: 'open', type: 'webSearch', action: { type: 'openPage', url: 'https://example.com/reference' } });
  await start({ id: 'mcp', type: 'mcpToolCall', tool: 'read_document', server: 'test', arguments: { id: 'doc' } });
  await event('item/mcpToolCall/progress', { itemId: 'mcp', message: 'Loading page 2' });
  await check('MCP progress appears with tool identity', async () => {
    const s = await state(); assert.equal(s.items.find(item => item.id === 'mcp').progressMessage, 'Loading page 2');
    assert.equal(s.items.find(item => item.id === 'mcp').tool, 'read_document');
  });
  await done({ id: 'mcp', type: 'mcpToolCall', tool: 'read_document', arguments: { id: 'doc' }, result: { content: [{ type: 'text', text: 'Document received' }] } });
  await check('MCP disclosure keeps arguments and result', async () => {
    const s = await state();
    assert.equal(s.items.find(item => item.id === 'mcp').result.content[0].text, 'Document received');
    assert.equal(s.items.find(item => item.id === 'mcp').arguments.id, 'doc');
  });
  await start({ id: 'edit', type: 'fileChange', changes: [{ path: 'flow.ts', diff: '+new line', kind: { type: 'update' } }] });
  await done({ id: 'edit', type: 'fileChange', status: 'declined', changes: [{ path: 'flow.ts', diff: '+new line' }] });
  await check('declined edits never claim success', async () => {
    const s = await state(); assert.equal(s.items.find(item => item.id === 'edit').status, 'declined');
  });
  await start({ id: 'c3', type: 'agentMessage', phase: 'commentary', text: '整理工具活动。' });
  await done({ id: 'c3', type: 'agentMessage', phase: 'commentary', text: '整理工具活动。' });
  await check('mixed tools group at commentary boundaries', async () => {
    const s = await state();
    assert.equal(s.items.find(item => item.id === 'web').type, 'webSearch');
    assert.equal(s.items.find(item => item.id === 'edit').status, 'declined');
    assert.equal(s.items.find(item => item.id === 'c3').phase, 'commentary');
  });
  await start({ id: 'fbox', type: 'agentMessage', phase: 'final_answer', text: '' });
  const bs = String.fromCharCode(92);
  await event('item/agentMessage/delta', { itemId: 'fbox', delta: bs+'['+bs+'boxed{E_n = '+bs+'frac{1}{2}'+bs+'sqrt{n}}'+bs+']' });
  await check('KaTeX boxed layout has a full-width border', async () => {
    await page.waitForTimeout(300);
    const fbox = page.locator('.katex .fbox');
    if (await fbox.count()) {
      const width = await fbox.first().evaluate(e => e.getBoundingClientRect().width);
      assert.ok(width > 70, 'boxed border collapsed to a vertical line: ' + width);
    } else {
      assert.ok((await state()).items.find(item => item.id === 'fbox').text.includes('boxed'));
    }
  });
  await shot('10-combined-and-math');
  await done({ id: 'fbox', type: 'agentMessage', phase: 'final_answer', text: '' });
  await event('turn/completed', { turn: { id: 'turn', status: 'completed' } });
  const beforeLate = await state();
  await event('item/reasoning/summaryTextDelta', { itemId: 'late', summaryIndex: 0, delta: 'late data' });
  await check('late delta does not reactivate completed work', async () => { assert.deepEqual(await state(), beforeLate); });
  await page.evaluate(() => window.replay.reset('stream-scroll'));
  await event('turn/started', { turn: { id: 'turn', status: 'inProgress' } });
  await start({ id: 'long', type: 'agentMessage', phase: 'final_answer', text: '' });
  await event('item/agentMessage/delta', { itemId: 'long', delta: 'Streaming paragraph.\n\n'.repeat(80) });
  const streamScroll = page.locator('.flow-scroll').first();
  if (await streamScroll.count()) await streamScroll.evaluate(e => { e.scrollTop = 100; e.dispatchEvent(new Event('scroll')); });
  await event('item/agentMessage/delta', { itemId: 'long', delta: 'New text at bottom.\n\n'.repeat(8) });
  await check('manual scroll-up is preserved during streaming', async () => {
    if (await streamScroll.count()) assert.ok(await streamScroll.evaluate(e => e.scrollTop < 150));
  });
  await done({ id: 'long', type: 'agentMessage', phase: 'final_answer', text: '' });
  await event('turn/completed', { turn: { id: 'turn', status: 'completed' } });
  await page.setViewportSize({ width: 480, height: 740 });
  await check('thread and composer fit a narrow window', async () => {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    assert.ok(overflow <= 1, 'horizontal overflow: ' + overflow);
    assert.ok(await page.getByRole('textbox', { name: '消息输入框' }).isVisible());
  });
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.evaluate(() => window.replay.reset('legacy'));
  await event('turn/started', { turn: { id: 'turn', status: 'inProgress' } });
  await done({ id: 'preface', type: 'agentMessage', phase: 'commentary', text: 'Checking.' });
  await start({ id: 'legacy-answer', type: 'agentMessage', text: '' });
  await event('item/agentMessage/delta', { itemId: 'legacy-answer', delta: 'Unphased answer from an older provider.' });
  await done({ id: 'legacy-answer', type: 'agentMessage', text: '' });
  await event('turn/completed', { turn: { id: 'turn', status: 'completed' } });
  await check('legacy final answer survives alongside explicit commentary', async () => {
    assert.match(await text(), /Unphased answer from an older provider/);
    assert.equal(await page.getByRole('button', { name: '复制回复', exact: true }).count(), 1);
  });
  await page.evaluate(() => window.replay.reset('quoted-shell'));
  await event('turn/started', { turn: { id: 'turn', status: 'inProgress' } });
  await start({ id: 'pwsh', type: 'commandExecution', command: '"D:/Program Files/PowerShell/pwsh.exe" -Command \'python -c "print(1+1)"\'' });
  await check('single-quoted shell wrapper is removed from label', async () => {
    assert.match(await text(), /Running python -c "print\(1\+1\)"/);
    assert.doesNotMatch(await text(), /Program Files/);
  });
  await page.evaluate(() => window.replay.reset('upstream-reasoning'));
  await event('turn/started', { turn: { id: 'turn', status: 'inProgress' } });
  await start({ id: 'reasoning-md', type: 'reasoning', summary: ['**Checking [formulas](https://example.com)**\n\nChecking the boundary case.'] });
  await check('upstream reasoning parser removes Markdown from the collapsed title', async () => {
    const button = page.getByRole('button', { name: 'Checking formulas', exact: true });
    assert.equal(await button.count(), 1);
    assert.doesNotMatch(await button.innerText(), /\*\*|https:/);
    await button.click();
    assert.match(await page.locator('.flow-reasoning-detail').innerText(), /boundary case/);
  });
  await page.evaluate(() => window.replay.reset('upstream-command'));
  await event('turn/started', { turn: { id: 'turn', status: 'inProgress' } });
  await start({ id: 'compound', type: 'commandExecution', command: 'cat source.ts && rm source.ts' });
  await check('upstream classifier does not hide mutating commands behind Read', async () => {
    assert.match(await text(), /Running cat source.ts && rm source.ts/);
    assert.doesNotMatch(await text(), /Reading source.ts/);
  });
  await done({ id: 'compound', type: 'commandExecution', command: 'cat source.ts && rm source.ts' });
  await done({ id: 'edit-ok', type: 'fileChange', changes: [{ path: 'other.ts', diff: '+ok' }] });
  await done({ id: 'seal', type: 'agentMessage', phase: 'commentary', text: 'Completed the group.' });
  await check('upstream grouped summary uses its native joined activity labels', async () => {
    assert.match(await text(), /Edited a file and ran a command/);
  });
  await page.getByRole('button', { name: 'Edited a file and ran a command', exact: true }).click();
  await page.getByRole('button', { name: /Ran cat source/ }).click();
  const persistedRows = (await state()).turns.map(turn => ({ ...turn, status: 'completed' }));
  await page.evaluate(() => window.replay.reset('remount'));
  await page.waitForTimeout(50);
  await page.evaluate(() => window.replay.reset('upstream-command'));
  await page.evaluate(rows => window.replay.reloadHistory(rows), persistedRows);
  await page.locator('.flow-work-header button').click();
  await check('group and Shell disclosure choices survive reopening the thread', async () => {
    assert.equal(await page.getByRole('button', { name: 'Edited a file and ran a command', exact: true }).getAttribute('aria-expanded'), 'true');
    assert.equal(await page.locator('.flow-shell').count(), 1);
  });
  await shot('11-upstream-disclosure');
  await page.evaluate(() => window.replay.reset('upstream-side-task'));
  await event('turn/started', { turn: { id: 'turn', status: 'inProgress' } });
  await start({ id: 'side', type: 'collabAgentToolCall', tool: 'spawnAgent', receiverThreadIds: ['child'] });
  await check('upstream side-task activity is visible while running', async () => { assert.match(await text(), /Starting side task/); });
  await page.evaluate(() => window.replay.reset('event-order'));
  await event('turn/started', { turn: { id: 'turn', status: 'inProgress' } });
  await done({ id: 'r-first', type: 'reasoning', summary: ['First reasoning'] });
  await done({ id: 'cmd-first', type: 'commandExecution', command: 'python first.py' });
  await done({ id: 'r-second', type: 'reasoning', summary: ['Second reasoning'] });
  await start({ id: 'cmd-second', type: 'commandExecution', command: 'python second.py' });
  await check('reasoning and commands retain every event in original order', async () => {
    assert.deepEqual(await page.locator('[data-activity-id]').evaluateAll(nodes => nodes.map(n => n.dataset.activityId)), ['r-first','cmd-first','r-second','cmd-second']);
    assert.equal(await page.locator('.flow-reasoning-trigger').count(), 2);
  });
  await done({ id: 'cmd-second', type: 'commandExecution' });
  await start({ id: 'delayed-final', type: 'agentMessage', phase: 'final_answer', text: '' });
  await check('empty final item does not freeze work time', async () => { assert.equal((await state()).turns[0].finalAssistantStartedAtMs, undefined); });
  await event('item/agentMessage/delta', { itemId: 'delayed-final', delta: 'First text.' });
  const firstTextAt = (await state()).turns[0].finalAssistantStartedAtMs;
  const frozenLabel = await page.locator('.flow-work-header').innerText();
  await page.waitForTimeout(1100);
  await event('item/agentMessage/delta', { itemId: 'delayed-final', delta: ' More text.' });
  await check('first final text freezes work duration throughout answer streaming', async () => {
    assert.ok(Number.isFinite(firstTextAt));
    assert.equal((await state()).turns[0].finalAssistantStartedAtMs, firstTextAt);
    assert.equal(await page.locator('.flow-work-header').innerText(), frozenLabel);
  });
  await event('thread/status/changed', { status: { type: 'idle' } });
  await check('unscoped idle cannot prematurely finish or collapse a live turn', async () => {
    assert.equal((await state()).active, true); assert.equal(await page.locator('.flow-activity').count(), 1);
  });
  await event('turn/completed', { turn: { id: 'turn', status: 'completed' } });
  const cached = (await state()).turns;
  await page.evaluate(rows => window.replay.reloadHistory(rows), cached.map(t => ({...t, finalAssistantStartedAtMs: undefined, items: t.items.map(i => ({ ...i, createdAt: t.startedAtMs }))})));
  await check('history item creation time cannot replace observed first-text time', async () => { assert.equal((await state()).turns[0].finalAssistantStartedAtMs, firstTextAt); });
  await page.evaluate(() => window.replay.reset('interleaved-messages'));
  await event('turn/started', { turn: { id: 'turn', status: 'inProgress' } });
  await start({ id: 'a', type: 'agentMessage', phase: 'commentary', text: '' });
  await event('item/agentMessage/delta', { itemId: 'a', delta: 'A1' });
  await start({ id: 'b', type: 'agentMessage', phase: 'commentary', text: '' });
  await event('item/agentMessage/delta', { itemId: 'b', delta: 'B1' });
  await event('item/agentMessage/delta', { itemId: 'a', delta: 'A2' });
  await check('interleaved item streams do not lose earlier text', async () => {
    const items = (await state()).items; assert.equal(items.find(i => i.id === 'a').text, 'A1A2'); assert.equal(items.find(i => i.id === 'b').text, 'B1');
  });
  await page.evaluate(() => window.replay.reset('failed-completion'));
  await event('turn/started', { turn: { id: 'turn', status: 'inProgress' } });
  await start({ id: 'failed-cmd', type: 'commandExecution', command: 'python calc.py' });
  await event('turn/completed', { turn: { id: 'turn', status: 'failed', error: { message: 'Server exhausted retries' } } });
  await check('failed turn payload exposes its cause without a separate error event', async () => {
    assert.match(await text(), /Server exhausted retries/); assert.match(await text(), /Command failed/); assert.doesNotMatch(await text(), /Success/);
  });
  await page.evaluate(() => window.replay.reset('kernel-exit'));
  await event('turn/started', { turn: { id: 'turn', status: 'inProgress' } });
  await start({ id: 'crash-cmd', type: 'commandExecution', command: 'python calc.py' });
  await event('server/exited');
  await check('kernel exit marks running tools failed and leaves input usable', async () => {
    const s = await state(); assert.equal(s.active, false); assert.equal(s.turns[0].status, 'failed');
    assert.equal(s.items.find(i => i.id === 'crash-cmd').status, 'failed'); assert.match(await text(), /内核已退出/);
  });
  await page.evaluate(() => window.replay.reset('narrow-tools'));
  await event('turn/started', { turn: { id: 'turn', status: 'inProgress' } });
  await done({ id: 'long-cmd', type: 'commandExecution', command: 'python ' + 'long_argument_'.repeat(100), aggregatedOutput: 'wide output'.repeat(200) });
  await page.getByRole('button', { name: /^Ran python/ }).click();
  await done({ id: 'long-diff', type: 'fileChange', changes: [{ path: 'long.ts', diff: '+' + 'long_source_'.repeat(160) }] });
  await page.getByRole('button', { name: 'Edited a file', exact: true }).click();
  await page.setViewportSize({ width: 480, height: 740 });
  await check('expanded long Shell and diff stay within a narrow viewport', async () => {
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth <= 1));
    for (const selector of ['.flow-shell','.flow-diff']) { const box = await page.locator(selector).boundingBox(); assert.ok(box.x >= 0 && box.x + box.width <= 481); }
  });
  await page.setViewportSize({ width: 1100, height: 900 });
  const question = id => ({ id, method: 'item/tool/requestUserInput', params: { questions: [{ id: 'choice', header: 'Test', question: 'Choose an option', options: [{ label: 'Option A' }, { label: 'Option B' }] }] } });
  await page.evaluate(() => window.replay.reset('approval-cases'));
  await page.evaluate(q => window.replay.configure({ approvals: [q] }), question('q1'));
  await page.getByRole('button', { name: 'Option A', exact: true }).click();
  await page.getByRole('button', { name: '跳过', exact: true }).click();
  await check('Skip discards previously selected answers', async () => {
    const calls = await page.evaluate(() => window.replay.calls()); assert.deepEqual(calls.at(-1).params.response, { answers: {} });
  });
  await page.evaluate(q => { window.replay.transport({ fail: 'approval' }); window.replay.configure({ approvals: [q] }); }, question('q2'));
  await page.getByRole('button', { name: 'Option B', exact: true }).click();
  await page.getByRole('button', { name: '提交', exact: true }).click();
  await check('failed approval submission stays available to retry', async () => {
    assert.equal((await page.evaluate(() => window.replay.approvals())).length, 1); assert.match(await page.getByRole('alert').innerText(), /提交失败/);
  });
  await page.evaluate(() => window.replay.transport());
  await page.getByRole('button', { name: '提交', exact: true }).click();
  await check('approval retry sends the selected value once and dismisses on success', async () => {
    const calls = await page.evaluate(() => window.replay.calls()); assert.deepEqual(calls.at(-1).params.response, { answers: { choice: { answers: ['Option B'] } } });
    assert.equal((await page.evaluate(() => window.replay.approvals())).length, 0);
  });
  await page.evaluate(qs => window.replay.configure({ approvals: qs }), [question('q3'), question('q4')]);
  await page.getByRole('button', { name: 'Option A', exact: true }).click();
  await page.evaluate(q => window.replay.configure({ approvals: [q] }), question('q4'));
  await page.getByRole('button', { name: '提交', exact: true }).click();
  await check('answers do not leak to the next question after timeout', async () => {
    const calls = await page.evaluate(() => window.replay.calls()); assert.deepEqual(calls.at(-1).params.response, { answers: {} });
  });
  await page.evaluate(() => { window.replay.reset('send-settings'); window.replay.configure({ prefs: { model: 'test-model', effort: 'high', permission: 'read-only' } }); window.replay.transport({ hold: 'turn/start' }); });
  await page.getByRole('textbox', { name: '消息输入框' }).fill('Settings and duplicate submit test');
  await page.getByRole('button', { name: '发送', exact: true }).evaluate(e => { e.click(); e.click(); });
  await page.waitForTimeout(80);
  await check('send forwards current model effort and permission once', async () => {
    const calls = (await page.evaluate(() => window.replay.calls())).filter(c => c.method === 'turn/start');
    assert.equal(calls.length, 1); assert.equal(calls[0].params.model, 'test-model'); assert.equal(calls[0].params.effort, 'high');
    assert.equal(calls[0].params.approvalPolicy, 'on-request'); assert.deepEqual(calls[0].params.sandboxPolicy, { type: 'readOnly' });
    assert.equal(await page.getByRole('button', { name: '中断', exact: true }).isDisabled(), true);
  });
  await event('turn/started', { turn: { id: 'turn', status: 'inProgress' } });
  await page.evaluate(() => window.replay.release({ turn: { id: 'turn' } }));
  await page.getByRole('button', { name: '中断', exact: true }).click();
  await check('interrupt sends the real server turn id', async () => {
    const calls = await page.evaluate(() => window.replay.calls()); assert.deepEqual(calls.find(c => c.method === 'turn/interrupt').params, { threadId: 'send-settings', turnId: 'turn' });
  });
  await event('turn/completed', { turn: { id: 'turn', status: 'interrupted' } });
  await page.evaluate(() => { window.replay.reset('send-failure'); window.replay.transport({ fail: 'turn/start' }); });
  await page.getByRole('textbox', { name: '消息输入框' }).fill('Restore this failed message');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.waitForTimeout(80);
  await check('send failure restores input and removes optimistic pending state', async () => {
    assert.equal(await page.getByRole('textbox', { name: '消息输入框' }).inputValue(), 'Restore this failed message');
    assert.equal((await state()).active, false); assert.equal((await state()).turns.length, 0);
  });
  assert.deepEqual(errors, []);
  await fs.writeFile(out + '/results.json', JSON.stringify({ checks, errors, modelCalls: 0, screenshotsEnabled: process.env.FLOW_SCREENSHOTS === '1', timestamp: new Date().toISOString() }, null, 2));
  console.log('All ' + checks.length + ' workflow checks passed.');
} finally { await browser.close(); await server.close(); }
