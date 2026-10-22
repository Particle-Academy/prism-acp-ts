// Binary stdio fixture. Honor output backpressure before requesting the next input chunk.
// The supervisor must withhold its control address/token from the provider.
if (process.env.PRISM_ACP_TREE_CHANNEL !== undefined || process.env.PRISM_ACP_TREE_TOKEN !== undefined) process.exit(91);
const write = (stream, bytes) => new Promise((resolve, reject) => stream.write(bytes, (e) => e ? reject(e) : resolve()));
(async () => {
  for await (const chunk of process.stdin) {
    const inverted = Buffer.from(chunk);
    for (let i = 0; i < inverted.length; i++) inverted[i] ^= 0xff;
    await Promise.all([write(process.stdout, chunk), write(process.stderr, inverted)]);
  }
})().catch(() => { process.exitCode = 92; });
