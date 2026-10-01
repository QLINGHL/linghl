// 用内核「原样」条目格式做精确对照，定位网关到底卡哪个字段
const fs = require('node:fs');
const path = require('node:path');

const OUT = path.join(__dirname, '_r2');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const user = { role: 'user', content: [{ type: 'input_text', text: 'hi' }] };

// 内核原样（从 _round2-2.json 抄来的真实格式）
const fcKernel = { type: 'function_call', id: 'fc_1', name: 'exec_command', arguments: '{"cmd":"echo hi"}', call_id: 'call_1' };
const fcoKernel = { type: 'function_call_output', id: 'fco_1', call_id: 'call_1', output: 'ok' };
const rsKernel = {
  type: 'reasoning', id: 'rs_1',
  summary: [{ type: 'summary_text', text: 'thinking' }],
  content: null, encrypted_content: null,
};

// 变体：逐项补 status
const fcStatus = { ...fcKernel, status: 'completed' };
const fcoStatus = { ...fcoKernel, status: 'completed' };
const rsStatus = { ...rsKernel, status: 'completed' };

const cases = {
  'a-fc-fco-kernel-as-is': [user, fcKernel, fcoKernel],
  'b-fc-fco-with-status': [user, fcStatus, fcoStatus],
  'c-reasoning-kernel-as-is': [user, rsKernel],
  'd-reasoning-with-status': [user, rsStatus],
  'e-full-kernel-as-is': [user, rsKernel, fcKernel, fcoKernel],
  'f-full-status-added': [user, rsStatus, fcStatus, fcoStatus],
};

for (const [name, input] of Object.entries(cases)) {
  fs.writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify({ model: 'agnes-2.5-flash', input, stream: false, store: false }));
}
console.log(Object.keys(cases).join('\n'));
