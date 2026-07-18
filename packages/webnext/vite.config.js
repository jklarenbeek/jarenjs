import { defineConfig } from 'vite';

// Same GitHub Pages base as @jarenjs/website so behavior matches 1:1
// when webnext takes over the name. No framework plugins: the site is
// plain ESM over @jarenjs/view + @jarenjs/app.
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
