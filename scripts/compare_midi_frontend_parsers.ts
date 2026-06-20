/**
 * Compare the two current frontend MIDI parsers against the same on-disk corpus.
 *
 * This is read-only diagnostic code. It exists to avoid fragile shell one-liners
 * while investigating whether `frontend/src/utils/midi.ts` and
 * `frontend/src/lib/midi.ts` diverge on real library MIDI files.
 *
 * Usage from the repository root:
 *
 *   npm --prefix frontend exec tsx scripts/compare_midi_frontend_parsers.ts
 *   npm --prefix frontend exec tsx scripts/compare_midi_frontend_parsers.ts -- --json
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseMidi as parseUtilsMidi } from '../frontend/src/utils/midi';
import { parseMidi as parseLibMidi } from '../frontend/src/lib/midi';

interface ParserResult {
  ok: boolean;
  error?: string;
  tracks?: number;
  notes?: number;
  ppq?: number;
  bpm?: number;
}

interface FileComparison {
  path: string;
  bytes: number;
  utils: ParserResult;
  lib: ParserResult;
  diverged: boolean;
}

const DEFAULT_ROOTS = ['data', 'frontend', 'backend'];

function walkMidiFiles(root: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(root, entry);
    let st;
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walkMidiFiles(path, out);
      continue;
    }
    if (/\.midi?$/i.test(entry)) out.push(path);
  }
}

function tryParser(parse: (bytes: Uint8Array) => { ppq: number; bpm: number; tracks: Array<{ notes: unknown[] }> }, bytes: Uint8Array): ParserResult {
  try {
    const parsed = parse(bytes);
    return {
      ok: true,
      tracks: parsed.tracks.length,
      notes: parsed.tracks.reduce((sum, track) => sum + track.notes.length, 0),
      ppq: parsed.ppq,
      bpm: parsed.bpm,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function sameResult(a: ParserResult, b: ParserResult): boolean {
  if (a.ok !== b.ok) return false;
  if (!a.ok || !b.ok) return a.error === b.error;
  return a.tracks === b.tracks && a.notes === b.notes && a.ppq === b.ppq && Math.round(a.bpm ?? 0) === Math.round(b.bpm ?? 0);
}

function parseArgs(): { roots: string[]; json: boolean } {
  const args = process.argv.slice(2);
  const roots: string[] = [];
  let json = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--json') {
      json = true;
    } else if (arg === '--root' && args[i + 1]) {
      roots.push(args[i + 1]);
      i += 1;
    }
  }
  return { roots: roots.length ? roots : DEFAULT_ROOTS, json };
}

function main(): void {
  const { roots, json } = parseArgs();
  const files: string[] = [];
  for (const root of roots) walkMidiFiles(root, files);
  const uniqueFiles = Array.from(new Set(files.map((file) => resolve(file)))).sort((a, b) => a.localeCompare(b));

  const comparisons: FileComparison[] = uniqueFiles.map((path) => {
    const bytes = readFileSync(path);
    const arr = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const utils = tryParser(parseUtilsMidi, arr);
    const lib = tryParser(parseLibMidi, arr);
    return {
      path,
      bytes: bytes.byteLength,
      utils,
      lib,
      diverged: !sameResult(utils, lib),
    };
  });

  const utilsFailures = comparisons.filter((item) => !item.utils.ok);
  const libFailures = comparisons.filter((item) => !item.lib.ok);
  const divergences = comparisons.filter((item) => item.diverged);
  const report = {
    roots,
    scanned: comparisons.length,
    utilsFailures: utilsFailures.length,
    libFailures: libFailures.length,
    divergences: divergences.length,
    firstUtilsFailures: utilsFailures.slice(0, 20),
    firstLibFailures: libFailures.slice(0, 20),
    firstDivergences: divergences.slice(0, 20),
  };

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log('Frontend MIDI parser comparison');
  console.log(`Roots: ${roots.join(', ')}`);
  console.log(`MIDI files scanned: ${report.scanned}`);
  console.log(`utils/midi.ts failures: ${report.utilsFailures}`);
  console.log(`lib/midi.ts failures: ${report.libFailures}`);
  console.log(`Parser divergences: ${report.divergences}`);
  if (divergences.length) {
    console.log('\nFirst divergences:');
    for (const item of divergences.slice(0, 20)) {
      console.log(`- ${item.path}`);
      console.log(`  utils: ${item.utils.ok ? `${item.utils.tracks} tracks, ${item.utils.notes} notes` : item.utils.error}`);
      console.log(`  lib:   ${item.lib.ok ? `${item.lib.tracks} tracks, ${item.lib.notes} notes` : item.lib.error}`);
    }
  }
}

main();