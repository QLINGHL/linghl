import fs from "node:fs";
import path from "node:path";

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  maximized: boolean;
}

export interface DeskStateData {
  projects: { name: string; path: string; lastOpenedAt: number }[];
  bounds?: WindowBounds;
  preferences: {
    theme: "system" | "light" | "dark";
    model: string;
    effort: string;
    permission: "read-only" | "workspace-write" | "full-access";
    notifications: boolean;
    sendShortcut: "enter" | "mod-enter";
    fontSize: number;
    pinnedThreads: string[];
    shell: string;
    lang: string;
    fullView: boolean;
    bottomPanel: boolean;
    promptSuggest: boolean;
    projectsFolder: string;
  };
}

const DEFAULTS: DeskStateData = {
  projects: [],
  preferences: {
    theme: "system",
    model: "",
    effort: "",
    permission: "workspace-write",
    notifications: true,
    sendShortcut: "enter",
    fontSize: 14,
    pinnedThreads: [],
    shell: "powershell",
    lang: "auto",
    fullView: false,
    bottomPanel: false,
    promptSuggest: false,
    projectsFolder: "",
  },
};

/** 校验持久化/传参中的窗口 bounds，防止脏数据把窗口开到屏幕外或尺寸为 0 */
function isValidBounds(v: unknown): v is WindowBounds {
  if (!v || typeof v !== "object") return false;
  const b = v as Partial<WindowBounds>;
  return (
    typeof b.x === "number" && Number.isFinite(b.x) &&
    typeof b.y === "number" && Number.isFinite(b.y) &&
    typeof b.width === "number" && b.width > 0 &&
    typeof b.height === "number" && b.height > 0 &&
    typeof b.maximized === "boolean"
  );
}

/** 与官方应用同构的 desk-state.json（存于本应用独立 userData，互不可见） */
export class DeskState {
  data: DeskStateData;
  private file: string;

  constructor(dir: string) {
    this.file = path.join(dir, "desk-state.json");
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf-8")) as Partial<DeskStateData>;
      this.data = {
        projects: Array.isArray(raw.projects) ? raw.projects : DEFAULTS.projects,
        bounds: isValidBounds(raw.bounds) ? raw.bounds : undefined,
        preferences: { ...DEFAULTS.preferences, ...(raw.preferences ?? {}) },
      };
    } catch {
      this.data = structuredClone(DEFAULTS);
      this.save();
    }
  }

  update(patch: Record<string, unknown>) {
    if (patch.preferences && typeof patch.preferences === "object") {
      this.data.preferences = { ...this.data.preferences, ...(patch.preferences as object) };
    }
    if (Array.isArray(patch.projects)) {
      this.data.projects = patch.projects as DeskStateData["projects"];
    }
    if (isValidBounds(patch.bounds)) {
      this.data.bounds = patch.bounds;
    }
    this.save();
  }

  addProject(p: { name: string; path: string }) {
    if (!this.data.projects.some((x) => x.path === p.path)) {
      this.data.projects.push({ ...p, lastOpenedAt: Date.now() });
      this.save();
    }
  }

  /**
   * ⚠️ 写盘失败绝不能让异常冒到主进程顶层：Electron 会弹「A JavaScript error occurred in the main
   * process」的模态框，用户看到的就是一个只能点确定的报错窗口，应用等于打不开。
   * 桌面状态（窗口位置/主题/项目列表）属于「丢了也不致命」的数据 —— 失败就记一条日志，继续跑。
   * 2026-09-30 实测：一次 EPERM 写入异常就是这样把启动流程打断的。
   */
  private save() {
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), "utf-8");
    } catch (error) {
      console.error(`[desk-state] 写入失败（忽略，不影响使用）：${this.file}`, error);
    }
  }
}
