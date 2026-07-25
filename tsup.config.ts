import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/daemon-entry.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node20',
  noExternal: ['zod'],
})
