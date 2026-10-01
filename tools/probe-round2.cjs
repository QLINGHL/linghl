// 第二轮请求探针：第 1 次请求回「reasoning + function_call」诱使内核执行工具，
// 第 2 次请求（带工具结果的续轮）落盘并打印 input 条目类型。
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

let n = 0;

const srv = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    n += 1;
    fs.writeFileSync(path.join(__dirname, `_round2-${n}.json`), raw, 'utf8');
    console.log(`[probe] #${n} bytes=${raw.length}`);
    try {
      const b = JSON.parse(raw);
      console.log('[probe] input items: ' + JSON.stringify(b.input.map((it) => it.type || `role:${it.role}`)));
      for (const it of b.input) {
        if (it.type === 'reasoning') console.log('[probe] REASONING ITEM >>> ' + JSON.stringify(it).slice(0, 600));
        if (it.type === 'function_call') console.log('[probe] FUNCTION_CALL >>> ' + JSON.stringify(it).slice(0, 300));
        if (it.type === 'function_call_output') console.log('[probe] FCO >>> ' + JSON.stringify(it).slice(0, 300));
      }
    } catch (e) {
      console.log('[probe] not json: ' + e.message);
    }

    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const send = (ev, data) => res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);

    if (n === 1) {
      const rItem = {
        type: 'reasoning', id: 'rs_probe1',
        summary: [{ type: 'summary_text', text: 'I should check the workspace first.' }],
      };
      const fcItem = {
        type: 'function_call', id: 'fc_probe1', call_id: 'call_probe1',
        name: 'exec_command', arguments: JSON.stringify({ cmd: 'echo probe-ok' }), status: 'completed',
      };
      send('response.created', { type: 'response.created', response: { id: 'resp_p1', status: 'in_progress', output: [] } });
      send('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: rItem });
      send('response.output_item.done', { type: 'response.output_item.done', output_index: 1, item: fcItem });
      send('response.completed', {
        type: 'response.completed',
        response: { id: 'resp_p1', status: 'completed', output: [rItem, fcItem], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
      });
    } else {
      const item = { type: 'message', id: 'msg_p', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'done', annotations: [] }] };
      send('response.created', { type: 'response.created', response: { id: 'resp_p2', status: 'in_progress', output: [] } });
      send('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item });
      send('response.completed', {
        type: 'response.completed',
        response: { id: 'resp_p2', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
      });
    }
    res.end();
  });
});

srv.listen(8899, '127.0.0.1', () => console.log('[probe] listening on 8899'));
