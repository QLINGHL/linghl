/**
 * 改动文件卡片 hover 预览探针（离线、不连内核）
 *
 * 做法：起一个静态服务器指向真实构建产物 `.vite/renderer/main_window`，
 * 在页面加载前 stub 掉 preload 暴露的 `window.codex`，注入一条带文件改动的回合，
 * 然后用 Playwright 的真鼠标移动量：
 *   ① 鼠标进入卡片头 → diff 浮层出现 的耗时（首帧 / 渲染完成）
 *   ② 鼠标移到浮层上之后，卡片的 :hover 态（底色 / 阴影）是否还在
 *   ③ 卡片与浮层的几何（是否发生位移 / 是否被裁剪）
 *
 * 用法：node tools/probe-card-hover.cjs [--streaming] [--out d:/tmp/x.json]
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '.vite', 'renderer', 'main_window');
const PORT = Number(process.env.PROBE_PORT || 8799);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.json': 'application/json' };

const THREAD_ID = 'thread_probe_card';
const PATCH = [
  '@@ -1,4 +1,6 @@',
  ' # 验收记录',
  '+',
  '+新增了一行说明：hover 预览不能盖住卡片。',
  ' ',
  ' 已有内容保持不变。',
].join('\n');

const BIG_DIFF = ['@@ -1,200 +1,200 @@']
  .concat(Array.from({ length: 200 }, (_, i) => (i % 7 === 0 ? `+新增行 ${i}：这一行用来把浮层渲染成本压出来` : ` 上下文行 ${i}`)))
  .join('\n');

function makeItem(type, id, extra) {
  return Object.assign({ id, type, status: 'completed', createdAt: Date.now() - 60000 }, extra);
}

const MULTI_TURNS = [
  {
    id: 'turn_probe_multi',
    status: 'completed',
    startedAtMs: Date.now() - 120000,
    completedAtMs: Date.now() - 60000,
    items: [
      makeItem('userMessage', 'item_user_m', { content: [{ type: 'text', text: '改了三个文件' }], phase: 'user_message' }),
      makeItem('fileChange', 'item_fc_m', {
        changes: [
          { path: '/project/codex-app/docs/reply-flow-reuse.md', kind: { type: 'update' }, diff: BIG_DIFF },
          { path: '/project/codex-app/src/renderer/src/components/ThreadView.tsx', kind: { type: 'update' }, diff: BIG_DIFF },
          { path: '/project/codex-app/src/renderer/src/vendor/codex-webui/conversation.css', kind: { type: 'update' }, diff: BIG_DIFF },
        ],
        phase: 'activity',
      }),
      makeItem('agentMessage', 'item_agent_m', { text: '三个文件都改好了。', phase: 'final_answer' }),
    ],
  },
];

const TURNS = [
  {
    id: 'turn_probe_1',
    status: 'completed',
    startedAtMs: Date.now() - 120000,
    completedAtMs: Date.now() - 60000,
    items: [
      makeItem('userMessage', 'item_user_1', {
        content: [{ type: 'text', text: '帮我改一下 docs/reply-flow-reuse.md' }],
        phase: 'user_message',
      }),
      makeItem('commandExecution', 'item_cmd_1', {
        command: 'node -v',
        aggregatedOutput: 'v24.18.0\n',
        exitCode: 0,
        phase: 'activity',
      }),
      makeItem('fileChange', 'item_fc_1', {
        changes: [{ path: '/project/codex-app/docs/reply-flow-reuse.md', kind: { type: 'update' }, diff: PATCH }],
        phase: 'activity',
      }),
      makeItem('agentMessage', 'item_agent_1', {
        text: '已按验收记录补上 hover 说明，详细内容见改动文件卡片。',
        phase: 'final_answer',
      }),
    ],
  },
];

function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = decodeURIComponent((req.url || '/').split('?')[0]);
      const rel = url === '/' ? '/index.html' : url;
      const file = path.join(ROOT, rel);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404).end('nope');
        return;
      }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

const lastArg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const STREAMING = process.argv.includes('--streaming');
const MULTI = process.argv.includes('--multi');
const OUT = lastArg('--out', '');
const THREAD_NAME = MULTI ? '多文件改动探针会话' : 'hover 预览探针会话';

(async () => {
  const pw = await import("./playwright-loader.mjs");
  const { chromium } = pw.default ?? pw;
  const server = await serve();
  // 本机没装 playwright 的 headless_shell，直接用已下载的 chromium 全量包
  const chromePath = process.env.PROBE_CHROME ||
    path.join(process.env.LOCALAPPDATA || '', 'ms-playwright', 'chromium-1228', 'chrome-win64', 'chrome.exe');
  const browser = await chromium.launch({ executablePath: fs.existsSync(chromePath) ? chromePath : undefined, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1441, height: 913 }, deviceScaleFactor: 1 });
  page.on('console', (m) => { const t = m.text(); if (m.type() === 'error' || t.includes('[probe]')) console.error('[page]', t); });
  page.on('pageerror', (e) => console.error('[pageerror]', e.message, '\nSTACK:', e.stack));

  const payload = { turns: MULTI ? MULTI_TURNS : TURNS, streaming: STREAMING, threadName: THREAD_NAME };
  await page.addInitScript((seed) => {
    const listeners = {};
    const fire = (name, arg) => (listeners[name] || []).forEach((cb) => { try { cb(arg); } catch (e) { console.warn(e); } });
    window.__probe = { fire, calls: [] };
    const project = { id: 'proj_probe', name: 'cUI', path: '/project', lastOpenedAt: Date.now() };
    const request = async (method, params) => {
      window.__probe.calls.push({ method, params });
      if (method === 'account/read') return { account: { type: 'chatgpt', email: 'probe@local' } };
      if (method === 'thread/list') return { data: [{ id: 'thread_probe_card', name: seed.threadName, cwd: '/project', createdAt: Date.now() - 1e6, updatedAt: Date.now() }] };
      if (method === 'thread/turns/list') return { data: seed.turns };
      if (method === 'thread/resume' || method === 'thread/start') return { thread: { id: 'thread_probe_card' } };
      if (method === 'model/list') return { data: [{ id: 'gpt-5-codex', displayName: 'gpt-5-codex' }] };
      return {};
    };
    window.codex = {
      request,
      approvalResponse: async () => ({}),
      onNotification: (cb) => { (listeners.notification ||= []).push(cb); return () => {}; },
      onServerRequest: (cb) => { (listeners.request ||= []).push(cb); return () => {}; },
      onServerExit: (cb) => { (listeners.exit ||= []).push(cb); return () => {}; },
      onApprovalTimeout: (cb) => { (listeners.timeout ||= []).push(cb); return () => {}; },
      getDeskState: async () => ({ preferences: { theme: 'light', fontSize: 14 }, projects: [project] }),
      setDeskState: async () => ({}),
      appInfo: async () => ({ version: 'probe', isDev: true, platform: 'win32' }),
      openExternal: async () => true,
      editCommand: async () => true,
      newWindow: async () => true,
      envRpc: async (channel) => {
        if (channel === 'env:list') {
          return {
            activeId: 'local',
            envs: [{ id: 'local', name: '本地 Codex', mode: 'local', codexHome: 'D:/tmp/codex-home', createdAt: Date.now() - 1e6 }],
            relays: [],
            official: { home: 'D:/tmp/official', exists: true, hasAuth: true, hasConfig: true, sessionCount: 3, hasSkills: false },
          };
        }
        if (channel === 'env:projects') return { projects: [project], activeId: 'proj_probe' };
        if (channel === 'app:kernel-issue') return { issue: null };
        if (channel === 'customize:list-skills') return [];
        return {};
      },
      browserRpc: async () => ({}),
      onBrowserState: () => () => {},
      onBrowserOpenUrl: () => () => {},
      onBrowserAddTab: () => () => {},
    };
  }, payload);

  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
  // 首页只列会话，要像用户那样点开这条会话才会渲染 ThreadView
  try {
    await page.getByRole('button', { name: THREAD_NAME }).first().click({ timeout: 10000 });
  } catch (e) {
    console.error('OPEN_THREAD_FAILED', e.message);
  }
  try {
    await page.waitForSelector('.flow-changed', { timeout: 15000 });
  } catch (e) {
    const dump = await page.evaluate(() => ({
      rootHtml: (document.getElementById('root') || {}).innerHTML ? document.getElementById('root').innerHTML.slice(0, 1200) : '(empty)',
      calls: window.__probe ? window.__probe.calls.map((c) => c.method) : null,
      hasCodex: typeof window.codex,
      bodyText: document.body.innerText.slice(0, 400),
    }));
    console.error('CARD_NOT_FOUND', JSON.stringify(dump, null, 2));
    throw e;
  }

  if (STREAMING) {
    // 让这一回合处于「流式进行中」，贴近用户描述的场景：回复还在生成时去看卡片
    await page.evaluate(() => {
      window.__probe.fire('notification', { method: 'turn/started', params: { threadId: 'thread_probe_card', turnId: 'turn_probe_1' } });
      window.__probe.fire('notification', { method: 'item/agentMessage/delta', params: { threadId: 'thread_probe_card', turnId: 'turn_probe_1', itemId: 'item_agent_1', delta: '正在补充说明…' } });
    });
    await page.waitForTimeout(200);
    // 模拟流式期间卡片所在的回合被反复重渲染（每 60ms 一次 delta + 一次 fileChange patch）
    await page.evaluate(() => {
      window.__probeChurn = setInterval(() => {
        window.__probe.fire('notification', { method: 'item/agentMessage/delta', params: { threadId: 'thread_probe_card', turnId: 'turn_probe_1', itemId: 'item_agent_1', delta: '。' } });
        window.__probe.fire('notification', {
          method: 'item/fileChange/patchUpdated',
          params: { threadId: 'thread_probe_card', turnId: 'turn_probe_1', itemId: 'item_fc_1', changes: [{ path: '/project/codex-app/docs/reply-flow-reuse.md', kind: { type: 'update' }, diff: '@@ -1,3 +1,4 @@\n # 验收记录\n+churn 行\n 已有内容保持不变。' }] },
        });
      }, 60);
    });
    await page.waitForTimeout(400);
  }

  // 记录 hover→浮层出现 的耗时与几何变化：在页面里挂一个 mouseover 捕获 + rAF 轮询
  await page.evaluate(() => {
    window.__probeMarks = { t0: null, tShown: null, mutations: [], scrolls: [] };
    const cardSel = '.flow-changed';
    document.addEventListener('mouseover', (e) => {
      const card = e.target instanceof Element ? e.target.closest(cardSel) : null;
      if (card && window.__probeMarks.t0 == null) window.__probeMarks.t0 = performance.now();
    }, true);
    const obs = new MutationObserver(() => {
      if (window.__probeMarks.tShown == null && document.querySelector('.flow-diff-preview')) {
        window.__probeMarks.tShown = performance.now();
        // 再等一帧：浮层真正提交到屏幕的近似时刻
        requestAnimationFrame(() => { window.__probeMarks.tPainted = performance.now(); });
      }
    });
    obs.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] });
    window.__probeMarks.obs = obs;
    // 主线程长任务：如果 hover 命中时主线程被别的渲染占着，长任务会解释「为什么感觉慢」
    window.__probeMarks.longTasks = [];
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) window.__probeMarks.longTasks.push({ start: Math.round(entry.startTime), dur: Math.round(entry.duration) });
      }).observe({ entryTypes: ['longtask'] });
    } catch { /* 不支持就算了 */ }
    const scroller = document.querySelector('.flow-scroll');
    if (scroller) scroller.addEventListener('scroll', () => window.__probeMarks.scrolls.push({ t: performance.now(), top: scroller.scrollTop }), true);
  });

  const readState = () => page.evaluate(() => {
    const card = document.querySelector('.flow-changed');
    const prev = document.querySelector('.flow-diff-preview');
    const head = document.querySelector('.flow-changed-head');
    const scroller = document.querySelector('.flow-scroll');
    const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
    const cs = (el) => { if (!el) return null; const s = getComputedStyle(el); return { bg: s.backgroundColor, shadow: s.boxShadow, transition: s.transitionProperty + ' ' + s.transitionDuration, transform: s.transform, zIndex: s.zIndex, position: s.position, overflow: s.overflow }; };
    const atPoint = (() => {
      if (!prev) return null;
      const r = prev.getBoundingClientRect();
      const el = document.elementFromPoint(Math.round(r.x + r.width / 2), Math.round(r.y + Math.min(20, r.height / 2)));
      if (!el) return null;
      return { tag: el.tagName, cls: String(el.className).slice(0, 80), inCard: !!el.closest('.flow-changed') };
    })();
    return {
      hasCard: !!card, hasPreview: !!prev,
      cardRect: rect(card), prevRect: rect(prev), headRect: rect(head),
      cardHover: card ? card.matches(':hover') : null,
      cardCs: cs(card), prevCs: cs(prev), headCs: cs(head),
      viewport: { w: innerWidth, h: innerHeight },
      scroll: scroller ? { top: Math.round(scroller.scrollTop), h: scroller.clientHeight } : null,
      previewLineCount: document.querySelectorAll('.flow-diff-preview .flow-diff-line').length,
      sub: document.querySelector('.flow-changed-viewlink') ? document.querySelector('.flow-changed-viewlink').textContent.trim() : (document.querySelector('.flow-changed-total') ? document.querySelector('.flow-changed-total').textContent.trim() : null),
      elementAtPreviewTop: atPoint,
      marks: window.__probeMarks ? { t0: window.__probeMarks.t0, tShown: window.__probeMarks.tShown, tPainted: window.__probeMarks.tPainted, longTasks: window.__probeMarks.longTasks, scrolls: window.__probeMarks.scrolls } : null,
      nativeTitleHits: [...document.querySelectorAll('[title]')].filter((el) => el.closest('.flow-changed')).map((el) => ({ tag: el.tagName, title: el.getAttribute('title') })),
    };
  });

  // 逐帧采样：卡片节点是否被 React 卸载/重建、浮层是否在鼠标仍在上面时消失
  await page.evaluate(() => {
    const log = [];
    const t0 = performance.now();
    let mouse = { x: -1, y: -1 };
    document.addEventListener('mousemove', (e) => { mouse = { x: e.clientX, y: e.clientY }; }, true);
    const snap = (ev) => {
      const card = document.querySelector('.flow-changed');
      const prev = document.querySelector('.flow-diff-preview');
      let inside = false;
      if (prev && mouse.x >= 0) {
        const r = prev.getBoundingClientRect();
        inside = mouse.x >= r.left && mouse.x <= r.right && mouse.y >= r.top && mouse.y <= r.bottom;
      }
      log.push({
        t: Math.round(performance.now() - t0), ev, mouse: { ...mouse },
        hasPreview: !!prev, mouseInsidePrev: inside,
        cardHover: card ? card.matches(':hover') : null,
        cardBg: card ? getComputedStyle(card).backgroundColor : null,
        cardY: card ? Math.round(card.getBoundingClientRect().y) : null,
        cardConnected: card ? card.isConnected : null,
        prevY: prev ? Math.round(prev.getBoundingClientRect().y) : null,
      });
    };
    window.__probeSnap = snap;
    // 卡片位置在一段时间内的漂移（流式时上方内容增长会把卡片顶下去）
    let lastY = null;
    setInterval(() => {
      const card = document.querySelector('.flow-changed');
      if (!card) { if (lastY !== null) { lastY = null; snap('card-gone'); } return; }
      const y = Math.round(card.getBoundingClientRect().y);
      if (lastY !== null && Math.abs(y - lastY) >= 1) snap('card-y-shift');
      lastY = y;
    }, 16);
    // 鼠标进出卡片 / 浮层
    const wire = () => {
      const card = document.querySelector('.flow-changed');
      if (card && !card.__probeWired) {
        card.__probeWired = true;
        card.addEventListener('mouseenter', () => snap('mouse-enter-card'));
        card.addEventListener('mouseleave', (e) => snap('mouse-leave-card->' + (e.relatedTarget && e.relatedTarget.className ? String(e.relatedTarget.className).split(' ')[0] : 'none')));
      }
      const prev = document.querySelector('.flow-diff-preview');
      if (prev && !prev.__probeWired) {
        prev.__probeWired = true;
        prev.addEventListener('mouseenter', () => snap('mouse-enter-preview'));
        prev.addEventListener('mouseleave', () => snap('mouse-leave-preview'));
      }
    };
    wire();
    setInterval(wire, 50);
    let last = { prev: !!document.querySelector('.flow-diff-preview'), card: document.querySelector('.flow-changed') };
    setInterval(() => {
      const prev = document.querySelector('.flow-diff-preview');
      const card = document.querySelector('.flow-changed');
      const there = !!prev;
      if (there !== last.prev) { snap(there ? 'preview-shown' : 'preview-hidden'); last.prev = there; }
      if (card !== last.card) { snap('card-node-replaced'); last.card = card; }
    }, 16);
    window.__probeFrames = log;
  });

  const report = { streaming: STREAMING, steps: [] };
  // 给卡片打上身份标记：如果 React 重挂了 DOM 节点，这个属性会消失 → 能直接判定重挂载
  await page.evaluate(() => { const c = document.querySelector('.flow-changed'); if (c) c.setAttribute('data-probe-id', 'card-1'); });
  const nodeTag = () => page.evaluate(() => !!document.querySelector('.flow-changed[data-probe-id="card-1"]'));
  report.steps.push({ step: 'initial', state: await readState(), sameNode: await nodeTag() });

  // ① 移到卡片头 → 量 hover 到浮层出现
  const headBox = await page.locator('.flow-changed-head').boundingBox();
  await page.mouse.move(headBox.x + headBox.width / 2, headBox.y + 10, { steps: 4 });
  await page.waitForTimeout(600);
  report.steps.push({ step: 'hoverHead', state: await readState(), sameNode: await nodeTag() });

  // ①b 多文件卡：移到第一条文件行（浮层出现在卡片上方，可能远离光标）
  if (MULTI) {
    const rowBox = await page.locator('.flow-changed-row').first().boundingBox();
    await page.mouse.move(rowBox.x + 120, rowBox.y + rowBox.height / 2, { steps: 6 });
    await page.waitForTimeout(600);
    report.steps.push({ step: 'hoverFileRow', state: await readState(), sameNode: await nodeTag(), mouse: { x: Math.round(rowBox.x + 120), y: Math.round(rowBox.y + rowBox.height / 2) } });
  }

  // ② 移到浮层上（从卡片头往上走，穿过 6px 间隙）
  const prevBox = await page.locator('.flow-diff-preview').boundingBox();
  await page.mouse.move(prevBox.x + prevBox.width / 2, prevBox.y + 18, { steps: 12 });
  await page.waitForTimeout(700);
  report.steps.push({ step: 'hoverPreview', state: await readState(), sameNode: await nodeTag() });

  // ③ 在浮层里横向拖动滚动条区域 / 再读一次（确认浮层是否还活着）
  await page.mouse.move(prevBox.x + 40, prevBox.y + 30, { steps: 6 });
  await page.waitForTimeout(400);
  report.steps.push({ step: 'hoverPreviewLeft', state: await readState(), sameNode: await nodeTag() });

  // ④ 手指/鼠标停在卡片与浮层之间的 6px 间隙里：浮层必须还在（延时桥接）
  const gapBox = await page.locator('.flow-diff-preview').boundingBox();
  await page.mouse.move(gapBox.x + gapBox.width / 2, gapBox.y + gapBox.height + 3, { steps: 6 });
  await page.waitForTimeout(150);
  report.steps.push({ step: 'inGap', state: await readState(), sameNode: await nodeTag() });

  // ⑤ 彻底移开（移到左侧栏空白区，远离卡片与浮层）：浮层要在延时后收起
  await page.mouse.move(120, 700, { steps: 10 });
  await page.waitForTimeout(900);
  report.steps.push({ step: 'movedAway', state: await readState(), sameNode: await nodeTag() });

  // ⑤b 用页面内合成 pointermove 再确认一次（区分「Playwright 没派发事件」和「代码没关」）
  report.synthetic = await page.evaluate(async () => {
    const before = !!document.querySelector('.flow-diff-preview');
    for (let i = 0; i < 4; i++) {
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: 40 + i, clientY: 700, bubbles: true }));
    }
    await new Promise((r) => setTimeout(r, 700));
    return { before, after: !!document.querySelector('.flow-diff-preview') };
  });

  // ⑥ 移开后的收敛过程：每 60ms 采样一次，看浮层到底有没有收起
  report.afterMoveAway = await page.evaluate(async () => {
    const samples = [];
    const t0 = performance.now();
    for (let i = 0; i < 25; i++) {
      const prev = document.querySelector('.flow-diff-preview');
      samples.push({ t: Math.round(performance.now() - t0), hasPreview: !!prev });
      if (!prev) break;
      await new Promise((r) => setTimeout(r, 60));
    }
    return samples;
  });

  report.counters = await page.evaluate(() => ({ ticks: window.__ticks ?? 0, farTicks: window.__far ?? 0 }));
  console.log('COUNTERS', JSON.stringify(report.counters));
  report.closeTimerTrace = await page.evaluate(() => (window.__closeTimers || []).slice(-8));
  console.log('CLOSE_TIMERS', JSON.stringify(report.closeTimerTrace));

  report.frames = await page.evaluate(() => window.__probeFrames || []);

  const { state: initial } = report.steps.find((s) => s.step === 'initial');
  const { state: hovered } = report.steps.find((s) => s.step === 'hoverHead');
  const { state: onPreview } = report.steps.find((s) => s.step === 'hoverPreview');
  report.summary = {
    sameNodeAcrossHover: report.steps.map((s) => ({ step: s.step, sameNode: s.sameNode })),
    hoverToPreviewMs: hovered.marks && hovered.marks.t0 != null && hovered.marks.tShown != null ? Math.round(hovered.marks.tShown - hovered.marks.t0) : null,
    hoverToPaintMs: hovered.marks && hovered.marks.t0 != null && hovered.marks.tPainted != null ? Math.round(hovered.marks.tPainted - hovered.marks.t0) : null,
    longTasksDuringHover: (hovered.marks && hovered.marks.longTasks || []).slice(-6),
    previewLines: hovered.previewLineCount,
    cardMovedAfterHover: initial.cardRect && hovered.cardRect ? { dy: hovered.cardRect.y - initial.cardRect.y, dx: hovered.cardRect.x - initial.cardRect.x } : null,
    hoverLightsCard: { initial: initial.cardCs && initial.cardCs.bg, hovered: hovered.cardCs && hovered.cardCs.bg },
    onPreview: { hasPreview: onPreview.hasPreview, cardHover: onPreview.cardHover, cardBg: onPreview.cardCs && onPreview.cardCs.bg, prevShadow: onPreview.prevCs && onPreview.prevCs.shadow, sub: onPreview.sub, elementAtPreviewTop: onPreview.elementAtPreviewTop },
    nativeTitleHits: initial.nativeTitleHits,
  };

  await browser.close();
  server.close();
  if (OUT) fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
