import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8')) as {
  version: string;
};

// `BASE_PATH` is set by the GitHub Pages workflow (e.g. "/world-kit/").
// Locally it stays "/" so the HTTPS dev server works unchanged.
const base = process.env.BASE_PATH ?? '/';

export default defineConfig({
  base,
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  // HTTPS is mandatory: getUserMedia and DeviceMotion both require a secure
  // context, and an iPhone reaching this dev server over LAN IP is not
  // localhost. basic-ssl issues a self-signed cert; Safari will warn once.
  plugins: [basicSsl()],
  server: {
    host: true,
    port: 5173,
  },
  build: {
    target: 'es2020',
    sourcemap: true,
    outDir: 'dist',
  },
});
