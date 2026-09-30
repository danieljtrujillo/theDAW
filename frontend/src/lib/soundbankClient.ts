// Sound bank catalog client: the orchestral banks the download manager can
// fetch (or link to), each with its licence.
//
// API contract (backend, snake_case JSON, backend/modules/modeldl):
//   GET  /api/models/soundbanks                -> { banks: SoundbankEntry[] }
//   POST /api/models/soundbanks/{id}/download  -> { job_id, name, status }
//   GET  /api/models/soundbanks/{id}/manifest  -> the build manifest, with
//                                               playback_gain {"bank:program": dB}
// A started download is an ordinary job in GET /api/models/downloads with
// kind 'soundbank', so the DownloadDock shows its progress.

import type { ClassifiedDownloadError, DownloadJob } from './modelDownloadClient';
import { registerSoundbankGains, type SoundbankGainManifest } from './soundbankGain';

export interface SoundbankLicence {
  name: string;
  url: string;
  /** One line on what the licence lets the user do. */
  summary: string;
  spdx: string;
}

export interface SoundbankEntry {
  id: string;
  label: string;
  summary: string;
  format: 'sf3' | 'sf2' | 'sfz';
  licence: SoundbankLicence;
  homepage: string;
  credit: string;
  /** 'download': the app fetches it. 'link': SFZ, opened on its own page. */
  kind: 'download' | 'link';
  url: string | null;
  size_bytes: number | null;
  sha256: string | null;
  /** The soundfont pickers can load what this entry installs. */
  loadable: boolean;
  notes: string;
  tags: string[];
  /** Bank files an earlier download left on this machine. */
  installed: string[];
  installed_bytes: number;
  /** The live download job, if one is running. */
  job_id: string | null;
}

async function readDetail(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { detail?: unknown } | null;
    return typeof body?.detail === 'string' ? body.detail : null;
  } catch {
    return null;
  }
}

export async function fetchSoundbanks(): Promise<SoundbankEntry[]> {
  const res = await fetch('/api/models/soundbanks');
  if (!res.ok) throw new Error((await readDetail(res)) ?? `HTTP ${res.status}`);
  const data = (await res.json()) as { banks?: SoundbankEntry[] };
  return data.banks ?? [];
}

export async function startSoundbankDownload(id: string): Promise<void> {
  const res = await fetch(`/api/models/soundbanks/${encodeURIComponent(id)}/download`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  if (!res.ok) throw new Error((await readDetail(res)) ?? `HTTP ${res.status}`);
}

/**
 * Register an installed bank's playback gains (lib/soundbankGain) under the
 * bank registry's `bankId`, loaded at `bankOffset`. Returns how many preset
 * slots carry a gain; 0 when the bank has no manifest.
 */
export async function registerInstalledSoundbankGains(entryId: string, bankId: string, bankOffset = 0): Promise<number> {
  const manifest = await fetchInstalledSoundbankManifest(entryId);
  return manifest ? registerSoundbankGains(bankId, manifest, bankOffset) : 0;
}

/** The installed catalog bank's build manifest (its playback gains), or null when it has none. */
export async function fetchInstalledSoundbankManifest(entryId: string): Promise<SoundbankGainManifest | null> {
  const res = await fetch(`/api/models/soundbanks/${encodeURIComponent(entryId)}/manifest`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error((await readDetail(res)) ?? `HTTP ${res.status}`);
  return (await res.json()) as SoundbankGainManifest;
}

export type SoundbankState = 'link' | 'available' | 'downloading' | 'installed' | 'failed';

/** What a catalog row shows: the newest job for the bank wins over the list. */
export function soundbankState(entry: SoundbankEntry, jobs: readonly DownloadJob[]): SoundbankState {
  if (entry.kind === 'link') return 'link';
  const mine = jobs.filter((j) => j.kind === 'soundbank' && j.name === entry.id);
  const latest = mine[mine.length - 1];
  if (latest && (latest.status === 'queued' || latest.status === 'downloading')) return 'downloading';
  if (entry.job_id) return 'downloading';
  if (entry.installed.length > 0) return 'installed';
  if (latest?.status === 'done') return 'installed';
  if (latest?.status === 'error') return 'failed';
  return 'available';
}

/** Status word per state, shown after the status dot. */
export const SOUNDBANK_STATE_LABEL: Record<SoundbankState, string> = {
  link: 'External',
  available: 'Available',
  downloading: 'Downloading',
  installed: 'Installed',
  failed: 'Failed',
};

/** Size line for a row: what is on disk, else what the download weighs. */
export function soundbankSizeText(entry: SoundbankEntry, formatBytes: (n: number) => string): string {
  if (entry.installed_bytes > 0) return `${formatBytes(entry.installed_bytes)} on disk`;
  if (entry.size_bytes) return formatBytes(entry.size_bytes);
  return entry.kind === 'link' ? 'SFZ, on its own site' : 'size shown when published';
}

/**
 * A sound bank download failure, in words that fit it: these files come from
 * GitHub releases and the Internet Archive, never from Hugging Face, so the
 * model classifier's sign-in advice would send the user the wrong way.
 */
export function classifySoundbankError(detail: string, homepage?: string): ClassifiedDownloadError {
  const text = detail ?? '';
  const links = homepage ? [{ label: 'Open download page', url: homepage }] : undefined;
  if (/no published release|carries theDAW-Orchestra/i.test(text)) {
    return {
      kind: 'not_found',
      headline: 'Not published yet',
      fix: 'This bank has no published release yet. It is built by scripts/build_orchestra_sf3.py and attached to a release.',
      links,
    };
  }
  if (/sha-256|expected \d+/i.test(text)) {
    return {
      kind: 'unknown',
      headline: 'The download arrived damaged',
      fix: 'The file did not match its published checksum and was deleted. Retry the download.',
    };
  }
  if (/no space|enospc|errno 28|disk (is )?full|not enough space/i.test(text)) {
    return {
      kind: 'disk',
      headline: 'Not enough disk space',
      fix: "Free up room on the drive that holds theDAW's data folder, then retry.",
    };
  }
  if (/\b404\b|not found/i.test(text)) {
    return {
      kind: 'not_found',
      headline: 'The file has moved',
      fix: 'The download site no longer has the file at this address. Open its page to find it.',
      links,
    };
  }
  if (
    /timeout|timed out|connection|temporarily|unreachable|getaddrinfo|urlopen error|name (or service )?not known|failed to (establish|resolve)|\b5\d\d\b/i.test(
      text,
    )
  ) {
    return {
      kind: 'network',
      headline: "Can't reach the download site",
      fix: 'Check your internet connection (or VPN/proxy), then retry.',
      links,
    };
  }
  const firstLine = text.trim().split('\n')[0].slice(0, 160);
  return { kind: 'unknown', headline: 'Download failed', fix: firstLine || 'Unknown error. Retry the download.', links };
}
