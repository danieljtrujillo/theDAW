/**
 * Resilient fetch helpers for library media (stems, MIDI).
 *
 * The single-worker backend can stall mid-response while it is loading a model
 * (a CPU/GIL-heavy operation), so a large stream aborts with `net::ERR_FAILED`
 * even though headers returned 200, and a MIDI fetch can come back truncated
 * (which then parses as "Invalid MIDI track chunk"). A couple of short retries
 * ride over that window — the file on disk is fine, the connection just dropped.
 */
import { logWarn } from '../state/logStore';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface RetryOpts {
  retries?: number;
  backoffMs?: number;
  label?: string;
}

async function fetchOk(url: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
}

/** Fetch bytes with retries; rejects only after the last attempt fails. */
export async function fetchBytesWithRetry(url: string, opts: RetryOpts = {}): Promise<ArrayBuffer> {
  const { retries = 3, backoffMs = 450, label } = opts;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const res = await fetchOk(url);
      const buf = await res.arrayBuffer();
      if (buf.byteLength === 0) throw new Error('empty response body');
      return buf;
    } catch (e) {
      lastErr = e;
      if (attempt < retries) {
        if (label) logWarn('library', `${label}: fetch attempt ${attempt + 1} failed (${e instanceof Error ? e.message : String(e)}); retrying…`);
        await sleep(backoffMs * (attempt + 1));
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** True when the bytes are a structurally complete Standard MIDI File (header
 *  present and every declared MTrk chunk fits within the buffer) — catches a
 *  truncated 200 response that would otherwise parse as "Invalid track chunk". */
function midiLooksComplete(buf: ArrayBuffer): boolean {
  const b = new Uint8Array(buf);
  if (b.length < 14 || b[0] !== 0x4d || b[1] !== 0x54 || b[2] !== 0x68 || b[3] !== 0x64) return false; // 'MThd'
  const dv = new DataView(buf);
  let off = 8 + dv.getUint32(4);
  const ntrk = dv.getUint16(10);
  let seen = 0;
  while (off + 8 <= b.length && seen < ntrk) {
    if (b[off] !== 0x4d || b[off + 1] !== 0x54 || b[off + 2] !== 0x72 || b[off + 3] !== 0x6b) break; // 'MTrk'
    off += 8 + dv.getUint32(off + 4);
    seen += 1;
  }
  return seen >= ntrk && off <= b.length;
}

/** Fetch a complete MIDI file with retries, re-fetching truncated/partial bodies. */
export async function fetchMidiBytesWithRetry(url: string, opts: RetryOpts = {}): Promise<ArrayBuffer> {
  const { retries = 3, backoffMs = 450, label } = opts;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const res = await fetchOk(url);
      const buf = await res.arrayBuffer();
      if (!midiLooksComplete(buf)) throw new Error('incomplete MIDI response (server busy?)');
      return buf;
    } catch (e) {
      lastErr = e;
      if (attempt < retries) {
        if (label) logWarn('library', `${label}: MIDI fetch attempt ${attempt + 1} failed (${e instanceof Error ? e.message : String(e)}); retrying…`);
        await sleep(backoffMs * (attempt + 1));
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Fetch a Blob with retries; rejects only after the last attempt fails. */
export async function fetchBlobWithRetry(url: string, opts: RetryOpts = {}): Promise<Blob> {
  const { retries = 3, backoffMs = 450, label } = opts;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const res = await fetchOk(url);
      const blob = await res.blob();
      if (blob.size === 0) throw new Error('empty response body');
      return blob;
    } catch (e) {
      lastErr = e;
      if (attempt < retries) {
        if (label) logWarn('library', `${label}: fetch attempt ${attempt + 1} failed (${e instanceof Error ? e.message : String(e)}); retrying…`);
        await sleep(backoffMs * (attempt + 1));
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
