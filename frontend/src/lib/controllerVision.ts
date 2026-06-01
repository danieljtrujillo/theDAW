/**
 * Client for the controllervision backend (/api/controllervision) — Tier-3
 * controller layout inference from a product image.
 *
 * Honest scope: this returns SUGGESTED control counts + positions the user
 * verifies; the MIDI mapping is never inferred from the image (that's the
 * learn-capture / MIDI-learn path). See docs/plans/2026-06-01 §7a.
 */

export interface CvControl {
  kind: 'knob' | 'fader' | 'pad';
  cx: number; cy: number; w: number; h: number; // normalized 0..1
  confidence: number;
}

export interface CvResult {
  available: boolean;
  error?: string;
  found?: boolean;        // detect-by-name: was an image found?
  query?: string;
  source?: string;        // 'upload' | 'wikimedia'
  width?: number;
  height?: number;
  controls: CvControl[];
  counts: { knob?: number; fader?: number; pad?: number };
  imageUrl?: string;      // detect-by-name: the source image
  imageTitle?: string;
  descriptionUrl?: string;
}

/** AI identify result — brand/model + control counts from a vision LLM. */
export interface CvIdentifyResult {
  available: boolean;
  error?: string;
  used?: string;          // provider/model that answered
  brand?: string | null;
  model?: string | null;
  confidence?: number | null;
  notes?: string | null;
  counts: { knob?: number; fader?: number; pad?: number };
  source?: string;
}

/** Backend capabilities: classical CV (OpenCV) + AI vision (Assistant keys). */
export async function cvCapabilities(): Promise<{ ok: boolean; available: boolean; aiAvailable: boolean; aiProvider: string | null }> {
  try {
    const r = await fetch('/api/controllervision');
    if (!r.ok) return { ok: false, available: false, aiAvailable: false, aiProvider: null };
    const j = await r.json();
    return { ok: !!j.ok, available: !!j.available, aiAvailable: !!j.ai_available, aiProvider: j.ai_provider ?? null };
  } catch {
    return { ok: false, available: false, aiAvailable: false, aiProvider: null };
  }
}

/** Identify a controller from a photo via a vision LLM (the accurate path). */
export async function identifyWithAi(file: File): Promise<CvIdentifyResult> {
  const fd = new FormData();
  fd.append('image_file', file);
  const r = await fetch('/api/controllervision/identify', { method: 'POST', body: fd });
  if (!r.ok) {
    const msg = await r.text().catch(() => r.statusText);
    throw new Error(`identify failed (${r.status}): ${msg}`);
  }
  return (await r.json()) as CvIdentifyResult;
}

/** Detect controls in a user-supplied photo (source #1). */
export async function detectFromUpload(file: File): Promise<CvResult> {
  const fd = new FormData();
  fd.append('image_file', file);
  const r = await fetch('/api/controllervision/detect', { method: 'POST', body: fd });
  if (!r.ok) {
    const msg = await r.text().catch(() => r.statusText);
    throw new Error(`detect failed (${r.status}): ${msg}`);
  }
  return (await r.json()) as CvResult;
}

/** Find a product image by device name on Wikimedia + detect (source #2). */
export async function detectByName(deviceName: string): Promise<CvResult> {
  const fd = new FormData();
  fd.append('device_name', deviceName);
  const r = await fetch('/api/controllervision/detect-by-name', { method: 'POST', body: fd });
  if (!r.ok) {
    const msg = await r.text().catch(() => r.statusText);
    throw new Error(`detect-by-name failed (${r.status}): ${msg}`);
  }
  return (await r.json()) as CvResult;
}

/* ── Phone pairing (source #3): snap the photo from a phone over the LAN ──── */

export interface PairingSession {
  id: string;
  mobilePath: string; // backend path; combine with the LAN base for the QR
}

/** Open a pairing session; the phone will upload to it. */
export async function createPhoneSession(): Promise<PairingSession> {
  const r = await fetch('/api/controllervision/session', { method: 'POST' });
  if (!r.ok) throw new Error(`session create failed (${r.status})`);
  const j = await r.json();
  return { id: j.id, mobilePath: j.mobile_path };
}

/** This machine's LAN IP (for building a phone-reachable URL), or null. */
export async function lanIp(): Promise<string | null> {
  try {
    const r = await fetch('/api/vj/lan-ip');
    if (!r.ok) return null;
    const j = await r.json();
    return j.lan_ip ?? null;
  } catch {
    return null;
  }
}

/** Poll a pairing session. Returns the CvResult once the phone has uploaded,
 *  null while still pending, throws if the session expired (404). */
export async function pollPhoneSession(id: string): Promise<CvResult | null> {
  const r = await fetch(`/api/controllervision/session/${id}`);
  if (r.status === 404) throw new Error('pairing session expired');
  if (!r.ok) throw new Error(`session poll failed (${r.status})`);
  const j = await r.json();
  return j.status === 'ready' ? (j.result as CvResult) : null;
}
