from pathlib import Path
root = Path(__file__).resolve().parents[1]
path = root / 'src/renderer/src/components/ThreadView.tsx'
source = path.read_text(encoding='utf-8')
if '../lib/activityModel' in source:
    raise RuntimeError('Upstream activity module is already integrated')
anchor = 'import { normalizeMath } from "../lib/normalizeMath";'
source = source.replace(anchor, anchor + '''
import { commandBody, describeActivity, activityGroupSummary, activityGroupPrimary } from "../lib/activityModel";
import { parseReasoning } from "../vendor/codex-monitor/reasoning";
import { useActivityDisclosure } from "../lib/useActivityDisclosure";''', 1)
begin = source.index('/** 把命令外壳')
end = source.index('/** 官方 h(r)', begin)
source = source[:begin] + source[end:]
begin = source.index('    const cmd = Array.isArray(item?.command)')
end = source.index('\n  }', begin)
source = source[:begin] + '''    const data = describeActivity(item!, true);
    return data.label + (data.detail ? ' ' + data.detail : '');''' + source[end:]
source = source.replace('const [expanded, setExpanded] = useState<boolean | null>(null);', 'const [expanded, setExpanded] = useActivityDisclosure("group", items[0]?.id ?? "empty");', 1)
begin = source.index('  const commands = tools.filter(')
end = source.index('  return <div className="flow-cluster', begin)
source = source[:begin] + '''  const summary = activityGroupSummary(tools);
  const primary = activityGroupPrimary(tools);
  const primaryType = itemType(primary);
''' + source[end:]
source = source.replace('{fileCount ? <FilePenLine size={14} /> : commands.length ? <TerminalSquare size={14} /> : <Globe size={14} />}', '{primaryType === "fileChange" ? <FilePenLine size={14} /> : primaryType === "commandExecution" ? <TerminalSquare size={14} /> : <Globe size={14} />}', 1)
begin = source.index('  const [open, setOpen] = useState(false);', source.index('const ReasoningRow'))
end = source.index('  if (!preview && !running)', begin)
source = source[:begin] + '''  const [savedOpen, setOpen] = useActivityDisclosure("item", item.id);
  const open = savedOpen ?? false;
  const text = reasoningText(item);
  const parsed = parseReasoning({ summary: text });
  const preview = parsed.workingLabel ?? "";
''' + source[end:]
begin = source.index('  const [manual, setManual] = useState(false);', source.index('const CommandRow'))
end = source.index('  const cmd = ', begin)
source = source[:begin] + '  const [savedOpen, setOpen] = useActivityDisclosure("item", item.id);\n' + source[end:]
source = source.replace('  const action = commandAction(item);', '  const data = describeActivity(item, running);', 1)
begin = source.index('  const actionLabel = ')
end = source.index('  const hasBody = ', begin)
source = source[:begin] + '''  const actionLabel = ["read", "search", "list"].includes(data.category ?? "")
    ? data.label + (data.detail ? " " + data.detail : "") : null;
''' + source[end:]
source = source.replace('const open = manual ? userOpen : failed && hasBody;', 'const open = savedOpen ?? (failed && hasBody);', 1)
source = source.replace('''            setManual(true);
            setUserOpen(!open);''', '''            setOpen(!open);''', 1)
source = source.replace('''          type="button"
          onClick={() => {
            setOpen(!open);''', '''          type="button"
          aria-expanded={open}
          onClick={() => {
            setOpen(!open);''', 1)
source = source.replace('''    case "dynamic_tool_call":
      return <ToolCallRow item={item} running={running} />;''', '''    case "dynamic_tool_call":
      return <ToolCallRow item={item} running={running} />;
    case "collabAgentToolCall":
    case "subAgentActivity": {
      const data = describeActivity(item, running);
      return <ActivityLine tone={data.tone === "error" ? "text-[var(--red-500)]" : tone}
        icon={<ListTodo size={14} />} text={data.label + (data.detail ? " · " + data.detail : "")} />;
    }''', 1)
path.write_text(source, encoding='utf-8')
print('Production ThreadView now consumes the pinned upstream activity and reasoning modules.')
