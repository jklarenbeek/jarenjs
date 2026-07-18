import { defineConfig } from 'vite';

// GitHub Pages serves the site under /jarenjs/. No framework plugins:
// the site is plain ESM over @jarenjs/view + @jarenjs/app.
export default defineConfig({
  base: '/jarenjs/',
  build: {
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: {
          jaren: [
            '@jarenjs/core',
            '@jarenjs/json',
            '@jarenjs/validate',
            '@jarenjs/formats',
            '@jarenjs/refs',
            '@jarenjs/forms',
            '@jarenjs/locales',
            '@jarenjs/view',
            '@jarenjs/app',
          ],
        },
      },
    },
  },
});
