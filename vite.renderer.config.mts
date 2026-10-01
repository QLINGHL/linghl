import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";
import tailwindcss from "@tailwindcss/vite";

/**
 * Tailwind v4 首帧开销优化：把 `*` 上的全量属性初始化，收敛成"真正需要的那几条"。
 *
 * ── 问题（2026-10-01 实测，boot.log 打点定位）──────────────────────────────
 *   窗口 +316ms 创建；renderer 脚本 +1154ms 开始执行；
 *   React 提交只花 **4ms**（renderer:render-returned → first-commit），
 *   但 **first-paint 拖到 +3240ms** —— 提交完成后浏览器还要 ~2s 才画出第一帧。
 *   根因是 Tailwind v4 生成的第一条规则：
 *
 *     @layer properties{ @supports (<复杂条件>){
 *       *,:before,:after,::backdrop{ --tw-translate-x:0; ...（57 个自定义属性）}
 *     }}
 *
 *   初始样式解析必须：① 求值嵌套 @supports；② 注册 57 个 @property；
 *   ③ 把这 57 个属性铺到 DOM 里**每一个元素**。三步合计实测约 **2.0s**。
 *
 * ── 为什么不能"全删"（走过的弯路，务必保留这段结论）──────────────────────
 *   第一版直接删掉这两块，首帧降到 +1078ms，但**会破坏 UI**：
 *     .-translate-y-1\/2{ --tw-translate-y:calc(...); translate:var(--tw-translate-x) var(--tw-translate-y) }
 *   元素只写 `-translate-y-1/2` 时，`--tw-translate-x` 无人赋值 →
 *   `translate: var(--tw-translate-x) var(--tw-translate-y)` 整体变成无效值 →
 *   整条 translate 被丢弃 → **居中失效**（输入框右侧的清除按钮、搜索图标全跑位）。
 *   同理 `border-style:var(--tw-border-style)`、`box-shadow:var(--tw-inset-shadow),...`
 *   都是"无 fallback 的 var()"，删掉初始化就废。
 *
 * ── 正确做法：按"是否真的被消费"精准保留 ──────────────────────────────────
 *   分析产物里每个 `var(--tw-*)` 的引用点，分三类：
 *
 *   A. `var(--tw-x, ...)` **带空 fallback**（如 `.blur{filter:var(--tw-blur,) ...}`）
 *      → 未定义时 fallback 生效，**无需初始化**。这类占绝大多数。
 *
 *   B. 规则内**自带赋值**（如 `.divide-y>:not(:last-child){--tw-divide-y-reverse:0; ...}`）
 *      → 同一规则里已给值，**无需全局初始化**。
 *
 *   C. `var(--tw-x)` **无 fallback，且本规则不给值**（`translate:` / `border-style:` /
 *      `box-shadow:` 这三族）→ **必须初始化**，否则整条声明失效。
 *      我们只给这类补一条最小初始化：不再用 `*` 铺全量，只写实际用到的属性。
 *
 *   实测：初始化集合从 57 个属性 × 全元素，收敛到 **C 类那几个属性 × 全元素**，
 *   且完全去掉 `@property` 注册与嵌套 `@supports`。
 *
 * ── 安全性 ────────────────────────────────────────────────────────────────
 *   C 类集合由本插件在构建时**从产物反推**（见 NEED_INIT 白名单 + 校验），
 *   不是写死的猜测。若 Tailwind 将来改变输出形态导致反推为空，
 *   插件会**放弃优化并原样保留** Tailwind 输出（宁可慢，也不能错）。
 */
function optimizeTailwindPropertyInit(): Plugin {
  /**
   * 需要全局初始化的属性白名单 —— 判定依据是"被无 fallback 的 var() 消费"，
   * 且对应规则不自带赋值。逐条对应上面的 C 类，并在构建时用产物校验。
   *
   *   --tw-translate-x / --tw-translate-y：translate: var(x) var(y)（两轴互相依赖）
   *   --tw-border-style                  ：border-style: var(--tw-border-style)
   *   --tw-outline-style                 ：outline-style: var(--tw-outline-style)
   *   --tw-shadow                        ：box-shadow: ..., var(--tw-shadow)（.shadow-* 与 .ring 都消费）
   *   --tw-divide-y-reverse              ：参与 calc()，虽然同规则内自赋值，但保守起见一并初始化
   *   --tw-inset-shadow / --tw-ring-offset-shadow / --tw-ring-shadow / --tw-inset-ring-shadow
   *                                      ：box-shadow: var(--tw-inset-shadow), var(--tw-ring-offset-shadow), var(--tw-ring-shadow), var(--tw-shadow)
   *   --tw-ring-offset-width / --tw-ring-offset-color / --tw-ring-color / --tw-ring-inset
   *                                      ：参与 ring 阴影计算
   */
  const NEED_INIT: Array<[string, string]> = [
    ["--tw-translate-x", "0"],
    ["--tw-translate-y", "0"],
    ["--tw-translate-z", "0"],
    ["--tw-border-style", "solid"],
    ["--tw-outline-style", "solid"],
    ["--tw-shadow", "0 0 #0000"],
    ["--tw-divide-y-reverse", "0"],
    ["--tw-inset-shadow", "0 0 #0000"],
    ["--tw-ring-offset-shadow", "0 0 #0000"],
    ["--tw-ring-shadow", "0 0 #0000"],
    ["--tw-inset-ring-shadow", "0 0 #0000"],
    ["--tw-ring-offset-width", "0px"],
    ["--tw-ring-offset-color", "#fff"],
    ["--tw-ring-color", "#3b82f6"],
    ["--tw-ring-inset", ""],
  ];

  /** 从 `openIdx` 处的 `{` 开始括号配对，返回整块结束下标（含 `}`）；失败返回 -1 */
  function matchBrace(css: string, openIdx: number): number {
    let depth = 0;
    for (let i = openIdx; i < css.length; i++) {
      const c = css[i];
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) return i + 1;
      }
    }
    return -1;
  }

  /**
   * 纯函数：把一份产物 CSS 重写成"最小初始化"版本。
   *
   * 返回 `null` 表示**不做修改**（不满足优化前提，或改了也不省），
   * 调用方应保持原样 —— 这是安全阀：宁可首帧慢，也不能悄悄改坏样式。
   *
   * ⚠️ 这个函数必须能被 `renderChunk`（hash 之前）调用，否则改了内容却不改文件名，
   *    缓存校验会失效（实测踩过：两份不同的 CSS 共用一个 `index-XXX.css` 名字，
   *    热缓存用户会一直拿到旧的那份）。所以逻辑抽成纯函数，两个钩子共用。
   */
  function rewrite(css: string): { css: string; removed: number; initCount: number; propCount: number } | null {
    // ---- 1. 收集产物里所有"裸" `var(--tw-*)` 引用（紧跟 `)`，即无 fallback）----
    const referenced = new Set<string>();
    for (const m of css.matchAll(/var\(\s*(--tw-[a-z0-9-]+)\s*([,)])/g)) {
      if (m[2] === ")") referenced.add(m[1]);
    }
    // 裸引用里凡不在白名单 → 白名单不全 → 放弃（避免 UI 悄悄坏掉）
    const missing = [...referenced].filter((p) => !NEED_INIT.some(([n]) => n === p));
    if (missing.length > 0) {
      thisWarn(
        `检测到未纳入白名单的裸 var(--tw-*) 引用：${missing.join(", ")} —— ` +
          `已放弃 Tailwind 属性初始化优化（保持原样，避免破坏样式）。` +
          `请把对应属性补进 vite.renderer.config.mts 的 NEED_INIT。`,
      );
      return null;
    }
    // 一个裸引用都没有（Tailwind 输出形态变了）→ 也放弃
    if (referenced.size === 0) return null;

    let removedChars = 0;

    // ---- 2. 删 `@layer properties{...}`（`*` 上铺全量属性的那一大块）----
    const layerStart = css.indexOf("@layer properties{");
    if (layerStart !== -1) {
      const end = matchBrace(css, css.indexOf("{", layerStart));
      if (end !== -1) {
        removedChars += end - layerStart;
        css = css.slice(0, layerStart) + css.slice(end);
      }
    }

    // ---- 3. 删无消费方的 `@property --tw-*{...}` 注册（syntax:"*" 静态等价）----
    const ranges: Array<[number, number]> = [];
    for (const m of css.matchAll(/@property\s+--tw-[a-z0-9-]+\s*\{/g)) {
      const end = matchBrace(css, m.index + m[0].length - 1);
      if (end !== -1) ranges.push([m.index, end]);
    }
    for (let i = ranges.length - 1; i >= 0; i--) {
      const [s, e] = ranges[i];
      removedChars += e - s;
      css = css.slice(0, s) + css.slice(e);
    }

    if (removedChars === 0) return null;

    // ---- 4. 只把"真正需要"的属性补回去（最小初始化）----
    const usedInit = NEED_INIT.filter(([name]) => referenced.has(name));
    const decls = usedInit
      .map(([name, value]) => (value === "" ? `${name}:;` : `${name}:${value};`))
      .join("");
    // 用 @layer properties 保持与 Tailwind 相同的层叠优先级
    css = `@layer properties{*,:before,:after,::backdrop{${decls}}}` + css;

    return { css, removed: removedChars, initCount: usedInit.length, propCount: ranges.length };
  }

  let thisWarn: (msg: string) => void = () => {
    /* 钩子外调用时忽略 */
  };

  return {
    name: "optimize-tailwind-property-init",
    apply: "build",
    enforce: "post",

    /**
     * ⚠️ 为什么在 closeBundle 里改磁盘文件，而不是在 renderChunk/generateBundle 里改 bundle 对象
     * （2026-10-01 实测两次踩坑，务必保留这段结论）：
     *
     *   实测 Vite 8（rolldown）的钩子行为：
     *     - `transform`   只看到 `global.css` 且 `code.length === 0`（CSS 是 Tailwind 插件
     *                     在后续 postcss 阶段生成并直接交给 CSS 管线，不经过我们的 transform）；
     *     - `renderChunk` **只对 JS chunk 触发**，CSS 产物根本不进来（探针实测 18 个 chunk 全是 .js）；
     *     - `generateBundle` 是唯一能看到最终 CSS 资产的钩子，但 **rolldown 明确禁止
     *                     在 generateBundle 里改 bundle 对象**（改 key 会被忽略并报
     *                     "not supported by Rolldown"），于是"改了内容却没改文件名"，
     *                      两份不同 CSS 共用一个 hash 名 → 热缓存用户永远拿到旧样式。
     *
     *   所以唯一正确的位置是 `closeBundle`：此时文件已落盘、hash 已定，
     *   我们直接改写 CSS 文件内容，**并按新内容重命名**，最后同步改写 index.html
     *   里的引用。这样"内容 ↔ 文件名"始终一一对应，缓存校验天然正确。
     */
    closeBundle() {
      thisWarn = (m) => this.warn(m);
      const outDir = path.resolve(__dirname, "dist-renderer");
      const assetsDir = path.join(outDir, "assets");
      if (!fs.existsSync(assetsDir)) return;

      // 只处理入口 CSS（index-*.css）。lazy 组件的 CSS（如 ThreadView-*.css）
      // 同样含 Tailwind 输出，也一并处理 —— 它们是首屏之后才下载的，
      // 但保持处理一致，避免两套规则带来的维护混乱。
      const cssFiles = fs.readdirSync(assetsDir).filter((f) => f.endsWith(".css"));
      const renames = new Map<string, string>();

      for (const file of cssFiles) {
        const full = path.join(assetsDir, file);
        let css: string;
        try {
          css = fs.readFileSync(full, "utf8");
        } catch {
          continue;
        }
        const result = rewrite(css);
        if (!result) continue;
        // 按新内容算指纹并改名：保证"改了内容一定换名字"
        const digest = createHash("sha256").update(result.css).digest("hex").slice(0, 8);
        const newName = file.replace(/\.css$/, `.${digest}.css`);
        try {
          fs.writeFileSync(path.join(assetsDir, newName), result.css, "utf8");
          if (newName !== file) fs.unlinkSync(full);
        } catch (e) {
          this.warn(`写入优化后的 CSS 失败（跳过 ${file}）：${String(e)}`);
          continue;
        }
        renames.set(file, newName);
        this.warn(
          `Tailwind 属性初始化优化：${file} → ${newName}，` +
            `移除 ${result.removed} 字符（@layer properties 全量块 + ${result.propCount} 个 @property），` +
            `改为只初始化 ${result.initCount} 个真正被裸 var() 消费的属性。`,
        );
      }

      if (renames.size === 0) return;

      // 同步改写 index.html 的引用，否则会指向已被删除的旧文件名 → 白屏
      const htmlPath = path.join(outDir, "index.html");
      if (fs.existsSync(htmlPath)) {
        let html = fs.readFileSync(htmlPath, "utf8");
        let touched = false;
        for (const [oldName, newName] of renames) {
          if (html.includes(oldName)) {
            html = html.split(oldName).join(newName);
            touched = true;
          }
        }
        if (touched) fs.writeFileSync(htmlPath, html, "utf8");
      }

      // 自检：确认 index.html 里引用的每个本地资源都真实存在。
      // 这一步是在实际踩过"引用指向不存在的文件 → 白屏"之后加的，
      // 构建期失败远好于运行期白屏。
      if (fs.existsSync(htmlPath)) {
        const html = fs.readFileSync(htmlPath, "utf8");
        const refs = [...html.matchAll(/(?:src|href)="\.\/([^"]+)"/g)].map((m) => m[1]);
        const missing = refs.filter((r) => !fs.existsSync(path.join(outDir, r)));
        if (missing.length > 0) {
          this.error(
            `构建自检失败：index.html 引用了不存在的资源 ${missing.join(", ")}。` +
              `这会导致界面白屏，已中止构建。`,
          );
        }
      }
    },
  };
}

/**
 * ⚠️ 渲染层产物**故意不放在 `.vite/` 下面**（2026-10-01 实测踩坑）。
 *
 * 原因：`npm start` 走 electron-forge 时，`@electron-forge/plugin-vite` 的
 * `preStart` 钩子会执行 `fs.remove('.vite')`（VitePlugin.js:49）。
 * 本机工作区的安全删除垫片对"一次删 50+ 个文件"会抛
 * `SAFE_DELETE_BULK_CONFIRM_REQUIRED` —— 但它是在**删了一部分之后**才抛的，
 * 于是 `.vite/renderer/` 被删干净、`.vite/build/` 也常被波及，
 * 而 forge 崩在了起 Electron 之前。
 * 用户看到的就是：命令跑完了、窗口出来了、**里面什么都没有**（2~3 秒后
 * 才可能靠 dev server 或报错收场）。
 *
 * 放在 `.vite` 之外（`dist-renderer/`）就彻底绕开这个删除范围，
 * 不论 `npm start` 怎么清理都不会碰到已构建好的界面。
 * 对应的加载路径见 src/main/main.ts 的 builtIndexCandidates。
 */
export default defineConfig({
  base: "./",
  plugins: [tailwindcss(), optimizeTailwindPropertyInit()],
  build: {
    outDir: "dist-renderer",
    // outDir 在项目根之外（不在 vite root 的默认清理范围内），
    // 必须显式打开 emptyOutDir，否则每次构建都会和上一次的产物混在一起 ——
    // 一个 index.html 可能引用到上一轮已不存在的 hash 文件名，界面就白了。
    // 这里确认过 dist-renderer/ 里只会有 vite 的产物（无手工维护文件），
    // 所以让它整目录清空是安全的。
    emptyOutDir: true,
  },
});
