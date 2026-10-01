from pathlib import Path

p = Path('src/renderer/src/components/ThreadView.tsx')
s = p.read_text(encoding='utf-8')
start = s.index('const ActivityBody =')
end = s.index('/** 探索命令组', start)
s = s[:start] + '''// Commentary seals the preceding group. Only the current cluster has a live status.
const ActivityBody = memo(function ActivityBody({ items, activeItemId, live = false, finalStarted = false, phase }: {
  items: ThreadItem[]; activeItemId?: string; live?: boolean; finalStarted?: boolean; phase?: TurnPhase;
}) {
  const units: { key: string; items: ThreadItem[]; standalone?: ThreadItem }[] = [];
  for (const item of items) {
    if (ASSISTANT_TYPES.has(itemType(item)) || PLAN_TYPES.has(itemType(item)) || itemType(item) === "streamError") {
      units.push({ key: item.id, items: [], standalone: item });
    } else {
      const last = units.at(-1);
      if (last && !last.standalone) last.items.push(item);
      else units.push({ key: item.id, items: [item] });
    }
  }
  const tail = units.at(-1);
  return <div className="flow-activity flex min-w-0 flex-col gap-4 pt-3 pb-2">
    {units.map((unit, i) => unit.standalone
      ? <ActivityRow key={unit.key} item={unit.standalone} running={live && itemRunning(unit.standalone, activeItemId)} />
      : <ActivityCluster key={unit.key} items={unit.items} activeItemId={activeItemId} active={live && i === units.length - 1} finalStarted={finalStarted} phase={phase} />)}
    {live && !finalStarted && (!tail || tail.standalone) && !activeItemId ? <LiveStatusLine phase={phase} /> : null}
  </div>;
});

function ActivityCluster({ items, activeItemId, active, finalStarted, phase }: {
  items: ThreadItem[]; activeItemId?: string; active: boolean; finalStarted: boolean; phase?: TurnPhase;
}) {
  const [expanded, setExpanded] = useState<boolean | null>(null);
  const tools = items.filter(item => itemType(item) !== "reasoning");
  const latestReasoning = items.findLast(item => itemType(item) === "reasoning");
  const runningTool = active ? tools.findLast(item => itemRunning(item, activeItemId)) : undefined;
  const open = expanded ?? (active || tools.some(itemFailed));
  if (!active && tools.length === 0) return null;
  if (!active && tools.length === 1 && !latestReasoning) return <ActivityRow item={tools[0]} running={false} />;
  const commands = tools.filter(item => ["commandExecution", "command_execution"].includes(itemType(item)));
  const explores = commands.filter(item => isExploreCommand(String(item.command ?? ""), item));
  const summary = [
    commands.length > explores.length ? (commands.length - explores.length === 1 ? "Ran a command" : "Ran commands") : "",
    explores.length ? "Explored files" : "",
    tools.some(item => ["fileChange", "file_change"].includes(itemType(item))) ? "Edited files" : "",
    tools.some(item => ["webSearch", "web_search"].includes(itemType(item))) ? "Searched the web" : "",
    tools.some(item => /ToolCall|tool_call/.test(itemType(item))) ? "Used tools" : "",
  ].filter(Boolean).join(" · ") || "Activity";
  return <div className="flow-cluster flex min-w-0 flex-col gap-1">
    {!active ? <button type="button" aria-expanded={open} onClick={() => setExpanded(!open)} className="group/hdr inline-flex min-w-0 items-center gap-1 self-start py-0.5 text-[14px] text-text3">
      <TerminalSquare size={14} /><span>{summary}</span><ChevronRight size={12} className={open ? "rotate-90" : "opacity-0 group-hover/hdr:opacity-100"} />
    </button> : null}
    {open ? <>
      {active && !finalStarted && !runningTool ? latestReasoning ? <ReasoningRow item={latestReasoning} running tone="text-text3" /> : <LiveStatusLine phase={phase} /> : null}
      {tools.map(item => <ActivityRow key={item.id} item={item} running={active && itemRunning(item, activeItemId)} />)}
    </> : null}
  </div>;
}

''' + s[end:]
start = s.index('  const [open, setOpen]', s.index('const ReasoningRow ='))
end = s.index('\n});', start)
s = s[:start] + '''  const [open, setOpen] = useState(false);
  const text = reasoningText(item);
  const preview = text.replace(/\s+/g, " ").trim();
  if (!preview && !running) return null;
  return <div className="flex min-w-0 flex-col">
    <button type="button" aria-expanded={open} onClick={() => text && setOpen(!open)}
      className="group/hdr flex w-full min-w-0 items-center gap-1 py-0.5 text-left text-[14px] text-text3">
      <span className={"min-w-0 flex-1 truncate " + (running ? "shimmer-text" : "")}>{preview || "Thinking"}</span>
      {text ? <ChevronRight size={12} className={"shrink-0 transition-transform " + (open ? "rotate-90" : "opacity-0 group-hover/hdr:opacity-100")} /> : null}
    </button>
    {open && text ? <MarkdownMessage text={text} className="prose-chat flow-reasoning-detail py-2 text-[14px] text-text3" /> : null}
  </div>;''' + s[end:]
start = s.index('  const header = (', s.index('const CommandRow ='))
end = s.index('  return (', start)
s = s[:start] + '''  const header = <>
    {failed ? <TriangleAlert size={14} className="shrink-0" /> : <TerminalSquare size={14} className="shrink-0" />}
    <span className={"min-w-0 truncate " + (running ? "shimmer-text" : "")}>
      {failed ? "Command failed" : open ? (running ? "Running command" : "Ran command") :
        (running ? "Running " : "Ran ") + (commandBody(cmd).replace(/\s+/g, " ").trim() || "command")}
    </span>
    {hasBody ? <ChevronRight size={12} className={"shrink-0 transition-transform " + (open ? "rotate-90" : "opacity-0 group-hover/hdr:opacity-100")} /> : null}
  </>;

''' + s[end:]
s = s.replace('const open = manual ? userOpen : (running && Boolean(output)) || (failed && hasBody);', 'const open = manual ? userOpen : failed && hasBody;')
start = s.index('      {open && hasBody ? (', s.index('const CommandRow ='))
end = s.index('      ) : null}', start) + len('      ) : null}')
s = s[:start] + '''      {open && hasBody ? (
        <div className="flow-shell mt-2 rounded-xl border border-border bg-[var(--c-bg-raised)] px-3 py-2 text-[13px] text-text2">
          <div className="mb-3">Shell</div>
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-5">{"$ " + commandBody(cmd) + (output ? "\n\n" + output : "")}</pre>
          <div className="mt-3 flex justify-end gap-1 text-text3">{running ? "Running" : failed ? "Failed" : <><Check size={14} /> Success</>}</div>
        </div>
      ) : null}''' + s[end:]
s = s.replace('return "正在思考";', 'return "Thinking";').replace('return "正在处理";', 'return "Thinking";').replace('return "正在回应";', 'return "Thinking";')
s = s.replace('<div className="py-2 text-[13px] text-text">', '<div className="flow-live-status py-2 text-[14px] text-text3" role="status">')
s = s.replace('Math.round(ms / 1000)', 'Math.floor(ms / 1000)')
s = s.replace('<div className="flex h-full flex-col">', '<div className="relative flex h-full min-h-0 flex-col">', 1)
s = s.replace('mx-auto flex max-w-[760px] flex-col px-6 pb-10', 'mx-auto flex w-full max-w-[786px] flex-col px-6 pb-10')
s = s.replace('flex justify-center px-[26px] pb-4', 'flex shrink-0 justify-center px-[26px] pb-4')
p.write_text(s, encoding='utf-8')
