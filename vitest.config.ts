import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Local Windows 5s failures reported: inherited ACL 6377ms, refusal reason 5005ms,
    // simultaneous MCP sessions 5777ms, driver paths 7043ms, private child 7087ms,
    // refuse-existing 6668ms, invalid channel 5003ms, MCP-file ACL 6638ms, cache owner 8729ms.
    // Hosted Windows passed these rows (42019070984). Keep hangs bounded and explicit case clocks intact.
    testTimeout: process.platform === 'win32' ? 15_000 : 5_000,
    hookTimeout: process.platform === 'win32' ? 15_000 : 10_000,
    // POSIX hooks retain the installed Vitest 4.1.12 default of 10s.
    globalSetup: ['./test/windows-native-setup.ts'],
  },
});
