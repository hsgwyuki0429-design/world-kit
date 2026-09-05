import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8')) as {
  version: string;
};

/**
 * The commit this bundle was built from, for the evidence to name.
 *
 * `appVersion` is `package.json`'s `0.1.0` and has been for every phase, so it cannot tell one
 * build from another — and twice in one session that was the question that mattered. A device
 * bundle from 2026-09-05 was judged against Phase 5 instruments that had been corrected a week
 * earlier, because a failing deploy had left the phone on an older build and nothing in the
 * bundle said so; it took reading the *prose of a failure message* to establish it. Later the
 * same day a Phase 7 fix appeared to have no effect, and whether the phone had it could not be
 * answered from the evidence at all.
 *
 * `GITHUB_SHA` in CI, `git rev-parse` locally, `unknown` where neither exists — which is honest
 * rather than absent, and is what a build from a tarball should say.
 */
const buildCommit = ((): string => {
  const fromCi = process.env.GITHUB_SHA;
  if (fromCi && fromCi.length > 0) return fromCi;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
  } catch {
    return 'unknown';
  }
})();

// `BASE_PATH` is set by the GitHub Pages workflow (e.g. "/world-kit/").
// Locally it stays "/" so the HTTPS dev server works unchanged.
const base = process.env.BASE_PATH ?? '/';

export default defineConfig({
  base,
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_COMMIT__: JSON.stringify(buildCommit),
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
