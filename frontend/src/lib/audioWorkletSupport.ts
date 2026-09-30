/**
 * One gate in front of every `AudioWorklet` load in the app.
 *
 * `BaseAudioContext.audioWorklet` is `[SecureContext]` in the Web Audio spec:
 * browsers expose it ONLY on `https://` pages and on `http://localhost`. Open
 * the same dev server from another machine on the LAN — `http://192.168.1.34:5174`
 * — and `ctx.audioWorklet` is plain `undefined`, so every
 * `ctx.audioWorklet.addModule(...)` in the codebase died with
 * "Cannot read properties of undefined (reading 'addModule')" and the user got
 * a generic crash card with a Retry button that could never succeed.
 *
 * So: no direct `.audioWorklet.addModule(` anywhere under `src` but here
 * (enforced by `audioWorkletSupport.test.ts`). Every site calls
 * {@link addWorkletModule}, which REJECTS — never throws synchronously, so the
 * existing per-context promise caches and `.catch()` chains keep working
 * untouched — with an {@link AudioWorkletUnavailableError} carrying a message a
 * user can act on. The app shell shows the same explanation once, up front,
 * via {@link describeAudioWorkletProblem}.
 */

/** Why the worklet is missing. */
export type AudioWorkletProblemReason =
  /** The page is not a secure context, so the browser hides `audioWorklet`. */
  | 'insecure-context'
  /** A secure page, but this browser has no AudioWorklet at all. */
  | 'unsupported';

/** The globals {@link describeAudioWorkletProblem} reads. Injectable for tests. */
export interface AudioWorkletEnv {
  isSecureContext?: boolean;
  AudioContext?: unknown;
  BaseAudioContext?: unknown;
  webkitAudioContext?: unknown;
}

export const INSECURE_CONTEXT_MESSAGE =
  'Audio processing is blocked because this page is not secure. Open theDAW at https:// or at ' +
  'http://localhost. From another computer on your network, either tunnel it (ssh -L) or mark this ' +
  'address as secure in your browser.';

export const UNSUPPORTED_MESSAGE =
  'Audio processing is blocked because this browser has no AudioWorklet. Open theDAW in a current ' +
  'version of Chrome, Edge, Firefox or Safari.';

/** Thrown (as a rejection) by {@link addWorkletModule} when there is no worklet. */
export class AudioWorkletUnavailableError extends Error {
  readonly reason: AudioWorkletProblemReason;

  constructor(reason: AudioWorkletProblemReason, message?: string) {
    super(message ?? (reason === 'insecure-context' ? INSECURE_CONTEXT_MESSAGE : UNSUPPORTED_MESSAGE));
    this.name = 'AudioWorkletUnavailableError';
    this.reason = reason;
    // Extending a built-in under a `target` below ES2015 breaks `instanceof`;
    // setting the prototype explicitly makes it hold under every target.
    Object.setPrototypeOf(this, AudioWorkletUnavailableError.prototype);
  }
}

/** True when `ctx` can actually load a worklet module. Works for `AudioContext`
 *  and `OfflineAudioContext` alike — both inherit `audioWorklet` from
 *  `BaseAudioContext`. */
export function audioWorkletAvailable(ctx: BaseAudioContext | null | undefined): boolean {
  const worklet = (ctx as unknown as { audioWorklet?: { addModule?: unknown } } | null | undefined)
    ?.audioWorklet;
  return typeof worklet?.addModule === 'function';
}

const env = (): AudioWorkletEnv => globalThis as unknown as AudioWorkletEnv;

/** 'insecure-context' when the page itself is the reason, else 'unsupported'. */
function reasonFor(e: AudioWorkletEnv): AudioWorkletProblemReason {
  return e.isSecureContext === false ? 'insecure-context' : 'unsupported';
}

/**
 * Load `url` into `ctx`, or reject with an {@link AudioWorkletUnavailableError}.
 *
 * Never throws synchronously: callers cache the returned promise and attach
 * `.catch()` to it, and a synchronous throw would skip both.
 */
export function addWorkletModule(ctx: BaseAudioContext, url: string): Promise<void> {
  if (!audioWorkletAvailable(ctx)) {
    return Promise.reject(new AudioWorkletUnavailableError(reasonFor(env())));
  }
  try {
    return Promise.resolve(ctx.audioWorklet.addModule(url));
  } catch (err) {
    return Promise.reject(err);
  }
}

/** What the shell shows the user. */
export interface AudioWorkletProblem {
  reason: AudioWorkletProblemReason;
  title: string;
  detail: string;
}

/** The generic advice for an insecure page: true wherever it is shown, but it
 *  asks the reader to go and arrange something. */
const INSECURE_DETAIL =
  'Browsers only allow audio processing (AudioWorklet) on a secure page, and this one is plain ' +
  'http on a network address. Open theDAW at https:// or at http://localhost to get audio back. ' +
  'From another computer, either forward the port to your own machine (ssh -L) and open it as ' +
  'localhost, or mark this address as secure in your browser.';

/**
 * The concrete way out, when the app knows one.
 *
 * `GET /api/network/lan` reports `https_url` when this machine is ALREADY
 * serving the same app over TLS on the LAN (backend/lib/lan_https.py). On a
 * device that has the problem, that address is the whole answer — no port
 * forwarding, no browser flag — so it goes first and the generic advice stays
 * behind it as the fallback for everyone else.
 *
 * Only an `https://` URL qualifies: handing someone a second plain-http
 * address as the cure would send them to a page with exactly this fault.
 */
export function secureAddressAdvice(secureUrl: string | null | undefined): string | null {
  const url = (secureUrl ?? '').trim();
  if (!url.toLowerCase().startsWith('https://')) return null;
  return (
    `This machine is also serving theDAW at ${url} — the same app on a secure address, where audio, ` +
    'the microphone and MIDI all work. The first visit shows a certificate warning; choose Proceed. '
  );
}

const hasWorkletOnPrototype = (ctor: unknown): boolean => {
  const proto = (ctor as { prototype?: object } | undefined)?.prototype;
  return typeof proto === 'object' && proto !== null && 'audioWorklet' in proto;
};

/**
 * `null` when this page can run worklets; otherwise what to tell the user.
 *
 * Pure: everything it reads comes from `e`, which defaults to the real globals.
 * The check is on the CONSTRUCTOR prototype, not on a live context, so the
 * shell can answer before (and without) building an audio engine.
 *
 * `secureUrl` is the LAN https address from `GET /api/network/lan`, when the
 * app has learned one. It only changes the 'insecure-context' message: a
 * browser with no AudioWorklet at all is not fixed by a different address, and
 * offering one there would be a false lead.
 */
export function describeAudioWorkletProblem(
  e: AudioWorkletEnv = env(),
  secureUrl?: string | null,
): AudioWorkletProblem | null {
  if (hasWorkletOnPrototype(e.BaseAudioContext) || hasWorkletOnPrototype(e.AudioContext)) return null;

  const reason = reasonFor(e);
  return reason === 'insecure-context'
    ? {
        reason,
        title: 'Audio is switched off on this address',
        detail: `${secureAddressAdvice(secureUrl) ?? ''}${INSECURE_DETAIL}`,
      }
    : {
        reason,
        title: 'This browser cannot run theDAW audio',
        detail:
          'Audio processing here needs AudioWorklet, which this browser does not provide. Open theDAW ' +
          'in a current version of Chrome, Edge, Firefox or Safari.',
      };
}
