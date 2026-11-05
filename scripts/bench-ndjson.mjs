// Times pushing one large NDJSON line through NdjsonFramer in 64 KB chunks. Usage: node scripts/bench-ndjson.mjs <dist dir> <MB>
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const dist = path.resolve(process.argv[2] ?? 'dist');
const megabytes = Number(process.argv[3] ?? 20);
const { NdjsonFramer } = await import(pathToFileURL(path.join(dist, 'ndjson.js')).href);

const payload = 'x'.repeat(megabytes * 1024 * 1024);
const line = Buffer.from(`{"k":"${payload}"}\n`, 'utf8');
const chunkSize = 64 * 1024;

const framer = new NdjsonFramer();
let frames = [];
let slowest = 0;
const started = performance.now();
for (let offset = 0; offset < line.length; offset += chunkSize) {
  const t = performance.now();
  frames = frames.concat(framer.push(line.subarray(offset, offset + chunkSize)));
  slowest = Math.max(slowest, performance.now() - t);
}
const total = performance.now() - started;

console.log(JSON.stringify({
  megabytes,
  chunks: Math.ceil(line.length / chunkSize),
  totalMs: Math.round(total),
  slowestPushMs: Math.round(slowest),
  frames: frames.length,
  parsedOk: frames[0]?.ok === true && frames[0].value.k.length === payload.length,
}));
