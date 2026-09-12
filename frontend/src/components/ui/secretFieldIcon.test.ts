/**
 * "Always a key icon" — the rule, enforced on the source.
 *
 * Wherever a key, token or password is typed in theDAW, the thing that says so
 * wears lucide's KeyRound. That held right up until three assistant orbs
 * shipped a Chat|Keys drawer with no icons at all and two Settings fields whose
 * only label was `sr-only`, so this test stops trusting anyone to remember it.
 *
 * It works in two directions:
 *   1. DISCOVERY — anything under src/ that looks like a secret field (a
 *      password-typed input, or a placeholder that says "paste … key/token")
 *      must render KeyRound, directly or through <SecretFieldLabel>. A NEW key
 *      surface added without the glyph fails here without being registered
 *      anywhere first, which is the whole point.
 *   2. THE KNOWN LIST — the surfaces mapped today must still be discovered and
 *      still carry the glyph, so the detector above cannot quietly stop
 *      matching (a reworded placeholder, a field that stops being type=password)
 *      and take the coverage with it.
 *
 * It also holds the two lines this rule keeps getting confused with:
 *   - Eye / EyeOff is the REVEAL toggle, a different affordance. Any field that
 *     flips between password and text must still have it; it must never become
 *     a key.
 *   - KeyRound also means MUSICAL key in this repo (DJView's key-lock / master
 *     tempo). That file is not a secret surface and must not be dragged in.
 *
 * Run with:  npx tsx src/components/ui/secretFieldIcon.test.ts
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKIP_DIRS = new Set(['node_modules', 'dist', '.vite']);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...walk(join(dir, entry.name)));
    } else if (entry.name.endsWith('.tsx')) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

const rel = (file: string) => relative(SRC, file).replace(/\\/g, '/');

/** `type="password"`, or the usual `type={show ? 'text' : 'password'}` toggle. */
const PASSWORD_INPUT = /type=\s*(?:["']password["']|\{[^}]*["']password["'][^}]*\})/;
/** A placeholder that asks for the secret in words: "Paste API key…", "paste your token here". */
const PASTE_A_SECRET = /placeholder[^\n]{0,120}?paste[^\n]{0,60}?(?:key|token)/i;
/** The glyph itself, or the shared label component that always renders it. */
const HAS_KEY_ICON = /\bKeyRound\b|\bSecretFieldLabel\b/;
/** A field that can be un-masked — it needs the reveal toggle, not a key. */
const REVEAL_TOGGLE = /\?\s*["']text["']\s*:\s*["']password["']/;

/**
 * Every secret surface mapped today. Deleting one of these files, or renaming
 * it, is fine — updating this list is part of that change. Silently dropping
 * the icon from one is not.
 */
const KNOWN_SURFACES = [
  'components/ui/HfTokenField.tsx',
  'components/layout/settings/ProviderCards.tsx',
  'orb-kit/AssistantPanel.tsx',
  'orb-kit/chat/OrbChatPanel.tsx',
  'views/TourView.tsx',
  'views/underfit/UnderfitAssistantOrb.tsx',
];

const files = walk(SRC);
assert.ok(files.length > 100, 'the walk should see the whole app, not a corner of it');

const sources = new Map(files.map((f) => [rel(f), readFileSync(f, 'utf8')]));

/* ── 1. discovery: anything that looks like a secret field wears the key ──── */
const detected: string[] = [];
for (const [name, src] of sources) {
  if (name.endsWith('.test.tsx')) continue;
  if (PASSWORD_INPUT.test(src) || PASTE_A_SECRET.test(src)) detected.push(name);
}
assert.ok(detected.length >= KNOWN_SURFACES.length, 'the detector found fewer surfaces than exist');

for (const name of detected) {
  assert.ok(
    HAS_KEY_ICON.test(sources.get(name)!),
    `${name} takes a key/token/password but renders no key icon.\n` +
      '  Every secret-entry affordance carries lucide KeyRound — the field label, the\n' +
      '  button that opens it, the tab that holds it. Use <SecretFieldLabel> from\n' +
      '  components/ui/SecretFieldLabel.tsx, which brings the glyph and the htmlFor.',
  );
}

/* ── 2. the known surfaces stay discovered, labelled, and iconed ──────────── */
for (const name of KNOWN_SURFACES) {
  const src = sources.get(name);
  assert.ok(src, `${name} is gone — update KNOWN_SURFACES if the surface moved`);
  assert.ok(detected.includes(name), `${name} is no longer detected as a secret surface — the detector above has rotted`);
  assert.ok(HAS_KEY_ICON.test(src), `${name} lost its key icon`);
  // HARD RULE 3: a secret input is associated with a real label, not just a `name`.
  assert.match(src, /htmlFor/, `${name} has a secret field with no <label htmlFor> anywhere`);
}

/* ── 3. reveal stays Eye/EyeOff, never a key ─────────────────────────────── */
for (const name of detected) {
  const src = sources.get(name)!;
  if (!REVEAL_TOGGLE.test(src)) continue;
  assert.match(
    src,
    /\bEyeOff\b/,
    `${name} can un-mask a secret but has no Eye/EyeOff toggle — the reveal affordance is Eye, not a key`,
  );
}

/* ── 4. one key icon, and the musical one is not it ──────────────────────── */
for (const [name, src] of sources) {
  for (const block of src.matchAll(/import\s*\{([\s\S]*?)\}\s*from\s*['"]lucide-react['"]/g)) {
    const named = block[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0].trim());
    assert.ok(
      !named.includes('Key'),
      `${name} imports lucide's bare \`Key\`. KeyRound is this app's key icon — one convention, not two.`,
    );
  }
}
assert.ok(
  !detected.includes('views/DJView.tsx'),
  'DJView was detected as a secret surface. Its KeyRound is MUSICAL key-lock (master tempo) — ' +
    'if the detector now matches it, narrow the detector rather than re-skinning the deck.',
);

console.log(`secret-field key icon: ${detected.length} surfaces checked, all wearing KeyRound`);
console.log(`  ${detected.join('\n  ')}`);
