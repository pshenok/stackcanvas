import { defineConfig } from 'tsup'

export default defineConfig({
  entry: { cli: 'src/cli.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  noExternal: ['@stackcanvas/core', '@stackcanvas/server'],
  clean: true,
  banner: { js: '#!/usr/bin/env node' },
})
