import { defineConfig } from 'vite';

// The deployed page lives at https://<user>.github.io/feelTechFunctionGenerator/,
// so every asset URL needs that prefix. Without `base` the built page 404s on
// Pages while working perfectly in `npm run dev` - a classic trap.
export default defineConfig({
  base: process.env.VITE_BASE ?? '/feelTechFunctionGenerator/',
  build: { target: 'es2022', outDir: 'dist' },
});
