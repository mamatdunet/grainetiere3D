import { defineConfig } from 'vite';

// In dev the converted clouds are served locally; in production they live in Blob.
export default defineConfig(({ command }) => ({
  publicDir: command === 'serve' ? '../data/out' : false,
}));
