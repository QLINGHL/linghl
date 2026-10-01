/**
 * 回归测试：新聊天必须**立刻**出现在侧栏「最近」，并在生成期间显示工作指示器。
 *
 * 背景（用户 2026-10-01 报告）：
 *   "我点击新聊天，然后输入提示词，在获得对话的过程中，为什么这个最近它竟然没有
 *    我这个东西？不像 ChatGPT 桌面版那样，只要一发送就会有一条出现在项目或最近里，
 *    并且后面有一个小圆圈（加载中）。"
 *
 * 实测根因（timeline.jsonl）：thread/start 之后 130ms 就查了 thread/list，
 * 但新会话那时还没落进内核的 state DB，列表里没有它；下一次刷新要等
 * turn/completed —— 那一轮差了 **2 分 25 秒**。整段生成过程中用户在
 * 「最近」里都找不到自己这条会话。
 *
 * 本测试锁定三条不变量：
 *   ① thread/start 返回后立刻乐观插入（用提示词首句当占位标题）；
 *   ② 内核还没收录时，loadThreads 刷新**不能**把它抹掉；
 *   ③ 内核收录后转正：用内核标题、pending 标记摘掉、不出现重复条目。
 * 外加：工作指示器（turnActive）必须立刻为 true。
 */
import assert from 'node:assert/strict';
import { createServer } from 'vite';
const pw = await import("./playwright-loader.mjs");
const chromium = (pw.default ?? pw).chromium;
const port = Number(process.env.RECENTS_PORT || 5199);
const server = await createServer({
  configFile: 'vite.renderer.config.mts',
  server: { host: '127.0.0.1', port, strictPort: true },
});
await server.listen();
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
let passed = 0;
const check = async (name, fn) => {
  await fn();
  passed++;
  console.log('PASS ' + name);
};

try {
  await page.goto(`http://127.0.0.1:${port}/tools/flow-replay.html?sidebar=1`);
  await page.waitForFunction(() => window.replay);

  // ---------- ① 乐观插入：thread/start 一返回就有条目 ----------
  await check('新会话在 thread/start 返回后立刻出现在最近列表', async () => {
    await page.evaluate(() => {
      window.replay.reset('t-new');
      window.replay.configure({ activeThreadId: null });
    });
    const before = await page.evaluate(() => window.replay.threads());
    assert.equal(before.length, 0, '初始应为空');

    // 模拟 Composer 在拿到 thread id 后做的事
    await page.evaluate(() => window.replay.upsertPending('th_1', '帮我写一个快速排序'));
    const after = await page.evaluate(() => window.replay.threads());
    assert.equal(after.length, 1, '应立即出现 1 条');
    assert.equal(after[0].id, 'th_1');
    // 标题回落到 preview（提示词首句），而不是"未命名会话"
    assert.equal(after[0].preview, '帮我写一个快速排序');
    assert.ok(!after[0].name, 'name 应为空，让 UI 回落到 preview');
    assert.deepEqual(await page.evaluate(() => window.replay.pendingIds()), ['th_1']);
  });

  // ---------- ② 内核还没收录时，刷新不能抹掉它 ----------
  await check('内核 thread/list 尚未收录时，刷新不会抹掉乐观条目', async () => {
    // 内核只返回别的历史会话，没有 th_1
    await page.evaluate(() =>
      window.replay.loadThreads([
        { id: 'old_a', name: '老会话 A', updatedAt: 1 },
        { id: 'old_b', name: '老会话 B', updatedAt: 2 },
      ]),
    );
    const rows = await page.evaluate(() => window.replay.threads());
    assert.equal(rows.length, 3, '乐观条目必须保留，共 3 条');
    assert.ok(rows.some((t) => t.id === 'th_1'), 'th_1 不能被刷掉');
    // 乐观条目置顶（最新）
    assert.equal(rows[0].id, 'th_1', '乐观条目应置顶');
    assert.deepEqual(await page.evaluate(() => window.replay.pendingIds()), ['th_1']);
  });

  // ---------- ③ 内核收录后转正 ----------
  await check('内核收录后转正：用内核标题、pending 摘掉、不重复', async () => {
    await page.evaluate(() =>
      window.replay.loadThreads([
        { id: 'th_1', name: '快速排序实现', updatedAt: 99 },
        { id: 'old_a', name: '老会话 A', updatedAt: 1 },
      ]),
    );
    const rows = await page.evaluate(() => window.replay.threads());
    assert.equal(rows.length, 2, '不能出现重复条目');
    const th = rows.find((t) => t.id === 'th_1');
    assert.ok(th, 'th_1 应仍在列表里');
    assert.equal(th.name, '快速排序实现', '应换成内核给的真标题');
    assert.deepEqual(await page.evaluate(() => window.replay.pendingIds()), [], 'pending 标记应摘掉');
  });

  // ---------- ③b 标题回填：内核行没有标题时继承本地预览 ----------
  await check('内核收录但没带标题时，继承本地预览而不是退回「未命名会话」', async () => {
    await page.evaluate(() => {
      window.replay.reset('t-backfill');
      window.replay.upsertPending('th_bf', '帮我把这个函数改成异步的');
    });
    // 内核收录了这条，但既无 name 也无 preview（实测内核不会推 thread/name/updated）
    await page.evaluate(() => window.replay.loadThreads([{ id: 'th_bf', updatedAt: 5 }]));
    const rows = await page.evaluate(() => window.replay.threads());
    const th = rows.find((t) => t.id === 'th_bf');
    assert.ok(th, '条目应存在');
    assert.equal(th.preview, '帮我把这个函数改成异步的', '应继承本地预览，不能变成空标题');
    assert.deepEqual(await page.evaluate(() => window.replay.pendingIds()), [], '应已转正');
  });

  // ---------- ④ 幂等：同一 id 重复 upsert 不产生两条 ----------
  await check('同一会话重复 upsert 不会插出两条', async () => {
    await page.evaluate(() => {
      window.replay.reset('t-idem');
      window.replay.upsertPending('th_x', '第一句');
      window.replay.upsertPending('th_x', '改过的第一句');
    });
    const rows = await page.evaluate(() => window.replay.threads());
    assert.equal(rows.length, 1);
    assert.equal(rows[0].preview, '改过的第一句', '应更新为最新标题');
  });

  // ---------- ⑤ 项目归属：新会话挂到 cwd 匹配的项目下 ----------
  await check('新会话会挂进 cwd 匹配的项目', async () => {
    await page.evaluate(() => {
      window.replay.reset('t-proj');
      window.replay.configure({
        projects: [
          { id: 'p1', name: 'cUI', path: '/project' },
          { id: 'p2', name: 'other', path: 'D:/other' },
        ],
      });
      window.replay.upsertPending('th_p', '在这个项目里干活', '/project');
    });
    const projects = await page.evaluate(() => window.replay.projects());
    const cui = projects.find((p) => p.id === 'p1');
    const other = projects.find((p) => p.id === 'p2');
    assert.deepEqual(cui.threadIds, ['th_p'], 'cwd 匹配的项目应收录这个会话');
    assert.ok(!other.threadIds?.length, '不匹配的项目不应被改动');
  });

  // ---------- ⑥ 失败回滚：撤掉乐观条目与项目归属 ----------
  await check('发送失败时撤掉乐观条目和项目归属', async () => {
    await page.evaluate(() => {
      window.replay.reset('t-drop');
      window.replay.configure({ projects: [{ id: 'p1', name: 'cUI', path: '/project' }] });
      window.replay.upsertPending('th_d', '这句发不出去', '/project');
    });
    await page.evaluate(() => window.replay.dropPending('th_d'));
    assert.equal((await page.evaluate(() => window.replay.threads())).length, 0, '列表应清空');
    assert.deepEqual(await page.evaluate(() => window.replay.pendingIds()), [], 'pending 应清空');
    const projects = await page.evaluate(() => window.replay.projects());
    assert.ok(!projects[0].threadIds?.length, '项目归属也应撤掉');
  });

  // ---------- ⑦ 工作指示器：发送瞬间就亮 ----------
  await check('发送瞬间工作指示器即为 on，turn 完成后熄灭', async () => {
    await page.evaluate(() => {
      window.replay.reset('t-spin');
      window.replay.pending('正在生成');   // 内部会 markTurnPending
    });
    assert.equal(await page.evaluate(() => window.replay.turnActiveOf('t-spin')), true, '发送后应立刻为 true');

    await page.evaluate(() => {
      window.replay.event('turn/started', { turn: { id: 'turn', status: 'inProgress' } });
      window.replay.event('turn/completed', { turn: { id: 'turn', status: 'completed' } });
    });
    assert.equal(await page.evaluate(() => window.replay.turnActiveOf('t-spin')), false, '完成后应熄灭');
  });

  // ---------- ⑧ 侧栏 DOM：条目真的渲染出来，且转圈图标真的出现 ----------
  await check('侧栏「最近」渲染出条目，生成期间显示转圈图标', async () => {
    await page.evaluate(() => {
      // ⚠️ 侧栏条目的 id 与 turn 的 threadId 必须是同一个（真实应用里就是同一个：
      // Composer 用 thread/start 返回的 id 同时做这两件事）。用不同的 id 测不出东西。
      window.replay.reset('th_dom');
      window.replay.configure({ activeThreadId: null, recentsExpanded: true });
      window.replay.upsertPending('th_dom', '侧栏应该能看到这句');
    });
    // 条目文本出现在侧栏
    const item = page.locator('aside').getByText('侧栏应该能看到这句');
    await item.waitFor({ timeout: 3000 });
    assert.equal(await item.count(), 1, '最近里应有这条会话');

    // 未开始生成时不应有转圈
    assert.equal(
      await page.locator('aside [aria-label="正在生成回复"]').count(),
      0,
      '没在生成时不该有转圈',
    );

    // 开始生成 → 转圈出现
    await page.evaluate(() => window.replay.pending('侧栏应该能看到这句'));
    await page.locator('aside [aria-label="正在生成回复"]').waitFor({ timeout: 3000 });
    assert.equal(await page.locator('aside [aria-label="正在生成回复"]').count(), 1, '生成期间应有 1 个转圈');

    // 生成结束 → 转圈消失
    await page.evaluate(() => {
      window.replay.event('turn/started', { turn: { id: 'turn', status: 'inProgress' } });
      window.replay.event('turn/completed', { turn: { id: 'turn', status: 'completed' } });
    });
    await page.waitForFunction(
      () => document.querySelectorAll('aside [aria-label="正在生成回复"]').length === 0,
      undefined,
      { timeout: 3000 },
    );
    assert.equal(await page.locator('aside [aria-label="正在生成回复"]').count(), 0, '完成后转圈应消失');
  });

  // ---------- ⑨ 合并：内核按 provider 过滤掉的会话必须被补回来 ----------
  //
  // 这是用户 2026-10-01 报告的第二个问题："这个项目里边的各种会话记录没了"。
  // 根因：内核 thread/list **只返回 model_provider 等于当前 provider 的会话**。
  // 实测 96 条未归档会话里只返回 33 条（全部 replica_relay），
  // 隐藏的 63 条 provider = custom/probe/stringai —— 项目里登记的恰好都是这些。
  // 修法：与 env:threads（应用直读 sqlite，不做该过滤）并行取、按 id 合并。
  await check('内核按 provider 隐藏的会话会被本地库补回来', async () => {
    await page.evaluate(() => {
      window.replay.reset('t-merge');
      window.replay.configure({ envList: { activeId: 'e1', envs: [], relays: [], official: {} } });
    });
    await page.evaluate(() =>
      window.replay.loadThreads(
        // 内核只返回当前 provider（replica_relay）的 2 条
        [
          { id: 'k1', name: '内核可见 A', modelProvider: 'replica_relay', recencyAt: 3000 },
          { id: 'k2', name: '内核可见 B', modelProvider: 'replica_relay', recencyAt: 1000 },
        ],
        // 本地库有全部 4 条（含被隐藏的 h1/h2）
        [
          { id: 'k1', name: '内核可见 A', modelProvider: 'replica_relay', recencyAt: 3000000 },
          { id: 'k2', name: '内核可见 B', modelProvider: 'replica_relay', recencyAt: 1000000 },
          { id: 'h1', name: '被隐藏的旧会话', modelProvider: 'stringai', recencyAt: 2000000 },
          { id: 'h2', name: '另一个隐藏会话', modelProvider: 'custom', recencyAt: 500000 },
        ],
      ),
    );
    const rows = await page.evaluate(() => window.replay.threads());
    assert.equal(rows.length, 4, '被内核隐藏的 2 条必须补回来，共 4 条');
    assert.ok(rows.some((t) => t.id === 'h1'), 'h1 必须出现在列表里');
    assert.ok(rows.some((t) => t.id === 'h2'), 'h2 必须出现在列表里');
  });

  // ---------- ⑩ 合并排序：内核（秒）与本地库（毫秒）必须正确交错 ----------
  //
  // ⚠️ 这是最容易写错的地方：内核 recencyAt 是**秒**、本地库是**毫秒**。
  // 不归一化直接相减，秒级值看起来小 1000 倍 → 内核条目会全部沉底。
  // 另外内核的排序键是 recencyAt 而**不是** updatedAt（实测确认），用错键顺序会乱。
  await check('合并后按 recency 正确排序（秒/毫秒归一化）', async () => {
    await page.evaluate(() =>
      window.replay.loadThreads(
        // 内核：秒级时间戳（1790835228 ≈ 2026-10）
        [{ id: 'k1', name: '内核条目', recencyAt: 1790835228 }],
        // 本地库：毫秒级时间戳。故意让本地这条更**旧**，它应该排在后面
        [
          { id: 'k1', name: '内核条目', recencyAt: 1790835228000 },
          { id: 'e1', name: '本地较旧', recencyAt: 1790835000000 },
        ],
      ),
    );
    const rows = await page.evaluate(() => window.replay.threads());
    assert.equal(rows.length, 2);
    assert.equal(rows[0].id, 'k1', '较新的内核条目应排第一（若未归一化会被本地毫秒值挤到后面）');
    assert.equal(rows[1].id, 'e1', '较旧的本地条目应排第二');
  });

  // ---------- ⑪ 同一 id 冲突时以内核数据为准 ----------
  await check('同一 id 同时出现在两份数据里时以内核为准', async () => {
    await page.evaluate(() =>
      window.replay.loadThreads(
        [{ id: 'dup', name: '内核标题', recencyAt: 1790835228 }],
        [{ id: 'dup', name: '本地标题', recencyAt: 1790835228000 }],
      ),
    );
    const rows = await page.evaluate(() => window.replay.threads());
    assert.equal(rows.length, 1, '不能出现重复条目');
    assert.equal(rows[0].name, '内核标题', '应以内核数据为准');
  });

  // ---------- ⑫ 只读说明：provider 已不存在的会话要点明原因 ----------
  //
  // 我们把被内核隐藏的历史补回了列表（见 ⑨），这些会话**历史可读但无法继续** ——
  // resume/turn/start 会因 "Model provider `xxx` not found" 失败。
  // 必须把原始英文报错换成用户能懂、且知道下一步的说明，否则他会以为会话坏了。
  await check('打开 provider 已不存在的会话时给出可读的只读说明', async () => {
    await page.evaluate(() => {
      window.replay.reset('t-readonly');
      window.replay.resumeFailsWith(
        'Error: Error invoking remote method \'codex:request\': AppServerRpcError: failed to load configuration: Model provider `stringai` not found',
      );
    });
    await page.evaluate(() => window.replay.openThread('t-readonly'));
    const notices = await page.evaluate(() => window.replay.errors());
    const notice = notices.find((e) => e.threadId === 't-readonly');
    assert.ok(notice, '应产生一条针对该会话的提示');
    assert.match(notice.message, /stringai/, '要指出是哪个接入不见了');
    assert.match(notice.message, /不能继续对话/, '要说明当前状态');
    assert.match(notice.message, /设置/, '要给出下一步');
    // 不能把原始英文报错直接甩给用户
    assert.doesNotMatch(notice.message, /AppServerRpcError|remote method/);
  });

  // ---------- ⑬ 非 provider 类的 resume 失败不应打扰用户 ----------
  await check('普通的 resume 失败（内核不支持等）不弹提示', async () => {
    await page.evaluate(() => {
      window.replay.reset('t-quiet');
      window.replay.resumeFailsWith('some unrelated transport hiccup');
    });
    await page.evaluate(() => window.replay.openThread('t-quiet'));
    const notices = await page.evaluate(() => window.replay.errors());
    assert.equal(notices.filter((e) => e.threadId === 't-quiet').length, 0, '不该产生提示');
  });

  // ---------- ⑭ 侧栏滚动：项目/最近共用一条滚动条 + 标题吸顶 ----------
  //
  // 用户反馈（2026-10-01）：
  //   "滚动条应该是项目和最近共用一个……往下滑的话，项目和最近可以保留在最上面，
  //    一直往下滑，项目已经划走了，那只有最近在最上面"
  // 以前是「项目」固定高度、「最近」自己 overflow-y-auto —— 项目一多最近就被挤没，
  // 而且两个列表各滚各的。现在两节共用一个滚动容器，标题各自 sticky。
  await check('侧栏「项目」「最近」共用一条滚动条且标题吸顶', async () => {
    await page.evaluate(() => {
      window.replay.reset('t-scroll');
      window.replay.configure({
        sidebarVisible: true,
        windowNarrow: false,
        recentsExpanded: true,
        projects: Array.from({ length: 5 }, (_, i) => ({
          id: `p${i}`, name: `项目${i}`, path: `D:/p${i}`, threadIds: [],
        })),
        threads: Array.from({ length: 60 }, (_, i) => ({
          id: `th${i}`, name: `会话 ${i}`, preview: `会话 ${i}`, recencyAt: 1000000 - i,
        })),
        bootPhase: { envs: true, threads: true, projects: true },
      });
    });
    await page.waitForTimeout(400);

    const r = await page.evaluate(() => {
      const aside = document.querySelector('aside');
      if (!aside) return { error: 'no aside' };
      const scrollable = (el) => {
        const cs = getComputedStyle(el);
        return /(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 1;
      };
      const all = [aside, ...aside.querySelectorAll('*')];
      const scrollers = all.filter(scrollable);
      const scroller =
        scrollers.find((el) => el.innerText.includes('项目') && el.innerText.includes('最近')) ?? scrollers[0];
      if (!scroller) return { scrollerCount: scrollers.length, error: 'no scroller' };

      const projBtn = [...scroller.querySelectorAll('button')].find((b) => b.innerText.trim().startsWith('项目'));
      const recBtn = [...scroller.querySelectorAll('button')].find((b) => b.innerText.trim().startsWith('最近'));
      const newChatBtn = [...aside.querySelectorAll('button')].find((b) => b.innerText.trim() === '新聊天');
      const top = () => Math.round(scroller.getBoundingClientRect().top);

      scroller.scrollTop = 0;
      const newChatAt0 = newChatBtn ? Math.round(newChatBtn.getBoundingClientRect().top) : null;

      scroller.scrollTop = 100;
      const projSticky = Math.abs(Math.round(projBtn.getBoundingClientRect().top) - top()) <= 2;

      scroller.scrollTop = scroller.scrollHeight;
      const recSticky = Math.abs(Math.round(recBtn.getBoundingClientRect().top) - top()) <= 2;
      const projGone = projBtn.getBoundingClientRect().bottom <= top();

      scroller.scrollTop = 300;
      const newChatAt300 = newChatBtn ? Math.round(newChatBtn.getBoundingClientRect().top) : null;
      scroller.scrollTop = 0;

      return {
        scrollerCount: scrollers.length,
        projSticky,
        recSticky,
        projGone,
        newChatFixed: newChatAt0 === newChatAt300,
      };
    });

    assert.ok(!r.error, r.error ?? '');
    assert.equal(r.scrollerCount, 1, '「项目」与「最近」应共用**一个**滚动容器');
    assert.ok(r.projSticky, '「项目」标题应吸顶');
    assert.ok(r.recSticky, '「最近」标题应吸顶');
    assert.ok(r.projGone, '滚到底时「项目」标题应被顶出可视区');
    assert.ok(r.newChatFixed, '「新聊天」不应参与滚动');
  });

  if (errors.length) throw new Error('页面报错：' + errors.join(' | '));
  console.log(`\nAll ${passed} recents checks passed.`);
} finally {
  await browser.close();
  await server.close();
}
