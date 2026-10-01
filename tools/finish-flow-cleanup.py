from pathlib import Path

p = Path('src/renderer/src/components/ThreadView.tsx')
s = p.read_text(encoding='utf-8')
dollar = chr(36)
s = s.replace(dollar+'{totalSeconds} 秒', dollar+'{totalSeconds}秒')
s = s.replace(dollar+'{minutes} 分 '+dollar+'{String(seconds).padStart(2, "0")} 秒', dollar+'{minutes}分钟 '+dollar+'{seconds}秒')
a = s.index('/* ──', s.index('function textFromUserItem'))
b = s.index('const USER_TYPES', a)
s = s[:a] + '// A turn keeps commentary/tool activity separate from its final answer.\n\n' + s[b:]
a = s.index('/* ──', s.index('export default function ThreadView'))
b = s.index('const TurnBlock', a)
s = s[:a] + '// Keep work expanded through final streaming; collapse when the turn completes.\n\n' + s[b:]
a = s.index('/* ──', s.index('const TurnBlock'))
b = s.index('// Commentary seals', a)
s = s[:a] + s[b:]
a = s.index('/** 探索命令组')
b = s.index('const ActivityRow', a)
s = s[:a] + s[b:]
a = s.index('/**\n * 推理行')
b = s.index('const ReasoningRow', a)
s = s[:a] + '// A reasoning summary is a single expandable line.\n' + s[b:]
a = s.index('/**\n * 命令行')
b = s.index('const CommandRow', a)
s = s[:a] + '// Commands stay compact until opened; command and output share one Shell card.\n' + s[b:]
s = s.replace('  // 官方 tool-activity-disclosure：running 且有内容时自动展开，完成自动折叠；\n  // 失败时保持展开，让错误输出直接可见（对齐官方 failed disclosure 默认打开）', '  // Failed commands expose diagnostic output; otherwise user controls disclosure.')
s = s.replace('  // 官方 EE()：只有最终回复开始后才允许折叠；过程中强制展开', '  // Final streaming permits manual collapse; completion supplies the default.')
s = s.replace('const open = manual ? userOpen : running && hasBody;', 'const open = manual ? userOpen : failed && hasBody;')
p.write_text(s, encoding='utf-8')
