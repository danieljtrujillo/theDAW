/**
 * ControllerVisionModal — Tier-3 controller recognition UI.
 *
 * Build a controller layout from a PHOTO when no preset matches and you'd rather
 * not capture every control by hand. Two sources: upload your own device photo,
 * or search by device name (Wikimedia Commons). The backend runs classical CV
 * (OpenCV) to detect knobs/faders/pads + positions; this modal shows the image
 * with the detected controls overlaid and the COUNTS editable, so you VERIFY /
 * correct before it builds a profile.
 *
 * Honesty surfaced in the UI: CV is approximate (it proposes; you confirm), and
 * the layout it builds has NO MIDI mapping yet — a photo can't tell which CC/
 * note each control sends. The modal says so and points to Learn/MIDI-map for
 * the actual binding.
 */
import React, { useEffect, useRef, useState } from 'react';
import { ScanLine, Upload, Search, X, Check, AlertTriangle, Smartphone, Sparkles } from 'lucide-react';
import {
  detectFromUpload, detectByName, identifyWithAi, cvCapabilities,
  createPhoneSession, lanIp, pollPhoneSession, type CvResult, type CvIdentifyResult,
} from '../../lib/controllerVision';
import { useLearnedProfilesStore } from '../../state/learnedProfilesStore';
import { detectProfile } from '../../state/controllerProfiles';

const BACKEND_PORT = 8600; // theDAW FastAPI — serves the mobile upload page

interface Props {
  onClose: () => void;
  /** Called with the new learned-profile id once the user accepts a layout. */
  onBuilt: (profileId: string) => void;
}

const KIND_COLOR: Record<string, string> = {
  knob: '#a855f7',
  fader: '#22d3ee',
  pad: '#f59e0b',
};

export const ControllerVisionModal: React.FC<Props> = ({ onClose, onBuilt }) => {
  const buildFromCounts = useLearnedProfilesStore((s) => s.buildFromCounts);

  const [available, setAvailable] = useState<boolean | null>(null);
  const [aiAvailable, setAiAvailable] = useState<boolean>(false);
  const [aiProvider, setAiProvider] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<CvResult | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [name, setName] = useState('');
  // What the AI identified (brand/model) + whether our library has a match.
  const [identified, setIdentified] = useState<{ brand?: string | null; model?: string | null; used?: string; libraryMatch?: string | null } | null>(null);
  // Editable counts (the user-verify step).
  const [counts, setCounts] = useState<{ knob: number; fader: number; pad: number }>({ knob: 0, fader: 0, pad: 0 });
  const fileRef = useRef<HTMLInputElement>(null);
  const aiFileRef = useRef<HTMLInputElement>(null);
  // Phone pairing: QR → phone upload → poll.
  const [phoneUrl, setPhoneUrl] = useState<string | null>(null);
  const [phoneWaiting, setPhoneWaiting] = useState(false);
  const phonePoll = useRef<number | null>(null);

  useEffect(() => {
    void cvCapabilities().then((c) => { setAvailable(c.available); setAiAvailable(c.aiAvailable); setAiProvider(c.aiProvider); });
  }, []);

  // Revoke object URLs we create for uploaded-photo previews.
  useEffect(() => () => { if (previewUrl && previewUrl.startsWith('blob:')) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  // Stop polling when the modal unmounts.
  useEffect(() => () => { if (phonePoll.current) window.clearInterval(phonePoll.current); }, []);

  const applyResult = (res: CvResult, preview: string | null) => {
    setResult(res);
    setPreviewUrl(preview);
    setIdentified(null);
    setCounts({
      knob: res.counts.knob ?? 0,
      fader: res.counts.fader ?? 0,
      pad: res.counts.pad ?? 0,
    });
  };

  /** Apply a vision-LLM identify result: record brand/model, cross-check the
   *  built-in library, seed editable counts. */
  const applyIdentify = (res: CvIdentifyResult, preview: string | null) => {
    // Cross-check the AI's brand/model against our ~110-profile library.
    const guess = [res.brand, res.model].filter(Boolean).join(' ').trim();
    const libHit = guess ? detectProfile(guess) : null;
    setResult({
      available: res.available,
      controls: [],
      counts: res.counts,
      source: res.source,
    } as CvResult);
    setPreviewUrl(preview);
    setIdentified({ brand: res.brand, model: res.model, used: res.used, libraryMatch: libHit ? libHit.name : null });
    setCounts({
      knob: res.counts.knob ?? 0,
      fader: res.counts.fader ?? 0,
      pad: res.counts.pad ?? 0,
    });
    if (guess && !name) setName(guess);
  };

  // AI identify (the accurate path) — vision LLM names the device + counts.
  const onAiIdentify = async (file: File) => {
    setErr(null); setBusy(true); setResult(null); setIdentified(null);
    try {
      const res = await identifyWithAi(file);
      if (!res.available || res.error || !res.counts) { setErr(res.error || 'AI identify failed'); return; }
      applyIdentify(res, URL.createObjectURL(file));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  // Classical CV upload (no-key fallback / explainable bounding boxes).
  const onUpload = async (file: File) => {
    setErr(null); setBusy(true); setResult(null);
    try {
      const res = await detectFromUpload(file);
      if (!res.available) { setErr(res.error || 'CV not available'); return; }
      applyResult(res, URL.createObjectURL(file));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  const onSearch = async () => {
    if (!name.trim()) return;
    setErr(null); setBusy(true); setResult(null);
    try {
      const res = await detectByName(name.trim());
      if (!res.available) { setErr(res.error || 'CV not available'); return; }
      if (res.found === false) { setErr(`No product image found for “${name.trim()}”. Try a photo upload instead.`); return; }
      applyResult(res, res.imageUrl ?? null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  const startPhone = async () => {
    setErr(null);
    if (phonePoll.current) { window.clearInterval(phonePoll.current); phonePoll.current = null; }
    try {
      const ip = await lanIp();
      if (!ip) { setErr('No LAN IP detected — connect this machine to Wi-Fi/Ethernet so your phone can reach it.'); return; }
      const sess = await createPhoneSession();
      setPhoneUrl(`http://${ip}:${BACKEND_PORT}${sess.mobilePath}`);
      setPhoneWaiting(true);
      phonePoll.current = window.setInterval(async () => {
        try {
          const res = await pollPhoneSession(sess.id);
          if (res) {
            if (phonePoll.current) { window.clearInterval(phonePoll.current); phonePoll.current = null; }
            setPhoneWaiting(false);
            setPhoneUrl(null);
            // Phone result has no client-side image — show the overlay-less
            // verify panel (counts only).
            applyResult(res, null);
          }
        } catch (e) {
          if (phonePoll.current) { window.clearInterval(phonePoll.current); phonePoll.current = null; }
          setPhoneWaiting(false);
          setErr(e instanceof Error ? e.message : String(e));
        }
      }, 1500);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const accept = () => {
    const id = buildFromCounts(name || (result?.query ?? 'CV layout'), counts);
    if (id) onBuilt(id);
  };

  const total = counts.knob + counts.fader + counts.pad;

  return (
    <div className="fixed inset-0 z-200 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-170 max-w-[92vw] max-h-[88vh] overflow-y-auto bg-[#0c0a14] border border-indigo-500/30 rounded-xl shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/8 bg-indigo-500/8">
          <div className="flex items-center gap-2">
            <ScanLine className="w-4 h-4 text-indigo-300" />
            <span className="text-[11px] font-black uppercase tracking-widest text-indigo-200">Detect device from image</span>
          </div>
          <button onClick={onClose} className="p-1 text-zinc-500 hover:text-white" aria-label="Close"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-4 space-y-3">
          {available === false && !aiAvailable && (
            <div className="flex items-start gap-2 p-2 rounded border border-amber-500/40 bg-amber-500/10 text-[10px] text-amber-200">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>No image analysis available — add a vision-capable API key in the Assistant (for AI identify), or install OpenCV. You can still use <b>Learn</b> or pick a library profile.</span>
            </div>
          )}

          {/* PRIMARY: AI identify (the accurate path). Upload a photo OR scan
              with a phone; a vision model names the device + counts controls. */}
          <div className="rounded-lg border border-indigo-500/40 bg-indigo-500/8 p-3 space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-widest text-indigo-200">
                <Sparkles className="w-3.5 h-3.5" /> AI identify <span className="text-[8px] font-bold text-indigo-300/70">recommended</span>
              </div>
              <span className="text-[8px] font-mono text-zinc-500">{aiAvailable ? (aiProvider ?? 'vision model') : 'no vision key'}</span>
            </div>
            <p className="text-[9px] text-zinc-400 leading-relaxed">
              A vision model identifies your controller (brand + model) and counts its controls — far more accurate than raw shape detection. If enabled, this uploads the photo to your configured AI provider (via your Assistant keys).
            </p>
            <div className="flex gap-2">
              <input ref={aiFileRef} type="file" accept="image/*" className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) void onAiIdentify(f); }} />
              <button
                onClick={() => aiFileRef.current?.click()}
                disabled={busy || !aiAvailable}
                className="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded border border-indigo-500/50 bg-indigo-500/15 text-[10px] font-bold uppercase tracking-wider text-indigo-100 hover:bg-indigo-500/25 disabled:opacity-40"
              >
                <Upload className="w-3.5 h-3.5" /> Upload photo
              </button>
              <button
                onClick={() => void startPhone()}
                disabled={busy || (!aiAvailable && available === false)}
                className="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded border border-indigo-500/50 bg-indigo-500/15 text-[10px] font-bold uppercase tracking-wider text-indigo-100 hover:bg-indigo-500/25 disabled:opacity-40"
                title="Show a QR — snap the controller photo from your phone over the local network (uses AI if a key is set)"
              >
                <Smartphone className="w-3.5 h-3.5" /> Scan with phone
              </button>
            </div>
          </div>

          {/* SECONDARY: by-name search + raw OpenCV (no-key fallback). */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <div className="text-[9px] font-mono uppercase tracking-widest text-zinc-500">By name (Wikimedia)</div>
              <div className="flex gap-1.5">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void onSearch(); }}
                  placeholder="AKAI MIDIMIX"
                  className="flex-1 min-w-0 bg-black/40 border border-white/12 rounded px-2 py-1.5 text-[10px] font-mono text-zinc-200 outline-none focus:border-indigo-500/50"
                />
                <button
                  onClick={() => void onSearch()}
                  disabled={busy || !name.trim() || available === false}
                  className="px-2 py-1.5 rounded border border-white/12 text-zinc-300 hover:border-indigo-500/40 hover:text-indigo-200 disabled:opacity-40"
                  aria-label="Search"
                ><Search className="w-3.5 h-3.5" /></button>
              </div>
            </div>
            <div className="space-y-1.5">
              <div className="text-[9px] font-mono uppercase tracking-widest text-zinc-500">Raw CV (no AI)</div>
              <input ref={fileRef} type="file" accept="image/*" className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) void onUpload(f); }} />
              <button
                onClick={() => fileRef.current?.click()}
                disabled={busy || available === false}
                className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded border border-white/12 text-[10px] font-bold uppercase tracking-wider text-zinc-300 hover:border-indigo-500/40 hover:text-indigo-200 disabled:opacity-40"
                title="Classical OpenCV shape detection — no API key needed, but approximate"
              >
                <Upload className="w-3.5 h-3.5" /> Photo
              </button>
            </div>
          </div>

          {/* What the AI identified + library cross-check. */}
          {identified && (
            <div className="flex items-start gap-2 p-2 rounded border border-emerald-500/30 bg-emerald-500/8 text-[10px] text-emerald-100">
              <Sparkles className="w-3.5 h-3.5 mt-0.5 shrink-0 text-emerald-300" />
              <div className="min-w-0">
                <div className="font-bold">
                  {[identified.brand, identified.model].filter(Boolean).join(' ') || 'Device identified'}
                </div>
                <div className="text-[9px] text-emerald-200/70">
                  {identified.used ? `via ${identified.used}` : 'AI vision'}
                  {identified.libraryMatch
                    ? ` · matches library profile “${identified.libraryMatch}” (you can pick it instead for an exact layout)`
                    : ' · not in the built-in library — building from the counts below'}
                </div>
              </div>
            </div>
          )}

          {/* Phone-pairing QR */}
          {phoneUrl && (
            <div className="flex items-center gap-3 p-3 rounded border border-indigo-500/30 bg-indigo-500/8">
              <img
                src={`https://api.qrserver.com/v1/create-qr-code/?size=140x140&margin=8&data=${encodeURIComponent(phoneUrl)}`}
                alt="Scan to upload from phone"
                className="w-30 h-30 rounded bg-white p-1 shrink-0"
              />
              <div className="min-w-0 text-[10px] text-zinc-300 space-y-1">
                <div className="font-bold text-indigo-200">Scan with your phone</div>
                <div className="text-zinc-400">Open this QR on a phone on the same network, take a straight-on photo of your controller, and it’ll appear here to confirm.</div>
                <div className="font-mono text-[8px] text-zinc-600 break-all">{phoneUrl}</div>
                {phoneWaiting && <div className="text-[9px] text-amber-300 animate-pulse">◉ Waiting for the phone’s photo…</div>}
              </div>
            </div>
          )}

          {busy && <div className="text-[10px] font-mono text-indigo-300 animate-pulse">Analyzing image…</div>}
          {err && <div className="text-[10px] font-mono text-rose-300">{err}</div>}

          {/* Result preview + overlay + verify. The image preview shows for
              upload / by-name (we have the pixels); the phone path has no
              client-side image, so we skip straight to the verify counts. */}
          {result && (
            <div className="space-y-3">
              {previewUrl && (
                <div className="relative w-full rounded border border-white/10 overflow-hidden bg-black">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={previewUrl} alt="controller" className="w-full h-auto block" />
                  <svg className="absolute inset-0 w-full h-full" viewBox="0 0 100 100" preserveAspectRatio="none">
                    {result.controls.map((c, i) => (
                      <rect
                        key={i}
                        x={(c.cx - c.w / 2) * 100} y={(c.cy - c.h / 2) * 100}
                        width={c.w * 100} height={c.h * 100}
                        fill="none" stroke={KIND_COLOR[c.kind] ?? '#fff'} strokeWidth={0.4}
                        vectorEffect="non-scaling-stroke" rx={c.kind === 'knob' ? 50 : 0.5}
                      />
                    ))}
                  </svg>
                </div>
              )}
              {result.source === 'phone' && (
                <div className="text-[9px] font-mono text-emerald-300">Photo received from phone — verify the counts below.</div>
              )}
              {result.descriptionUrl && (
                <div className="text-[8px] font-mono text-zinc-600 truncate">
                  source: {result.imageTitle} · {result.source}
                </div>
              )}

              {/* Verify counts */}
              <div className="text-[9px] font-mono uppercase tracking-widest text-zinc-500">Verify control counts</div>
              <div className="grid grid-cols-3 gap-2">
                {(['knob', 'fader', 'pad'] as const).map((k) => (
                  <label key={k} className="flex flex-col gap-1">
                    <span className="text-[8px] font-mono uppercase" style={{ color: KIND_COLOR[k] }}>{k}s</span>
                    <input
                      type="number" min={0} value={counts[k]}
                      onChange={(e) => setCounts((c) => ({ ...c, [k]: Math.max(0, parseInt(e.target.value || '0', 10)) }))}
                      className="bg-black/40 border border-white/12 rounded px-2 py-1 text-[11px] font-mono text-zinc-100 outline-none focus:border-indigo-500/50"
                    />
                  </label>
                ))}
              </div>

              <div className="flex items-start gap-2 p-2 rounded border border-white/8 bg-white/3 text-[9px] text-zinc-400">
                <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0 text-zinc-500" />
                <span>CV is approximate — adjust the counts to match your device. This builds the <b>layout</b> only; run <b>Learn</b> or MIDI-map afterward so each control drives the right thing (a photo can’t read MIDI numbers).</span>
              </div>

              <div className="flex items-center justify-end gap-2">
                <span className="flex-1 text-[9px] font-mono text-zinc-500">{total} controls</span>
                <button onClick={onClose} className="px-3 py-1.5 rounded border border-white/12 text-[10px] font-bold uppercase tracking-wider text-zinc-400 hover:text-zinc-200">Cancel</button>
                <button
                  onClick={accept}
                  disabled={total === 0}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-emerald-500/50 bg-emerald-500/15 text-emerald-200 text-[10px] font-black uppercase tracking-wider disabled:opacity-40"
                >
                  <Check className="w-3.5 h-3.5" /> Build layout
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
