import { defineConfig } from 'vite';

// The UI is plain scripts and styles in public/, served as they are; Vite
// only serves index.html and copies public/ into the build.
export default defineConfig({
  server: {
    port: 3000,
    host: '0.0.0.0',
  },
  preview: {
    port: 3000,
    host: '0.0.0.0',
  },
});
