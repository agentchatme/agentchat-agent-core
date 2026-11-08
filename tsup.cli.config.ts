import { defineConfig } from 'tsup'

// The `agentchat` CLI: two self-contained ESM files, built after the library
// (so the library's `clean` cannot race them) from one config so they never
// drift in target or inlining:
//
//   dist/cli.js              the `agentchat` bin
//   dist/listener-daemon.js  the background listener, copied to a durable path
//                            by `listen --install` and run by the service
//
// Both must run with no node_modules beside them (an npx cache, the durable
// copy), so every dependency is inlined and nothing is split into chunks.
// `ws` is CommonJS and reaches for `require` at runtime, which plain ESM has
// no binding for ("Dynamic require of events is not supported"); the banner
// defines it from `import.meta.url`.
const BANNER = [
  '#!/usr/bin/env node',
  'import{createRequire as __acCreateRequire}from"node:module";',
  'const require=__acCreateRequire(import.meta.url);',
].join('\n')

export default defineConfig({
  entry: { cli: 'src/cli/bin.ts', 'listener-daemon': 'src/cli/listener-daemon.ts' },
  format: ['esm'],
  dts: false,
  sourcemap: false,
  clean: false,
  splitting: false,
  platform: 'node',
  target: 'node22',
  banner: { js: BANNER },
  noExternal: ['agentchatme', 'cross-spawn', 'zod', 'ws'],
})
