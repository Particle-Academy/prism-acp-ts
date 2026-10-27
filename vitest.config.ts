import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Native startup belongs to bounded setup; each security assertion keeps its own existing clock.
    globalSetup: ['./test/windows-native-setup.ts'],
  },
});
