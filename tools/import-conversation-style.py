"""Import only conversation CSS from the reviewed, pinned MIT source."""
from pathlib import Path
import subprocess

project = Path(__file__).resolve().parents[1]
upstream = project.parent / '_research' / 'codex-webui'
revision = 'f84909859d6f80e40aeaa984d329dd00dcc8e59d'
actual = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=upstream, text=True).strip()
if actual != revision:
    raise SystemExit('Review the upstream revision before changing imported styles.')
source = (upstream / 'public/style.css').read_text(encoding='utf-8').splitlines()
rules = []
for line in source:
    if line.startswith('.message-text') and len(rules) < 27 and (rules or line.startswith('.message-text{font-size:var(--codex-chat-font-size)')):
        if line.startswith('.message-text code{border-color:'):
            break
        rules.append(line)
shell = [line for line in source if line.startswith('.command-shell')]
css = '\n'.join(rules + shell)
for before, after in [
    ('.message-text', '.flow-thread .prose-chat'),
    ('.command-shell', '.flow-thread .flow-shell'),
    ('var(--codex-chat-font-size)', 'var(--flow-font-size)'),
    ('var(--codex-chat-code-font-size)', '12px'),
    ('var(--app-text-tertiary)', 'var(--c-text-3)'),
    ('var(--app-text-secondary)', 'var(--c-text-2)'),
    ('var(--app-text)', 'var(--c-text)'),
    ('var(--text-strong)', 'var(--c-text)'),
    ('var(--app-hover)', 'var(--c-bg-hover)'),
    ('var(--app-main)', 'var(--c-bg)'),
    ('var(--app-border-default)', 'var(--c-border)'),
    ('var(--mono)', 'Consolas, "Cascadia Code", monospace'),
]:
    css = css.replace(before, after)
header = '/* Adapted from lezi-fun/codex-webui public/style.css\n * Commit: ' + revision + '\n * Copyright (c) 2026 lezi-fun. MIT; see ./LICENSE.\n * Scope and theme tokens mapped to this project. No official app resources.\n */\n'
adapter = '''
/* React host adapter: row alignment, focus targets and constrained content. */
.flow-thread { --flow-font-size: 14px; --flow-row-gap: 4px; }
.flow-thread .prose-chat > :first-child { margin-top: 0; }
.flow-thread .prose-chat > :last-child { margin-bottom: 0; }
.flow-thread .flow-activity { gap: 16px; padding-block: 8px; }
.flow-thread .flow-cluster { gap: var(--flow-row-gap); }
.flow-thread .flow-event { min-width: 0; }
.flow-thread .flow-activity-trigger {
  display: inline-flex; align-items: center; align-self: flex-start;
  min-width: 0; max-width: 100%; min-height: 22px;
  gap: 4px; padding: 0; font-size: var(--flow-font-size); line-height: 22px;
  text-align: left; color: var(--c-text-3);
}
.flow-thread .flow-activity-trigger > svg, .flow-thread .flow-activity-trigger > span > svg { flex: 0 0 auto; width: 16px; height: 16px; }
.flow-thread .flow-activity-trigger:has(.lucide-triangle-alert) { color: var(--red-500, #e02e2a); }
.flow-thread .flow-activity-trigger > .lucide-chevron-right { width: 14px; height: 14px; }
.flow-thread .flow-activity-trigger:hover { color: var(--c-text-2); }
.flow-thread .flow-activity-trigger:focus-visible { outline: 1px solid var(--c-text-3); outline-offset: 3px; border-radius: 4px; }
.flow-thread .flow-activity-copy { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.flow-thread .flow-shell { margin: 6px 0 8px 20px; min-width: 0; }
.flow-thread .flow-shell-heading { padding: 8px 10px 0; font-size: 12px; color: var(--c-text-3); }
.flow-thread .flow-shell-command code { display: block; max-height: 72px; overflow: auto; -webkit-line-clamp: unset; }
.flow-thread .flow-shell-output { max-height: 200px; }
.flow-thread .flow-shell-output pre { font-weight: 400; }
.flow-thread .flow-shell-footer { padding: 4px 10px 6px; }
.flow-thread .flow-reasoning-detail { max-height: 160px; overflow-y: auto; }
.flow-thread .flow-work-header { padding-block: 0; border: 0; font-size: 14px; line-height: 22px; }
.flow-thread .flow-work-header button { max-width: 100%; }
.flow-thread .prose-chat table { display: block; max-width: 100%; width: max-content; min-width: 60%; overflow-x: auto; border-collapse: collapse; margin-block: 16px; }
.flow-thread .prose-chat th, .flow-thread .prose-chat td { padding: 10px 16px; border: 0; border-bottom: 1px solid var(--c-border); line-height: 24px; }
.flow-thread .prose-chat th { font-weight: 600; }
.flow-thread .prose-chat tr:last-child td { border-bottom: 0; }
.flow-thread .prose-chat .katex-display { margin: 16px 0; }
.flow-thread header h1 { min-width: 0; flex: 1; }
@media (max-width: 600px) { .flow-thread .flow-shell { margin-left: 0; } .flow-thread .prose-chat table { min-width: 100%; } }
'''
target = project / 'src/renderer/src/vendor/codex-webui/conversation.css'
target.write_text(header + css + '\n' + adapter, encoding='utf-8')
print(f'Imported {len(rules)} Markdown and {len(shell)} Shell rules to {target}')
