// 生成一组 responses input 变体，用于定位网关不认识的 item 类型
const fs = require('node:fs');
const path = require('node:path');

const OUT = path.join(__dirname, '_iv');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const user = { role: 'user', content: [{ type: 'input_text', text: 'hi' }] };
const fc = { type: 'function_call', call_id: 'call_1', name: 'exec_command', arguments: '{"command":"echo hi"}' };
const fco = { type: 'function_call_output', call_id: 'call_1', output: 'hi' };
const asstMsg = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] };
const reasoning = { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'thinking' }] };
const reasoningContent = { type: 'reasoning', id: 'rs_2', content: [{ type: 'reasoning_text', text: 'thinking' }] };
const itemRef = { type: 'item_reference', id: 'msg_1' };
const localShell = { type: 'local_shell_call', call_id: 'call_2', action: { type: 'exec', command: ['echo', 'hi'] }, status: 'completed' };
const customCall = { type: 'custom_tool_call', call_id: 'call_3', name: 'my_tool', input: 'hi' };
const customOut = { type: 'custom_tool_call_output', call_id: 'call_3', output: 'hi' };

const cases = {
  '01-baseline-user-only': [user],
  '02-assistant-message': [user, asstMsg],
  '03-function-call-pair': [user, fc, fco],
  '04-reasoning-summary': [user, reasoning],
  '05-reasoning-content': [user, reasoningContent],
  '06-full-reasoning-call': [user, reasoning, asstMsg, fc, fco],
  '07-item-reference': [user, itemRef],
  '08-local-shell-call': [user, localShell],
  '09-custom-tool-call': [user, customCall, customOut],
  // ── 第二轮：把字段补全（OpenAI 规范里的 id / status）再试一遍 ──
  '10-fc-full-fields': [
    user,
    { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'exec_command', arguments: '{}', status: 'completed' },
    { type: 'function_call_output', id: 'fco_1', call_id: 'call_1', output: 'hi', status: 'completed' },
  ],
  '11-fco-only-full': [{ type: 'function_call_output', id: 'fco_1', call_id: 'call_1', output: 'hi', status: 'completed' }],
  '12-reasoning-full': [
    { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 't' }], status: 'completed' },
  ],
  '13-role-assistant-string-content': [user, { role: 'assistant', content: 'ok' }],
  '14-role-assistant-tool-calls': [
    user,
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'exec_command', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: 'hi' },
  ],
  '15-output-array': [{ type: 'function_call_output', call_id: 'call_1', output: [{ type: 'output_text', text: 'hi' }] }],
};

for (const [name, input] of Object.entries(cases)) {
  const body = { model: 'agnes-2.5-flash', input, stream: false, store: false };
  fs.writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify(body));
}
console.log(Object.keys(cases).join('\n'));
