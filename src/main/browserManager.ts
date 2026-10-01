import { BrowserWindow, WebContentsView, ipcMain, session, type WebContents } from "electron";

/**
 * 工作区内置浏览器 —— 对齐官方 ChatGPT 桌面版的做法。
 *
 * 官方（`asar-out/.vite/build/main-DAwJoFgo.js` 实测）：浏览面板**不是**渲染层的
 * `<webview>`，而是主进程的 `WebContentsView`，由主进程按像素摆位；每个标签的
 * `webContents` 上挂 `webContents.debugger`（CDP 1.3），页面能力全部经 CDP 白名单
 * 暴露给"Browser Use"（模型侧再包成 MCP 工具）。官方自己的 webPreferences 里
 * `webviewTag` 是 **false**。
 *
 * 这里就按这套来：
 *   - 一个标签 = 一个 WebContentsView，加进主窗口的 contentView（独立图层，不受页面 CSS 影响）
 *   - 渲染层只报告"页面区域"的矩形（CSS px，与 setBounds 的 DIP 1:1），不参与绘制
 *   - CDP 方法白名单，与官方同一批；越权直接抛错
 *   - 另起一个本机 HTTP 桥（带 token）给 MCP server 用，模型因此可以真正"看见并操作"这个浏览器
 */

/** 与官方同款：只有这些 CDP 方法可以被外部（模型 / 渲染层）调用 */
const CDP_WHITELIST = new Set([
  "Page.navigate",
  "Page.navigateToHistoryEntry",
  "Page.reload",
  "Page.captureScreenshot",
  "Page.getNavigationHistory",
  "Page.getLayoutMetrics",
  "Page.bringToFront",
  "Runtime.evaluate",
  "Runtime.addBinding",
  "DOM.enable",
  "DOM.getDocument",
  "DOM.querySelector",
  "DOM.querySelectorAll",
  "DOM.getBoxModel",
  "DOM.describeNode",
  "DOM.focus",
  "CSS.enable",
  "CSS.getMatchedStylesForNode",
  "Input.dispatchMouseEvent",
  "Input.dispatchKeyEvent",
  "Input.insertText",
  "Network.enable",
  "Network.getResponseBody",
  "Emulation.setDeviceMetricsOverride",
]);

export interface BrowserState {
  id: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  favicon: string | null;
  error: string | null;
}

interface TabRecord {
  id: string;
  view: WebContentsView;
  cdpReady: boolean;
  lastError: string | null;
  state: BrowserState;
}

/** 抓取可交互元素时用的页面侧脚本（注入执行，返回编号 + 矩形） */
const SNAPSHOT_SCRIPT = `(() => {
  const REF = "data-replica-ref";
  document.querySelectorAll("[" + REF + "]").forEach((el) => el.removeAttribute(REF));
  const SEL = 'a[href],button,input,textarea,select,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[contenteditable="true"],summary';
  const out = [];
  const seen = new Set();
  const push = (el, extra) => {
    if (seen.has(el)) return;
    seen.add(el);
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0) return;
    if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return;
    const ref = out.length;
    el.setAttribute(REF, String(ref));
    const text = ((el.getAttribute("aria-label") || el.innerText || el.value || el.getAttribute("placeholder") || el.getAttribute("title") || "") + "").trim().replace(/\\s+/g, " ").slice(0, 120);
    out.push({ ref, tag: el.tagName.toLowerCase(), type: el.getAttribute("type") || undefined, role: el.getAttribute("role") || undefined, name: text || undefined, href: el.getAttribute("href") || undefined, value: (el.value ?? undefined), checked: el.checked === true ? true : undefined, disabled: el.disabled === true ? true : undefined, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width), h: Math.round(r.height), ...extra });
  };
  document.querySelectorAll(SEL).forEach((el) => push(el));
  // iframe 里的元素拿不到（跨域），但至少把 iframe 本身列出来
  document.querySelectorAll("iframe").forEach((el) => push(el, { note: "iframe" }));
  return JSON.stringify({
    url: location.href,
    title: document.title,
    viewport: { width: innerWidth, height: innerHeight, scrollX: Math.round(scrollX), scrollY: Math.round(scrollY), scrollHeight: document.documentElement.scrollHeight },
    text: (document.body ? document.body.innerText : "").replace(/\\n{3,}/g, "\\n\\n").slice(0, 4000),
    elements: out.slice(0, 160),
  });
})()`;

export class BrowserManager {
  /**
   * 视图还没有被界面摆放时的默认尺寸（对应官方的 `defaultBrowserUseViewportSize`）。
   * 模型在"标签还没显示出来"的时候新建并操作标签时，0×0 视口会让页面布局塌成 0，
   * 快照扫不到元素、截图也会挂住，所以这里给一个真实尺寸兜底。
   */
  private static readonly DEFAULT_BOUNDS = { x: 0, y: 0, width: 1280, height: 800 };

  private win: BrowserWindow | null = null;
  private tabs = new Map<string, TabRecord>();
  private activeId: string | null = null;
  private bounds = { x: 0, y: 0, width: 0, height: 0 };
  /** 渲染层报告过的页面区域，新建/切换标签时复用 */
  private emit: (state: BrowserState) => void = () => {};
  private onOpenUrl: (url: string) => void = () => {};
  /** 模型（MCP）那边新建了标签 → 通知界面把它加进工作区 */
  private onTabAdded: (tab: { id: string; url: string }) => void = () => {};

  attachWindow(win: BrowserWindow): void {
    this.win = win;
    win.on("closed", () => {
      this.win = null;
      this.tabs.clear();
      this.activeId = null;
    });
  }

  setEmitter(emit: (state: BrowserState) => void): void {
    this.emit = emit;
  }

  setTabAddedHandler(handler: (tab: { id: string; url: string }) => void): void {
    this.onTabAdded = handler;
  }

  /** 页面里 target=_blank / window.open → 交给渲染层开一个新标签 */
  setOpenUrlHandler(handler: (url: string) => void): void {
    this.onOpenUrl = handler;
  }

  list(): BrowserState[] {
    return [...this.tabs.values()].map((t) => t.state);
  }

  has(id: string): boolean {
    return this.tabs.has(id);
  }

  create(id: string): BrowserState {
    if (this.tabs.has(id)) return this.tabs.get(id)!.state;
    // 界面还没登记这个标签（多半是模型通过 MCP 建的）→ 让界面把它加进工作区
    this.onTabAdded({ id, url: "" });
    const view = new WebContentsView({
      webPreferences: {
        // 与官方一致：浏览器页面跑在独立 session（独立 cookie/缓存），沙箱打开、无 node
        session: session.fromPartition("persist:replica-browser"),
        sandbox: true,
        nodeIntegration: false,
        contextIsolation: true,
        webviewTag: false,
        // 页面里的 target=_blank 走主进程处理
        disableDialogs: false,
      },
    });
    this.win?.contentView.addChildView(view);
    view.setVisible(false);
    view.setBounds(this.bounds);

    const state: BrowserState = {
      id,
      url: "",
      title: "新标签页",
      loading: false,
      canGoBack: false,
      canGoForward: false,
      favicon: null,
      error: null,
    };
    const record: TabRecord = { id, view, cdpReady: false, lastError: null, state };
    this.tabs.set(id, record);

    const wc = view.webContents;
    const sync = () => {
      state.url = wc.getURL();
      const t = wc.getTitle();
      if (t) state.title = t;
      state.canGoBack = wc.navigationHistory.canGoBack();
      state.canGoForward = wc.navigationHistory.canGoForward();
      this.emit({ ...state });
    };
    wc.on("did-start-loading", () => {
      state.loading = true;
      this.emit({ ...state });
    });
    wc.on("did-stop-loading", () => {
      state.loading = false;
      state.error = null;
      sync();
    });
    wc.on("did-navigate", sync);
    wc.on("did-navigate-in-page", sync);
    wc.on("page-title-updated", (_e, title) => {
      state.title = title || state.title;
      this.emit({ ...state });
    });
    wc.on("page-favicon-updated", (_e, favicons) => {
      state.favicon = favicons?.[0] ?? null;
      this.emit({ ...state });
    });
    wc.on("did-fail-load", (_e, code, desc, validatedURL, isMainFrame) => {
      if (!isMainFrame || code === -3) return; // -3 = 主动中断
      state.loading = false;
      state.error = `${desc}（${code}）`;
      state.url = validatedURL || state.url;
      this.emit({ ...state });
    });
    wc.setWindowOpenHandler(({ url }) => {
      this.onOpenUrl(url);
      return { action: "deny" };
    });

    this.attachCdp(record);
    return state;
  }

  /**
   * 挂 CDP。官方用 `webContents.debugger` + `Target.attachToTarget`（还会接管 iframe 子目标），
   * 这里先挂主目标，把常用域打开，方便后面直接 sendCommand。
   */
  private attachCdp(record: TabRecord): void {
    const dbg = record.view.webContents.debugger;
    const open = async () => {
      try {
        if (!dbg.isAttached()) dbg.attach("1.3");
        for (const domain of ["Page.enable", "DOM.enable", "Runtime.enable", "Network.enable"]) {
          try {
            await dbg.sendCommand(domain);
          } catch {
            /* 某些域在个别页面上打开失败，不影响其它命令 */
          }
        }
        record.cdpReady = true;
      } catch (error) {
        record.cdpReady = false;
        record.lastError = String(error);
      }
    };
    void open();
    record.view.webContents.on("did-finish-load", () => {
      if (!record.cdpReady) void open();
    });
  }

  close(id: string): void {
    const record = this.tabs.get(id);
    if (!record) return;
    try {
      const dbg = record.view.webContents.debugger;
      if (dbg.isAttached()) dbg.detach();
    } catch {
      /* ignore */
    }
    try {
      this.win?.contentView.removeChildView(record.view);
    } catch {
      /* ignore */
    }
    if (!record.view.webContents.isDestroyed()) record.view.webContents.close();
    this.tabs.delete(id);
    if (this.activeId === id) this.activeId = null;
  }

  closeAll(): void {
    for (const id of [...this.tabs.keys()]) this.close(id);
  }

  activate(id: string | null): void {
    this.activeId = id;
    // 界面还没上报过矩形（例如模型刚建完标签就直接操作）时用默认视口，别让页面塌成 0×0
    const rect =
      this.bounds.width > 1 && this.bounds.height > 1 ? this.bounds : BrowserManager.DEFAULT_BOUNDS;
    for (const [tabId, record] of this.tabs) {
      const on = tabId === id;
      record.view.setVisible(on);
      if (on) record.view.setBounds(rect);
    }
  }

  setBounds(rect: { x: number; y: number; width: number; height: number }): void {
    // 渲染层给的是 CSS px，setBounds 用的 DIP 在 zoomFactor=1 时与之 1:1
    this.bounds = {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.max(0, Math.round(rect.width)),
      height: Math.max(0, Math.round(rect.height)),
    };
    const active = this.activeId ? this.tabs.get(this.activeId) : null;
    if (active) active.view.setBounds(this.bounds);
  }

  async navigate(id: string, url: string): Promise<void> {
    const record = this.tabs.get(id);
    if (!record) throw new Error(`未知标签页: ${id}`);
    const wc = record.view.webContents;
    // 不要把整页加载 await 掉：页面（或代理）挂住时会把 IPC / MCP 调用一起拖死，
    // 加载进度与失败都通过 browser-state 事件上报给界面。
    void wc.loadURL(url || "about:blank").catch((error) => {
      record.state.loading = false;
      record.state.error = String((error as Error)?.message ?? error).slice(0, 200);
      this.emit({ ...record.state });
    });
  }

  back(id: string): void {
    this.tabs.get(id)?.view.webContents.navigationHistory.goBack();
  }

  forward(id: string): void {
    this.tabs.get(id)?.view.webContents.navigationHistory.goForward();
  }

  reload(id: string): void {
    this.tabs.get(id)?.view.webContents.reload();
  }

  stop(id: string): void {
    this.tabs.get(id)?.view.webContents.stop();
  }

  /** 白名单 CDP，越权与官方同款报错 */
  async cdp(id: string, method: string, params: unknown): Promise<unknown> {
    const record = this.requireTab(id);
    if (!CDP_WHITELIST.has(method)) {
      throw new Error(`Browser Use CDP method is not supported in the in-app browser: ${method}`);
    }
    const dbg = record.view.webContents.debugger;
    if (!dbg.isAttached()) dbg.attach("1.3");
    return dbg.sendCommand(method, (params ?? {}) as Record<string, unknown>);
  }

  /** 页面结构快照：给模型"看"的东西（编号 + 矩形 + 可见文本） */
  async snapshot(id: string): Promise<string> {
    const raw = (await this.cdp(id, "Runtime.evaluate", {
      expression: SNAPSHOT_SCRIPT,
      returnByValue: true,
      awaitPromise: false,
    })) as { result?: { value?: string } };
    return raw?.result?.value ?? "{}";
  }

  /** 截图：整页或指定区域，返回 data URL */
  async screenshot(id: string, clip?: { x: number; y: number; width: number; height: number }): Promise<string> {
    const params: Record<string, unknown> = { format: "png", captureBeyondViewport: false };
    if (clip && clip.width > 0 && clip.height > 0) params.clip = { ...clip, scale: 1 };
    const raw = (await this.cdp(id, "Page.captureScreenshot", params)) as { data?: string };
    if (!raw?.data) throw new Error("截图失败");
    return `data:image/png;base64,${raw.data}`;
  }

  /** 按快照里的编号点击 */
  async clickRef(id: string, ref: number): Promise<void> {
    const info = await this.refCenter(id, ref);
    await this.clickPoint(id, info.x, info.y);
  }

  async refCenter(id: string, ref: number): Promise<{ x: number; y: number }> {
    const raw = (await this.cdp(id, "Runtime.evaluate", {
      expression: `(() => { const el = document.querySelector('[data-replica-ref="${ref}"]'); if (!el) return "null"; const r = el.getBoundingClientRect(); return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }); })()`,
      returnByValue: true,
    })) as { result?: { value?: string } };
    const text = raw?.result?.value ?? "null";
    if (text === "null") throw new Error(`快照里没有编号 ${ref} 的元素（页面可能已经变化，请重新 browser_snapshot）`);
    return JSON.parse(text) as { x: number; y: number };
  }

  async clickPoint(id: string, x: number, y: number): Promise<void> {
    const base = { x: Math.round(x), y: Math.round(y), button: "left", clickCount: 1 };
    await this.cdp(id, "Input.dispatchMouseEvent", { type: "mouseMoved", ...base, button: "none" });
    await this.cdp(id, "Input.dispatchMouseEvent", { type: "mousePressed", ...base });
    await this.cdp(id, "Input.dispatchMouseEvent", { type: "mouseReleased", ...base });
  }

  async typeText(id: string, text: string): Promise<void> {
    await this.cdp(id, "Input.insertText", { text });
  }

  async pressKey(id: string, key: string): Promise<void> {
    const map: Record<string, { key: string; code: string; keyCode: number }> = {
      Enter: { key: "Enter", code: "Enter", keyCode: 13 },
      Tab: { key: "Tab", code: "Tab", keyCode: 9 },
      Escape: { key: "Escape", code: "Escape", keyCode: 27 },
      Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
      ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
      ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
      ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
      ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
    };
    const info = map[key];
    if (!info) throw new Error(`不支持的按键: ${key}`);
    await this.cdp(id, "Input.dispatchKeyEvent", { type: "keyDown", ...info });
    await this.cdp(id, "Input.dispatchKeyEvent", { type: "keyUp", ...info });
  }

  private requireTab(id: string): TabRecord {
    const record = this.tabs.get(id);
    if (!record) throw new Error(`未知标签页: ${id}`);
    return record;
  }

  /** 当前激活标签（MCP 侧不给 tabId 时默认用它） */
  activeTabId(): string | null {
    if (this.activeId && this.tabs.has(this.activeId)) return this.activeId;
    const first = [...this.tabs.keys()][0];
    return first ?? null;
  }

  tabWebContents(id: string): WebContents | null {
    return this.tabs.get(id)?.view.webContents ?? null;
  }

  /** 渲染层过来的 IPC 全部在这里注册（preload 里有通道白名单） */
  registerIpc(): void {
    ipcMain.handle("browser:list", () => this.list());
    ipcMain.handle("browser:create", (_e, id: unknown) => this.create(String(id)));
    ipcMain.handle("browser:close", (_e, id: unknown) => {
      this.close(String(id));
      return true;
    });
    ipcMain.handle("browser:activate", (_e, id: unknown) => {
      this.activate(id === null || id === undefined ? null : String(id));
      return true;
    });
    ipcMain.handle("browser:set-bounds", (_e, rect: unknown) => {
      const r = rect as { x: number; y: number; width: number; height: number };
      if (r && typeof r.x === "number") this.setBounds(r);
      return true;
    });
    ipcMain.handle("browser:navigate", async (_e, p: { id: string; url: string }) => {
      await this.navigate(String(p?.id), String(p?.url ?? ""));
      return true;
    });
    ipcMain.handle("browser:back", (_e, p: { id: string }) => {
      this.back(String(p?.id));
      return true;
    });
    ipcMain.handle("browser:forward", (_e, p: { id: string }) => {
      this.forward(String(p?.id));
      return true;
    });
    ipcMain.handle("browser:reload", (_e, p: { id: string }) => {
      this.reload(String(p?.id));
      return true;
    });
    ipcMain.handle("browser:stop", (_e, p: { id: string }) => {
      this.stop(String(p?.id));
      return true;
    });
    ipcMain.handle("browser:cdp", (_e, p: { id: string; method: string; params?: unknown }) =>
      this.cdp(String(p?.id), String(p?.method), p?.params),
    );
    ipcMain.handle("browser:snapshot", (_e, p: { id: string }) => this.snapshot(String(p?.id)));
    ipcMain.handle("browser:screenshot", (_e, p: { id: string; clip?: { x: number; y: number; width: number; height: number } }) =>
      this.screenshot(String(p?.id), p?.clip),
    );
  }
}

export const browserManager = new BrowserManager();
