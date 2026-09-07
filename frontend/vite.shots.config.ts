// Screenshot-stack config: the normal dev config on a second port, proxied to
// a second backend, so the docs rig can shoot the app without touching the
// developer's own :5173 / :8600 pair. Run:
//   SA3_SHOTS_BACKEND=http://localhost:8601 npx vite --config vite.shots.config.ts
import { defineConfig, type UserConfig } from 'vite';
import base from './vite.config';

const BACKEND = process.env.SA3_SHOTS_BACKEND ?? 'http://localhost:8601';
const PORT = Number(process.env.SA3_SHOTS_PORT ?? 5174);

export default defineConfig(async (env) => {
  const cfg = (await (base as unknown as (e: typeof env) => Promise<UserConfig> | UserConfig)(env)) as UserConfig;
  const server = { ...(cfg.server ?? {}) };
  server.port = PORT;
  // Re-target EVERY proxy entry that points at the developer's backend, not
  // just '/api'. The sidecar iframes ('/vj-app', '/sway-app') are proxied the
  // same way, so leaving them on :8600 makes the VJ and SWAY tabs fail to load
  // whenever the rig runs without the developer's own stack up.
  const proxy = { ...((server.proxy ?? {}) as Record<string, unknown>) };
  for (const [route, entry] of Object.entries(proxy)) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.target !== 'string' || !/\/\/(localhost|127\.0\.0\.1):8600/.test(e.target)) continue;
    proxy[route] = { ...e, target: BACKEND };
  }
  server.proxy = proxy as UserConfig['server'] extends infer S ? S extends { proxy?: infer P } ? P : never : never;
  return { ...cfg, server };
});
