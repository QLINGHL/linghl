import type { ThreadItem } from '../store';
import { summarizeActivity, type ActivityDescription } from '../vendor/codex-webui/activity.js';

// Host adapter for the pinned upstream implementation. The upstream files stay
// unchanged; Windows shell wrappers and protocol aliases are resolved here.
const aliases: Record<string, string> = { command_execution: 'commandExecution', file_change: 'fileChange',
  web_search: 'webSearch', image_view: 'imageView', mcp_tool_call: 'mcpToolCall', dynamic_tool_call: 'dynamicToolCall' };
export function commandBody(cmd: string): string {
  const inner = cmd.match(/-Command\s+(["'])([\s\S]*)\1\s*$/i);
  return inner ? (inner[1] === "'" ? inner[2].replace(/''/g, "'") : inner[2]) : cmd;
}
/** 官方展示口径：命令串里带 \" 两级转义，落屏前必须还原成真实引号（实测官方卡片显示 `python -c "…"`）。 */
export function displayCommand(cmd: string): string {
  return commandBody(cmd).replace(/\\"/g, '"').replace(/\\'/g, "'");
}
export function normalizedActivity(item: ThreadItem, running?: boolean): ThreadItem {
  const type = aliases[String(item.type ?? item.itemType)] ?? String(item.type ?? item.itemType);
  let status = String(item.status ?? 'completed');
  if (running === true) status = 'inProgress';
  else if (['pending', 'queued', 'in_progress', 'inprogress'].includes(status.toLowerCase())) status = 'inProgress';
  if (['error', 'errored'].includes(status) || (item.exitCode != null && Number(item.exitCode) !== 0) ||
    item.success === false || item.error) status = 'failed';
  return { ...item, type, status, command: commandBody(Array.isArray(item.command) ? item.command.join(' ') : String(item.command ?? '')) };
}
export function describeActivity(item: ThreadItem, running?: boolean): ActivityDescription {
  const normalized = normalizedActivity(item, running);
  const data = summarizeActivity(normalized);
  if (normalized.type !== 'commandExecution' || data.tone === 'error') return data;
  const actions = Array.isArray(item.commandActions) ? item.commandActions as Record<string, unknown>[] : [];
  const recognized = actions.filter(action => ['read', 'search', 'listFiles', 'list_files'].includes(String(action.type)));
  // An unknown component means the complete command must remain visible.
  if (!actions.length || recognized.length !== actions.length) return data;
  const action = recognized[0];
  const category = action.type === 'read' ? 'read' : action.type === 'search' ? 'search' : 'list';
  const labels = category === 'read' ? ['Reading', 'Read'] : category === 'search' ? ['Searching', 'Searched'] : ['Listing', 'Listed'];
  return { ...data, category, label: labels[data.active ? 0 : 1],
    detail: String(action.query ?? action.path ?? action.name ?? 'files') };
}

/* ────────────────────────────────────────────────────────────────────────────
 * 活动组摘要
 * 官方实现（conversation-blocks 的 Ae/summaryParts + agent-activity-units 的 ke）：
 *   · 分段顺序固定：file-changes → exploration → commands → web-search（前面还有
 *     mcp-sources / loaded-tools / unnamed-mcp-calls，本项目暂不产出）
 *   · 每段首段用 leading 文案、后续段用 following 文案（首字母小写）
 *   · **分段之间没有连接符，直接拼接** —— 官方实测显示为
 *     `Edited a fileran commandsearched the web`，不是 "Edited a file, ran ... and ..."
 *   · 组图标取第一段的类型（file-changes→铅笔 / exploration→文件 / commands→终端 / web-search→地球）
 * 文案按运行中的官方界面逐字抄录（官方包里的 i18n 默认值与线上文案已不一致，以实测为准）。
 * ──────────────────────────────────────────────────────────────────────────── */

type SummaryPartKind = 'file-changes' | 'exploration' | 'commands' | 'web-search' | 'other';

interface SummaryPart {
  kind: SummaryPartKind;
  count: number;
}

const PART_LABELS: Record<Exclude<SummaryPartKind, 'other'>, { leading: (count: number) => string; following: (count: number) => string }> = {
  'file-changes': {
    leading: (count) => (count === 1 ? 'Edited a file' : 'Edited files'),
    following: (count) => (count === 1 ? 'edited a file' : 'edited files'),
  },
  exploration: { leading: () => 'Read files', following: () => 'read files' },
  commands: {
    leading: (count) => (count === 1 ? 'Ran a command' : 'Ran commands'),
    following: (count) => (count === 1 ? 'ran a command' : 'ran commands'),
  },
  'web-search': { leading: () => 'Searched the web', following: () => 'searched the web' },
};

/** 官方 Ae：把一组活动项折叠成有序摘要分段 */
export function activityGroupParts(items: ThreadItem[]): SummaryPart[] {
  const normalized = items.map((item) => normalizedActivity(item));
  const healthy = normalized.filter((item) => describeActivity(item).tone !== 'error');
  let changedFiles = 0;
  let explored = false;
  let commands = 0;
  let searches = false;
  for (const item of healthy) {
    const data = describeActivity(item);
    switch (item.type) {
      case 'fileChange':
        changedFiles += Math.max(1, Array.isArray(item.changes) ? item.changes.length : 1);
        break;
      case 'commandExecution':
        if (['read', 'search', 'list'].includes(String(data.category ?? ''))) explored = true;
        else commands += 1;
        break;
      case 'webSearch':
        searches = true;
        break;
      default:
        break;
    }
  }
  const parts: SummaryPart[] = [];
  if (changedFiles > 0) parts.push({ kind: 'file-changes', count: changedFiles });
  if (explored) parts.push({ kind: 'exploration', count: 1 });
  if (commands > 0) parts.push({ kind: 'commands', count: commands });
  if (searches) parts.push({ kind: 'web-search', count: 1 });
  return parts;
}

/**
 * 摘要文案：首段大写、后续小写，用 " and " 连接（= 上游 joinActivityParts 的行为）。
 *
 * ⚠️ 这里原来在结尾又追加了三句失败说明（"Commands with failures" / "Commands interrupted" /
 * "Tools interrupted or failed"），其中三条**漏了连接词**，实测在活动组头上渲染成
 * `Ran a commandCommands with failures` —— 又丑又读不通。
 * 而且上游（vendor/codex-webui/activity.js 的 completedActivitySummary）根本没有这几句：
 * 它只把健康项拼成摘要，失败状态由那一行自己表达（红色的 "Command failed"）。
 * 所以这里按上游对齐，删掉这几句。
 */
export function activityGroupSummary(items: ThreadItem[]): string {
  const normalized = items.map((item) => normalizedActivity(item));
  const parts = activityGroupParts(items);
  let text = parts
    .map((part, index) => PART_LABELS[part.kind as Exclude<SummaryPartKind, 'other'>][index === 0 ? 'leading' : 'following'](part.count))
    .join(' and ');
  if (normalized.some((item) => /ToolCall/.test(String(item.type)))) text += `${text ? ', ' : ''}used tools`;
  if (text) return text;
  // 上游：没有健康项可总结时，全失败 → "Activity failed"，否则 "Worked"
  return normalized.some((item) => describeActivity(item).tone === 'error') ? 'Activity failed' : 'Worked';
}

/** 组图标只由第一段的类型决定（官方 ke: iconItem = Pe({ firstPart: summaryParts[0] })） */
export function activityGroupIconKind(items: ThreadItem[]): SummaryPartKind {
  const parts = activityGroupParts(items);
  return parts[0]?.kind ?? 'other';
}
