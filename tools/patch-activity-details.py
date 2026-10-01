from pathlib import Path
p=Path('src/renderer/src/components/ThreadView.tsx')
s=p.read_text(encoding='utf-8')
a=s.index('    case "webSearch":',s.index('const ActivityRow'))
b=s.index('    case "reasoning":',a)
s=s[:a]+'''    case "webSearch":
    case "web_search":
      return <WebSearchRow item={item} running={running} />;
'''+s[b:]
a=s.index('    case "mcpToolCall":',s.index('const ActivityRow'))
b=s.index('    default:',a)
s=s[:a]+'''    case "mcpToolCall":
    case "mcp_tool_call":
    case "dynamicToolCall":
    case "dynamic_tool_call":
      return <ToolCallRow item={item} running={running} />;
'''+s[b:]
a=s.index('  const label = running',s.index('const FileChangeRow'))
b=s.index('  const hasBody',a)
s=s[:a]+'''  const stopped = ["interrupted", "cancelled", "canceled"].includes(status);
  const label = running ? "Editing files" : declined ? "File edit declined" : failed ? "File edit failed"
    : stopped ? "Stopped editing files" : n === 1 ? "Edited a file" : "Edited " + n + " files";
'''+s[b:]
p.write_text(s,encoding='utf-8')
