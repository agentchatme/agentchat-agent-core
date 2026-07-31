import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/daemon-entry.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  platform: 'node',
  target: 'node22',
  noExternal: ['zod'],
})
