/**
 * 改动文件卡片 hover 预览的截图证据（离线、不连内核）
 *
 * 复用 probe-card-hover.cjs 的 stub 手法，把「流式回合 + 鼠标停在浮层上」这一刻截下来，
 * 用来肉眼确认：浮层有阴影和白底、卡片仍是 hover 灰、浮层没被聊天滚动容器裁掉。
 *
 * 用法：node tools/shot-card-hover.cjs [--multi] [--out <png>]
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '.vite', 'renderer', 'main_window');
const PORT = Number(process.env.PROBE_PORT || 8801);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf' };

const DIFF = ['@@ -1,6 +1,9 @@', ' # 验收记录', '+', '+hover 预览用 fixed 锚点锁位置：流式把卡片顶下去时不再跟着甩。', '+卡片 hover 态保持，浮层不消失。', ' ', ' 原有内容保持不变。', ' 第二行。', ' 第三行。'].join('\n');
const BIG_DIFF = ['@@ -1,200 +1,200 @@'].concat(Array.from({ length: 200 }, (_, i) => (i % 7 === 0 ? `+新增行 ${i}：用来压浮层渲染成本` : ` 上下文行 ${i}`))).join('\n');

const makeItem = (type, id, extra) => Object.assign({ id, type, status: 'completed', createdAt: Date.now() - 60000 }, extra);
const SINGLE = [{
  id: 'turn_1', status: 'completed', startedAtMs: Date.now() - 120000, completedAtMs: Date.now() - 60000,
  items: [
    makeItem('userMessage', 'u1', { content: [{ type: 'text', text: '把 hover 预览的抖动修一下' }], phase: 'user_message' }),
    makeItem('commandExecution', 'c1', { command: 'node -v', aggregatedOutput: 'v24.18.0\n', exitCode: 0, phase: 'activity' }),
    makeItem('fileChange', 'f1', { changes: [{ path: '/project/codex-app/src/renderer/src/vendor/codex-webui/conversation.css', kind: { type: 'update' }, diff: DIFF }], phase: 'activity' }),
    makeItem('agentMessage', 'a1', { text: '**已修复**：浮层位置在打开时锁定，卡片被流式内容顶下去时不再甩动，hover 态保持。', phase: 'final_answer' }),
  ],
}];
const MULTI = [{
  id: 'turn_1', status: 'completed', startedAtMs: Date.now() - 120000, completedAtMs: Date.now() - 60000,
  items: [
    makeItem('userMessage', 'u1', { content: [{ type: 'text', text: '三个文件都改了' }], phase: 'user_message' }),
    makeItem('fileChange', 'f1', {
      changes: [
        { path: '/project/codex-app/src/renderer/src/components/ThreadView.tsx', kind: { type: 'update' }, diff: BIG_DIFF },
        { path: '/project/codex-app/src/renderer/src/vendor/codex-webui/conversation.css', kind: { type: 'update' }, diff: DIFF },
        { path: '/project/codex-app/docs/reply-flow-reuse.md', kind: { type: 'update' }, diff: DIFF },
      ], phase: 'activity',
    }),
    makeItem('agentMessage', 'a1', { text: '三个文件都改好了。', phase: 'final_answer' }),
  ],
}];

const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const MULTI_MODE = process.argv.includes('--multi');
const OUT = arg('--out', path.resolve(__dirname, '..', 'artifacts', 'flow-observation', MULTI_MODE ? 'card-hover-multi.png' : 'card-hover-streaming.png'));

function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = decodeURIComponent((req.url || '/').split('?')[0]);
      const file = path.join(ROOT, url === '/' ? '/index.html' : url);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return res.writeHead(404).end('nope');
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

(async () => {
  const pw = await import("./playwright-loader.mjs");
  const { chromium } = pw.default ?? pw;
  const server = await serve();
  const chromePath = process.env.PROBE_CHROME || path.join(process.env.LOCALAPPDATA || '', 'ms-playwright', 'chromium-1228', 'chrome-win64', 'chrome.exe');
  const browser = await chromium.launch({ executablePath: fs.existsSync(chromePath) ? chromePath : undefined, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1441, height: 913 }, deviceScaleFactor: 2 });
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));

  const turns = MULTI_MODE ? MULTI : SINGLE;
  await page.addInitScript((seed) => {
    const listeners = {};
    const fire = (name, arg) => (listeners[name] || []).forEach((cb) => cb(arg));
    window.__probe = { fire };
    const project = { id: 'p1', name: 'cUI', path: '/project', lastOpenedAt: Date.now() };
    window.codex = {
      request: async (method) => {
        if (method === 'account/read') return { account: { type: 'chatgpt' } };
        if (method === 'thread/list') return { data: [{ id: 'thread_shot', name: 'hover 预览截图会话', cwd: '/project', createdAt: Date.now() - 1e6, updatedAt: Date.now() }] };
        if (method === 'thread/turns/list') return { data: seed.turns };
        if (method === 'model/list') return { data: [{ id: 'gpt-5-codex', displayName: 'gpt-5-codex' }] };
        return {};
      },
      approvalResponse: async () => ({}),
      onNotification: (cb) => { (listeners.notification ||= []).push(cb); return () => {}; },
      onServerRequest: () => () => {}, onServerExit: () => () => {}, onApprovalTimeout: () => () => {},
      getDeskState: async () => ({ preferences: { theme: 'light', fontSize: 14 }, projects: [project] }),
      setDeskState: async () => ({}), appInfo: async () => ({ version: 'probe' }), openExternal: async () => true,
      editCommand: async () => true, newWindow: async () => true,
      envRpc: async (channel) => {
        if (channel === 'env:list') return { activeId: 'local', envs: [{ id: 'local', name: '本地 Codex', mode: 'local', codexHome: 'D:/tmp/ch' }], relays: [], official: { home: 'D:/tmp/o', exists: true, hasAuth: true, hasConfig: true, sessionCount: 1, hasSkills: false } };
        if (channel === 'env:projects') return { projects: [project], activeId: 'p1' };
        if (channel === 'app:kernel-issue') return { issue: null };
        if (channel === 'customize:list-skills') return [];
        return {};
      },
      browserRpc: async () => ({}), onBrowserState: () => () => {}, onBrowserOpenUrl: () => () => {}, onBrowserAddTab: () => () => {},
    };
  }, { turns });

  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
  await page.getByRole('button', { name: 'hover 预览截图会话' }).first().click();
  await page.waitForSelector('.flow-changed');

  // 让这一回合处于流式进行中（贴用户场景）
  await page.evaluate(() => {
    window.__probe.fire('notification', { method: 'turn/started', params: { threadId: 'thread_shot', turnId: 'turn_1' } });
    window.__probe.fire('notification', { method: 'item/agentMessage/delta', params: { threadId: 'thread_shot', turnId: 'turn_1', itemId: 'a1', delta: '正在继续写…' } });
    window.__probeChurn = setInterval(() => {
      window.__probe.fire('notification', { method: 'item/agentMessage/delta', params: { threadId: 'thread_shot', turnId: 'turn_1', itemId: 'a1', delta: '。流式内容继续增长，把下面的卡片往下顶。' } });
    }, 120);
  });
  await page.waitForTimeout(300);

  const head = await page.locator('.flow-changed-head').boundingBox();
  await page.mouse.move(head.x + head.width / 2, head.y + 12, { steps: 5 });
  await page.waitForTimeout(250);
  const prev = await page.locator('.flow-diff-preview').boundingBox();
  // 停在浮层上：这正是「一移过去就没了」的位置
  await page.mouse.move(prev.x + prev.width / 2, prev.y + 20, { steps: 10 });
  await page.waitForTimeout(900);
  // 期间流式继续增长 → 卡片被顶下去，验证浮层是否还钉在原处
  await page.waitForTimeout(1200);

  const state = await page.evaluate(() => {
    const card = document.querySelector('.flow-changed');
    const prev = document.querySelector('.flow-diff-preview');
    return {
      hasPreview: !!prev,
      cardHover: card ? card.matches(':hover') : null,
      cardBg: card ? getComputedStyle(card).backgroundColor : null,
      prevShadow: prev ? getComputedStyle(prev).boxShadow : null,
      prevBgResolved: prev ? getComputedStyle(prev).backgroundColor : null,
      cBgVar: prev ? getComputedStyle(prev).getPropertyValue('--c-bg') : null,
      prevOpacity: prev ? getComputedStyle(prev).opacity + '/' + getComputedStyle(prev).mixBlendMode : null,
      prevZ: prev ? getComputedStyle(prev).zIndex + '/' + getComputedStyle(prev).position : null,
      // 浮层被谁困在层叠上下文里（fixed + z-index 仍然被盖住时就是这里出问题）
      stackingChain: prev ? (() => {
        const chain = [];
        for (let el = prev.parentElement; el && el !== document.documentElement; el = el.parentElement) {
          const s = getComputedStyle(el);
          const traps = [];
          if (s.position !== 'static' && s.zIndex !== 'auto') traps.push('z:' + s.zIndex);
          if (s.transform !== 'none') traps.push('transform');
          if (s.filter !== 'none') traps.push('filter');
          if (s.willChange !== 'auto') traps.push('will-change:' + s.willChange);
          if (s.contain !== 'none') traps.push('contain:' + s.contain);
          if (s.isolation === 'isolate') traps.push('isolate');
          if (s.opacity !== '1') traps.push('opacity:' + s.opacity);
          chain.push({ cls: String(el.className).slice(0, 46), pos: s.position, z: s.zIndex, traps: traps.join(',') });
        }
        return chain;
      })() : null,
      cardRect: card ? { y: Math.round(card.getBoundingClientRect().y), h: Math.round(card.getBoundingClientRect().height) } : null,
      prevRect: prev ? { y: Math.round(prev.getBoundingClientRect().y), h: Math.round(prev.getBoundingClientRect().height) } : null,
    };
  });
  const clip = await page.evaluate(() => {
    const prev = document.querySelector('.flow-diff-preview');
    const card = document.querySelector('.flow-changed');
    const top = Math.min(prev ? prev.getBoundingClientRect().top : 0, card.getBoundingClientRect().top) - 24;
    const bottom = Math.max(prev ? prev.getBoundingClientRect().bottom : 0, card.getBoundingClientRect().bottom) + 16;
    return { x: 380, y: Math.max(0, top), width: 980, height: Math.min(913 - Math.max(0, top), bottom - Math.max(0, top)) };
  });
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  // 全视口整页截图（不用 clip：便于确认浮层是真的画上去了、有没有被别的层盖住）
  await page.screenshot({ path: OUT.replace(/\.png$/, '-full.png') });
  await page.screenshot({ path: OUT, clip });
  // 像素级验证「浮层是否漏出背后的正文」：把浮层整块隐藏再截同一区域，
  // 两块像素若完全一致 → 浮层是不透明的、没有文字穿透
  const popOnly = await page.evaluate(() => {
    const p = document.querySelector('.flow-diff-preview');
    if (!p) return null;
    const r = p.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  });
  const behindText = await page.evaluate(() => {
    const p = document.querySelector('.flow-diff-preview');
    if (!p) return null;
    const r = p.getBoundingClientRect();
    // 浮层正中偏下处、浮层下面那一层是什么（用来判断有没有别的文字层盖在浮层上）
    const x = Math.round(r.left + r.width / 2);
    const y = Math.round(r.top + r.height - 12);
    return { x, y, stack: document.elementsFromPoint(x, y).slice(0, 4).map((e) => String(e.className).slice(0, 44) || e.tagName) };
  });
  console.log(JSON.stringify({ popoverHitTest: behindText }, null, 2));
  if (popOnly) {
    const hiddenOut = OUT.replace(/\.png$/, '-nopopover.png');
    const shownOut = OUT.replace(/\.png$/, '-popoveronly.png');
    // 同一块区域截两次：浮层可见 / 浮层隐藏。两块像素若一致 → 浮层不透明、没有透字
    await page.screenshot({ path: shownOut, clip: popOnly });
    await page.evaluate(() => { const p = document.querySelector('.flow-diff-preview'); if (p) p.style.visibility = 'hidden'; });
    await page.waitForTimeout(120);
    await page.screenshot({ path: hiddenOut, clip: popOnly });
    await page.evaluate(() => { const p = document.querySelector('.flow-diff-preview'); if (p) p.style.visibility = ''; });
    const a = fs.readFileSync(shownOut);
    const b = fs.readFileSync(hiddenOut);
    console.log(JSON.stringify({ compareShots: { popoverRegion: shownOut, behindRegion: hiddenOut, identical: a.equals(b), bytesShown: a.length, bytesBehind: b.length } }));
  }
  await page.evaluate(() => clearInterval(window.__probeChurn));
  await browser.close();
  server.close();
  console.log(JSON.stringify({ out: OUT, state, clip }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
