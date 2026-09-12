/**
 * What a failed microphone open actually means, in words a user can act on.
 *
 * Every mic surface used to log the raw exception: the MIDI tab's always-on
 * level monitor said
 *
 *     mic monitor unavailable: NotFoundError: Requested device not found
 *
 * on a machine that simply has no microphone attached. That reads as a broken
 * feature, and it fires every time the tab is opened. The three cases behind
 * that one string want three different responses:
 *
 *   - `NotFoundError` / `DevicesNotFoundError` — there is no microphone on this
 *     machine. Nothing is wrong and there is nothing to fix; say so once, at
 *     info level, and stop.
 *   - `NotAllowedError` / `SecurityError` — a microphone exists and the user (or
 *     policy) refused it. Actionable: name the permission.
 *   - `NotReadableError` / `AbortError` — the device is there but another app
 *     holds it. Also actionable, and a different fix.
 *
 * `OverconstrainedError` is listed for completeness: `startInputMonitor` and
 * `startVocalCapture` pass `deviceId` as a SOFT constraint precisely so a stale
 * id degrades to the OS default instead of rejecting, so seeing it means a
 * constraint other than the device id could not be met.
 *
 * Pure: no DOM, no logging. The caller decides the level, because "no mic on a
 * machine with no mic" is not a warning.
 */

/** How the caller should treat a mic-open failure. */
export type MicFailureKind =
  /** No capture device exists. Expected on plenty of machines. */
  | 'no-device'
  /** A device exists; permission was refused. */
  | 'denied'
  /** A device exists; something else is using it. */
  | 'busy'
  /** The browser cannot do capture at all. */
  | 'unsupported'
  /** Constraints other than the device id could not be satisfied. */
  | 'overconstrained'
  /** Anything we do not recognise — keep the raw text. */
  | 'unknown'

export interface MicFailure {
  kind: MicFailureKind
  /** One sentence for the LOG or a `role="alert"`. Never includes a stack. */
  message: string
  /** True when this is a normal state of the machine, not a fault. */
  benign: boolean
}

/** `DOMException.name`, when the thrown thing has one. */
function errorName(err: unknown): string {
  if (typeof err === 'object' && err !== null) {
    const name = (err as { name?: unknown }).name
    if (typeof name === 'string') return name
  }
  return ''
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message || err.name
  return String(err)
}

/**
 * Classify a `getUserMedia` rejection.
 *
 * `what` names the surface for the message ("the level meter", "SING's pitch
 * lane"), so one classifier serves every caller without a generic sentence.
 */
export function describeMicFailure(err: unknown, what: string): MicFailure {
  switch (errorName(err)) {
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return {
        kind: 'no-device',
        message: `No microphone is attached, so ${what} is off. Plug one in and reopen this tab.`,
        benign: true,
      }
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return {
        kind: 'denied',
        message: `Microphone access was refused, so ${what} is off. Allow the microphone for theDAW and reopen this tab.`,
        benign: false,
      }
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return {
        kind: 'busy',
        message: `The microphone is in use by another program, so ${what} is off. Close whatever is holding it and reopen this tab.`,
        benign: false,
      }
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return {
        kind: 'overconstrained',
        message: `The microphone cannot record in the format ${what} asked for. It will use the system default instead.`,
        benign: false,
      }
    case 'TypeError':
      return {
        kind: 'unsupported',
        message: `This build cannot open a microphone, so ${what} is off.`,
        benign: false,
      }
    default:
      return { kind: 'unknown', message: `${what} could not open the microphone: ${errorText(err)}`, benign: false }
  }
}

/**
 * True the first time a given (kind, surface) pair is seen this session.
 *
 * The monitor effect re-runs whenever the chosen device changes and whenever the
 * panel remounts, so without this the same "no microphone" line stacks up in the
 * LOG. Keyed on the kind as well as the surface so a state CHANGE — device
 * appears, permission granted, device taken by another app — is still reported.
 */
const announced = new Set<string>()

export function shouldAnnounceMicFailure(failure: MicFailure, what: string): boolean {
  const key = `${what}:${failure.kind}`
  if (announced.has(key)) return false
  announced.add(key)
  return true
}

/** Forget what has been announced. For tests, and for a deliberate re-probe. */
export function resetMicFailureLog(): void {
  announced.clear()
}
