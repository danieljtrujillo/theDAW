/**
 * loomScore — the LOOM score model, its text notation, and the two-way
 * conversion between them (docs/design/loom.md §4–5).
 *
 * The model is Jacquard's plane with one substitution: a Note tile is a SHARD
 * tile — a query into the Shard Index (or a pinned shard) plus a length in
 * steps. Lanes have their own step length and lane length (polyrhythm), stacks
 * are read top→bottom, gates stop the descent, locks colour what is read after
 * them, jumps redirect from the step after, the first non-target lane is the
 * master whose loop wrap is the sync boundary.
 *
 * The text IS the plane. A lane block is a header line followed by rows of
 * one token per step; the LAST row is the rail (where shards usually sit), the
 * rows above it are the upper stack, read top→bottom. So the picture and the
 * code are the same thing:
 *
 *   bpm 128
 *   key Am
 *   lane drums 1/16 x16
 *     .  .  ?50 .   .  .  ?50 .   | .  .  .  .   .  .  !2:4 .
 *     k  .  h   .   s  .  h   .   | k  .  h  k   s  .  h    ->fill
 *   lane fill 1/16 x4 @target
 *     k  k  k  k
 *
 * Tokens: `.`/`~` empty · `-` tie (rail) · `k s h c t d` drum roles ·
 * `b v g p o m` bass/vocals/guitar/piano/other/mix · `<song:role>` pin a song,
 * `<song:role#12>` pin its bar 12, `<#shardId>` pin a shard ·
 * `{role=drums energy>0.7 entry!=eacc text=love}` query literal ·
 * suffixes `:N` length in steps, `^` re-roll every lap, `^N` every N laps ·
 * `?60` chance gate · `!2:4` cycle gate (lap 2 of 4; `!1,3:4`) ·
 * `=gain-6,cut.35` absolute lock · `+trans12` relative lock · `->name` jump.
 * `;` starts a comment.
 */

export type LoomRole =
  | 'drums' | 'kick' | 'snare' | 'hihat' | 'cymbals' | 'toms'
  | 'bass' | 'vocals' | 'guitar' | 'piano' | 'other' | 'mix';

export const LOOM_ROLES: readonly LoomRole[] = [
  'drums', 'kick', 'snare', 'hihat', 'cymbals', 'toms', 'bass', 'vocals', 'guitar', 'piano', 'other', 'mix',
];

export const ROLE_LETTER: Record<string, LoomRole> = {
  k: 'kick', s: 'snare', h: 'hihat', c: 'cymbals', t: 'toms', d: 'drums',
  b: 'bass', v: 'vocals', g: 'guitar', p: 'piano', o: 'other', m: 'mix',
};
const LETTER_FOR_ROLE: Record<LoomRole, string> = {
  kick: 'k', snare: 's', hihat: 'h', cymbals: 'c', toms: 't', drums: 'd',
  bass: 'b', vocals: 'v', guitar: 'g', piano: 'p', other: 'o', mix: 'm',
};

export const LOCK_PARAMS = [
  'gain', 'pan', 'transpose', 'stretch', 'bleed', 'cutoff', 'resonance', 'drive',
  'crush', 'delay', 'reverb', 'gate', 'attack', 'release', 'roll',
] as const;
export type LockParam = typeof LOCK_PARAMS[number];

/** Lock params the v1 engine applies live. The rest parse and serialize but
 *  are surfaced as "not yet live" so the score stays honest. */
export const LIVE_LOCK_PARAMS: ReadonlySet<LockParam> = new Set<LockParam>([
  'gain', 'pan', 'transpose', 'bleed', 'cutoff', 'resonance', 'gate', 'attack', 'release', 'roll',
]);

const LOCK_ALIASES: Record<string, LockParam> = {
  g: 'gain', gain: 'gain', vol: 'gain',
  pan: 'pan',
  tr: 'transpose', trans: 'transpose', transpose: 'transpose',
  st: 'stretch', stretch: 'stretch',
  bl: 'bleed', bleed: 'bleed',
  cut: 'cutoff', cutoff: 'cutoff', lp: 'cutoff',
  res: 'resonance', reso: 'resonance', resonance: 'resonance', q: 'resonance',
  drive: 'drive', crush: 'crush',
  dly: 'delay', delay: 'delay', rev: 'reverb', reverb: 'reverb',
  gate: 'gate', att: 'attack', attack: 'attack', rel: 'release', release: 'release',
  roll: 'roll',
};
const LOCK_SHORT: Record<LockParam, string> = {
  gain: 'gain', pan: 'pan', transpose: 'trans', stretch: 'stretch', bleed: 'bleed', cutoff: 'cut',
  resonance: 'res', drive: 'drive', crush: 'crush', delay: 'dly', reverb: 'rev', gate: 'gate',
  attack: 'att', release: 'rel', roll: 'roll',
};

export interface LoomQuery {
  role?: LoomRole;
  /** Library entry id, or a case-insensitive title fragment. */
  entry?: string;
  excludeEntry?: string;
  energyMin?: number;
  energyMax?: number;
  section?: string;
  beats?: number;
  text?: string;
  /** Pin one bar of the pinned song. */
  bar?: number;
  /** Pin one exact shard. */
  shardId?: string;
}

export type LoomTile =
  | { kind: 'shard'; query: LoomQuery; steps: number; roll: number }
  | { kind: 'chance'; pct: number }
  | { kind: 'cycle'; period: number; laps: number[] }
  | { kind: 'lock'; mode: 'abs' | 'rel'; params: Partial<Record<LockParam, number>> }
  | { kind: 'jump'; target: string };

export interface LoomLane {
  name: string;
  /** Steps per whole note: 16 = sixteenths. */
  div: number;
  length: number;
  isTarget: boolean;
  play: boolean;
  /** rows[r][step]; rows[rows.length - 1] is the rail. */
  rows: (LoomTile | null)[][];
}

export interface LoomScore {
  bpm?: number;
  /** 'follow' = the beat clock's source key; else a tonic like 'A'. */
  key?: string;
  scale?: 'major' | 'minor';
  lanes: LoomLane[];
}

export interface LoomParseError { line: number; message: string }

export const DEFAULT_DIV = 16;
export const DEFAULT_LENGTH = 16;

/* ── parsing ──────────────────────────────────────────────────────────────── */

const stripComment = (s: string) => {
  const i = s.indexOf(';');
  return i >= 0 ? s.slice(0, i) : s;
};

function parseKey(s: string): { key?: string; scale?: 'major' | 'minor' } | null {
  const t = s.trim();
  if (!t) return null;
  if (/^follow$/i.test(t)) return { key: 'follow' };
  const m = /^([A-Ga-g])([#b♯♭]?)\s*(m|min|minor|maj|major|M)?$/.exec(t);
  if (!m) return null;
  const acc = m[2] === '♯' ? '#' : m[2] === '♭' ? 'b' : m[2];
  const scale: 'major' | 'minor' = m[3] && /^(m|min|minor)$/.test(m[3]) ? 'minor' : 'major';
  return { key: m[1].toUpperCase() + acc, scale };
}

function parseDiv(tok: string): number | null {
  const m = /^1\/(1|2|4|8|16|32|64)$/.exec(tok);
  return m ? Number(m[1]) : null;
}

function parseLockParams(body: string, line: number, errors: LoomParseError[]): Partial<Record<LockParam, number>> {
  const out: Partial<Record<LockParam, number>> = {};
  for (const part of body.split(',')) {
    const m = /^([a-zA-Z]+)\s*([-+]?(?:\d+\.?\d*|\.\d+))$/.exec(part.trim());
    if (!m) { if (part.trim()) errors.push({ line, message: `lock: cannot read "${part}"` }); continue; }
    const key = LOCK_ALIASES[m[1].toLowerCase()];
    if (!key) { errors.push({ line, message: `lock: unknown param "${m[1]}"` }); continue; }
    out[key] = Number(m[2]);
  }
  return out;
}

/** Split a query literal's body on whitespace/commas, keeping "quoted values"
 *  (song titles have spaces) together; quotes are stripped from the value. */
function splitQueryParts(body: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (const ch of body) {
    if (quote) {
      if (ch === quote) quote = null; else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (/[\s,]/.test(ch)) { if (cur) parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur) parts.push(cur);
  return parts;
}

function parseQueryLiteral(body: string, line: number, errors: LoomParseError[]): LoomQuery {
  const q: LoomQuery = {};
  for (const raw of splitQueryParts(body)) {
    const part = raw.trim();
    if (!part) continue;
    const m = /^([a-zA-Z_]+)\s*(!=|>=|<=|=|>|<)\s*(.+)$/.exec(part);
    if (!m) { errors.push({ line, message: `query: cannot read "${part}"` }); continue; }
    const [, k, op, v] = m;
    const key = k.toLowerCase();
    if (key === 'role') {
      const role = (ROLE_LETTER[v] ?? v) as LoomRole;
      if (!LOOM_ROLES.includes(role)) errors.push({ line, message: `query: unknown role "${v}"` });
      else q.role = role;
    } else if (key === 'entry' || key === 'song') {
      if (op === '!=') q.excludeEntry = v; else q.entry = v;
    } else if (key === 'energy' || key === 'e') {
      const n = Number(v);
      if (!Number.isFinite(n)) errors.push({ line, message: `query: energy needs a number` });
      else if (op === '>' || op === '>=') q.energyMin = n;
      else if (op === '<' || op === '<=') q.energyMax = n;
      else { q.energyMin = n - 0.1; q.energyMax = n + 0.1; }
    } else if (key === 'section') q.section = v;
    else if (key === 'beats') q.beats = Number(v) || undefined;
    else if (key === 'text' || key === 'word' || key === 'chord') q.text = v;
    else if (key === 'bar') q.bar = Number(v);
    else if (key === 'id') q.shardId = v;
    else errors.push({ line, message: `query: unknown field "${k}"` });
  }
  return q;
}

/** A single step token → a tile, `'tie'`, or null (empty). */
function parseToken(tok: string, line: number, errors: LoomParseError[]): LoomTile | 'tie' | null {
  if (tok === '.' || tok === '~') return null;
  if (tok === '-') return 'tie';
  if (tok.startsWith('?')) {
    const pct = Number(tok.slice(1));
    if (!Number.isFinite(pct)) { errors.push({ line, message: `chance gate needs a percentage: "${tok}"` }); return null; }
    return { kind: 'chance', pct: Math.max(0, Math.min(100, pct)) };
  }
  if (tok.startsWith('!')) {
    const m = /^!(\d+(?:,\d+)*):(\d+)$/.exec(tok);
    if (!m) { errors.push({ line, message: `cycle gate is !laps:period, e.g. !2:4 — got "${tok}"` }); return null; }
    const period = Math.max(2, Math.min(32, Number(m[2])));
    const laps = m[1].split(',').map(Number).filter((n) => n >= 1 && n <= period);
    return { kind: 'cycle', period, laps };
  }
  if (tok.startsWith('=') || tok.startsWith('+')) {
    return { kind: 'lock', mode: tok[0] === '=' ? 'abs' : 'rel', params: parseLockParams(tok.slice(1), line, errors) };
  }
  if (tok.startsWith('->')) {
    const target = tok.slice(2).trim();
    if (!target) { errors.push({ line, message: 'jump needs a lane name: ->name' }); return null; }
    return { kind: 'jump', target };
  }
  // Shard tile: body + optional suffixes  :N  ^  ^N
  let body = tok;
  let steps = 1;
  let roll = 0;
  const sfx = /^(.*?)(?::(\d+))?(?:\^(\d*))?$/.exec(tok);
  if (sfx) {
    body = sfx[1];
    if (sfx[2]) steps = Math.max(1, Number(sfx[2]));
    if (sfx[3] !== undefined) roll = sfx[3] === '' ? 1 : Math.max(1, Number(sfx[3]));
  }
  let query: LoomQuery | null = null;
  if (body.startsWith('<') && body.endsWith('>')) {
    const inner = body.slice(1, -1);
    if (inner.startsWith('#')) query = { shardId: inner.slice(1) };
    else {
      const m = /^([^:#]+)(?::([a-zA-Z]+))?(?:#(\d+))?$/.exec(inner);
      if (!m) { errors.push({ line, message: `pin is <song:role#bar> — got "${tok}"` }); return null; }
      query = { entry: m[1] };
      if (m[2]) {
        const role = (ROLE_LETTER[m[2]] ?? m[2]) as LoomRole;
        if (!LOOM_ROLES.includes(role)) { errors.push({ line, message: `unknown role "${m[2]}"` }); return null; }
        query.role = role;
      }
      if (m[3]) query.bar = Number(m[3]);
    }
  } else if (body.startsWith('{') && body.endsWith('}')) {
    query = parseQueryLiteral(body.slice(1, -1), line, errors);
  } else {
    const role = (ROLE_LETTER[body] ?? body) as LoomRole;
    if (!LOOM_ROLES.includes(role)) { errors.push({ line, message: `unknown token "${tok}"` }); return null; }
    query = { role };
  }
  return { kind: 'shard', query, steps, roll };
}

/** Split a row into tokens; `|` is decoration. Braces/angle groups may
 *  contain spaces, so they are gathered before splitting. */
function tokenizeRow(row: string): string[] {
  const out: string[] = [];
  let cur = '';
  let braces = 0; // { … } query literal — may contain '>' and '<' comparators
  let angles = 0; // < … > pin
  for (const ch of row) {
    if (ch === '{') braces += 1;
    else if (ch === '}') braces = Math.max(0, braces - 1);
    else if (ch === '<' && braces === 0) angles += 1;
    else if (ch === '>' && braces === 0 && angles > 0) angles -= 1;
    if (/\s/.test(ch) && braces === 0 && angles === 0) {
      if (cur) out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out.filter((t) => t !== '|');
}

export function parseLoom(text: string): { score: LoomScore; errors: LoomParseError[] } {
  const errors: LoomParseError[] = [];
  const score: LoomScore = { lanes: [] };
  let lane: LoomLane | null = null;
  let pendingRows: { line: number; tokens: string[] }[] = [];

  const flushLane = () => {
    if (!lane) return;
    const rows: (LoomTile | null)[][] = [];
    for (let r = 0; r < pendingRows.length; r += 1) {
      const { line, tokens } = pendingRows[r];
      const isRail = r === pendingRows.length - 1;
      const row: (LoomTile | null)[] = new Array(lane.length).fill(null);
      if (tokens.length > lane.length) errors.push({ line, message: `row has ${tokens.length} steps, lane is x${lane.length}` });
      let lastShard: { kind: 'shard'; query: LoomQuery; steps: number; roll: number } | null = null;
      for (let s = 0; s < Math.min(tokens.length, lane.length); s += 1) {
        const t = parseToken(tokens[s], line, errors);
        if (t === 'tie') {
          if (!isRail) errors.push({ line, message: 'a tie (-) only extends a shard on the rail row' });
          else if (lastShard) lastShard.steps += 1;
          else errors.push({ line, message: 'a tie (-) needs a shard before it' });
          continue;
        }
        row[s] = t;
        if (t && t.kind === 'shard') lastShard = t; else if (t) lastShard = null;
      }
      rows.push(row);
    }
    if (rows.length === 0) rows.push(new Array(lane.length).fill(null));
    lane.rows = rows;
    score.lanes.push(lane);
    lane = null;
    pendingRows = [];
  };

  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const lineNo = i + 1;
    const raw = stripComment(lines[i]);
    if (!raw.trim()) continue;
    const indented = /^\s/.test(raw);
    const s = raw.trim();
    if (indented && lane) {
      pendingRows.push({ line: lineNo, tokens: tokenizeRow(s) });
      continue;
    }
    if (indented && !lane) { errors.push({ line: lineNo, message: 'a row needs a lane above it' }); continue; }
    const [head, ...rest] = s.split(/\s+/);
    const h = head.toLowerCase();
    if (h === 'bpm') {
      flushLane();
      const b = Number(rest[0]);
      if (!Number.isFinite(b) || b < 20 || b > 300) errors.push({ line: lineNo, message: 'bpm is 20–300' });
      else score.bpm = b;
    } else if (h === 'key') {
      flushLane();
      const k = parseKey(rest.join(' '));
      if (!k) errors.push({ line: lineNo, message: `key looks like "Am", "F#", "Bb major", or "follow"` });
      else { score.key = k.key; score.scale = k.scale; }
    } else if (h === 'lane') {
      flushLane();
      const name = rest[0];
      if (!name || /[^a-zA-Z0-9_\-.]/.test(name)) { errors.push({ line: lineNo, message: 'lane needs a name (letters, digits, _ -)' }); continue; }
      const l: LoomLane = { name, div: DEFAULT_DIV, length: DEFAULT_LENGTH, isTarget: false, play: true, rows: [] };
      for (const tok of rest.slice(1)) {
        const div = parseDiv(tok);
        if (div) { l.div = div; continue; }
        const xm = /^x(\d+)$/i.exec(tok);
        if (xm) { l.length = Math.max(1, Math.min(256, Number(xm[1]))); continue; }
        if (tok === '@target') { l.isTarget = true; continue; }
        if (tok === 'off') { l.play = false; continue; }
        errors.push({ line: lineNo, message: `lane: unknown option "${tok}"` });
      }
      if (score.lanes.some((x) => x.name === name)) errors.push({ line: lineNo, message: `lane "${name}" is defined twice` });
      lane = l;
    } else {
      errors.push({ line: lineNo, message: `unknown directive "${head}" (bpm, key, lane)` });
    }
  }
  flushLane();

  // Jump targets must exist.
  const names = new Set(score.lanes.map((l) => l.name));
  score.lanes.forEach((l) => {
    l.rows.forEach((row) => row.forEach((t) => {
      if (t && t.kind === 'jump' && !names.has(t.target)) errors.push({ line: 0, message: `lane "${l.name}" jumps to "${t.target}", which does not exist` });
    }));
  });
  if (score.lanes.length > 0 && !score.lanes.some((l) => !l.isTarget)) {
    errors.push({ line: 0, message: 'every lane is a @target — nothing would ever play' });
  }
  return { score, errors };
}

/* ── serializing ──────────────────────────────────────────────────────────── */

const num = (n: number) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000).replace(/^0\./, '.').replace(/^-0\./, '-.'));

export function serializeQuery(q: LoomQuery): string {
  if (q.shardId) return `<#${q.shardId}>`;
  const simple = q.role && !q.entry && !q.excludeEntry && q.energyMin == null && q.energyMax == null && !q.section && !q.beats && !q.text && q.bar == null;
  if (simple && q.role) return LETTER_FOR_ROLE[q.role];
  if (q.entry && q.excludeEntry == null && q.energyMin == null && q.energyMax == null && !q.section && !q.beats && !q.text) {
    return `<${q.entry}${q.role ? `:${q.role}` : ''}${q.bar != null ? `#${q.bar}` : ''}>`;
  }
  const quoted = (v: string) => (/[\s,]/.test(v) ? `"${v}"` : v);
  const parts: string[] = [];
  if (q.role) parts.push(`role=${q.role}`);
  if (q.entry) parts.push(`entry=${quoted(q.entry)}`);
  if (q.excludeEntry) parts.push(`entry!=${quoted(q.excludeEntry)}`);
  if (q.energyMin != null) parts.push(`energy>${num(q.energyMin)}`);
  if (q.energyMax != null) parts.push(`energy<${num(q.energyMax)}`);
  if (q.section) parts.push(`section=${q.section}`);
  if (q.beats) parts.push(`beats=${q.beats}`);
  if (q.text) parts.push(`text=${quoted(q.text)}`);
  if (q.bar != null) parts.push(`bar=${q.bar}`);
  return `{${parts.join(' ')}}`;
}

/** One tile as a token. `withSteps` writes a shard's length as `:N`; the row
 *  serializer omits it on the rail when ties (`-`) can carry the length. */
export function serializeTile(t: LoomTile | null, withSteps = true): string {
  if (!t) return '.';
  switch (t.kind) {
    case 'shard': {
      let s = serializeQuery(t.query);
      if (withSteps && t.steps > 1) s += `:${t.steps}`;
      if (t.roll === 1) s += '^'; else if (t.roll > 1) s += `^${t.roll}`;
      return s;
    }
    case 'chance': return `?${num(t.pct)}`;
    case 'cycle': return `!${t.laps.join(',')}:${t.period}`;
    case 'lock': return (t.mode === 'abs' ? '=' : '+') + Object.entries(t.params).map(([k, v]) => `${LOCK_SHORT[k as LockParam]}${num(v as number)}`).join(',');
    case 'jump': return `->${t.target}`;
  }
}

export function serializeLoom(score: LoomScore): string {
  const out: string[] = [];
  if (score.bpm) out.push(`bpm ${num(score.bpm)}`);
  if (score.key) out.push(`key ${score.key === 'follow' ? 'follow' : score.key + (score.scale === 'minor' ? 'm' : '')}`);
  for (const lane of score.lanes) {
    if (out.length) out.push('');
    const opts = [`1/${lane.div}`, `x${lane.length}`];
    if (lane.isTarget) opts.push('@target');
    if (!lane.play) opts.push('off');
    out.push(`lane ${lane.name} ${opts.join(' ')}`);
    // Rail ties: a shard of N steps prints as the token followed by N-1 '-'
    // when the ties fit before the lane end and the cells are free; otherwise
    // (upper rows, or a shard running past the end) the length rides as `:N`.
    const rows = lane.rows.length ? lane.rows : [new Array(lane.length).fill(null)];
    const cells: string[][] = rows.map((row, r) => {
      const isRail = r === rows.length - 1;
      const toks: string[] = new Array(lane.length).fill('.');
      for (let s = 0; s < lane.length; s += 1) {
        const t = row[s];
        if (!t) continue;
        if (t.kind === 'shard' && t.steps > 1) {
          const fits = isRail && s + t.steps <= lane.length && row.slice(s + 1, s + t.steps).every((x) => !x);
          toks[s] = serializeTile(t, !fits);
          if (fits) for (let k = 1; k < t.steps; k += 1) toks[s + k] = '-';
        } else {
          toks[s] = serializeTile(t);
        }
      }
      return toks;
    });
    const width = Math.max(1, ...cells.flat().map((c) => c.length));
    const barEvery = lane.length > lane.div ? lane.div : 0;
    for (const toks of cells) {
      const line = toks.map((c, i) => c.padEnd(width) + (barEvery && i > 0 && (i + 1) % barEvery === 0 && i < lane.length - 1 ? ' |' : '')).join(' ').trimEnd();
      out.push(`  ${line}`);
    }
  }
  return out.join('\n') + '\n';
}

/** A fresh two-lane score that plays something the moment a song is on the index. */
export const STARTER_SCORE = `; LOOM — a Jacquard for your own catalogue.
; Rows are the plane: the last row of a lane is the rail, rows above are the stack.
; Gates (?60, !2:4) stop what is below them; locks (=gain-6) colour what follows.
bpm 120
key follow

lane drums 1/16 x16
  .   .   .   .   .   .   ?50 .   | .   .   .   .   .   .   !2:4 .
  k   .   h   .   s   .   h   .   | k   .   h   k   s   .   h    .

lane bass 1/8 x8
  b:2 -   .   b   .   b:2 -   .

lane vox 1/4 x4
  .    =gain-3  .    ?40
  v:2  -        .    v^
`;
