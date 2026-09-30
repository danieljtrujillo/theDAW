/**
 * Persisted stores keep working when localStorage is blocked.
 *
 * With zustand's default storage, a browser that throws on `localStorage`
 * access (private windows, blocked site data) left `persist` with no storage:
 * every `setState` printed "[zustand persist middleware] Unable to update
 * item ..., the given storage is currently unavailable" and the setting was
 * dropped. The shared backend in persistStorage.ts falls back to memory and
 * says so once in the LOG.
 *
 * The sequence replayed: storage blocked when the stores are created, the
 * user changes settings, storage becomes available, a later write hits a full
 * storage.
 *
 * Run: npx tsx src/state/persistStorage.test.ts
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Blocked site data: reading `localStorage` throws, exactly as a browser does.
class SecurityError extends Error {
  override name = 'SecurityError';
}
let current: Storage | null = null;
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  get() {
    if (!current) throw new SecurityError("Failed to read the 'localStorage' property from 'Window': Access is denied");
    return current;
  },
});

const warnings: string[] = [];
const realWarn = console.warn;
console.warn = (...args: unknown[]) => {
  warnings.push(args.map(String).join(' '));
};

const { useLogStore } = await import('./logStore.ts');
const { persistBackend, reportingPersistBackend, MEMORY_FALLBACK_LOG } = await import('./persistStorage.ts');
const { useMidiIgnoreStore } = await import('./midiIgnoreStore.ts');
const { usePromptLibraryStore } = await import('./promptLibraryStore.ts');

const storageLogLines = () =>
  useLogStore.getState().entries.filter((e) => e.source === 'storage' && e.msg.startsWith(MEMORY_FALLBACK_LOG));

/* ── blocked: settings still change, no persist warning, one LOG line ────── */
{
  useMidiIgnoreStore.getState().ignoreControl({ kind: 'cc', number: 20, channel: 0 });
  useMidiIgnoreStore.getState().ignoreChannel('note', 3);
  usePromptLibraryStore.setState({});
  assert.equal(useMidiIgnoreStore.getState().controls.length, 2, 'the setting is live while storage is blocked');
  assert.deepEqual(
    warnings.filter((w) => w.includes('zustand persist')),
    [],
    'no "storage is currently unavailable" warning from any write',
  );
  const lines = storageLogLines();
  assert.equal(lines.length, 1, 'the fallback is announced once, however many stores and writes');
  assert.equal(lines[0].level, 'warn');
  assert.match(lines[0].msg, /SecurityError/, 'the LOG line carries the browser reason');
  const held = persistBackend.getItem('thedaw.midiIgnore.v1');
  assert.ok(held, 'the value is kept in memory for the session');
  assert.equal(JSON.parse(held!).state.controls.length, 2);
}

/* ── storage becomes available: writes land in it, memory copy dropped ──── */
function mapStorage(opts: { full?: boolean } = {}): Storage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (opts.full) {
        const err = new Error('The quota has been exceeded.');
        err.name = 'QuotaExceededError';
        throw err;
      }
      data.set(k, String(v));
    },
    removeItem: (k: string) => {
      data.delete(k);
    },
    clear: () => data.clear(),
    key: (i: number) => Array.from(data.keys())[i] ?? null,
    get length() {
      return data.size;
    },
  };
}
{
  const real = mapStorage();
  current = real;
  useMidiIgnoreStore.getState().clearIgnoredControls();
  const stored = real.data.get('thedaw.midiIgnore.v1');
  assert.ok(stored, 'the write goes to localStorage once it is readable');
  assert.equal(JSON.parse(stored!).state.controls.length, 0);
  assert.equal(persistBackend.getItem('thedaw.midiIgnore.v1'), stored, 'reads come from localStorage again');
}

/* ── a full storage: the newer value stays readable from memory ─────────── */
{
  const full = mapStorage({ full: true });
  full.data.set('thedaw.midiIgnore.v1', '{"state":{"controls":[]},"version":0}');
  current = full;
  useMidiIgnoreStore.getState().ignoreControl({ kind: 'note', number: 60, channel: 1 });
  const read = persistBackend.getItem('thedaw.midiIgnore.v1');
  assert.equal(JSON.parse(read!).state.controls.length, 1, 'the value the full storage refused is the one read back');
  assert.equal(storageLogLines().length, 1, 'still one LOG line for the session');
  // The reporting variant (the MIX effect chain) throws the refusal so the
  // store can report that save, and still keeps the value.
  assert.throws(() => reportingPersistBackend.setItem('thedaw.probe', 'KEPT'), { name: 'QuotaExceededError' });
  assert.equal(reportingPersistBackend.getItem('thedaw.probe'), 'KEPT');
  assert.deepEqual(warnings.filter((w) => w.includes('zustand persist')), []);
}

console.warn = realWarn;

/* ── guard: every persisted store in src/ uses the shared storage ─────────── */
{
  const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..');
  const missing: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue;
      const text = readFileSync(full, 'utf8');
      if (!/import \{[^}]*\bpersist\b[^}]*\} from 'zustand\/middleware'/.test(text)) continue;
      if (!/persistStorage\(\)|persistBackend/.test(text)) missing.push(relative(srcDir, full));
    }
  };
  walk(srcDir);
  assert.deepEqual(missing, [], `persisted stores without the shared storage: ${missing.join(', ')}`);
}

console.log('persistStorage: all assertions passed');
