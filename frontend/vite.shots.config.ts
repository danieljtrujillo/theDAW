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
  const proxy = { ...((server.proxy ?? {}) as Record<string, unknown>) };
  const api = { ...((proxy['/api'] ?? {}) as Record<string, unknown>), target: BACKEND };
  proxy['/api'] = api;
  server.proxy = proxy as UserConfig['server'] extends infer S ? S extends { proxy?: infer P } ? P : never : never;
  return { ...cfg, server };
});
