import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { cli: 'src/index.ts' },
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  dts: false,
  sourcemap: true,
  shims: false,
  banner: { js: '#!/usr/bin/env node' },
});
