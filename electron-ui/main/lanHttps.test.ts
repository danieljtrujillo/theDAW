// Run with: npx tsx electron-ui/main/lanHttps.test.ts
//
// The pure half of the desktop shell's LAN HTTPS listener (no Electron import
// -- this runs under plain node/tsx, unlike main/index.ts).
//   - parseLanHttpsPlan reads the plan backend/lib/lan_https.py prints, takes
//     the LAST JSON line (a wrapper can print ahead of it), and returns null
//     rather than a half-plan for anything it cannot use -- including an
//     "enabled" plan with no certificate, which would only crash-loop vite.
//   - lanListenerEnv adds exactly the three names vite.lan.config.ts reads and
//     removes the launch token under every spelling. ENABLE_HMR is whatever the
//     base carried: the desktop shell wants no repo-wide watcher.
//   - lanListenerCommand runs the frontend's OWN vite (the path comes from the
//     plan), through `cmd /c` on Windows, where vite.cmd is a batch shim node
//     refuses to exec directly.
//   - lanHttpsLogLine always says something, and says WHY when it is off.
import assert from 'node:assert/strict';
import {
  LAN_HTTPS_CERT_ENV,
  rendererDevPort,
  LAN_HTTPS_KEY_ENV,
  LAN_HTTPS_PORT_ENV,
  lanHttpsLogLine,
  lanListenerCommand,
  lanListenerEnv,
  parseLanHttpsPlan,
  type LanHttpsPlan,
} from './lanHttps';

const VITE = 'C:\\theDAW\\frontend\\node_modules\\.bin\\vite.cmd';

const ENABLED = {
  enabled: true,
  port: 5443,
  url: 'https://192.168.1.34:5443',
  cert: 'C:\\theDAW\\data\\lan-cert\\lan-cert.pem',
  key: 'C:\\theDAW\\data\\lan-cert\\lan-key.pem',
  vite: VITE,
  reason: null,
};

// ── parseLanHttpsPlan ─────────────────────────────────────────────────────
{
  const plan = parseLanHttpsPlan(`${JSON.stringify(ENABLED)}\n`);
  assert.deepEqual(plan, ENABLED);

  // A wrapper (uv, a venv shim, a warning filter) printed first: the LAST
  // parsable object wins, not the first.
  const noisy = `Installed 3 packages in 12ms\n{"stray": 1}\n${JSON.stringify(ENABLED)}\n`;
  assert.deepEqual(parseLanHttpsPlan(noisy), ENABLED, 'the plan is read from the last JSON line');

  // A disabled plan keeps its reason — that is the whole point of printing one.
  const off = { enabled: false, port: 5443, url: null, cert: null, key: null, vite: null, reason: 'no LAN address' };
  assert.deepEqual(parseLanHttpsPlan(JSON.stringify(off)), off);

  // Nothing usable -> null, never a guess. The caller logs "no plan" and the
  // app runs exactly as it does today.
  assert.equal(parseLanHttpsPlan(''), null);
  assert.equal(parseLanHttpsPlan('Traceback (most recent call last):'), null);
  assert.equal(parseLanHttpsPlan('{not json'), null);
  assert.equal(parseLanHttpsPlan('[]'), null, 'an array is not a plan');
  assert.equal(parseLanHttpsPlan('{"port": 5443}'), null, 'no enabled flag');
  assert.equal(parseLanHttpsPlan('{"enabled": "yes", "port": 5443}'), null, 'enabled must be a boolean');
  assert.equal(parseLanHttpsPlan('{"enabled": false, "port": "5443"}'), null, 'port must be a number');
  assert.equal(parseLanHttpsPlan('{"enabled": false, "port": 70000}'), null, 'port must be a TCP port');
  assert.equal(parseLanHttpsPlan('{"enabled": false, "port": 0}'), null, 'port must be a TCP port');

  // An enabled plan missing any of url/cert/key is a broken contract, not a
  // usable plan: starting vite without a certificate only crash-loops.
  for (const missing of ['url', 'cert', 'key', 'vite'] as const) {
    const broken: Record<string, unknown> = { ...ENABLED };
    broken[missing] = null;
    assert.equal(parseLanHttpsPlan(JSON.stringify(broken)), null, `enabled with no ${missing}`);
    broken[missing] = '   ';
    assert.equal(parseLanHttpsPlan(JSON.stringify(broken)), null, `enabled with blank ${missing}`);
  }
}

// ── lanListenerEnv ────────────────────────────────────────────────────────
{
  const base = {
    PATH: '/usr/bin',
    THEDAW_LAUNCH_TOKEN: 'secret-a',
    thedaw_launch_token: 'secret-b',
    Thedaw_Launch_Token: 'secret-c',
  };
  const env = lanListenerEnv(base, ENABLED as LanHttpsPlan);

  assert.equal(env.PATH, '/usr/bin', 'the base environment is kept');
  assert.equal(env[LAN_HTTPS_CERT_ENV], ENABLED.cert);
  assert.equal(env[LAN_HTTPS_KEY_ENV], ENABLED.key);
  assert.equal(env[LAN_HTTPS_PORT_ENV], '5443', 'the port is a string, as an environment value must be');

  // No spelling of the launch token survives: vite runs the frontend's own
  // devDependencies, and that code must not be able to pass as this shell.
  for (const key of Object.keys(env)) {
    assert.notEqual(key.toUpperCase(), 'THEDAW_LAUNCH_TOKEN', `launch token leaked as ${key}`);
  }
  assert.ok(!Object.values(env).some((v) => String(v).startsWith('secret-')), 'no token value survived');

  // The caller's object is not mutated (buildBaseEnv()'s result is reused).
  assert.equal(base.THEDAW_LAUNCH_TOKEN, 'secret-a');

  // Only the three names are added: live reload is NOT forced on here. It
  // starts a watcher over the whole repository, the desktop shell has no use
  // for one, and the web launcher sets it for its own http dev server.
  const added = Object.keys(env).filter((k) => !(k in base));
  assert.deepEqual(added.sort(), [LAN_HTTPS_CERT_ENV, LAN_HTTPS_KEY_ENV, LAN_HTTPS_PORT_ENV].sort());
  assert.equal(lanListenerEnv({ ...base, ENABLE_HMR: 'true' }, ENABLED as LanHttpsPlan).ENABLE_HMR, 'true', 'a base that asked for live reload keeps it');

  // A plan that is off, or has no certificate, is a programming error here
  // rather than a listener started with nothing to serve TLS with.
  assert.throws(() => lanListenerEnv(base, { ...ENABLED, enabled: false } as LanHttpsPlan));
  assert.throws(() => lanListenerEnv(base, { ...ENABLED, cert: null } as LanHttpsPlan));
  assert.throws(() => lanListenerEnv(base, { ...ENABLED, key: null } as LanHttpsPlan));
}

// ── lanListenerCommand ────────────────────────────────────────────────────
{
  // The binary is the frontend's own, resolved once by backend/lib/lan_https.py
  // and carried in the plan. `npx` searched the current directory before PATH
  // on Windows and, with no node_modules, fetches vite from the registry.
  const win = lanListenerCommand('win32', ENABLED as LanHttpsPlan);
  assert.equal(win.command, 'cmd', 'vite.cmd is a batch shim — node refuses to spawn one directly');
  assert.deepEqual(win.args, ['/c', VITE, '--config', 'vite.lan.config.ts']);
  assert.ok(!JSON.stringify(win).includes('npx'), 'no npx anywhere in the Windows command');

  // A path with a space in it is handed over UNQUOTED, as its own argv
  // element. libuv quotes it when it builds cmd's command line; quoting it
  // here made libuv escape those quotes, and cmd answered `'\"C:\Program
  // Files\...\vite.cmd\"' is not recognized as an internal or external
  // command` — measured against a real .cmd under a spaced path. Any `"` in
  // any argument is that bug coming back.
  const spacedVite = 'C:\\Program Files\\theDAW\\frontend\\node_modules\\.bin\\vite.cmd';
  const spaced = lanListenerCommand('win32', { ...ENABLED, vite: spacedVite } as LanHttpsPlan);
  assert.deepEqual(spaced.args, ['/c', spacedVite, '--config', 'vite.lan.config.ts']);
  for (const args of [win.args, spaced.args]) {
    for (const arg of args) {
      assert.ok(!arg.includes('"'), `pre-quoted argument: ${arg}`);
    }
    // cmd /c strips the outer pair of quotes off the whole command line, so
    // leaving the quoting to libuv only survives while exactly ONE element
    // needs quoting; a second spaced argument would need /s and a rethink.
    assert.ok(
      args.filter((arg) => arg.includes(' ')).length <= 1,
      `more than one argument needs quoting: ${JSON.stringify(args)}`,
    );
  }

  for (const platform of ['linux', 'darwin']) {
    const posix = lanListenerCommand(platform, ENABLED as LanHttpsPlan);
    assert.equal(posix.command, VITE, platform);
    assert.deepEqual(posix.args, ['--config', 'vite.lan.config.ts'], platform);
  }

  // Nothing to run -> a thrown programming error, not a spawn of `undefined`.
  assert.throws(() => lanListenerCommand('win32', { ...ENABLED, vite: null } as LanHttpsPlan));
  assert.throws(() => lanListenerCommand('linux', { ...ENABLED, enabled: false } as LanHttpsPlan));
}

// ── lanHttpsLogLine ───────────────────────────────────────────────────────
{
  assert.equal(lanHttpsLogLine(ENABLED as LanHttpsPlan), 'LAN (https): https://192.168.1.34:5443');
  assert.equal(
    lanHttpsLogLine({ enabled: false, port: 5443, url: null, cert: null, key: null, vite: null, reason: 'no certificate' }),
    'LAN (https): off - no certificate',
    'a launcher that turns it off has to say why',
  );
  // Never silent, even with nothing to go on.
  assert.equal(lanHttpsLogLine(null), 'LAN (https): off - no plan could be read');
  assert.equal(
    lanHttpsLogLine({ enabled: false, port: 5443, url: null, cert: null, key: null, vite: null, reason: null }),
    'LAN (https): off - unavailable',
  );
}

// rendererDevPort: the port the renderer dev server really got, read from the
// URL electron-vite hands the main process, or null when there is no dev server.
{
  assert.equal(rendererDevPort('http://localhost:5175/'), 5175);
  assert.equal(rendererDevPort('http://127.0.0.1:5173'), 5173);
  assert.equal(rendererDevPort(undefined), null, 'packaged build: no dev server');
  assert.equal(rendererDevPort(''), null);
  assert.equal(rendererDevPort('http://localhost/'), null, 'no explicit port');
  assert.equal(rendererDevPort('not a url'), null);
}

console.log('lanHttps: plan parsing + token-free child env + platform command contract passed');
