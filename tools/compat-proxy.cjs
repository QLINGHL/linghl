// 兼容代理原型：内核 → 本代理 → 真实上游。
// 作用：剥掉 responses 请求 input 里网关不认识的条目（reasoning 等），其余原样转发。
// 环境变量：COMPAT_PROXY_PORT / COMPAT_PROXY_UPSTREAM / COMPAT_PROXY_VIA
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const { URL } = require('node:url');

const PORT = Number(process.env.COMPAT_PROXY_PORT || 18991);
const UPSTREAM = process.env.COMPAT_PROXY_UPSTREAM;
const SYS_PROXY = process.env.COMPAT_PROXY_VIA || null;

if (!UPSTREAM) {
  console.error('[proxy] 缺少 COMPAT_PROXY_UPSTREAM');
  process.exit(1);
}

// 只剥离网关明确不认的条目类型（黑名单制，其余原样透传）
const DROP_TYPES = new Set(['reasoning']);

function tunnel(proxyUrl, targetHost, targetPort) {
  return new Promise((resolve, reject) => {
    const p = new URL(proxyUrl);
    const socket = net.connect(Number(p.port), p.hostname, () => {
      socket.write(
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\nProxy-Connection: keep-alive\r\n\r\n`,
      );
    });
    let buf = Buffer.alloc(0);
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      const idx = buf.indexOf('\r\n\r\n');
      if (idx < 0) return;
      const head = buf.slice(0, idx).toString('latin1');
      if (!/^HTTP\/1\.\d 200/.test(head)) {
        socket.destroy();
        reject(new Error('CONNECT 失败: ' + head.split('\r\n')[0]));
        return;
      }
      socket.removeListener('data', onData);
      const rest = buf.subarray(idx + 4);
      if (rest.length) socket.unshift(rest);
      resolve(socket);
    };
    socket.on('data', onData);
    socket.on('error', reject);
    socket.setTimeout(30000, () => {
      socket.destroy();
      reject(new Error('CONNECT 超时'));
    });
  });
}

function sanitize(bodyBuf) {
  try {
    const j = JSON.parse(bodyBuf.toString('utf8'));
    if (Array.isArray(j.input)) {
      const dropped = j.input.filter((it) => it && DROP_TYPES.has(it.type)).map((it) => it.type);
      j.input = j.input.filter((it) => !(it && DROP_TYPES.has(it.type)));
      return { body: Buffer.from(JSON.stringify(j), 'utf8'), dropped };
    }
  } catch {
    /* 非 JSON 原样转发 */
  }
  return { body: bodyBuf, dropped: [] };
}

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  let body = Buffer.concat(chunks);
  let dropped = [];
  if (req.method === 'POST' && body.length) {
    const r = sanitize(body);
    body = r.body;
    dropped = r.dropped;
  }
  console.log(
    `[proxy] ${req.method} ${req.url} -> ${UPSTREAM}${req.url} bytes=${body.length}` +
      (dropped.length ? ` 已剥离 input 条目: ${dropped.join(',')}` : ''),
  );

  const up = new URL(UPSTREAM);
  const headers = { ...req.headers, host: up.host };
  delete headers['transfer-encoding'];
  headers['content-length'] = String(Buffer.byteLength(body));

  let socket = null;
  if (SYS_PROXY) {
    socket = await tunnel(SYS_PROXY, up.hostname, Number(up.port || 443)).catch((e) => {
      console.log('[proxy] 隧道错误: ' + e.message);
      return null;
    });
  }

  const preq = https.request(
    {
      host: up.hostname,
      port: Number(up.port || 443),
      path: req.url,
      method: req.method,
      headers,
      agent: false,
      ...(socket ? { createConnection: () => socket } : {}),
    },
    (pres) => {
      res.writeHead(pres.statusCode, pres.headers);
      pres.pipe(res);
    },
  );
  preq.on('error', (e) => {
    console.log('[proxy] 上游错误: ' + e.message);
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'compat proxy: ' + e.message } }));
  });
  preq.end(body);
});

server.listen(PORT, '127.0.0.1', () => console.log(`[proxy] 监听 127.0.0.1:${PORT} → ${UPSTREAM}（经 ${SYS_PROXY || '直连'}）`));
