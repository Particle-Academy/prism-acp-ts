// A provider stand-in with a process tree to end. Level 0 (the "provider") echoes stdin to stdout and starts level 1,
// which starts level 2 DETACHED -- its own process group / session on POSIX, DETACHED_PROCESS on Windows -- the way a
// tool subprocess that wants to outlive its parent would. Every level appends its pid to the file in argv[2].
//   ORPHAN=1        level 1 exits once level 2 is up, orphaning it
//   EXIT_ON_EOF=1   level 0 exits with code 7 when its stdin closes
const { spawn } = require('child_process');
const { appendFileSync } = require('fs');
const [file, level = '0'] = process.argv.slice(2);
const n = Number(level);
if (n < 2) {
  const child = spawn(process.execPath, [__filename, file, String(n + 1)], { stdio: 'ignore', detached: n === 1 });
  child.unref();
  if (n === 1 && process.env.ORPHAN) child.on('spawn', () => setTimeout(() => process.exit(0), 100));
}
appendFileSync(file, `${process.pid}\n`);
if (n === 0) {
  process.stdin.on('data', (d) => process.stdout.write(`echo:${d}`));
  process.stdin.on('end', () => { if (process.env.EXIT_ON_EOF) process.exit(7); });
}
setInterval(() => {}, 1 << 30);
