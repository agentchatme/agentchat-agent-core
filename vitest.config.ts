import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // No test reaches the network: non-loopback fetch and sockets are
    // refused, and a test that tried fails (tests/setup/network-guard.ts).
    // Agent locks go to a folder of each test file's own (tests/setup/isolated-locks.ts).
    setupFiles: ['tests/setup/network-guard.ts', 'tests/setup/isolated-locks.ts'],
    // launchctl and systemctl always address the REAL user's domain whatever
    // HOME says, so a test that reaches a service install would register a
    // genuine background job. Set here, once, for every test.
    env: { AGENTCHAT_SERVICE_DRY_RUN: '1' },
  },
})
