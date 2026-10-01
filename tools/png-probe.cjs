/**
 * 判定浮层是否真的不透明：读两张截图（浮层可见 / 浮层隐藏）在浮层区域的像素。
 * 逐行统计「变化像素占比」，若浮层是不透明的白底，则区域内几乎全是白（只有浮层自己文字的边缘噪声）。
 */
const fs = require('node:fs');
const zlib = require('node:zlib');

function readPNG(file) {
  const b = fs.readFileSync(file);
  let p = 8, w = 0, h = 0, bitDepth = 8, colorType = 6;
  const idat = [];
  while (p < b.length) {
    const len = b.readUInt32BE(p);
    const type = b.toString('ascii', p + 4, p + 8);
    const data = b.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; }
    if (type === 'IDAT') idat.push(data);
    p += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const channels = colorType === 6 ? 4 : 3;
  const stride = w * channels;
  const out = Buffer.alloc(h * stride);
  let pos = 0;
  for (let y = 0; y < h; y++) {
    const ft = raw[pos++];
    const line = raw.subarray(pos, pos + stride);
    pos += stride;
    const o = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[o + x - channels] : 0;
      const bb = y > 0 ? out[o - stride + x] : 0;
      const c = x >= channels && y > 0 ? out[o - stride + x - channels] : 0;
      let v = line[x];
      if (ft === 1) v += a; else if (ft === 2) v += bb; else if (ft === 3) v += (a + bb) >> 1;
      else if (ft === 4) { const pp = a + bb - c, pa = Math.abs(pp - a), pb = Math.abs(pp - bb), pc = Math.abs(pp - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? bb : c; }
      out[o + x] = v & 255;
    }
  }
  return { w, h, channels, out };
}

const [fileWith, fileWithout, ...points] = process.argv.slice(2);
const A = readPNG(fileWith);
const B = readPNG(fileWithout);
console.log({ withPopover: { w: A.w, h: A.h }, withoutPopover: { w: B.w, h: B.h } });
for (const pt of points) {
  const [x, y] = pt.split(',').map(Number);
  const iA = (y * A.w + x) * A.channels;
  const iB = (y * B.w + x) * B.channels;
  console.log(`(${x},${y}) 浮层内=${[A.out[iA], A.out[iA + 1], A.out[iA + 2]].join(',')}  浮层隐藏后=${[B.out[iB], B.out[iB + 1], B.out[iB + 2]].join(',')}`);
}
// 整块统计：以 B 的尺寸为准，逐行统计与 A 的差异（A 的浮层区域与 B 同尺寸同原点）
if (A.w >= B.w && A.h >= B.h) {
  let diff = 0, total = 0;
  for (let y = 0; y < B.h; y++) {
    for (let x = 0; x < B.w; x++) {
      const iA = (y * A.w + x) * A.channels;
      const iB = (y * B.w + x) * B.channels;
      let d = 0;
      for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(A.out[iA + k] - B.out[iB + k]));
      if (d > 12) diff++;
      total++;
    }
  }
  console.log({ total, diffPixels: diff, pct: (100 * diff / total).toFixed(2) + '%' });
}
