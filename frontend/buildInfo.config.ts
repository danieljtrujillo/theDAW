import {execFileSync} from 'node:child_process';

/**
 * Compile-time build identity for the renderer bundle.
 *
 * The backend serves whatever frontend/dist already exists, so a fix can land
 * in source while the running bundle is still the old one. These two constants
 * are baked into the bundle at build time; the Update dialog shows them next to
 * the backend's own SHA (GET /api/updates/build) so a stale bundle is visible.
 *
 * Shared by frontend/vite.config.ts and electron-ui/electron.vite.config.ts —
 * electron-vite builds the renderer with its own config (it never loads
 * frontend/vite.config.ts), so both must spread these defines.
 *
 * `THEDAW_BUILD_SHA` wins when set: Docker excludes .git from its build
 * context, so git is not available there. Anything that fails yields
 * "unknown" — a build never breaks because git is missing.
 */
export function resolveBuildSha(cwd: string): string {
  const override = (process.env.THEDAW_BUILD_SHA ?? '').trim();
  if (override) return override;
  try {
    const sha = execFileSync('git', ['-C', cwd, 'rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
      windowsHide: true,
    }).trim();
    return sha || 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Vite `define` entries. Values are raw expressions, hence JSON.stringify. */
export function buildInfoDefines(cwd: string): Record<string, string> {
  return {
    __APP_BUILD_SHA__: JSON.stringify(resolveBuildSha(cwd)),
    __APP_BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  };
}
