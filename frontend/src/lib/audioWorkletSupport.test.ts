/**
 * The AudioWorklet gate: availability, the two reasons it can be missing, the
 * promise contract every call site depends on, and the source-level rule that
 * keeps a thirteenth unguarded `addModule` from appearing.
 *
 * Why the promise contract matters: every worklet loader in the app caches the
 * promise (`moduleByCtx.set(ctx, p)`) and hangs a `.catch()` off it. A helper
 * that THREW instead of rejecting would skip both — the cache would never be
 * cleaned up and the catch would never run — so "rejects, never throws" is
 * tested directly rather than inferred.
 *
 * Run: `npx tsx src/lib/audioWorkletSupport.test.ts`
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AudioWorkletUnavailableError,
  INSECURE_CONTEXT_MESSAGE,
  UNSUPPORTED_MESSAGE,
  addWorkletModule,
  audioWorkletAvailable,
  describeAudioWorkletProblem,
  secureAddressAdvice,
  type AudioWorkletEnv,
} from './audioWorkletSupport.ts';

/** A context whose `audioWorklet` works, like a secure page's. */
const liveCtx = (record: string[]): BaseAudioContext =>
  ({
    audioWorklet: {
      addModule: async (url: string) => {
        record.push(url);
      },
    },
  }) as unknown as BaseAudioContext;

/** An `OfflineAudioContext` shape: same inherited `audioWorklet`, plus the
 *  `startRendering` that tells the two apart elsewhere in the codebase. */
const offlineCtx = (record: string[]): BaseAudioContext =>
  ({
    startRendering: async () => undefined,
    audioWorklet: {
      addModule: async (url: string) => {
        record.push(url);
      },
    },
  }) as unknown as BaseAudioContext;

/** What a plain-http LAN page hands you: no `audioWorklet` at all. */
const insecureCtx = (): BaseAudioContext => ({}) as unknown as BaseAudioContext;

// ── audioWorkletAvailable ────────────────────────────────────────────────────
{
  assert.equal(audioWorkletAvailable(liveCtx([])), true, 'a live context with addModule');
  assert.equal(audioWorkletAvailable(offlineCtx([])), true, 'an OfflineAudioContext is no different');
  assert.equal(audioWorkletAvailable(insecureCtx()), false, 'no audioWorklet at all');
  assert.equal(audioWorkletAvailable(null), false);
  assert.equal(audioWorkletAvailable(undefined), false);
  assert.equal(
    audioWorkletAvailable({ audioWorklet: {} } as unknown as BaseAudioContext),
    false,
    'an audioWorklet object without a callable addModule is not usable',
  );
  assert.equal(
    audioWorkletAvailable({ audioWorklet: { addModule: 'nope' } } as unknown as BaseAudioContext),
    false,
  );
}

// ── addWorkletModule: the happy path forwards, once, verbatim ────────────────
{
  const loaded: string[] = [];
  const p = addWorkletModule(liveCtx(loaded), '/chop.worklet.js');
  assert.ok(p instanceof Promise, 'always a promise, so callers can cache it');
  await p;
  assert.deepEqual(loaded, ['/chop.worklet.js']);

  const offlineLoaded: string[] = [];
  await addWorkletModule(offlineCtx(offlineLoaded), '/granular-morph.worklet.js');
  assert.deepEqual(offlineLoaded, ['/granular-morph.worklet.js'], 'offline contexts load the same way');
}

// ── addWorkletModule REJECTS, never throws synchronously ─────────────────────
{
  const secure = globalThis.isSecureContext;
  try {
    Object.defineProperty(globalThis, 'isSecureContext', { value: false, configurable: true, writable: true });
    let rejection: unknown;
    // If this threw, the assignment would never happen and the test would die
    // here with the raw error instead of reaching the assertions below.
    const p = addWorkletModule(insecureCtx(), '/chop.worklet.js');
    assert.ok(p instanceof Promise, 'an unavailable worklet still returns a promise');
    await p.then(
      () => assert.fail('must not resolve'),
      (e: unknown) => {
        rejection = e;
      },
    );
    assert.ok(rejection instanceof AudioWorkletUnavailableError, 'rejects with the typed error');
    assert.equal((rejection as AudioWorkletUnavailableError).reason, 'insecure-context');
    assert.equal((rejection as AudioWorkletUnavailableError).message, INSECURE_CONTEXT_MESSAGE);
    assert.match(
      (rejection as AudioWorkletUnavailableError).message,
      /localhost/,
      'the message tells the user somewhere to actually go',
    );
    assert.equal((rejection as Error).name, 'AudioWorkletUnavailableError');

    // The per-context caches in the call sites rely on `.catch()` firing.
    let caught = 0;
    await addWorkletModule(insecureCtx(), '/x.js').catch(() => {
      caught += 1;
    });
    assert.equal(caught, 1, 'a normal .catch() chain sees it');
  } finally {
    Object.defineProperty(globalThis, 'isSecureContext', { value: secure, configurable: true, writable: true });
  }
}

// ── a secure page with no AudioWorklet is 'unsupported', not 'insecure' ──────
{
  const secure = globalThis.isSecureContext;
  try {
    Object.defineProperty(globalThis, 'isSecureContext', { value: true, configurable: true, writable: true });
    const err = await addWorkletModule(insecureCtx(), '/x.js').then(
      () => null,
      (e: unknown) => e as AudioWorkletUnavailableError,
    );
    assert.ok(err instanceof AudioWorkletUnavailableError);
    assert.equal(err.reason, 'unsupported');
    assert.equal(err.message, UNSUPPORTED_MESSAGE);
  } finally {
    Object.defineProperty(globalThis, 'isSecureContext', { value: secure, configurable: true, writable: true });
  }
}

// ── a throwing addModule still comes back as a rejection ────────────────────
{
  const ctx = {
    audioWorklet: {
      addModule: () => {
        throw new Error('synchronous boom');
      },
    },
  } as unknown as BaseAudioContext;
  const err = await addWorkletModule(ctx, '/x.js').then(
    () => null,
    (e: unknown) => e as Error,
  );
  assert.equal(err?.message, 'synchronous boom', 'the real failure is preserved, not replaced');
}

// ── describeAudioWorkletProblem, with injected globals ──────────────────────
{
  const withWorklet = (): AudioWorkletEnv => {
    class Base {}
    Object.defineProperty(Base.prototype, 'audioWorklet', { get: () => ({}), configurable: true });
    class Ctx extends Base {}
    return { isSecureContext: true, BaseAudioContext: Base, AudioContext: Ctx };
  };

  assert.equal(describeAudioWorkletProblem(withWorklet()), null, 'a secure, supporting page has no problem');

  // Secure-context gating hides `audioWorklet` from the prototype entirely;
  // `isSecureContext` is the only thing that says why.
  const insecure = describeAudioWorkletProblem({
    isSecureContext: false,
    AudioContext: class {},
    BaseAudioContext: class {},
  });
  assert.ok(insecure, 'a plain-http LAN page has a problem');
  assert.equal(insecure.reason, 'insecure-context');
  assert.match(insecure.title, /\S/);
  assert.match(insecure.detail, /https:\/\//, 'says to use https');
  assert.match(insecure.detail, /localhost/, 'says to use localhost');
  assert.match(insecure.detail, /ssh -L/, 'gives the from-another-computer way out');

  const unsupported = describeAudioWorkletProblem({
    isSecureContext: true,
    AudioContext: class {},
    BaseAudioContext: class {},
  });
  assert.ok(unsupported);
  assert.equal(unsupported.reason, 'unsupported', 'secure but no worklet is the browser, not the address');
  assert.match(unsupported.detail, /AudioWorklet/);

  // Only one of the two constructors needs to carry it.
  class OnlyBase {}
  Object.defineProperty(OnlyBase.prototype, 'audioWorklet', { get: () => ({}), configurable: true });
  assert.equal(
    describeAudioWorkletProblem({ isSecureContext: true, BaseAudioContext: OnlyBase }),
    null,
    'BaseAudioContext alone is enough',
  );
  class OnlyCtx {}
  Object.defineProperty(OnlyCtx.prototype, 'audioWorklet', { get: () => ({}), configurable: true });
  assert.equal(
    describeAudioWorkletProblem({ isSecureContext: true, AudioContext: OnlyCtx }),
    null,
    'AudioContext alone is enough',
  );

  // No Web Audio whatsoever (an ancient browser) reads as unsupported.
  const none = describeAudioWorkletProblem({ isSecureContext: true });
  assert.equal(none?.reason, 'unsupported');
}

// ── the LAN https address, when this machine is serving one ────────────────
//
// `GET /api/network/lan` reports `https_url` only while a TLS listener is
// actually up (backend/lib/lan_https.py). On the device that HAS the problem
// that address is the entire fix — no port forwarding, no browser flag — so
// the notice must name it rather than leave the reader to arrange something.
{
  const INSECURE_ENV: AudioWorkletEnv = {
    isSecureContext: false,
    AudioContext: class {},
    BaseAudioContext: class {},
  };
  const generic = describeAudioWorkletProblem(INSECURE_ENV);
  assert.ok(generic);

  const withAddress = describeAudioWorkletProblem(INSECURE_ENV, 'https://192.168.1.34:5443');
  assert.ok(withAddress);
  assert.equal(withAddress.reason, 'insecure-context', 'the diagnosis does not change');
  assert.match(withAddress.detail, /https:\/\/192\.168\.1\.34:5443/, 'the detail names the address to open');
  assert.match(
    withAddress.detail,
    /certificate warning/i,
    'and warns about the self-signed certificate, so the warning is expected rather than alarming',
  );
  assert.ok(
    withAddress.detail.endsWith(generic.detail),
    'the generic advice is kept behind it — the address is an addition, not a replacement',
  );

  // A browser with no AudioWorklet at all is not fixed by a different
  // address. Offering one there is a false lead.
  const unsupported = describeAudioWorkletProblem(
    { isSecureContext: true, AudioContext: class {}, BaseAudioContext: class {} },
    'https://192.168.1.34:5443',
  );
  assert.equal(unsupported?.reason, 'unsupported');
  assert.doesNotMatch(unsupported?.detail ?? '', /192\.168\.1\.34/, 'no address offered for a browser fault');

  // Nothing to offer is the status quo, byte for byte.
  for (const empty of [undefined, null, '', '   ']) {
    assert.equal(
      describeAudioWorkletProblem(INSECURE_ENV, empty)?.detail,
      generic.detail,
      `secureUrl ${JSON.stringify(empty)} must leave the message exactly as it was`,
    );
  }

  // ── secureAddressAdvice, the piece that decides ──────────────────────────
  assert.equal(secureAddressAdvice('https://192.168.1.34:5443')?.includes('192.168.1.34:5443'), true);
  assert.equal(secureAddressAdvice(' https://host:5443 ')?.includes('https://host:5443'), true, 'trimmed');
  assert.equal(secureAddressAdvice('HTTPS://host:5443')?.includes('HTTPS://host:5443'), true, 'scheme case');
  assert.equal(secureAddressAdvice(null), null);
  assert.equal(secureAddressAdvice(undefined), null);
  assert.equal(secureAddressAdvice(''), null);
  // The whole point is a SECURE context. A second plain-http address would
  // send the reader to a page with exactly this fault.
  assert.equal(secureAddressAdvice('http://192.168.1.34:5173'), null, 'http is not a cure for http');
  assert.equal(secureAddressAdvice('192.168.1.34:5443'), null, 'a bare host:port is not an address to open');
  assert.equal(secureAddressAdvice('app://./index.html'), null);
}

// ── SOURCE GUARD: nothing under src calls addModule directly ────────────────
{
  const srcRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const sourceFiles = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(full);
      if (!/\.tsx?$/.test(entry.name)) return [];
      if (/\.test\.tsx?$/.test(entry.name)) return []; // tests fake contexts on purpose
      if (entry.name === 'audioWorkletSupport.ts') return []; // the one allowed site
      return [full];
    });

  const DIRECT_CALL = /\.audioWorklet\s*(\?\.)?\.?\s*addModule\s*\(/;
  const offenders = sourceFiles(srcRoot)
    .map((file) => ({ file, lines: readFileSync(file, 'utf8').split(/\r?\n/) }))
    .flatMap(({ file, lines }) =>
      lines
        .map((line, i) => ({ line, i }))
        .filter(({ line }) => DIRECT_CALL.test(line))
        .map(({ i }) => `${relative(srcRoot, file).replace(/\\/g, '/')}:${i + 1}`),
    );

  assert.deepEqual(
    offenders,
    [],
    'every worklet load goes through addWorkletModule (lib/audioWorkletSupport.ts), ' +
      'or it crashes with "reading \'addModule\'" on any non-secure page',
  );

  // The scan is only worth anything if it can actually see a violation.
  assert.ok(DIRECT_CALL.test("p = ctx.audioWorklet.addModule('/chop.worklet.js')"));
  assert.ok(DIRECT_CALL.test('await offline.audioWorklet.addModule(URL);'));
  assert.ok(DIRECT_CALL.test('void ctx.audioWorklet?.addModule(URL);'));
  assert.ok(!DIRECT_CALL.test('addWorkletModule(ctx, URL)'));
  assert.ok(sourceFiles(srcRoot).length > 50, 'the scan reached the tree, not an empty directory');

  // DIRECT_CALL only sees the property spelled out on the same line. Two ways
  // of writing the same crash slip past it:
  //
  //     const w = ctx.audioWorklet; w.addModule('/x.js');   // aliased
  //     ctx['audioWorklet'].addModule('/x.js');             // bracket access
  //
  // so the guard also runs a pattern that does not care HOW the object was
  // reached: any `addModule(` at all. `addModule` is not a name anything else
  // in this tree owns — a grep over src found no non-worklet definition or
  // call of it outside the exempt file — so the weak pattern needs no
  // exceptions today. If a legitimate one ever appears, add its
  // `path:line`-free source path here with a comment saying why.
  const ANY_CALL = /\baddModule\s*\(/;
  const ANY_CALL_ALLOWED: readonly string[] = [];

  const looseOffenders = sourceFiles(srcRoot)
    .filter((file) => !ANY_CALL_ALLOWED.includes(relative(srcRoot, file).replace(/\\/g, '/')))
    .map((file) => ({ file, lines: readFileSync(file, 'utf8').split(/\r?\n/) }))
    .flatMap(({ file, lines }) =>
      lines
        .map((line, i) => ({ line, i }))
        .filter(({ line }) => ANY_CALL.test(line))
        .map(({ i }) => `${relative(srcRoot, file).replace(/\\/g, '/')}:${i + 1}`),
    );

  assert.deepEqual(
    looseOffenders,
    [],
    'no file under src may call addModule under any spelling — alias it, index it ' +
      "with a string, it still crashes with \"reading 'addModule'\" off a secure context. " +
      'Use addWorkletModule (lib/audioWorkletSupport.ts).',
  );

  // The weaker scan has to catch what the stricter one misses.
  assert.ok(ANY_CALL.test("const w = ctx.audioWorklet; void w.addModule('/x.js');"), 'aliased');
  assert.ok(ANY_CALL.test("ctx['audioWorklet'].addModule('/x.js');"), 'bracket access');
  assert.ok(ANY_CALL.test('await worklet.addModule(URL);'), 'member on any receiver');
  assert.ok(!ANY_CALL.test('addWorkletModule(ctx, URL)'), 'the sanctioned helper is not a hit');
  assert.ok(!ANY_CALL.test("// crashed with reading 'addModule')"), 'prose about the crash is not a call');
}

console.log('audioWorkletSupport: ok');
