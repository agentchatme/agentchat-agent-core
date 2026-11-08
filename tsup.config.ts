import { defineConfig } from 'tsup'

// The library: three ESM entry points, dependencies left to the consumer.
//   dist/index.js         the main entry (no socket layer)
//   dist/daemon-entry.js  `./daemon` — the resident engine; pulls in `ws` via the SDK
//   dist/presets.js       `./presets` — how to start a known coding agent's headless run
// The `agentchat` CLI is built separately (tsup.cli.config.ts) as standalone bundles.
export default defineConfig({
  entry: { index: 'src/index.ts', 'daemon-entry': 'src/daemon-entry.ts', presets: 'src/presets/index.ts' },
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  platform: 'node',
  target: 'node22',
  noExternal: ['zod'],
})
