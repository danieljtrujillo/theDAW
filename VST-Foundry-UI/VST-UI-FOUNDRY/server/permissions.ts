// Permission policy for the Claude Code provider — the single decision point for
// the CLI's `can_use_tool` control requests.
//
// Ported from theDAW's `backend/modules/assistant/permissions.py`: same four
// modes, same rule ORDER, same verdicts. Pure logic — no filesystem access, no
// network, no express. The only thing adapted for this app is which paths count
// as "the assistant's own surface" (the Foundry's orb + bridge, not theDAW's).
//
// Requests arrive as `{ tool_name, input, tool_use_id, ... }`. This module
// answers: what kind of tool is it (`classify`), does it touch the assistant's
// own surface (`selfModifyPath`), and given the mode + session state,
// allow / deny / ask (`decide`).
//
// KNOWN LIMITATION (G5 round 5 item 2): the no-filesystem invariant above
// means this module compares path STRINGS, never the files those strings
// actually name on disk. A junction or symlink created inside the repo (e.g.
// `C:\tmp\x` junctioned to `server`) points a path that reads as completely
// unrelated -- `C:\tmp\x\routes.ts` -- at the real self-surface file, and no
// candidate here will ever match a self-surface glob for it. In `trusted`
// mode a `Bash` command creating such a junction is itself allowed (no
// candidate matches a self-surface glob), after which a `Write`/`Edit`
// through the junction reads as an ordinary, unrelated path and resolves to
// `allow`. Closing this needs resolving each candidate's nearest existing
// ancestor against the filesystem (`fs.realpathSync.native`) before the
// prefix compare -- deliberately NOT done here, because it would make every
// `can_use_tool` decision perform synchronous disk I/O (stat calls up each
// ancestor) on the hot control-request path, introduce TOCTOU races between
// the check and the actual write, and break the "pure string work" contract
// every other rule in this module (including its extensive test suite)
// currently relies on. Documenting the limitation, not silently resolving
// it, is the deliberate trade-off.

export type PermissionMode = "ask" | "accept_edits" | "readonly" | "trusted";
export type ToolKind = "read" | "edit" | "shell" | "agent" | "mcp" | "other";
export type PermissionAction = "allow" | "deny" | "ask";

export const PERMISSION_MODES: readonly PermissionMode[] = [
  "ask",
  "accept_edits",
  "readonly",
  "trusted",
];

// The Foundry orb has always run with prompts effectively off (the CLI spawn
// carried --dangerously-skip-permissions until this policy layer went live),
// and nobody asked to change that day-to-day experience — only to make the
// enforcement real. So the Foundry's OWN default is "trusted": every read,
// edit, command and sub-agent auto-allows, and only a self-modify request
// still bubbles (the decide() self-modify rule stands in every mode,
// including this one — see rule 2 below). theDAW's Python assistant
// (backend/modules/assistant/claude_session.py) keeps its own separate
// default of "ask" — that default lives in Python, is untouched by this file,
// and is NOT this constant.
export const DEFAULT_PERMISSION_MODE: PermissionMode = "trusted";

const READ_TOOLS = new Set([
  "Read",
  "Grep",
  "Glob",
  "LS",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
  "NotebookRead",
]);

// The CLI's --allowedTools baseline: tools pre-approved without a permission
// bubble. Same list, same order as theDAW's Python ALLOWED_TOOLS
// (backend/modules/assistant/claude_session.py) — kept as an array (Set
// iteration order == insertion order in JS/TS) so buildClaudeBaseArgs never
// drifts from READ_TOOLS above.
export const ALLOWED_TOOLS: readonly string[] = Array.from(READ_TOOLS);
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);
const AGENT_TOOLS = new Set(["Agent", "Task"]);

// Paths whose modification changes the assistant's own tool surface. These are
// the Foundry's equivalents of theDAW's assistant globs.
export const SELF_SURFACE_GLOBS = [
  "server/claude-bridge.ts",
  "server/routes.ts",
  "server/permissions.ts",
  "src/components/AIAssistantOrb.tsx",
  "src/components/orb/**",
  "src/orb-kit-skin/**",
];

// MCP tool leaf names with one of these prefixes are treated as reads. The
// trailing boundary keeps `getaway_write` / `listen_and_delete` out.
const MCP_READ_PREFIX = /^(get|list|read|status|search|find|describe)(_|$)/;

const WINDOWS_DRIVE = /^[A-Za-z]:\//;

// theDAW mode -> the CLI's own `--permission-mode` value.
//
// CRITICAL: every mode maps to "default", not to the CLI's own acceptEdits /
// bypassPermissions. A live proof against the installed CLI (2.1.278) showed
// that under "bypassPermissions" and "acceptEdits" the CLI auto-approves
// tools ITSELF and never emits a control_request at all -- so decide() never
// runs, and a self-modify write (which decide() must always turn into an
// "ask", in every mode) sails straight through ungoverned. "default" is the
// only CLI mode that asks the host (via --permission-prompt-tool stdio) for
// EVERY tool, which is what lets decide() be the sole authority on the
// allow/deny/ask verdict for every one of theDAW's four modes -- readonly,
// ask, accept_edits and trusted all differ only in what decide() itself
// returns, never in what the CLI pre-approves. Do not reintroduce
// acceptEdits/bypassPermissions here without re-running that live proof.
const CLI_PERMISSION_MODES: Record<PermissionMode, string> = {
  ask: "default",
  accept_edits: "default",
  readonly: "default",
  trusted: "default",
};

export interface Decision {
  kind: ToolKind;
  action: PermissionAction;
  reason: string;
  selfModify: boolean;
  selfModifyPath: string | null;
}

/** Coerce an unknown value (request body, localStorage, a DOM event) into a
 *  mode, or null when it is not one of the four. */
export function normalizePermissionMode(value: unknown): PermissionMode | null {
  return typeof value === "string" && (PERMISSION_MODES as readonly string[]).includes(value)
    ? (value as PermissionMode)
    : null;
}

/** Map a permission mode onto the CLI's `--permission-mode` value. */
export function cliPermissionMode(mode: string): string {
  const normalized = normalizePermissionMode(mode);
  if (!normalized) throw new Error(`unknown permission mode: ${JSON.stringify(mode)}`);
  return CLI_PERMISSION_MODES[normalized];
}

/** Return the policy kind for a tool request. */
export function classify(toolName: string): ToolKind {
  const name = (toolName || "").trim();
  if (READ_TOOLS.has(name)) return "read";
  if (EDIT_TOOLS.has(name)) return "edit";
  if (SHELL_TOOLS.has(name)) return "shell";
  if (AGENT_TOOLS.has(name)) return "agent";
  if (name.startsWith("mcp__")) {
    const parts = name.split("__");
    const leaf = parts.length >= 3 ? parts.slice(2).join("__") : "";
    return MCP_READ_PREFIX.test(leaf) ? "read" : "mcp";
  }
  return "other";
}

function globToRegex(pattern: string): RegExp {
  const out: string[] = [];
  let i = 0;
  while (i < pattern.length) {
    const char = pattern[i];
    if (char === "*") {
      if (pattern.slice(i, i + 3) === "**/") {
        out.push("(?:[^/]+/)*");
        i += 3;
        continue;
      }
      if (pattern.slice(i, i + 2) === "**") {
        // G5 round 6 item 2: a trailing "/**" originally compiled to "/.*"
        // -- which requires a literal "/" after the prefix, so the bare
        // directory itself ("src/components/orb", no trailing slash, e.g.
        // as an `rm -rf` argument) never matched even though every file
        // *inside* it did. Emitting "(?:/.*)?" for a trailing "/**" makes
        // the directory node match too, without changing any other "**"
        // occurrence (mid-pattern "**" still becomes plain ".*").
        if (i + 2 === pattern.length && out.length && out[out.length - 1] === "/") {
          out.pop();
          out.push("(?:/.*)?");
        } else {
          out.push(".*");
        }
        i += 2;
        continue;
      }
      out.push("[^/]*");
      i += 1;
      continue;
    }
    if (char === "?") {
      out.push("[^/]");
      i += 1;
      continue;
    }
    out.push(char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    i += 1;
  }
  // Always case-insensitive: this app ships on Windows, where NTFS resolves
  // `Server/Routes.ts` to `server/routes.ts` — a case-sensitive match there
  // would let a mixed-case path skip the self-modify bubble.
  return new RegExp("^" + out.join("") + "$", "i");
}

const SELF_SURFACE_RE = SELF_SURFACE_GLOBS.map(globToRegex);

function isSelfSurface(rel: string): boolean {
  return SELF_SURFACE_RE.some((rx) => rx.test(rel));
}

// POSIX-style path normalisation. Pure string work — never touches disk.
function normalizePosix(text: string): string {
  const absolute = text.startsWith("/");
  const drive = WINDOWS_DRIVE.test(text) ? text.slice(0, 3) : "";
  const body = drive ? text.slice(3) : text;
  const parts: string[] = [];
  for (const segment of body.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (parts.length && parts[parts.length - 1] !== "..") parts.pop();
      else if (!absolute && !drive) parts.push("..");
      continue;
    }
    parts.push(segment);
  }
  const joined = parts.join("/");
  if (drive) return drive + joined;
  if (absolute) return "/" + joined;
  return joined || ".";
}

// Win32 long-path prefix `\\?\` becomes `//?/` once backslashes are converted
// to slashes; strip it so `\\?\C:\repo\...` resolves through the same
// drive-letter path as a normal `C:\repo\...` instead of failing the prefix
// check (the raw text would otherwise start with `//?/C:/...`, which neither
// WINDOWS_DRIVE nor a POSIX `/` root prefix matches correctly).
//
// CRITICAL (G5 audit item 2, regression): only strip when a drive letter
// immediately follows — `\\?\UNC\evil\share\x.txt` and
// `\\?\GLOBALROOT\Device\...` are the OTHER two `\\?\` forms Win32 accepts
// (UNC shares and raw device paths). Stripping those unconditionally turned
// `//?/UNC/evil/share/x.txt` into `UNC/evil/share/x.txt`, which reads as a
// perfectly ordinary repo-relative path and got treated as inside the repo.
// Leaving them un-stripped means they keep their leading `//?/...`, never
// match ANY repo root prefix, and correctly resolve to null (outside the
// repo) instead of being silently reinterpreted as a safe relative path.
const WIN32_LONG_PATH_DRIVE_PREFIX = /^\/\/\?\/[A-Za-z]:\//;
// Git-Bash / MSYS path form (`/c/Users/...`): a single drive-letter segment
// right after the root slash. Deliberately narrow — exactly one letter
// between the two slashes — so a real single-letter POSIX directory
// (`/a/b`, two+ letters) never gets misread as a drive.
const GIT_BASH_DRIVE_PATH = /^\/([A-Za-z])\/(.*)$/;

/** Strip a Win32 long-path prefix ONLY when a drive letter follows it — see
 *  WIN32_LONG_PATH_DRIVE_PREFIX above for why the UNC/device-path forms of
 *  `\\?\` must NOT be stripped. */
function stripLongPathPrefix(text: string): string {
  return WIN32_LONG_PATH_DRIVE_PREFIX.test(text) ? text.slice(4) : text;
}

/** Map a Git-Bash / MSYS drive path onto its `C:/...` form. Deliberately NOT
 *  applied unconditionally — see the `rootIsWindowsStyle` guard at the call
 *  site: a POSIX repo with a genuine single-letter top-level directory
 *  (`/a/server/routes.ts` against root `/a`) must resolve normally, not get
 *  reinterpreted as drive `A:`. Only worth doing when the repo root ITSELF
 *  is a Windows drive path, where a bare `/c/...` input is unambiguously a
 *  Git-Bash spelling of that same root. */
function mapGitBashDrivePath(text: string): string {
  const gitBash = GIT_BASH_DRIVE_PATH.exec(text);
  return gitBash ? `${gitBash[1].toUpperCase()}:/${gitBash[2]}` : text;
}

// G5 round 3 item 4 (widened by round 4 item 1): a sentinel repoRelative
// returns for input under any Win32 NT-namespace prefix that ISN'T the plain
// drive-letter `\\?\` form -- a UNC (`\\?\UNC\...`), raw device
// (`\\?\GLOBALROOT\Device\HarddiskVolumeN\...\server\routes.ts`), Win32
// device-namespace (`\\.\C:\...`), or NT-native (`\??\C:\...`) path. Item 2
// correctly stopped treating the UNC/device `\\?\` forms as plain
// repo-relative paths (they used to get misread as ordinary, innocent-
// looking relative paths and counted as INSIDE the repo) — but returning
// bare `null` for them made decide() treat "can't verify" the same as
// "verified outside the repo", so rule 2 (self-modify always asks) was
// skipped and trusted mode fell through to its own "allow the rest" rule.
// Round 4 item 1 (CRITICAL): `\\.\` and `\??\` are two OTHER NT-namespace
// prefixes that ALSO resolve to the real file on this machine (verified live
// for all three forms opening the same file) but were never even
// recognised as Win32-special — they fell straight through repoRelative's
// normal absolute-path branch, failed the plain root-prefix comparison
// (their text starts with `//./` or `/??/`, not the repo root), and
// resolved to bare `null` — "provably outside" — exactly the same silent
// bypass as the original `\\?\` hole. The sentinel lets decide() distinguish
// "provably outside the repo" (plain null) from "cannot be verified either
// way" (this) and treat the latter as ask, in every mode, exactly like an
// actual self-modify match — for EVERY NT-namespace form, not just one.
export const AMBIGUOUS_WIN32_PATH = "\u0000ambiguous-win32-path\u0000";

// G5 batch-11 (9th audit) item 5: a distinct sentinel for the `cd`
// short-circuit case (see candidatePaths' shell branch), so decide() can
// report a reason that actually names the cause instead of reusing the
// Win32-device/UNC wording for an unrelated situation.
export const AMBIGUOUS_CD_PATH = "\u0000ambiguous-cd-path\u0000";

// Matches the NT-native path prefix (`\??\` -> `/??/` after the \ -> / swap).
// The other ambiguous root shape -- any double-separator root that ISN'T the
// safe drive-letter long-path form already stripped by stripLongPathPrefix
// -- is caught directly by `text.startsWith("//")` in repoRelative rather
// than an enumerated prefix list. G5 round 5 item 1: an enumerated list of
// named prefixes (`\\?\`, `\\.\`, `\??\`) missed plain UNC
// (`\\localhost\C$\...`, `\\127.0.0.1\C$\...`) entirely -- neither name has
// an NT-namespace prefix at all, yet both resolve to the identical live file
// on this machine. One predicate covering every double-separator root
// replaces a list that has now been proven incomplete twice.
const NT_NATIVE_PREFIX = /^\/\?\?\//;

// Drive-relative form (`C:server\routes.ts`, no separator right after the
// colon). Its target is CWD-dependent, and the CLI's CWD IS the repo root,
// so it can resolve to a real self-surface file with no path separator ever
// appearing after the drive letter -- but this module never touches the
// filesystem to learn the CWD, so it can't be resolved, only flagged.
const DRIVE_RELATIVE = /^[A-Za-z]:(?!\/)/;

// A path segment naming a Windows 8.3 short name (`PERMIS~1.TS`,
// `_THEDA~4`). GetShortPathNameW generation is live on this volume
// (verified), so a short-name segment can resolve to the identical
// long-name file this module would otherwise match against a self-surface
// glob -- but expanding it correctly needs GetLongPathNameW /
// fs.realpathSync, i.e. touching the filesystem, which this module's
// no-filesystem contract forbids. This is a STRING-ONLY APPROXIMATION: any
// segment matching the pattern is treated as ambiguous rather than
// resolved, so a short name can never silently bypass a glob it would
// expand to match. It cannot tell a short name that expands to something
// outside the repo from one that expands to something inside it -- both are
// (safely, over-cautiously) treated as ambiguous.
const SHORT_NAME_SEGMENT = /~\d/;

/** Normalise `raw` to a repo-relative POSIX path, `AMBIGUOUS_WIN32_PATH` when
 *  it cannot be safely verified either way (see its comment), or null when
 *  it is provably outside the repo. Handles Windows absolute paths, POSIX
 *  paths and quoted tokens.
 *
 *  LIMITATION (G5 round 5 item 1, part 4): Windows 8.3 short names
 *  (`ASSIST~1.PY`) are detected and treated as `AMBIGUOUS_WIN32_PATH` rather
 *  than resolved, because resolving one correctly needs
 *  `fs.realpathSync.native` -- i.e. touching the filesystem -- which this
 *  function's contract forbids. See SHORT_NAME_SEGMENT's comment for the
 *  exact trade-off this makes. */
export function repoRelative(raw: string, repoRoot: string): string | null {
  // G5 batch-11 (8th audit) item 4: this previously stripped at most ONE
  // quote char off each side (`/^["']|["']$/`), while the Python port's
  // `.strip("\"'")` removes ALL surrounding quotes, so `""backend/rag.py""`
  // diverged. Not exploitable (quotes are illegal in NTFS names and
  // shellTokens already strips quote characters before repoRelative ever
  // sees a shell token) — parity only. `+` makes both sides greedy to match
  // Python exactly.
  let text = (raw || "").trim().replace(/^["']+|["']+$/g, "").trim();
  if (!text) return null;
  text = text.replace(/\\/g, "/");
  const strippedText = stripLongPathPrefix(text);
  if (strippedText !== text) {
    text = strippedText;
  } else if (text.startsWith("//") || NT_NATIVE_PREFIX.test(text)) {
    // Left un-stripped: any double-separator or NT-native root other than
    // the safe drive-letter `\\?\` form -- plain UNC (`//server/share/...`,
    // including loopback spellings like `//localhost/C$/...` and
    // `//127.0.0.1/C$/...`), `//./`, `//?/UNC/...`, `//?/GLOBALROOT/...`,
    // `/??/...`. Signal ambiguity distinctly (item 4, widened by round 4
    // item 1, widened again by round 5 item 1 to a single predicate instead
    // of an enumerated list) rather than resolving it (wrongly) to a
    // clean-looking in-repo relative path or a plain "outside the repo"
    // null.
    return AMBIGUOUS_WIN32_PATH;
  } else if (DRIVE_RELATIVE.test(text)) {
    // Drive-relative (`C:server\routes.ts`): CWD-dependent, can't be
    // resolved as string work. See DRIVE_RELATIVE's comment.
    return AMBIGUOUS_WIN32_PATH;
  }
  const rootSlashed = stripLongPathPrefix(repoRoot.replace(/\\/g, "/"));
  // Both rewrites run BEFORE the repo-root prefix comparison, not after
  // (rewriting post-comparison would still let a `//?/` or `/c/...` path
  // slip past the root check it was meant for).
  if (WINDOWS_DRIVE.test(rootSlashed)) {
    const mapped = mapGitBashDrivePath(text);
    if (mapped !== text) {
      text = mapped;
    } else if (text.startsWith("/")) {
      // G5 batch-11 fixup (critical 1): a single-separator-rooted path
      // (backslash-Users-... or forward-slash-Users-... -- both become
      // /Users/... after the backslash-to-slash swap above) is relative
      // to the CURRENT DRIVE on Windows, not the filesystem root -- and
      // PROJECT_CWD is always repoRoot, so the drive is always
      // repoRoot's. This is NOT the Git-Bash /c/... form (already ruled
      // out by mapGitBashDrivePath returning the input unchanged) and
      // NOT // or /??/ roots (those already returned
      // AMBIGUOUS_WIN32_PATH above). Pure string work: graft
      // rootSlashed's own drive letter on.
      text = rootSlashed.slice(0, 2) + text;
    }
  }
  // G5 round 5 item 1 (parts 3-4): canonicalize each path segment BEFORE the
  // root-prefix comparison and before any glob match, so an evasion riding
  // on a filesystem quirk can't present a path that looks clean to the
  // string-matching code but opens the real self-surface file on disk. A
  // short-name (8.3) segment can't be canonicalized as pure string work (see
  // SHORT_NAME_SEGMENT's comment) so it short-circuits to
  // AMBIGUOUS_WIN32_PATH instead of being resolved.
  const segments = text.split("/");
  if (segments.some((segment) => SHORT_NAME_SEGMENT.test(segment))) {
    return AMBIGUOUS_WIN32_PATH;
  }
  text = segments
    .map((segment, index) => {
      // `.` / `..` / empty segments are structural (consumed by the
      // normalizePosix collapse right below) -- not filenames, so they must
      // be left untouched. Stripping trailing dots from `..` would turn it
      // into an empty segment and silently defeat the traversal collapse.
      if (segment === "" || segment === "." || segment === "..") return segment;
      // The drive segment (`C:`) is exempt from ADS truncation -- its colon
      // is the drive separator, not a stream marker.
      if (index === 0 && /^[A-Za-z]:$/.test(segment)) return segment;
      // NTFS Alternate Data Stream: `routes.ts::$DATA` opens `routes.ts`'s
      // unnamed stream, i.e. `routes.ts` itself -- truncate at the first
      // `:`.
      const colonIndex = segment.indexOf(":");
      if (colonIndex !== -1) segment = segment.slice(0, colonIndex);
      // NTFS silently strips a trailing `.` or space from a filename, so
      // `routes.ts.` and `routes.ts ` both name the same file as
      // `routes.ts`.
      return segment.replace(/[. ]+$/, "");
    })
    .join("/");
  // Collapse `..` BEFORE the prefix comparison, otherwise
  // `C:/repo/../repo/server/routes.ts` slips past the root check.
  text = normalizePosix(text);
  const root = normalizePosix(rootSlashed).replace(/\/+$/, "");

  let rel: string;
  if (text.startsWith("/") || WINDOWS_DRIVE.test(text)) {
    if (!root) return null;
    const prefix = root + "/";
    if (text.toLowerCase().startsWith(prefix.toLowerCase())) rel = text.slice(prefix.length);
    else return null;
  } else {
    rel = text;
  }

  rel = normalizePosix(rel);
  if (rel === "." || rel === "" || rel === ".." || rel.startsWith("../")) return null;
  if (rel.startsWith("/") || WINDOWS_DRIVE.test(rel)) return null;
  return rel;
}

// G5 round 6 item 3: comma joins bare-string arguments inside a single
// quoted Python/Node/etc. one-liner (`python -c "open('routes.ts','w')"`) --
// without it, `'routes.ts','w'` never splits into its two individual string
// arguments and the embedded comma survives every strip, so the path never
// resolves cleanly. (The concatenated/split-quote spellings themselves --
// `"rou""tes".ts` etc. -- are already handled correctly here because
// shellTokens strips quote characters as it tokenizes; this fix is parity
// with the Python port's comma handling, not a quote-stripping fix.)
const SHELL_SEPARATORS = /[;&|(),]+/;

// Split a shell token into every substring that could name a file: redirects and
// flag values (`>server/routes.ts`, `--output=server/routes.ts`,
// `<server/routes.ts`) and command separators (`server/routes.ts;`,
// `server/routes.ts&&ls`). The raw token alone never matches a glob, so every
// piece is offered.
//
// G5 batch-11 item 3 (CRITICAL): repoRelative's blanket
// `text.replace(/\\/g, "/")` reads every backslash as a Windows path
// separator, which is correct for Edit/Write file paths but WRONG for a
// shell command, where a backslash is a POSIX escape character —
// `echo x > back\end/rag.py` opens `backend/rag.py` in bash (the backslash
// is consumed, not a separator), while the separator reading builds the
// candidate `back/end/rag.py`, which matches nothing. Proven live to reach
// and overwrite the seeded file (both ports identical). Every candidate here
// also gets a backslash-REMOVED (escape) variant alongside its
// backslash-as-separator reading, skipped for a candidate that already looks
// like a genuine Windows drive path (`C:\...`) — there the backslashes ARE
// real separators, and deleting them would collapse
// `C:\proj\theDAW\server\routes.ts` into the nonsensical, drive-relative-
// looking `C:projtheDAWserverroutes.ts`.

// A genuine Windows drive path spelled with backslashes (`C:\proj\...`),
// used only to exempt such candidates from the shell backslash-as-escape
// variant in tokenVariants — see its comment.
const WINDOWS_DRIVE_BACKSLASH = /^[A-Za-z]:\\/;

function tokenVariants(token: string): string[] {
  const pieces = [token, ...token.split(SHELL_SEPARATORS).filter(Boolean)];
  const variants: string[] = [];
  for (const piece of pieces) {
    const candidates = [piece];
    for (const sep of [">", "=", ":"]) {
      const at = piece.lastIndexOf(sep);
      if (at >= 0 && at < piece.length - 1) candidates.push(piece.slice(at + 1));
    }
    const stripped = piece.replace(/^<+/, "");
    if (stripped && stripped !== piece) candidates.push(stripped);
    for (const candidate of [...candidates]) {
      if (WINDOWS_DRIVE_BACKSLASH.test(candidate)) continue;
      const noBackslash = candidate.replace(/\\/g, "");
      if (noBackslash && noBackslash !== candidate) candidates.push(noBackslash);
    }
    variants.push(...candidates);
  }
  return Array.from(new Set(variants));
}

// Whitespace split honouring simple quoting — Node has no shlex.
function shellTokens(command: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (const char of command) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) out.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current) out.push(current);
  return out;
}

/** Every repo-relative path this request could write to. */
// Shell tokens that change the effective working directory of every command
// that follows them on the same line. G5 round 6 item 1: candidates are
// resolved against `repoRoot` only -- the command's own effective cwd is
// never tracked, so `cd server && echo x > routes.ts` builds the candidate
// `routes.ts` (never `server/routes.ts`) and misses the self-surface glob
// entirely. Correctly tracking the accumulated `cd`/`pushd` directory would
// require actually interpreting the shell grammar (subshells, quoting,
// `&&` vs `;` vs newlines, `cd -`, environment expansion in the target);
// the auditor named the safer and cheaper alternative and this takes it:
// any shell command containing a `cd` or `pushd` token is treated as
// unresolvable and gets the same "ask, always" treatment as a proven
// self-modify match (see AMBIGUOUS_WIN32_PATH handling in decide()),
// rather than attempting -- and risking getting wrong -- a
// directory-prefix reconstruction.
//
// G5 batch-11 (7th audit) items 1/2/6: the original token-based check
// (`tokens.some((t) => CD_TOKENS.has(t.toLowerCase()))`) missed every
// spelling where shellTokens glues the directory-change word to adjacent
// punctuation or a nested-shell quote — `(cd server; ...)` tokenizes as ONE
// token `(cd` (never bare `cd`), and `bash -c "cd server && ..."` tokenizes
// the whole quoted string as ONE token, so `cd` never appears as its own
// token either. Both were proven live to reach and overwrite a seeded
// `server/routes.ts`. The fix stops tokenizing for this test entirely and
// matches case-insensitively against the RAW command string instead, so
// punctuation and quote characters immediately before/after the word no
// longer hide it. The set also grows from `{cd, pushd}` to every
// PowerShell equivalent (`popd`, `chdir`, `sl`, `set-location`,
// `push-location`, `pop-location`) — `PowerShell` is a first-class member
// of SHELL_TOOLS and all six aliases were proven live to change directory
// exactly like `cd`.
//
// Item 6: the original rule short-circuited to "ask, always" for ANY
// `cd`/`pushd` command, including read-only ones — every one of
// CLAUDE.md's own documented `cd frontend && npm run build`-shaped commands
// became an undismissable prompt with a misleading reason string.
//
// G5 batch-11 (8th audit) item 1, CRITICAL, revised: the fix that followed
// (scoping the short-circuit to a `cd` paired with a "write-shaped"
// BLACKLIST of tokens) was itself wrong — the set of programs able to
// write a file on a filesystem is not enumerable, and the auditor proved
// live, in trusted mode (the Foundry's default), that a seeded
// `backend/rag.py` is overwritten or destroyed by a heredoc
// (`python - <<'EOT'`), `node -e "require('fs').writeFileSync(...)"`,
// `perl -i -pe`, `sed -i.bak` (the dash-i regex required whitespace/quote/
// EOL after `-i`, which `-i.bak` does not supply), `install -m 644
// /dev/null rag.py`, `patch < p.diff`, `git apply p.diff`, `tar xf a.tar`,
// `gcc -o rag.py x.c`, `Copy-Item`, `New-Item -Force` (the alias `ni` was
// listed, `new-item` was not), and `Remove-Item`/`ri` (`rm` was listed,
// the PowerShell aliases were not) — none of these are redirects or in the
// old write-word list, and unbounded others (`unzip`, `7z x`, `Move-Item`,
// `Rename-Item`, `curl -o`, `rsync`, `shred -u`, any `npm run build` that
// emits into the directory, ...) share the same gap.
//
// The short-circuit is inverted to an ALLOWLIST instead: a directory
// change is ambiguous UNLESS the rest of the command is one of the
// narrow, explicitly documented CLAUDE.md shapes recognised by
// `isKnownReadOnlyCommand` below. A miss in an allowlist costs one extra
// "ask" prompt; a miss in a blacklist costs a silent write to the
// assistant's own policy surface — the allowlist direction is the only
// one that is safe by construction.
// G5 round 13 (12th audit) item 4: an explicit ASCII whitespace class,
// shared verbatim by both ports, standing in for every `\s` in the
// directory-argument and tail-normalisation regexes below. Python's `re`
// and JavaScript's regex engine disagree on which Unicode code points
// count as `\s` — Python's includes U+0085 (NEXT LINE) but not U+FEFF
// (BOM/ZWNBSP); JavaScript's includes U+FEFF but not U+0085 — so a
// character in that gap flips which side of a match boundary it falls on
// per engine, and the same command (`npm﻿run lint` as a `cd` tail;
// `cd back\u0085end&&ls` as a `cd` directory argument) resolved `allow` on
// one port and `ask` on the other. Restricting the separator set to six
// characters both engines are guaranteed to treat identically (space, tab,
// LF, CR, FF, VT) removes the ambiguity by construction instead of by
// coincidence.
const WS = " \\t\\n\\r\\f\\v";
const CD_WORDS = [
  "set-location",
  "push-location",
  "pop-location",
  "chdir",
  "pushd",
  "popd",
  "cd",
  "sl",
];
const CD_RAW_RE = new RegExp(
  `(?:^|[\\s;&|(){}"'])\\s*(?:${CD_WORDS.join("|")})(?=[\\s;&|)"']|$)`,
  "i",
);
// G5 batch-11 (9th audit) item 3: a `cd`/`pushd`/etc. word with a single
// directory argument and nothing else on the line -- no `&&`/`;` chaining
// in a second command. Matched against the whole command, not the raw-word
// search above, since it must anchor at both ends.
// G5 batch-11 (10th audit) item 4: the directory argument was `\S+`, which
// is greedy over non-whitespace and swallows a separator-glued second
// command whole (`cd backend&&../tools/x.sh`) -- proven live to reach
// `Trusted mode` allow with no space around `&&`. The directory argument
// must not itself contain a shell separator/metacharacter, so it is
// restricted to the same metacharacter-free class used to validate the
// post-`cd` tail (TAIL_METACHAR_RE's class, inlined here since this regex
// is defined above that one).
// G5 round 13 (12th audit) item 3: NUL (`\x00`) added to the excluded
// class. Inert on every shell this module targets — not a separator on
// bash, cmd, or PowerShell, and Node's `child_process` refuses to spawn an
// argv containing it outright — so this cannot be reached live. Added
// anyway so the one code point this class cannot already represent is
// never silently admitted into a directory argument.
// G5 round 13 item 4: `\s` replaced by the explicit WS class — see its
// definition above CD_WORDS for why.
const CD_BARE_RE = new RegExp(
  `^[${WS}]*(?:${CD_WORDS.join("|")})[${WS}]+[^${WS};&|<>$\`(){}\\u2028\\u2029\\x00]+[${WS}]*$`,
  "i",
);

// G5 batch-11 item 1 ("ALSO"): a nested-shell invocation whose argument this
// module cannot parse at all (`bash -c "..."`, `sh -c '...'`,
// `powershell -Command "..."`, `cmd /c "..."`) is unconditionally ambiguous
// — proven live to reach a seeded self-surface file via a `cd` buried inside
// the quoted argument that no amount of raw-string matching on the OUTER
// command can be trusted to fully enumerate. Both the interpreter name and
// its "run this string" flag must be present together, so common, unrelated
// flags that happen to also be spelled `-c` (`tar -c`, `gcc -c`, `grep -c`)
// are never mistaken for a nested shell.
// G5 batch-11 (8th audit) item 5 (note, folded in as belt-and-braces): the
// prefix boundary class previously omitted `/`, so `/bin/sh -c '...'` — the
// interpreter's absolute-path form — was invisible to this check even
// though `sh` and its `-c` flag were both present. Adding `/` closes that
// without risk of reopening any of the verified-clean substrings (none of
// them are preceded by `/`).
const SHELL_INTERPRETER_RE = /(?:^|[\s;&|(){}"'/])(?:bash|sh|zsh|powershell|pwsh|cmd)(?:\.exe)?(?=[\s;&|)"']|$)/i;
// G5 batch-11 (8th audit) item 2: this regex previously carried the `i`
// flag, which made a bare uppercase `-C` (single dash, capital C — `tar -C`,
// `make -C`, `git -C`, `sh -C`) match the `c` alternative case-insensitively.
// The Python port's equivalent has no such flag and spells the
// case-sensitivity into the character classes instead — `c` matches only
// lowercase, `[Cc]ommand`/`/[Cc]` explicitly allow either case — so a bare
// `-C` never matches there. Measured divergence: `tar -C backend -xf a.tar
// && sh`, `make -C src ; bash`, `git -C x log | sh`, and `sh -C foo` were
// Python `allow` / TypeScript `ask`. The direction was safe (over-asking,
// never under-asking) but broke structural parity between the two ports.
// Dropped the `i` flag and spelled the case-sensitivity inline to match
// Python exactly.
const SHELL_DASH_C_RE = /(?:^|\s)(?:-{1,2}(?:c|[Cc]ommand)|\/[Cc])(?=[\s="']|$)/;

function hasNestedShell(command: string): boolean {
  return SHELL_INTERPRETER_RE.test(command) && SHELL_DASH_C_RE.test(command);
}

// G5 batch-11 (8th audit) item 1: the ONLY commands the `cd` short-circuit
// below is allowed to let through without a prompt — exactly the shapes
// documented in CLAUDE.md and nothing more. This is an ALLOWLIST (unlike
// the write-signal blacklist it replaces): a directory change followed by
// anything NOT matching one of these narrow tails is treated as ambiguous.
// CD_TO_SAFE_TAIL_RE isolates the text after the first directory-change
// word and its `&&`/`;` separator (mirroring the CLAUDE.md
// `cd <dir> && <command>` shape); KNOWN_READ_ONLY_TAILS must equal that
// tail exactly (after whitespace normalisation), so appending anything
// after a recognised command (`npm run build && rm -rf .`) fails the match
// and correctly falls through to "ask".
// G5 round 12 (11th audit) item 1, CRITICAL: the directory argument here was
// `\S+`, the identical flaw fixed in CD_BARE_RE one round earlier and never
// carried over to this regex — greedy over non-whitespace, it swallowed a
// separator-glued second command whole (`cd backend&&./evil.sh`) so the
// capture group (intended to be the whole tail) was only the LAST segment,
// and that segment alone got validated against the allowlist. Proven live:
// `cd backend&&./evil.sh&&ls` -> allow (tail captured as `ls`) on both
// ports, writing an arbitrary-execution marker. Restricted to the same
// metacharacter-free class CD_BARE_RE already uses, so a separator-glued
// directory argument can never be mistaken for a single token again.
// G5 round 13 (12th audit) item 3: NUL (`\x00`) added to the excluded
// class — same rationale as CD_BARE_RE above.
// G5 round 13 item 4: `\s` replaced by the explicit WS class — see its
// definition above CD_WORDS for why.
// G5 round 13 (12th audit) item 1, MAJOR: the directory argument is now
// its OWN capture group (group 1), not discarded — the allowlist below
// bounded the command STRING but not the CODE THAT RUNS, because nine of
// the twenty-one literals (`npm`/`npx`/`uv run` invocations) execute code
// read from whatever directory this group names, and that directory was
// never validated: `cd /tmp/evil && npm run build`, `cd ../../evil && npx
// vitest run`, `cd ~ && npm run build`, `cd .. && npm run lint`, and their
// C:/-absolute equivalent were all proven live to reach `Trusted mode`
// allow and execute attacker-controlled code (a scratch
// `package.json`/`conftest.py` in the target directory). See
// isKnownReadOnlyCommand for how the two tail categories now use this
// group differently.
const CD_TO_SAFE_TAIL_RE = new RegExp(
  `^[${WS}]*(?:${CD_WORDS.join("|")})[${WS}]+([^${WS};&|<>$\`(){}\\u2028\\u2029\\x00]+)[${WS}]*(?:&&|;)[${WS}]*(.+?)[${WS}]*$`,
  "i",
);
// G5 batch-11 (9th audit) items 1/2: a shell metacharacter anywhere in the
// tail means the allowlist below cannot be trusted to have parsed the tail
// as a single command -- `uv run pytest ; rm -rf .` and
// `npm run lint>rag.py` would otherwise reach the exact-match check
// carrying a second command or a glued redirect. Reject the tail outright
// before attempting the exact-match check.
// G5 batch-11 (10th audit) item 6: add U+2028/U+2029 (Unicode line/paragraph
// separators) -- JavaScript's `.` treats them as line terminators (unlike
// Python's `re`), so a tail containing one could not be matched in full by
// this class while Python's equivalent kept matching across it, giving
// `cd backend && ls\u2028rm -rf .` divergent verdicts across the two ports
// (Python `allow`, TypeScript `ask`). Neither character is a shell
// separator on bash/cmd/PowerShell, so this only tightens TypeScript to
// match Python's (already-safe) behaviour.
const TAIL_METACHAR_RE = /[;&|<>$`(){}\n\r\u2028\u2029]/;

// G5 round 12 (11th audit) items 2/3, CRITICAL, revised approach: eleven
// rounds of narrowing a per-tool regex (flag allowlists, positional-arg
// shape rules, `--output` negative lookaheads, ...) have proven that
// modelling a tool's read-only *surface* is not tractable -- every
// narrowing has left a flag or a subcommand this module did not anticipate.
// `uv run pytest`'s flag pattern admitted every output-path-naming pytest
// option (`--junitxml=`, `--debug=`, `--basetemp=`, `--cov-report=`,
// `-o cache_dir=`, `-p <plugin>`), proven live to truncate, overwrite, or —
// via `--basetemp` — recursively DELETE `backend/modules/assistant/` (this
// policy module's own directory) whenever a collected test uses
// `tmp_path`/`tmpdir`, which this repo's own suite does. `uv run ruff
// check/format --diff`'s trailing-argument tail admitted `-o`/
// `--output-file`/`--cache-dir`, proven live against the repo's own pinned
// ruff binary to truncate and rewrite an arbitrary file even with `--diff`
// present (`--diff` wins over `-o` in ruff's own precedence, but the write
// to `-o`'s target happens regardless).
//
// The fix: stop modelling flags and arguments at all. Every entry below is
// a COMPLETE, EXACT command string with no argument tail whatsoever — not a
// regex over one. A miss (any flag, any argument, any variation) falls
// through to "ask"; there is no shape for an unanticipated flag to hide in,
// because no flag is ever parsed. Compared to `command` after collapsing
// internal whitespace and lower-casing (so `NPM  RUN   LINT` still matches
// `npm run lint`) — no other normalisation, so the string must be the
// admitted invocation and nothing else.
//
// Membership, and the document that prescribes each ONLY from CLAUDE.md /
// frontend/package.json / VST-Foundry-UI/VST-UI-FOUNDRY/package.json
// (never guessed) — see the matching comment above the Python port's
// `_KNOWN_READ_ONLY_TAILS` for the full per-entry rationale. `pnpm`/`yarn`
// equivalents are NOT admitted: CLAUDE.md and both `package.json` files
// document `npm` only for this repo; an unrecognised package manager falls
// through to "ask", which costs one prompt, never a silent write.
//
// G5 round 13 (12th audit) item 1, MAJOR: this set used to be flat — every
// entry treated identically regardless of the `cd` target directory. That
// bounded the command STRING but not the CODE THAT RUNS: `ls`/`cat`/the
// four bare `git` read verbs are INERT — they read, they never execute
// anything they find in the target directory, so the directory they run in
// cannot matter. But nine of the entries (every `npm`/`npx`/`uv run`
// invocation) EXECUTE code discovered in that directory —
// `package.json` scripts (`npm run build`/`test`/`lint*`), a
// cwd-discovered test suite and its `conftest.py` (`uv run pytest`, `npx
// vitest run`), or cwd config plus `node_modules/.bin` (`npx tsc
// --noEmit`) — and admitting them from ANY directory was proven live: a
// scratch `package.json` with `"build": "node evil.js"` under `/tmp/evil`,
// `C:/evil`, `../../evil`, or `~` made `cd <that dir> && npm run build`
// (and the `test`/`lint*`/`uv run pytest`/`npx vitest run`/`npx tsc
// --noEmit` equivalents) reach `Trusted mode` allow and run
// attacker-controlled code, with the write happening entirely OUTSIDE this
// module's self-surface/repo-relative path model, so no candidate-path
// check downstream ever saw it. The set is now split in two:
// INERT_READ_ONLY_TAILS (the four `ls`/`cat`/`git` shapes) stays admitted
// from ANY directory — inertness doesn't depend on location.
// PROJECT_CODE_READ_ONLY_TAILS (the nine code-executing shapes) is
// admitted ONLY when the captured `cd` directory (see CD_TO_SAFE_TAIL_RE
// group 1) is itself an exact literal from a CLOSED set naming this
// repo's own package/project roots — `.`/`frontend`/`backend`/
// `VST-Foundry-UI/VST-UI-FOUNDRY` — the only directories CLAUDE.md and the
// two `package.json` files document these commands as being run from. Any
// other directory, however spelled, falls through to "ask": there is no
// way to widen the closed set from the command line, because it is never
// parsed as a pattern.
const INERT_READ_ONLY_TAILS = new Set(
  ["ls", "cat", "git status", "git log", "git diff", "git show"].map((tail) => tail.toLowerCase()),
);
const PROJECT_CODE_READ_ONLY_TAILS = new Set(
  [
    "npm run lint",
    "npm run lint:classes",
    "npm run lint:scripts",
    "npm run build",
    "npm test",
    "npm run test:sing",
    "npx tsc --noEmit",
    "npx vitest run",
    "uv run pytest",
    "uv run pytest tests/test_inference.py",
    "uv run pytest --save-audio",
    "uv run ruff check",
    "uv run ruff check .",
    "uv run ruff format --check",
    "uv run ruff format --check .",
  ].map((tail) => tail.toLowerCase()),
);
// Union of the two sets above -- kept for callers/tests that only care
// whether a tail is admitted at all, not which category it falls in (the
// directory restriction is enforced in isKnownReadOnlyCommand, not by set
// membership here).
const KNOWN_READ_ONLY_TAILS = new Set([...INERT_READ_ONLY_TAILS, ...PROJECT_CODE_READ_ONLY_TAILS]);

// The closed set of `cd` target directories a PROJECT_CODE_READ_ONLY_TAILS
// entry may be run from — this repo's own package/project roots, and
// nothing else. Compared as an exact literal (the directory-argument class
// already excludes every shell metacharacter, so there is nothing to
// normalise beyond that): a trailing slash, a different case, or any
// relative/absolute spelling not listed here falls through to "ask".
const SAFE_PROJECT_DIRS = new Set([".", "frontend", "backend", "VST-Foundry-UI/VST-UI-FOUNDRY"]);

// Collapses runs of whitespace in a tail to a single space before comparing
// it against KNOWN_READ_ONLY_TAILS -- e.g. `npm  run   lint` (extra spaces)
// still matches `"npm run lint"`. This is normalisation of whitespace ONLY:
// it cannot merge two distinct tokens, add a flag, or otherwise widen what
// the exact-string comparison accepts.
// G5 round 13 item 4: `\s` replaced by the explicit WS class — see its
// definition above CD_WORDS for why.
const WHITESPACE_RUN_RE = new RegExp(`[${WS}]+`, "g");

// Whether `command` is one of the narrow `cd <dir> && <tool>` shapes
// documented in CLAUDE.md / package.json — the only commands the `cd`
// short-circuit is allowed to let through without a prompt. Anything that
// doesn't equal one of KNOWN_READ_ONLY_TAILS exactly (after whitespace
// normalisation) resolves to false and gets "ask", never "allow" — see the
// item 1 comment above CD_TO_SAFE_TAIL_RE for why this must be an
// allowlist, not a blacklist, and the comment above
// PROJECT_CODE_READ_ONLY_TAILS for why an inert tail is admitted from any
// directory while a project-code tail is admitted only from
// SAFE_PROJECT_DIRS.
function isKnownReadOnlyCommand(command: string): boolean {
  const match = CD_TO_SAFE_TAIL_RE.exec(command);
  if (!match) return false;
  const directory = match[1];
  const tail = match[2];
  if (TAIL_METACHAR_RE.test(tail)) return false;
  const normalized = tail.replace(WHITESPACE_RUN_RE, " ").trim().toLowerCase();
  if (INERT_READ_ONLY_TAILS.has(normalized)) return true;
  if (PROJECT_CODE_READ_ONLY_TAILS.has(normalized)) return SAFE_PROJECT_DIRS.has(directory);
  return false;
}

// G5 round 13 (12th audit) item 2, MAJOR (usability, and a security problem
// per the audit: heavy over-asking trains click-through, and the escape
// hatch -- "allow Bash for this session" -- is keyed on TOOL NAME, so one
// approval to silence the noise whitelists every future Bash command for
// the session). Ten of nineteen over-asks in the audit's 35-command corpus
// were plain, bare (no `cd`) invocations of `ls`/`cat`/`head`/`wc`/`git
// status`/`git log`/`git diff`/`git show` WITH arguments (`ls -la`, `cat
// backend/rag.py`, `git diff HEAD~1`, ...) -- none of which can write.
// They asked anyway because candidatePaths treats every token in a shell
// command as a possible write target regardless of which command it
// belongs to: naming a self-surface file as a plain READ argument (`cat
// backend/rag.py`) was indistinguishable from naming it as a WRITE target
// (`echo x > backend/rag.py`), and `git diff HEAD~1`'s `~1` token was
// independently flagged AMBIGUOUS_WIN32_PATH by the unrelated Windows
// short-name heuristic that scans every candidate token.
//
// The fix is scoped, not a blanket bypass: it recognises exactly these
// eight command heads with a trailing argument list built from the SAME
// metacharacter-free class the `cd` directory argument already uses (so a
// redirect or a second command glued on with a separator, e.g. `cat
// rag.py>backend/rag.py` or `cat rag.py; rm -rf .`, still contains a
// rejected character and falls through to the ordinary token scan
// unchanged), plus the one write primitive that flag surface actually has
// -- `--output`/`-o` on `git diff`/`git show` -- excluded by a negative
// lookahead so `git diff --output=backend/rag.py HEAD` can never match as
// safe. When the whole command matches, NO candidate paths are produced
// for it at all: none of these eight commands can write to an argument
// they are given, so there is nothing to compare against the self-surface
// glob or the ambiguous-Win32-path heuristic, and the command proceeds to
// `Trusted mode`'s ordinary allow.
const SAFE_READ_ARG_CLASS = `[^${WS};&|<>$\`(){}\\u2028\\u2029\\x00]+`;
const SAFE_READ_COMMAND_RE = new RegExp(
  `^[${WS}]*(?:ls|cat|head|wc|git[${WS}]+(?:status|log|diff|show))(?:[${WS}]+(?!--output|-o)${SAFE_READ_ARG_CLASS})*[${WS}]*$`,
  "i",
);

// Whether `command` is a bare (no `cd`) invocation of one of the eight
// inert read commands (`ls`/`cat`/`head`/`wc`/`git status`/`git log`/`git
// diff`/`git show`) with only metacharacter-free arguments and no
// `--output`/`-o` flag -- see the comment above SAFE_READ_COMMAND_RE for
// the full rationale. A command matching this can never write to any path
// it names, so it contributes no write-candidate paths at all.
function isSafeReadCommand(command: string): boolean {
  return SAFE_READ_COMMAND_RE.test(command);
}

export function candidatePaths(
  toolName: string,
  input: Record<string, unknown> | null | undefined,
  repoRoot: string,
): string[] {
  const kind = classify(toolName);
  const raw: string[] = [];
  const body = input && typeof input === "object" ? (input as Record<string, unknown>) : {};

  if (kind === "edit") {
    for (const key of ["file_path", "notebook_path"]) {
      const value = body[key];
      if (typeof value === "string") raw.push(value);
    }
  } else if (kind === "shell") {
    const command = body.command;
    if (typeof command === "string" && command.trim()) {
      // G5 round 13 (12th audit) item 2: a bare (no `cd`) invocation of one
      // of the eight inert read commands can never write to any argument
      // it is given -- see the comment above SAFE_READ_COMMAND_RE for the
      // full rationale. Checked before the nested-shell/`cd` checks below
      // since none of those can ever apply to a command this narrowly
      // shaped matches anyway (its character class already excludes every
      // shell metacharacter a nested-shell or `cd` chain would need).
      if (isSafeReadCommand(command)) return [];
      // G5 batch-11 items 1/2/6: match against the RAW command string, not
      // tokens — see CD_RAW_RE's comment for why the old token-based check
      // missed both paren-glued (`(cd`) and nested-shell
      // (`bash -c "cd ..."`) spellings. A nested shell whose argument this
      // module cannot parse is unconditionally ambiguous; a plain
      // `cd`/`pushd`/etc. is ambiguous UNLESS the rest of the line is one
      // of the narrow, known-read-only shapes from CLAUDE.md (see item 1's
      // comment above isKnownReadOnlyCommand) — everything else, including
      // every unenumerable way to write a file, asks.
      if (hasNestedShell(command)) return [AMBIGUOUS_WIN32_PATH];
      // G5 batch-11 (9th audit) item 3: a bare `cd <dir>` with no trailing
      // command carries no write risk at all -- there is nothing after it
      // to be ambiguous about -- so it falls through to the ordinary
      // token-based scan below instead of being treated as unresolvable.
      if (CD_RAW_RE.test(command) && !CD_BARE_RE.test(command) && !isKnownReadOnlyCommand(command)) {
        return [AMBIGUOUS_CD_PATH];
      }
      const tokens = shellTokens(command);
      for (const token of tokens) raw.push(...tokenVariants(token));
    }
  }

  const paths: string[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    const rel = repoRelative(value, repoRoot);
    if (rel && !seen.has(rel)) {
      seen.add(rel);
      paths.push(rel);
    }
  }
  return paths;
}

/** The repo-relative path of a self-surface write, or null. Keeps the caller's
 *  casing so the permission bubble shows what the model actually asked to write. */
// G5 audit item 7: candidatePaths() can return several variants of the SAME
// token — e.g. for a glued shell token `a.tsx&&ls`, both the raw, unsplit
// piece (`src/components/orb/a.tsx&&ls`, which a trailing `**` glob's `.*`
// happily swallows whole) and the cleanly split one
// (`src/components/orb/a.tsx`). Reporting whichever candidate happens to
// come first (tokenVariants pushes the raw piece before its split-derived
// ones) surfaced the raw, junk-suffixed string to the user. The shortest
// self-surface MATCH is always the cleanly-resolved path — a raw glued
// variant is never shorter than its own split sub-piece, only longer or
// equal — so picking the shortest is a safe, order-independent tiebreak.
function shortestSelfSurfaceMatch(paths: string[]): string | null {
  let best: string | null = null;
  for (const p of paths) {
    if (!isSelfSurface(p)) continue;
    if (best === null || p.length < best.length) best = p;
  }
  return best;
}

export function selfModifyPath(
  toolName: string,
  input: Record<string, unknown> | null | undefined,
  repoRoot: string,
): string | null {
  const paths = candidatePaths(toolName, input, repoRoot);
  // G5 round 3 item 4: an ambiguous Win32 UNC/device candidate gets the SAME
  // "is this self-modify?" treatment as a proven match — this function's
  // only caller (routes.ts's `!== null` check, gating whether an "always
  // allow" may populate sessionAllow) must never treat "can't verify" as
  // "verified NOT self-modify."
  if (paths.includes(AMBIGUOUS_WIN32_PATH)) return AMBIGUOUS_WIN32_PATH;
  // G5 batch-11 (9th audit) item 5: same "can't verify, treat as if it
  // matched" rule as the Win32 sentinel above, for the `cd` short-circuit.
  if (paths.includes(AMBIGUOUS_CD_PATH)) return AMBIGUOUS_CD_PATH;
  return shortestSelfSurfaceMatch(paths);
}

// Recursive canonical JSON: keys sorted at EVERY depth, arrays keep their
// order (they're semantically positional) but each element is itself
// canonicalized. A plain `JSON.stringify(value, topLevelKeys.sort())` only
// filters/orders the TOP level — the same replacer array is reused at every
// nested level, so any key not present at the top (e.g. MultiEdit's
// `edits[].old_string` / `edits[].new_string`) is silently dropped, and two
// requests that differ only in nested fields collide on the same denyKey.
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.keys(value as Record<string, unknown>).sort();
  const body = entries
    .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`)
    .join(",");
  return `{${body}}`;
}

/** Stable key for the repeated-deny rule: identical (tool, input) pairs.
 *  Sorts object keys at every nesting depth so two DIFFERENT inputs (e.g. two
 *  MultiEdits on the same file with different `edits` contents) never collide
 *  on the same key — see stableStringify above. */
export function denyKey(toolName: string, input: unknown): string {
  let serialized = "";
  try {
    serialized = stableStringify(input);
  } catch {
    serialized = String(input);
  }
  return `${toolName}\u0000${serialized}`;
}

export interface DecideOptions {
  sessionAllow: Set<string>;
  denyCount: number;
  repoRoot: string;
}

/** Apply the rules, in order, to one `can_use_tool` request. */
export function decide(
  mode: string,
  toolName: string,
  input: Record<string, unknown> | null | undefined,
  { sessionAllow, denyCount, repoRoot }: DecideOptions,
): Decision {
  const normalized = normalizePermissionMode(mode);
  if (!normalized) throw new Error(`unknown permission mode: ${JSON.stringify(mode)}`);

  const kind = classify(toolName);
  const paths = candidatePaths(toolName, input, repoRoot);
  const selfPath = shortestSelfSurfaceMatch(paths); // G5 item 7 — see its comment

  const verdict = (action: PermissionAction, reason: string): Decision => ({
    kind,
    action,
    reason,
    selfModify: selfPath !== null,
    selfModifyPath: selfPath,
  });

  // 1. Read-only mode short-circuits everything, including self-modification.
  if (normalized === "readonly") {
    if (kind === "read") return verdict("allow", "Read-only mode allows read-only tools");
    return verdict("deny", "Read-only mode");
  }

  // 2. Self-modification always bubbles, and is never remembered.
  if (selfPath !== null) {
    return verdict("ask", `Modifies the assistant's own surface: ${selfPath}`);
  }

  // 2b. G5 round 3 item 4: a candidate that resolved to AMBIGUOUS_WIN32_PATH
  // (a Win32 UNC or raw device path — see repoRelative's comment) can't be
  // proven either in or out of the repo, so it gets the SAME treatment as a
  // known self-modify match — always ask, in every remaining mode — rather
  // than falling through to trusted's "allow the rest". selfModify/
  // selfModifyPath stay false/null on the returned Decision (we truly
  // don't know the real path), but the verdict itself is exactly as
  // cautious as if it had matched.
  //
  // G5 round 5 item 3: this rule sits ABOVE rule 4 (session-allow) and rule
  // 5 (3x-deny auto-deny) DELIBERATELY — an ambiguous candidate can never be
  // remembered as allowed for the session, and can never auto-deny after
  // three declines either; it re-asks every single time. That is the safe
  // direction (a path this module can't verify must never become a
  // standing "yes" or a silent "no"), not an oversight, even though it
  // means there is no user-reachable way to make the prompt stop for a
  // truly ambiguous path short of it resolving cleanly one way or the
  // other.
  // G5 batch-11 (9th audit) item 5: same treatment as the Win32-ambiguous
  // case below -- always ask, in every remaining mode, never remembered --
  // but with a reason that actually names a `cd` short-circuit instead of
  // reusing the unrelated Win32 device/UNC wording.
  if (paths.includes(AMBIGUOUS_CD_PATH)) {
    return verdict("ask", "Command changes directory; target path cannot be resolved");
  }

  if (paths.includes(AMBIGUOUS_WIN32_PATH)) {
    return verdict("ask", "Path cannot be verified as outside the assistant's own surface (Win32 device/UNC form)");
  }

  // 3. Trusted mode allows the rest.
  if (normalized === "trusted") return verdict("allow", "Trusted mode");

  // 4. Explicitly allowed for this session.
  if (sessionAllow.has(toolName)) return verdict("allow", "Allowed for this session");

  // 5. Declined three times for the identical (tool, input).
  if (denyCount >= 3) return verdict("deny", "declined 3x - not asking again");

  // 6. Accept-edits allows reads and edits that stay inside the repo.
  if (normalized === "accept_edits") {
    if (kind === "read") return verdict("allow", "Accept-edits mode allows read-only tools");
    if (kind === "edit" && paths.length) {
      return verdict("allow", "Accept-edits mode allows edits inside the repo");
    }
    return verdict("ask", "Accept-edits mode asks for this tool");
  }

  // 7. Ask mode: reads are free, everything else bubbles.
  if (kind === "read") return verdict("allow", "Read-only tool");
  return verdict("ask", "Ask mode requires approval for this tool");
}
