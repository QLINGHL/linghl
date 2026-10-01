// 临时探针：拦截内核发往上游 /v1/responses 的请求体，落盘后返回最小合法 SSE。
// 用法：node tools/probe-tools-body.cjs  → 另开终端跑 codex exec 指向 http://127.0.0.1:8899/v1
const http = require('http');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '_probe-body.json');
let n = 0;

const srv = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    n += 1;
    const file = OUT.replace('.json', `-${n}.json`);
    fs.writeFileSync(file, raw, 'utf8');
    console.log(`[probe] #${n} ${req.method} ${req.url} bytes=${raw.length} -> ${path.basename(file)}`);
    try {
      const b = JSON.parse(raw);
      const tools = b.tools || [];
      console.log(`[probe]   tools(${tools.length}): ` + tools.map((t, i) => `${i}:${t.type}`).join(' '));
      const odd = tools.filter((t) => !['function', 'web_search_preview', 'code_interpreter', 'mcp', 'file_search'].includes(t.type));
      if (odd.length) console.log('[probe]   !!! 非标准 tool type: ' + JSON.stringify(odd.map((t) => ({ type: t.type, name: t.name }))));
    } catch (e) {
      console.log('[probe]   body not JSON: ' + e.message);
    }

    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const send = (ev, data) => res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
    const item = {
      type: 'message', id: 'msg_probe_1', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'probe-ok', annotations: [] }],
    };
    send('response.created', { type: 'response.created', sequence_number: 0, response: { id: 'resp_probe_1', status: 'in_progress', output: [] } });
    send('response.output_item.done', { type: 'response.output_item.done', sequence_number: 1, output_index: 0, item });
    send('response.completed', {
      type: 'response.completed', sequence_number: 2,
      response: { id: 'resp_probe_1', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
    });
    res.end();
  });
});

srv.listen(8899, '127.0.0.1', () => console.log('[probe] listening on http://127.0.0.1:8899'));
