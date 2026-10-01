"""Extract the reviewed, pinned MIT modules; never installs or executes upstream apps."""
from pathlib import Path
import json
import subprocess

root = Path(__file__).resolve().parents[1]
research = root.parent / '_research'
web = research / 'codex-webui'
monitor = research / 'CodexMonitor'
pins = {web: 'f84909859d6f80e40aeaa984d329dd00dcc8e59d', monitor: 'dd61b9abd37de5ded86e82b9fe8a83fd49d46fa5'}
for repo, expected in pins.items():
    actual = subprocess.check_output(['git', '-C', str(repo), 'rev-parse', 'HEAD'], text=True).strip()
    if actual != expected:
        raise RuntimeError(f'Unexpected upstream revision: {repo}')

def write(relative, text):
    destination = root / relative
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(text, encoding='utf-8')

def header(repo, source):
    license_text = (repo / 'LICENSE').read_text(encoding='utf-8').strip()
    return '/*\n' + license_text + '\n\nSource: ' + source + '\nRevision: ' + pins[repo] + '\n*/\n\n'

surface = (web / 'public/codex-surfaces.js').read_text(encoding='utf-8')
activity = surface[surface.index('function shellWords('):surface.index('export function createReviewPreferences(')]
app_lines = (web / 'public/app.js').read_text(encoding='utf-8').splitlines()
for name in ['joinActivityParts', 'completedActivitySummary', 'completedActivityPrimaryItem']:
    line = next(line for line in app_lines if line.startswith('function ' + name + '('))
    if name != 'joinActivityParts':
        line = line.replace('(items){', '(items, describe = summarizeActivity){', 1).replace('summarizeActivity(item)', 'describe(item)')
    activity += 'export ' + line + '\n\n'
write('src/renderer/src/vendor/codex-webui/activity.js', header(web, 'https://github.com/lezi-fun/codex-webui; public/codex-surfaces.js and public/app.js') + '// Extraction only; group functions accept the host protocol adapter.\n' + activity)
write('src/renderer/src/vendor/codex-webui/activity.d.ts', '''export type ActivityDescription = {
  label: string; detail: string; category?: string; animation: string;
  active: boolean; tone: string;
};
export type ActivityRecord = Record<string, any>;
export function summarizeActivity(item: ActivityRecord): ActivityDescription;
export function joinActivityParts(parts: string[]): string;
export function completedActivitySummary(items: ActivityRecord[], describe?: (item: ActivityRecord) => ActivityDescription): string;
export function completedActivityPrimaryItem(items: ActivityRecord[], describe?: (item: ActivityRecord) => ActivityDescription): ActivityRecord | undefined;
''')
source = (monitor / 'src/features/messages/utils/messageRenderUtils.ts').read_text(encoding='utf-8')
types = source[source.index('export type ParsedReasoning = {'):source.index('export type MessageImage = {')]
reasoning = source[source.index('function sanitizeReasoningTitle('):source.index('export function normalizeMessageImageSrc(')]
reasoning = reasoning.replace('Extract<ConversationItem, { kind: "reasoning" }>', '{ summary?: string; content?: string }')
write('src/renderer/src/vendor/codex-monitor/reasoning.ts', header(monitor, 'https://github.com/Dimillian/CodexMonitor; src/features/messages/utils/messageRenderUtils.ts') + '// Host-independent input type; parsing implementation retained.\n' + types + reasoning)
for repo, folder in [(web, 'codex-webui'), (monitor, 'codex-monitor')]:
    write('src/renderer/src/vendor/' + folder + '/LICENSE', (repo / 'LICENSE').read_text(encoding='utf-8'))
write('src/renderer/src/vendor/flow-sources.json', json.dumps({
    'codex-webui': {'repository': 'https://github.com/lezi-fun/codex-webui', 'revision': pins[web], 'license': 'MIT', 'reused': ['shellWords', 'hasShellControl', 'explorationCommand', 'summarizeActivity', 'joinActivityParts', 'completedActivitySummary', 'completedActivityPrimaryItem']},
    'CodexMonitor': {'repository': 'https://github.com/Dimillian/CodexMonitor', 'revision': pins[monitor], 'license': 'MIT', 'reused': ['sanitizeReasoningTitle', 'parseReasoning']}
}, indent=2) + '\n')
print('Imported pinned activity and reasoning modules with MIT notices.')
