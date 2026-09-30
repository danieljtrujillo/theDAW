// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  classify,
  decide,
  denyKey,
  selfModifyPath,
  repoRelative,
  normalizePermissionMode,
  DEFAULT_PERMISSION_MODE,
  AMBIGUOUS_WIN32_PATH,
  AMBIGUOUS_CD_PATH,
  type DecideOptions,
} from "../server/permissions";

// Permission policy regression tests (server/permissions.ts). Pins the mode x
// tool-kind decision matrix ported from theDAW's backend/modules/assistant/
// permissions.py, plus the read-prefix boundary, session-allow, and 3x-deny
// rules the Foundry orb's permission UI depends on.

const REPO_ROOT = "/repo";

function opts(overrides: Partial<DecideOptions> = {}): DecideOptions {
  return {
    sessionAllow: new Set<string>(),
    denyCount: 0,
    repoRoot: REPO_ROOT,
    ...overrides,
  };
}

describe("classify", () => {
  it("classifies known tool names by kind", () => {
    expect(classify("Read")).toBe("read");
    expect(classify("Grep")).toBe("read");
    expect(classify("Edit")).toBe("edit");
    expect(classify("Write")).toBe("edit");
    expect(classify("Bash")).toBe("shell");
    expect(classify("PowerShell")).toBe("shell");
    expect(classify("Agent")).toBe("agent");
    expect(classify("Task")).toBe("agent");
    expect(classify("SomeUnknownTool")).toBe("other");
  });

  it("read-prefix boundary: matches only a full read-verb segment, not a prefix substring", () => {
    // Real read-shaped MCP leaves.
    expect(classify("mcp__server__get_thing")).toBe("read");
    expect(classify("mcp__server__list_files")).toBe("read");
    expect(classify("mcp__server__read_file")).toBe("read");
    expect(classify("mcp__server__status")).toBe("read");
    expect(classify("mcp__server__search_docs")).toBe("read");
    expect(classify("mcp__server__find_symbol")).toBe("read");
    expect(classify("mcp__server__describe_table")).toBe("read");
    // These SHARE a read-verb prefix but are not read tools — the boundary
    // (verb followed by `_` or end-of-string) must exclude them.
    expect(classify("mcp__server__getaway_write")).toBe("mcp");
    expect(classify("mcp__server__listen_and_delete")).toBe("mcp");
    expect(classify("mcp__server__readonly_toggle_off")).toBe("mcp"); // "readonly" != "read" + boundary
    expect(classify("mcp__server__statuses_purge")).toBe("mcp");
    // A genuine write-shaped MCP leaf.
    expect(classify("mcp__server__write_file")).toBe("mcp");
  });
});

describe("decide — readonly mode", () => {
  it("allows read tools", () => {
    const d = decide("readonly", "Read", { file_path: "server/routes.ts" }, opts());
    expect(d.action).toBe("allow");
  });

  it("denies edit tools", () => {
    const d = decide("readonly", "Write", { file_path: "src/App.tsx" }, opts());
    expect(d.action).toBe("deny");
  });

  it("denies shell tools", () => {
    const d = decide("readonly", "Bash", { command: "ls" }, opts());
    expect(d.action).toBe("deny");
  });

  it("denies (not ask) a self-surface edit — readonly short-circuits before the self-modify check", () => {
    const d = decide("readonly", "Write", { file_path: "server/routes.ts" }, opts());
    expect(d.action).toBe("deny");
    expect(d.selfModify).toBe(true);
  });
});

describe("decide — ask mode", () => {
  it("allows read tools", () => {
    const d = decide("ask", "Grep", { pattern: "foo" }, opts());
    expect(d.action).toBe("allow");
  });

  it("asks for a non-self edit", () => {
    const d = decide("ask", "Write", { file_path: "src/App.tsx" }, opts());
    expect(d.action).toBe("ask");
    expect(d.selfModify).toBe(false);
  });

  it("asks for shell tools", () => {
    const d = decide("ask", "Bash", { command: "rm -rf /" }, opts());
    expect(d.action).toBe("ask");
  });

  it("asks (and flags selfModify) for an edit targeting the assistant's own surface", () => {
    const d = decide("ask", "Edit", { file_path: "server/permissions.ts" }, opts());
    expect(d.action).toBe("ask");
    expect(d.selfModify).toBe(true);
    expect(d.selfModifyPath).toBe("server/permissions.ts");
  });
});

describe("decide — accept_edits mode", () => {
  it("allows read tools", () => {
    const d = decide("accept_edits", "Read", { file_path: "src/App.tsx" }, opts());
    expect(d.action).toBe("allow");
  });

  it("allows an edit that resolves to a path inside the repo", () => {
    const d = decide("accept_edits", "Write", { file_path: "src/App.tsx" }, opts());
    expect(d.action).toBe("allow");
  });

  it("asks for an edit whose path cannot be resolved inside the repo", () => {
    const d = decide("accept_edits", "Write", { file_path: "../outside.txt" }, opts());
    expect(d.action).toBe("ask");
  });

  it("asks for shell tools", () => {
    const d = decide("accept_edits", "Bash", { command: "ls" }, opts());
    expect(d.action).toBe("ask");
  });

  it("still asks (never auto-allows) an edit targeting the assistant's own surface", () => {
    const d = decide("accept_edits", "Write", { file_path: "server/claude-bridge.ts" }, opts());
    expect(d.action).toBe("ask");
    expect(d.selfModify).toBe(true);
  });
});

describe("decide — trusted mode", () => {
  it("allows read tools", () => {
    const d = decide("trusted", "Read", { file_path: "src/App.tsx" }, opts());
    expect(d.action).toBe("allow");
  });

  it("allows edit tools", () => {
    const d = decide("trusted", "Write", { file_path: "src/App.tsx" }, opts());
    expect(d.action).toBe("allow");
  });

  it("allows shell tools", () => {
    const d = decide("trusted", "Bash", { command: "ls" }, opts());
    expect(d.action).toBe("allow");
  });

  it("still asks (never auto-allows) an edit targeting the assistant's own surface", () => {
    const d = decide("trusted", "Write", { file_path: "src/components/orb/PermissionModeSelect.tsx" }, opts());
    expect(d.action).toBe("ask");
    expect(d.selfModify).toBe(true);
  });
});

describe("decide — session-allow", () => {
  it("allows a tool the user previously approved for this session, even in ask mode", () => {
    const d = decide(
      "ask",
      "Bash",
      { command: "ls" },
      opts({ sessionAllow: new Set(["Bash"]) }),
    );
    expect(d.action).toBe("allow");
    expect(d.reason).toMatch(/session/i);
  });

  it("does not let session-allow override a self-modify request", () => {
    const d = decide(
      "ask",
      "Edit",
      { file_path: "server/routes.ts" },
      opts({ sessionAllow: new Set(["Edit"]) }),
    );
    expect(d.action).toBe("ask");
    expect(d.selfModify).toBe(true);
  });
});

describe("decide — 3x deny rule", () => {
  it("denies outright once the identical (tool, input) pair has been declined 3 times", () => {
    const input = { command: "curl evil.example" };
    const d = decide("ask", "Bash", input, opts({ denyCount: 3 }));
    expect(d.action).toBe("deny");
    expect(d.reason).toMatch(/3x/);
  });

  it("still asks below the 3x threshold", () => {
    const input = { command: "curl evil.example" };
    const d = decide("ask", "Bash", input, opts({ denyCount: 2 }));
    expect(d.action).toBe("ask");
  });
});

describe("denyKey", () => {
  it("is stable across key order but distinguishes different inputs", () => {
    const a = denyKey("Bash", { command: "ls", cwd: "." });
    const b = denyKey("Bash", { cwd: ".", command: "ls" });
    const c = denyKey("Bash", { command: "rm -rf /" });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("denyKey — m2: recursive stable stringify", () => {
  it("distinguishes two MultiEdits on the SAME file that differ only in nested edits content", () => {
    // A top-level-only key sort (Object.keys(input).sort() used as a
    // JSON.stringify replacer ARRAY) drops any key not present at the top
    // level, at every nested depth - so two MultiEdits on the same file
    // that differ only inside edits[].old_string / edits[].new_string
    // previously collided on the identical denyKey.
    const editA = denyKey("MultiEdit", {
      file_path: "server/routes.ts",
      edits: [{ old_string: "foo", new_string: "bar" }],
    });
    const editB = denyKey("MultiEdit", {
      file_path: "server/routes.ts",
      edits: [{ old_string: "baz", new_string: "qux" }],
    });
    expect(editA).not.toBe(editB);
  });

  it("is stable regardless of nested key order, at every depth", () => {
    const a = denyKey("MultiEdit", {
      file_path: "server/routes.ts",
      edits: [
        { old_string: "foo", new_string: "bar" },
        { old_string: "a", new_string: "b" },
      ],
    });
    const b = denyKey("MultiEdit", {
      edits: [
        { new_string: "bar", old_string: "foo" },
        { new_string: "b", old_string: "a" },
      ],
      file_path: "server/routes.ts",
    });
    expect(a).toBe(b);
  });

  it("preserves array element order (arrays are positional, not sorted)", () => {
    const a = denyKey("MultiEdit", { edits: [{ old_string: "1" }, { old_string: "2" }] });
    const b = denyKey("MultiEdit", { edits: [{ old_string: "2" }, { old_string: "1" }] });
    expect(a).not.toBe(b);
  });
});

describe("repoRelative / selfModifyPath — m4: Win32 long-path prefix and Git-Bash drive form", () => {
  it("strips a Win32 long-path prefix before the repo-root comparison", () => {
    // A raw Win32 \\?\ prefix becomes //?/ once repoRelative converts
    // backslashes to slashes; it must be stripped before the prefix check.
    const raw = String.raw`\\?\C:\repo\server\routes.ts`;
    const rel = repoRelative(raw, "C:\\repo");
    expect(rel).toBe("server/routes.ts");
  });

  it("maps a Git-Bash /c/... path onto the same C:/repo root", () => {
    const rel = repoRelative("/c/repo/server/routes.ts", "C:\\repo");
    expect(rel).toBe("server/routes.ts");
  });

  it("Git-Bash form still resolves outside a differently-lettered repo root", () => {
    const rel = repoRelative("/d/repo/server/routes.ts", "C:\\repo");
    expect(rel).toBeNull();
  });

  it("a real (non-drive) single-letter POSIX directory is not misread as a Git-Bash drive", () => {
    // "/a/server/routes.ts" against POSIX root "/a" must resolve normally -
    // the Git-Bash regex only fires when there is no matching POSIX root.
    const rel = repoRelative("/a/server/routes.ts", "/a");
    expect(rel).toBe("server/routes.ts");
  });

  it("G5 item 2 (regression): a \\\\?\\UNC\\... long path is NOT stripped, and (item 4) yields the ambiguous sentinel, not null", () => {
    // \\?\UNC\evil\share\x.txt -> //?/UNC/evil/share/x.txt after the \ -> /
    // conversion. Only the DRIVE-LETTER form of \\?\ may be stripped -- UNC
    // and raw device paths must keep their //?/... prefix so they never
    // collide with an innocent-looking repo-relative path. Item 4: this is
    // NOT the same as "provably outside the repo" (plain null) -- it cannot
    // be verified either way, so repoRelative signals that distinctly.
    const rel = repoRelative("\\\\?\\UNC\\evil\\share\\x.txt", "C:\\repo");
    expect(rel).toBe(AMBIGUOUS_WIN32_PATH);
  });

  it("G5 item 2 (regression) + item 4: a \\\\?\\GLOBALROOT\\Device\\... raw device path yields the ambiguous sentinel, not null", () => {
    const rel = repoRelative("\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1\\repo\\server\\routes.ts", "C:\\repo");
    expect(rel).toBe(AMBIGUOUS_WIN32_PATH);
  });

  it("the drive-letter form of \\\\?\\ still strips correctly (no regression from the item-2 fix)", () => {
    const rel = repoRelative("\\\\?\\C:\\repo\\server\\routes.ts", "C:\\repo");
    expect(rel).toBe("server/routes.ts");
  });
});

describe("G5 round 3 item 4: an ambiguous Win32 path is never silently allowed", () => {
  it("selfModifyPath returns the ambiguous sentinel (truthy, not null) for a GLOBALROOT device write to the assistant's own file", () => {
    const result = selfModifyPath(
      "Write",
      { file_path: "\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1\\repo\\server\\routes.ts" },
      "C:\\repo",
    );
    expect(result).toBe(AMBIGUOUS_WIN32_PATH);
    expect(result).not.toBeNull();
  });

  it("decide() in TRUSTED mode asks (never allows) a Write whose path is an ambiguous UNC/device form — the exact vulnerability: trusted mode used to ALLOW this outright", () => {
    const d = decide(
      "trusted",
      "Write",
      { file_path: "\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1\\repo\\server\\routes.ts" },
      { sessionAllow: new Set(), denyCount: 0, repoRoot: "C:\\repo" },
    );
    expect(d.action).toBe("ask");
  });

  it("decide() also asks for the UNC form, in every non-readonly mode", () => {
    for (const mode of ["ask", "accept_edits", "trusted"] as const) {
      const d = decide(
        mode,
        "Write",
        { file_path: "\\\\?\\UNC\\evil\\share\\server\\routes.ts" },
        { sessionAllow: new Set(), denyCount: 0, repoRoot: "C:\\repo" },
      );
      expect(d.action).toBe("ask");
    }
  });

  it("readonly mode still denies it outright (at least as strict as ask, no regression)", () => {
    const d = decide(
      "readonly",
      "Write",
      { file_path: "\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1\\repo\\server\\routes.ts" },
      { sessionAllow: new Set(), denyCount: 0, repoRoot: "C:\\repo" },
    );
    expect(d.action).toBe("deny");
  });

  it("an ordinary in-repo path is unaffected (still allowed in trusted, still no ambiguity)", () => {
    const d = decide(
      "trusted",
      "Write",
      { file_path: "src/App.tsx" },
      { sessionAllow: new Set(), denyCount: 0, repoRoot: "C:\\repo" },
    );
    expect(d.action).toBe("allow");
  });
});

describe("G5 round 4 item 1 (CRITICAL): the sentinel covers all three NT-namespace prefixes, not just \\\\?\\", () => {
  const WIN_ROOT = "C:\\repo";

  it.each([
    { label: "\\\\?\\ drive form (device namespace, DOS drive)", raw: "\\\\?\\C:\\repo\\server\\routes.ts" },
    { label: "\\\\.\\ drive form (device namespace)", raw: "\\\\.\\C:\\repo\\server\\routes.ts" },
    { label: "\\??\\ drive form (NT-native namespace)", raw: "\\??\\C:\\repo\\server\\routes.ts" },
  ])("$label opens the same real file but only the plain \\\\?\\ form is safely stripped", ({ raw, label }) => {
    const rel = repoRelative(raw, WIN_ROOT);
    if (label.startsWith("\\\\?\\")) {
      // The one form repoRelative can safely resolve (drive letter
      // immediately follows the known-safe \\?\ prefix).
      expect(rel).toBe("server/routes.ts");
    } else {
      // \\.\ and \??\ are NOT safely resolved — must be ambiguous, never a
      // clean path AND never plain null.
      expect(rel).toBe(AMBIGUOUS_WIN32_PATH);
    }
  });

  it.each([
    { label: "\\\\?\\UNC\\... (UNC share)", raw: "\\\\?\\UNC\\evil\\share\\server\\routes.ts" },
    {
      label: "\\\\?\\GLOBALROOT\\Device\\... (raw device)",
      raw: "\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1\\repo\\server\\routes.ts",
    },
    { label: "\\\\.\\C:\\... (device-namespace drive)", raw: "\\\\.\\C:\\repo\\server\\routes.ts" },
    {
      label: "\\\\.\\GLOBALROOT\\Device\\... (device-namespace device)",
      raw: "\\\\.\\GLOBALROOT\\Device\\HarddiskVolume1\\repo\\server\\routes.ts",
    },
    { label: "\\??\\C:\\... (NT-native drive)", raw: "\\??\\C:\\repo\\server\\routes.ts" },
    {
      label: "\\??\\GLOBALROOT\\Device\\... (NT-native device)",
      raw: "\\??\\GLOBALROOT\\Device\\HarddiskVolume1\\repo\\server\\routes.ts",
    },
  ])("$label resolves to the ambiguous sentinel via repoRelative, selfModifyPath and decide()", ({ raw }) => {
    expect(repoRelative(raw, WIN_ROOT)).toBe(AMBIGUOUS_WIN32_PATH);
    expect(selfModifyPath("Write", { file_path: raw }, WIN_ROOT)).toBe(AMBIGUOUS_WIN32_PATH);

    const d = decide("trusted", "Write", { file_path: raw }, {
      sessionAllow: new Set(),
      denyCount: 0,
      repoRoot: WIN_ROOT,
    });
    // The exact round-4 vulnerability: trusted mode must NEVER silently
    // allow any of these forms.
    expect(d.action).toBe("ask");
  });

  it("a normal absolute path (no NT-namespace prefix at all) must NOT become ambiguous", () => {
    const rel = repoRelative("C:\\repo\\server\\routes.ts", WIN_ROOT);
    expect(rel).toBe("server/routes.ts");
    expect(rel).not.toBe(AMBIGUOUS_WIN32_PATH);

    const d = decide("trusted", "Write", { file_path: "C:\\repo\\src\\App.tsx" }, {
      sessionAllow: new Set(),
      denyCount: 0,
      repoRoot: WIN_ROOT,
    });
    expect(d.action).toBe("allow");
  });

  it("a normal POSIX absolute path is also unaffected", () => {
    const rel = repoRelative("/repo/server/routes.ts", "/repo");
    expect(rel).toBe("server/routes.ts");
    expect(rel).not.toBe(AMBIGUOUS_WIN32_PATH);
  });
});

describe("G5 round 5 item 1 (CRITICAL): five OTHER Windows path spellings that open the same real file, beyond the three named NT-namespace prefixes", () => {
  const WIN_ROOT = "C:\\repo";

  it.each([
    { label: "plain UNC, loopback hostname", raw: "\\\\localhost\\C$\\repo\\server\\routes.ts" },
    { label: "plain UNC, loopback IP", raw: "\\\\127.0.0.1\\C$\\repo\\server\\routes.ts" },
  ])(
    "$label resolves to the ambiguous sentinel via repoRelative, selfModifyPath and decide()",
    ({ raw }) => {
      expect(repoRelative(raw, WIN_ROOT)).toBe(AMBIGUOUS_WIN32_PATH);
      expect(selfModifyPath("Write", { file_path: raw }, WIN_ROOT)).toBe(AMBIGUOUS_WIN32_PATH);

      const d = decide("trusted", "Write", { file_path: raw }, {
        sessionAllow: new Set(),
        denyCount: 0,
        repoRoot: WIN_ROOT,
      });
      // The exact round-5 vulnerability: trusted mode must NEVER silently
      // allow a plain UNC path with no NT-namespace prefix at all.
      expect(d.action).toBe("ask");
    },
  );

  it("drive-relative (`C:server\\routes.ts`, no separator after the colon) is ambiguous, not resolved", () => {
    const raw = "C:server\\routes.ts";
    expect(repoRelative(raw, WIN_ROOT)).toBe(AMBIGUOUS_WIN32_PATH);
    expect(selfModifyPath("Write", { file_path: raw }, WIN_ROOT)).toBe(AMBIGUOUS_WIN32_PATH);

    const d = decide("trusted", "Write", { file_path: raw }, {
      sessionAllow: new Set(),
      denyCount: 0,
      repoRoot: WIN_ROOT,
    });
    expect(d.action).toBe("ask");
  });

  it("trailing dot (`server\\routes.ts.`) canonicalizes to the real self-surface file", () => {
    const raw = "server\\routes.ts.";
    expect(repoRelative(raw, WIN_ROOT)).toBe("server/routes.ts");
    expect(selfModifyPath("Write", { file_path: raw }, WIN_ROOT)).toBe("server/routes.ts");

    const d = decide("trusted", "Write", { file_path: raw }, {
      sessionAllow: new Set(),
      denyCount: 0,
      repoRoot: WIN_ROOT,
    });
    expect(d.action).toBe("ask");
  });

  it("NTFS Alternate Data Stream (`server\\routes.ts::$DATA`) canonicalizes to the real self-surface file", () => {
    const raw = "server\\routes.ts::$DATA";
    expect(repoRelative(raw, WIN_ROOT)).toBe("server/routes.ts");
    expect(selfModifyPath("Write", { file_path: raw }, WIN_ROOT)).toBe("server/routes.ts");

    const d = decide("trusted", "Write", { file_path: raw }, {
      sessionAllow: new Set(),
      denyCount: 0,
      repoRoot: WIN_ROOT,
    });
    expect(d.action).toBe("ask");
  });

  it("Windows 8.3 short name (`ROUTES~1.TS`) is ambiguous, not resolved", () => {
    const raw = "server\\ROUTES~1.TS";
    expect(repoRelative(raw, WIN_ROOT)).toBe(AMBIGUOUS_WIN32_PATH);
    expect(selfModifyPath("Write", { file_path: raw }, WIN_ROOT)).toBe(AMBIGUOUS_WIN32_PATH);

    const d = decide("trusted", "Write", { file_path: raw }, {
      sessionAllow: new Set(),
      denyCount: 0,
      repoRoot: WIN_ROOT,
    });
    expect(d.action).toBe("ask");
  });

  it("`..` traversal still collapses correctly after per-segment canonicalization", () => {
    const raw = "server\\..\\server\\routes.ts";
    expect(repoRelative(raw, WIN_ROOT)).toBe("server/routes.ts");
  });
});

describe("selfModifyPath — G5 item 7: shortest matching variant, not the raw glued token", () => {
  it("reports the clean split path, not the raw token with a glued shell separator still attached", () => {
    // "src/components/orb/**" matches via its trailing `.*`, so the RAW,
    // unsplit token "src/components/orb/AIAssistantOrb.tsx&&ls" is itself a
    // (junk-suffixed) match -- exactly like the clean split piece
    // "src/components/orb/AIAssistantOrb.tsx" is. Both are valid matches;
    // the shortest one must win.
    const result = selfModifyPath(
      "Bash",
      { command: "cmd src/components/orb/AIAssistantOrb.tsx&&ls" },
      "/repo",
    );
    expect(result).toBe("src/components/orb/AIAssistantOrb.tsx");
  });

  it("same, through decide()'s selfModifyPath reporting", () => {
    const d = decide(
      "ask",
      "Bash",
      { command: "cmd src/components/orb/AIAssistantOrb.tsx&&ls" },
      { sessionAllow: new Set(), denyCount: 0, repoRoot: "/repo" },
    );
    expect(d.selfModify).toBe(true);
    expect(d.selfModifyPath).toBe("src/components/orb/AIAssistantOrb.tsx");
  });
});

describe("M2 - table-driven selfModifyPath / decide coverage", () => {
  const POSIX_ROOT = "/repo";
  const WIN_ROOT = "C:\\repo";

  describe.each([
    { label: "POSIX root", root: POSIX_ROOT },
    { label: "Windows root", root: WIN_ROOT },
  ])("$label", ({ root }) => {
    const drivePrefix = root === WIN_ROOT ? "C:\\repo\\" : "/repo/";
    const sep = root === WIN_ROOT ? "\\" : "/";

    it("dot-dot traversal that stays inside the repo still resolves to the self-surface path", () => {
      const raw = drivePrefix + "sub" + sep + ".." + sep + "server" + sep + "routes.ts";
      expect(selfModifyPath("Write", { file_path: raw }, root)).toBe("server/routes.ts");
    });

    it("dot-dot traversal that escapes the repo resolves to null (not self-modify, not even in-repo)", () => {
      const raw =
        root === WIN_ROOT ? "C:\\repo\\..\\Windows\\System32\\cmd.exe" : "/repo/../etc/passwd";
      expect(repoRelative(raw, root)).toBeNull();
      expect(selfModifyPath("Write", { file_path: raw }, root)).toBeNull();
    });

    it("mixed-case path still matches the self-surface glob but keeps the caller's casing in the report", () => {
      const raw = root === WIN_ROOT ? "C:\\Repo\\SERVER\\Routes.TS" : "/repo/SERVER/Routes.TS";
      expect(selfModifyPath("Write", { file_path: raw }, root)).toBe("SERVER/Routes.TS");
    });

    it("backslashes resolve the same as forward slashes for a self-surface path", () => {
      const raw = drivePrefix + "server" + sep + "routes.ts";
      expect(selfModifyPath("Write", { file_path: raw }, root)).toBe("server/routes.ts");
    });

    it("a path outside the repo (different top-level dir / drive) resolves to null", () => {
      const raw = root === WIN_ROOT ? "D:\\other\\server\\routes.ts" : "/other/server/routes.ts";
      expect(repoRelative(raw, root)).toBeNull();
      expect(selfModifyPath("Write", { file_path: raw }, root)).toBeNull();
    });

    // Glued shell-redirect / flag tokens - all must resolve to the
    // self-surface path "server/routes.ts" once the shell command is
    // tokenized.
    const gluedCases: Array<{ name: string; cmd: string }> = [
      { name: "trailing semicolon after a bare redirect", cmd: "cmd >server/routes.ts;" },
      { name: "space before the redirect, glued && after", cmd: "cmd > server/routes.ts&&ls" },
      { name: "clobber-overwrite redirect, no space", cmd: "cmd >|server/routes.ts" },
      { name: "glued long-flag value", cmd: "cmd --out=server/routes.ts" },
      { name: "glued colon flag value (PowerShell)", cmd: "cmd -Path:server/routes.ts" },
      { name: "input redirect, no space", cmd: "cmd <server/routes.ts" },
      { name: "fd-specific append redirect", cmd: "cmd 2>>server/routes.ts" },
      { name: "parenthesized subshell", cmd: "(echo x >server/routes.ts)" },
    ];
    it.each(gluedCases)("shell command with $name extracts the self-surface path from Bash input", ({ cmd }) => {
      expect(selfModifyPath("Bash", { command: cmd }, root)).toBe("server/routes.ts");
    });
  });

  // Kind coverage (agent / mcp-write / other) in ask + accept_edits: none of
  // these kinds get auto-allowed by either mode - only "read" (both modes)
  // and "edit"-with-a-resolvable-path (accept_edits only) do.
  describe.each(["ask", "accept_edits"] as const)("mode=%s", (mode) => {
    const kindCases: Array<{ label: string; toolName: string; input: Record<string, unknown> }> = [
      { label: "agent (Task)", toolName: "Task", input: { prompt: "do work" } },
      { label: "agent (Agent)", toolName: "Agent", input: {} },
      { label: "mcp-write (no read-prefix)", toolName: "mcp__server__write_file", input: { path: "x" } },
      { label: "other (unrecognized tool)", toolName: "SomeToolNobodyDeclared", input: {} },
    ];
    it.each(kindCases)("$label always asks, never auto-allows", ({ toolName, input }) => {
      const d = decide(mode, toolName, input, { sessionAllow: new Set(), denyCount: 0, repoRoot: POSIX_ROOT });
      expect(d.action).toBe("ask");
    });
  });
});

describe("DEFAULT_PERMISSION_MODE - Foundry default is trusted", () => {
  it("the Foundry's default constant is trusted (theDAW's Python default stays ask, separately)", () => {
    expect(DEFAULT_PERMISSION_MODE).toBe("trusted");
  });

  it("an absent/invalid mode normalizes to null, so callers falling back to DEFAULT_PERMISSION_MODE resolve to trusted", () => {
    expect(normalizePermissionMode(undefined) ?? DEFAULT_PERMISSION_MODE).toBe("trusted");
    expect(normalizePermissionMode(null) ?? DEFAULT_PERMISSION_MODE).toBe("trusted");
    expect(normalizePermissionMode("not-a-mode") ?? DEFAULT_PERMISSION_MODE).toBe("trusted");
    expect(normalizePermissionMode("") ?? DEFAULT_PERMISSION_MODE).toBe("trusted");
  });

  it("self-modify still asks even under the trusted default (policy invariant holds under the new default)", () => {
    const d = decide(
      DEFAULT_PERMISSION_MODE,
      "Write",
      { file_path: "server/permissions.ts" },
      { sessionAllow: new Set(), denyCount: 0, repoRoot: "/repo" },
    );
    expect(d.action).toBe("ask");
    expect(d.selfModify).toBe(true);
  });
});

describe("repoRelative / selfModifyPath / decide — G5 batch-11 fixup: drive-root-relative absolute paths", () => {
  // A Windows drive-root-relative absolute path (`\repo\...` / `/repo/...`,
  // no drive letter, no `//` or `/??/` root, and NOT the single-letter
  // Git-Bash `/c/...` form) used to fail the repo-root prefix comparison and
  // return bare `null` -- "provably outside the repo" -- even though it
  // names the real repo file, because on Windows such a path is relative to
  // the CURRENT DRIVE and PROJECT_CWD is always repoRoot.
  const WIN_ROOT = "C:\\repo";
  const BACKSLASH = "\\repo\\server\\routes.ts";
  const FORWARD = "/repo/server/routes.ts";
  const MIXED = "\\repo/server\\routes.ts";
  const TRAVERSAL = "\\repo\\server\\..\\server\\routes.ts";

  it.each([
    ["backslash", BACKSLASH],
    ["forward", FORWARD],
    ["mixed", MIXED],
    ["traversal", TRAVERSAL],
  ])("%s form normalises to the repo-relative posix path", (_name, raw) => {
    expect(repoRelative(raw, WIN_ROOT)).toBe("server/routes.ts");
  });

  it.each([
    ["backslash", BACKSLASH],
    ["forward", FORWARD],
    ["mixed", MIXED],
    ["traversal", TRAVERSAL],
  ])("%s form: decide() in TRUSTED mode never allows a self-surface write — the exact vulnerability", (_name, raw) => {
    const d = decide(
      "trusted",
      "Write",
      { file_path: raw },
      { sessionAllow: new Set(), denyCount: 0, repoRoot: WIN_ROOT },
    );
    expect(d.action).toBe("ask");
    expect(d.selfModify).toBe(true);
    expect(d.selfModifyPath).toBe("server/routes.ts");
  });

  it("a session-allowed Write still asks for a drive-root-relative self-surface path (never-remembered self-modify rule)", () => {
    const canonical = decide(
      "ask",
      "Write",
      { file_path: "server/routes.ts" },
      { sessionAllow: new Set(["Write"]), denyCount: 0, repoRoot: WIN_ROOT },
    );
    expect(canonical.action).toBe("ask");

    const rootRelative = decide(
      "ask",
      "Write",
      { file_path: BACKSLASH },
      { sessionAllow: new Set(["Write"]), denyCount: 0, repoRoot: WIN_ROOT },
    );
    expect(rootRelative.action).toBe("ask");
    expect(rootRelative.selfModify).toBe(true);
  });

  it("does not affect /etc/passwd (still outside the repo)", () => {
    expect(repoRelative("/etc/passwd", WIN_ROOT)).toBeNull();
  });

  it("does not affect the Git-Bash /c/... form (still resolves the same as before)", () => {
    expect(repoRelative("/c/repo/server/routes.ts", WIN_ROOT)).toBe("server/routes.ts");
  });
});

describe("G5 round 6: cd/pushd-prefixed shell writes are ambiguous, not resolved", () => {
  // G5 batch-11 (9th audit) item 5: plain cd/pushd short-circuits now
  // report the distinct AMBIGUOUS_CD_PATH sentinel, not the Win32-device/
  // UNC one -- same "ask, always" treatment, clearer reason.
  it.each([
    "cd server && echo x > routes.ts",
    "cd server; echo x > routes.ts",
    "pushd server && echo x > routes.ts",
  ])("%s -> AMBIGUOUS_CD_PATH", (command) => {
    expect(selfModifyPath("Bash", { command }, "/repo")).toBe(AMBIGUOUS_CD_PATH);
  });

  it.each(["trusted", "accept_edits", "ask"] as const)(
    "decide() in %s mode asks (never allows) a cd-prefixed write",
    (mode) => {
      const d = decide(
        mode,
        "Bash",
        { command: "cd server && echo x > routes.ts" },
        { sessionAllow: new Set(["Bash"]), denyCount: 0, repoRoot: "/repo" },
      );
      expect(d.action).toBe("ask");
    },
  );

  it("readonly mode still denies a cd-prefixed write", () => {
    const d = decide(
      "readonly",
      "Bash",
      { command: "cd server && echo x > routes.ts" },
      { sessionAllow: new Set(), denyCount: 0, repoRoot: "/repo" },
    );
    expect(d.action).toBe("deny");
  });
});

describe("G5 round 6: a bare self-surface directory (no trailing slash) is a self-modify match", () => {
  it.each([
    ["rm -rf src/components/orb", "src/components/orb"],
    ["rm -rf src/orb-kit-skin", "src/orb-kit-skin"],
  ])("%s -> %s", (command, expected) => {
    expect(selfModifyPath("Bash", { command }, "/repo")).toBe(expected);
  });

  it("decide() in trusted mode asks for a bare self-surface directory rm", () => {
    const d = decide(
      "trusted",
      "Bash",
      { command: "rm -rf src/components/orb" },
      { sessionAllow: new Set(), denyCount: 0, repoRoot: "/repo" },
    );
    expect(d.action).toBe("ask");
    expect(d.selfModify).toBe(true);
    expect(d.selfModifyPath).toBe("src/components/orb");
  });

  it("the existing trailing-slash spelling still matches (no regression)", () => {
    expect(selfModifyPath("Bash", { command: "rm -rf src/components/orb/" }, "/repo")).toBe(
      "src/components/orb",
    );
  });
});

describe("G5 round 6 item 3 (parity): comma splits bare-string arguments inside a quoted one-liner", () => {
  it("python -c \"open('server/routes.ts','w')\" is detected as a self-surface write", () => {
    const result = selfModifyPath(
      "Bash",
      { command: "python -c \"open('server/routes.ts','w')\"" },
      "/repo",
    );
    expect(result).toBe("server/routes.ts");
  });
});

// --- G5 batch-11 (7th audit) ------------------------------------------------
// The cd/pushd short-circuit was whitespace-sensitive and quote-blind (missed
// paren-glued and nested-shell spellings), the PowerShell aliases of cd were
// never covered, a backslash was always read as a path separator even for
// shell commands (where it can be a POSIX escape), and the cd short-circuit
// over-asked on every read-only `cd`-prefixed command including the ones
// CLAUDE.md documents.

describe("G5 batch-11 item 1: paren-glued cd spellings are ambiguous", () => {
  // G5 batch-11 (9th audit) item 5: plain (non-nested-shell) cd/pushd
  // spellings report AMBIGUOUS_CD_PATH now; see the nested-shell describe
  // block below for the ones that still report AMBIGUOUS_WIN32_PATH.
  it.each([
    "(cd server; echo x > routes.ts)",
    "(pushd server; echo x > routes.ts; popd)",
  ])("%s -> AMBIGUOUS_CD_PATH", (command) => {
    expect(selfModifyPath("Bash", { command }, "/repo")).toBe(AMBIGUOUS_CD_PATH);
  });

  it("control: a space right after the paren was already caught before this fix (no regression)", () => {
    expect(
      selfModifyPath("Bash", { command: "( cd server; echo x > routes.ts )" }, "/repo"),
    ).toBe(AMBIGUOUS_CD_PATH);
  });
});

describe("G5 batch-11 item 1: nested-shell cd spellings are ambiguous", () => {
  it.each([
    'bash -c "cd server && echo x > routes.ts"',
    "sh -c 'cd server && echo x > routes.ts'",
  ])("%s -> AMBIGUOUS_WIN32_PATH", (command) => {
    expect(selfModifyPath("Bash", { command }, "/repo")).toBe(AMBIGUOUS_WIN32_PATH);
  });
});

describe("G5 batch-11 item 2: every PowerShell cd alias is ambiguous when writing", () => {
  // G5 batch-11 (9th audit) item 5: plain cd-alias short-circuits report
  // AMBIGUOUS_CD_PATH now, not the Win32-device/UNC sentinel.
  it.each([
    "chdir server; echo x > routes.ts",
    "Set-Location server; Set-Content routes.ts x",
    "sl server; ni routes.ts",
    "pushd server; echo x > routes.ts; popd",
    "popd; echo x > routes.ts",
    "push-location server; echo x > routes.ts",
    "pop-location; echo x > routes.ts",
  ])("%s -> AMBIGUOUS_CD_PATH", (command) => {
    expect(selfModifyPath("Bash", { command }, "/repo")).toBe(AMBIGUOUS_CD_PATH);
  });
});

describe("G5 batch-11 item 3: backslash-as-escape shell spellings are detected", () => {
  it("echo x > serv\\er/routes.ts -> server/routes.ts (backslash read as escape)", () => {
    const result = selfModifyPath("Bash", { command: "echo x > serv\\er/routes.ts" }, "/repo");
    expect(result).toBe("server/routes.ts");
  });

  it("echo x > se\\rver/routes.ts -> server/routes.ts (backslash read as escape)", () => {
    const result = selfModifyPath("Bash", { command: "echo x > se\\rver/routes.ts" }, "/repo");
    expect(result).toBe("server/routes.ts");
  });

  it("Edit kind keeps backslash-as-separator only (no escape-reading variant)", () => {
    const result = selfModifyPath("Write", { file_path: "server\\routes.ts" }, "/repo");
    expect(result).toBe("server/routes.ts");
  });

  it("a genuine Windows drive path is not corrupted by the escape variant", () => {
    const result = selfModifyPath(
      "Bash",
      { command: "python gen.py --out=C:\\repo\\server\\routes.ts" },
      "/repo",
    );
    expect(result).toBe("server/routes.ts");
  });
});

describe("G5 batch-11 item 4 (parity): unbounded quote-fragment splits are detected", () => {
  it.each([
    'echo x > "s""e""r""v""e""r"/routes.ts', // 6 fragments
    'echo x > "ser""ver"/routes.ts', // 2 fragments
    'echo x > "s""e""r""v""e""r""/""r""o""u""t""e""s"".""t""s"', // 14+ fragments
  ])("%s -> server/routes.ts", (command) => {
    expect(selfModifyPath("Bash", { command }, "/repo")).toBe("server/routes.ts");
  });
});

describe("G5 batch-11 item 5: real-space joins no longer fabricate a match", () => {
  it.each(["ls server/ routes.ts", "git add server/ routes.ts"])(
    "%s -> null (no self-surface match)",
    (command) => {
      expect(selfModifyPath("Bash", { command }, "/repo")).toBeNull();
    },
  );
});

describe("G5 batch-11 item 6: cd-prefixed CLAUDE.md-shaped commands allow in trusted, unless paired with a write", () => {
  it.each([
    "cd frontend && npm run build",
    "cd frontend && npm run lint:classes",
    "cd frontend && npx tsc --noEmit",
    "cd backend && uv run pytest",
    "cd VST-Foundry-UI/VST-UI-FOUNDRY && npx vitest run",
    "cd /tmp && ls",
  ])("%s -> allow in trusted mode", (command) => {
    const d = decide(
      "trusted",
      "Bash",
      { command },
      { sessionAllow: new Set(), denyCount: 0, repoRoot: "/repo" },
    );
    expect(d.action).toBe("allow");
  });

  it.each([
    "cd server && rm -rf routes.ts",
    "cd server && echo x > routes.ts",
    "chdir server && git checkout routes.ts",
    "cd server; sed -i s/x/y/ routes.ts",
  ])("%s -> still asks in trusted mode (cd + write signal)", (command) => {
    const d = decide(
      "trusted",
      "Bash",
      { command },
      { sessionAllow: new Set(), denyCount: 0, repoRoot: "/repo" },
    );
    expect(d.action).toBe("ask");
  });
});

describe("G5 batch-11: cd word-boundary false positives still allow", () => {
  it.each(["cdk", "npx cdk synth", "procd", "--cd", "notes-cd.txt", "cd-rom.iso", "cdimage", "CD=1 make"])(
    "%s -> allow in trusted mode",
    (command) => {
      const d = decide(
        "trusted",
        "Bash",
        { command },
        { sessionAllow: new Set(), denyCount: 0, repoRoot: "/repo" },
      );
      expect(d.action).toBe("allow");
    },
  );
});

describe("G5 batch-11 (8th audit) item 1 CRITICAL: write-signal blacklist -> read-only allowlist", () => {
  it.each([
    "cd server && python - <<'EOT'\nopen('routes.ts','w')\nEOT",
    "cd server && node -e \"require('fs').writeFileSync('routes.ts','')\"",
    "cd server && perl -i -pe 's/a/b/' routes.ts",
    "cd server && sed -i.bak s/a/b/ routes.ts",
    "cd server && install -m 644 /dev/null routes.ts",
    "cd server && patch < p.diff",
    "cd server && git apply p.diff",
    "cd server && tar xf a.tar",
    "cd server && gcc -o routes.ts x.c",
    "cd server && Copy-Item a routes.ts",
    "cd server && New-Item -Force routes.ts",
    "cd server && Remove-Item routes.ts",
    "cd server && ri routes.ts",
  ])("%s -> ask in trusted mode (proven writer, missed by the old blacklist)", (command) => {
    const d = decide(
      "trusted",
      "Bash",
      { command },
      { sessionAllow: new Set(), denyCount: 0, repoRoot: "/repo" },
    );
    expect(d.action).toBe("ask");
  });

  it.each([
    "cd frontend && npm run build",
    "cd frontend && npm run lint:classes",
    "cd frontend && npx tsc --noEmit",
    "cd backend && uv run pytest",
    "cd VST-Foundry-UI/VST-UI-FOUNDRY && npx vitest run",
    "cd /tmp && ls",
  ])("%s -> still allow in trusted mode (documented CLAUDE.md shape)", (command) => {
    const d = decide(
      "trusted",
      "Bash",
      { command },
      { sessionAllow: new Set(), denyCount: 0, repoRoot: "/repo" },
    );
    expect(d.action).toBe("allow");
  });
});

describe("G5 batch-11 (8th audit) item 2 (parity): uppercase -C is excluded from the nested-shell check", () => {
  it.each([
    "tar -C server -xf a.tar && sh",
    "make -C src ; bash",
    "git -C x log | sh",
    "sh -C foo",
  ])("%s -> not AMBIGUOUS_WIN32_PATH (no cd token, no nested-shell -c/-Command flag)", (command) => {
    expect(selfModifyPath("Bash", { command }, "/repo")).not.toBe(AMBIGUOUS_WIN32_PATH);
  });
});

describe("G5 batch-11 (8th audit) item 3: drive-root traversal clamps instead of popping the drive", () => {
  it("C:/a/../../server/routes.ts against C:/proj/repo -> null, not a false self-modify match", () => {
    expect(repoRelative("C:/a/../../server/routes.ts", "C:/proj/repo")).toBeNull();
  });
});

describe("G5 batch-11 (8th audit) item 4 (parity): doubled surrounding quotes are fully stripped", () => {
  it('""server/routes.ts"" -> server/routes.ts', () => {
    expect(selfModifyPath("Edit", { file_path: '""server/routes.ts""' }, "/repo")).toBe(
      "server/routes.ts",
    );
  });
});

describe("G5 batch-11 (8th audit) item 5 (note, folded in): /bin/sh -c '...' is detected as a nested shell", () => {
  it.each([
    "/bin/sh -c 'cd server && rm -rf routes.ts'",
    "sh -c 'cd server; rm -rf routes.ts'",
  ])("%s -> AMBIGUOUS_WIN32_PATH", (command) => {
    expect(selfModifyPath("Bash", { command }, "/repo")).toBe(AMBIGUOUS_WIN32_PATH);
  });
});

describe("G5 batch-11 (8th audit): cd word-boundary false positives still allow (regression guard)", () => {
  it.each([
    "cdk",
    "npx cdk synth",
    "procd",
    "--cd",
    "notes-cd.txt",
    "cd-rom.iso",
    "cdimage",
    "CD=1 make",
    "my.sl",
  ])("%s -> allow in trusted mode", (command) => {
    const d = decide(
      "trusted",
      "Bash",
      { command },
      { sessionAllow: new Set(), denyCount: 0, repoRoot: "/repo" },
    );
    expect(d.action).toBe("allow");
  });
});

describe("G5 batch-11 (9th audit) items 1/2 CRITICAL: metachar-tail bypasses now ask", () => {
  it.each([
    "cd server && uv run pytest ; echo x > routes.ts",
    "cd server && uv run pytest ; rm -f routes.ts",
    "cd server && uv run pytest && rm -rf server/permissions.ts",
    "cd server && uv run pytest > routes.ts",
    "cd server && uv run pytest | tee routes.ts",
    "cd server && uv run pytest ; git checkout -- .",
    "cd server && uv run pytest ; rm -f permissions.ts",
    "cd server && npm run lint>routes.ts",
    "cd server && npm run lint>>routes.ts",
    "cd server && npm run lint;>routes.ts",
    "cd server && npm run lint>permissions.ts",
  ])("%s -> ask in trusted mode (universal wildcard / glued-redirect bypass)", (command) => {
    const d = decide(
      "trusted",
      "Bash",
      { command },
      { sessionAllow: new Set(), denyCount: 0, repoRoot: "/repo" },
    );
    expect(d.action).toBe("ask");
  });
});

describe("G5 batch-11 (9th audit) item 3 MAJOR: widened tails now allow in trusted", () => {
  // G5 batch-11 (10th audit) note: "cd server && npm run fix:classes" and
  // "cd server && uv run ruff check ." were removed from this list -- the
  // 10th audit proved both to be writers (fix:classes rewrites files under
  // the orb-kit self-surface glob; bare `ruff check .` is one `--fix`
  // token away from writing) that this allowlist must never grant. They
  // are asserted as "ask" in the round-10 proven-writers block below,
  // which supersedes their prior inclusion here.
  //
  // G5 round 12 (11th audit) note: "cd /tmp && ls -la", "cd /tmp && cat
  // routes.ts", "cd server && git log --oneline -5", and "cd server && git
  // status --short" were removed from this list -- all four carry a
  // flag/argument, which the round-12 exact-literal-invocation rewrite (see
  // the comment above KNOWN_READ_ONLY_TAILS in server/permissions.ts) no
  // longer admits. They are asserted as "ask" in the round-12
  // flag-bearing-variants block below, which supersedes their prior
  // inclusion here.
  //
  // G5 round 13 (12th audit) item 1 note: "cd server && npm run test:sing"
  // and "cd server && uv run ruff format --check ." were removed from this
  // list -- "server" is a source subdirectory, not a package/project root
  // (VST-Foundry-UI/VST-UI-FOUNDRY has no server/package.json; running npm
  // from inside it can silently pick up an attacker-planted
  // server/package.json rather than walking up to the real one), so it is
  // not in the round-13 closed directory set (SAFE_PROJECT_DIRS) an
  // `npm`/`npx`/`uv run` tail must now be run from. They are asserted as
  // "ask" in the round-13 closed-directory-set block below, which
  // supersedes their prior inclusion here.
  it.each(["cd frontend && npm test"])("%s -> allow in trusted mode", (command) => {
    const d = decide(
      "trusted",
      "Bash",
      { command },
      { sessionAllow: new Set(), denyCount: 0, repoRoot: "/repo" },
    );
    expect(d.action).toBe("allow");
  });

  it("bare 'cd server' with no tail -> allow in trusted mode", () => {
    const d = decide(
      "trusted",
      "Bash",
      { command: "cd server" },
      { sessionAllow: new Set(), denyCount: 0, repoRoot: "/repo" },
    );
    expect(d.action).toBe("allow");
  });
});

describe("G5 batch-11 (9th audit) item 5 MINOR: cd-ambiguous reason names the cause", () => {
  it("cd server && echo hi -> ask with a cd-specific reason, not the Win32 wording", () => {
    const d = decide(
      "trusted",
      "Bash",
      { command: "cd server && echo hi" },
      { sessionAllow: new Set(), denyCount: 0, repoRoot: "/repo" },
    );
    expect(d.action).toBe("ask");
    expect(d.reason).toBe("Command changes directory; target path cannot be resolved");
    expect(d.reason).not.toContain("Win32");
  });

  it("selfModifyPath surfaces AMBIGUOUS_CD_PATH for the same ambiguous cd command", () => {
    expect(selfModifyPath("Bash", { command: "cd server && echo hi" }, "/repo")).toBe(
      AMBIGUOUS_CD_PATH,
    );
  });
});

describe("G5 batch-11 (10th audit) items 1/2/3/5: proven writers ask in trusted", () => {
  // G5 round 12 (11th audit) note: "cd server && uv run ruff check ." was
  // removed from this ask-list -- round 10 excluded it out of caution
  // because its then flag-based allowlist could not structurally tell "no
  // --fix today" from "no --fix ever" ("--fix" was "one token away").
  // Round 12's exact-literal rewrite (KNOWN_READ_ONLY_TAILS) makes that
  // distinction moot: "uv run ruff check ." is a documented CLAUDE.md
  // hard-rule-2 command, is genuinely read-only, and -- being an exact
  // literal with no argument tail admitted at all -- can never have --fix
  // appended to it. It is now correctly asserted as "allow" in the
  // round-10 regression-guard block below.
  it.each([
    // item 1: ruff's default write modes must ask, not just its --fix flags.
    "cd server && uv run ruff format .",
    "cd server && uv run ruff check --fix .",
    // item 2: git --output creates/truncates the named file.
    "cd server && git diff --output=server/permissions.ts HEAD",
    "cd server && git show --output=server/permissions.ts HEAD --stat",
    // item 3: npm/pnpm/yarn subcommands other than `run <safe-script>`, and
    // `run <script>` with args that redirect its output elsewhere.
    "cd server && npm run fix:classes",
    "cd server && npm install",
    "cd server && npm install evil-pkg",
    "cd server && npm ci",
    "cd server && npm exec -- rimraf .",
    "cd server && yarn add evil",
    "cd server && pnpm dlx anything",
    "cd server && npm run build --prefix ../backend",
    "cd server && npm run build -- --outDir ../../backend",
    // item 5: pytest importing an arbitrary file/module outside tests/.
    "cd server && uv run pytest evil.py",
    "cd server && uv run pytest conftest.py",
  ])("%s -> ask in trusted mode", (command) => {
    const d = decide(
      "trusted",
      "Bash",
      { command },
      { sessionAllow: new Set(), denyCount: 0, repoRoot: "/repo" },
    );
    expect(d.action).toBe("ask");
  });
});

describe("G5 batch-11 (10th audit) item 4 CRITICAL: separator-glued cd asks in trusted", () => {
  it.each([
    "cd server&&../tools/x.sh",
    "cd server&&make",
    "cd server&&./evil.sh",
    "cd server&&rm -rf .",
  ])("%s -> ask in trusted mode", (command) => {
    const d = decide(
      "trusted",
      "Bash",
      { command },
      { sessionAllow: new Set(), denyCount: 0, repoRoot: "/repo" },
    );
    expect(d.action).toBe("ask");
  });

  it("cd server && ls (with a space) still allows in trusted mode", () => {
    const d = decide(
      "trusted",
      "Bash",
      { command: "cd server && ls" },
      { sessionAllow: new Set(), denyCount: 0, repoRoot: "/repo" },
    );
    expect(d.action).toBe("allow");
  });
});

describe("G5 round 12 (11th audit) item 1 CRITICAL: separator-glued cd with a trailing allowlisted command still asks in trusted", () => {
  // The identical `\S+` flaw round 10 fixed in the bare-cd regex was never
  // carried over to the cd-to-safe-tail regex -- greedy over non-whitespace,
  // it swallowed a separator-glued second command whole, so the capture
  // group (meant to be the WHOLE tail) was only the LAST segment, and only
  // that segment was checked against the allowlist. Proven live:
  // "cd server&&./evil.sh&&ls" resolved "allow" (tail captured as bare
  // "ls") on both ports and wrote an arbitrary-execution marker.
  it.each([
    "cd server&&./evil.sh&&ls",
    "cd server&&../tools/wipe.sh&&cat",
    "cd server&&evil.exe&&ls",
    "cd server&&C:/evil.bat&&cat",
    "cd server&&./evil.sh&&npm run build",
  ])("%s -> ask in trusted mode", (command) => {
    const d = decide(
      "trusted",
      "Bash",
      { command },
      { sessionAllow: new Set(), denyCount: 0, repoRoot: "/repo" },
    );
    expect(d.action).toBe("ask");
  });
});

describe("G5 batch-11 (10th audit) regression guard: surviving positives still allow in trusted", () => {
  // G5 round 12 (11th audit) note: this list previously also asserted
  // "uv run pytest -q"/"tests -q"/"tests/permissions.test.ts -q",
  // "uv run ruff check/format --diff .", and "git diff/show HEAD ..." as
  // "allow" -- exactly the CRITICAL 2/3 flag-tolerance holes round 12
  // closes. They are asserted as "ask" in the round-12 flag-bearing-variants
  // block below, which supersedes their prior inclusion here.
  //
  // G5 round 13 (12th audit) item 1 note: "cd server && uv run pytest",
  // "cd server && uv run pytest tests/test_inference.py", "cd server && uv
  // run pytest --save-audio", "cd server && uv run ruff check", "cd server
  // && uv run ruff check .", "cd server && uv run ruff format --check",
  // "cd server && npm run lint", "cd server && npm test", and "cd server &&
  // npx vitest run" were removed from this list -- "server" is not in the
  // round-13 closed directory set (see the item 3 MAJOR block's round-13
  // note above for why). The four bare `git` tails and the `cd frontend`
  // tails stay here: `git status`/`log`/`diff`/`show` are INERT and remain
  // admitted from any directory, and `frontend` is in the closed set. The
  // nine removed ones are asserted as "ask" in the round-13
  // closed-directory-set block below, which supersedes their prior
  // inclusion here.
  it.each([
    "cd server && git status",
    "cd server && git log",
    "cd server && git diff",
    "cd server && git show",
    "cd frontend && npm run lint",
    "cd frontend && npm run lint:scripts",
    "cd frontend && npm run build",
  ])("%s -> allow in trusted mode", (command) => {
    const d = decide(
      "trusted",
      "Bash",
      { command },
      { sessionAllow: new Set(), denyCount: 0, repoRoot: "/repo" },
    );
    expect(d.action).toBe("allow");
  });
});

describe("G5 round 12 (11th audit) items 2/3 CRITICAL: flag-bearing variants of allowlisted tails still ask in trusted", () => {
  it.each([
    // Finding 2: every proven pytest output-path flag.
    "cd server && uv run pytest -q",
    "cd server && uv run pytest tests -q",
    "cd server && uv run pytest tests/permissions.test.ts -q",
    "cd server && uv run pytest --junitxml=rag.py",
    "cd server && uv run pytest --debug=rag.py",
    "cd server && uv run pytest --basetemp=modules",
    "cd server && uv run pytest --cov-report=xml:rag.py",
    "cd server && uv run pytest -ocache_dir=modules/assistant/junk",
    "cd server && uv run pytest -pmyplug",
    // Finding 3: every proven ruff output-path flag, including with a
    // --diff/--check preview flag also present.
    "cd server && uv run ruff check --diff -o rag.py .",
    "cd server && uv run ruff check --diff --output-file=rag.py .",
    "cd server && uv run ruff format --check -o rag.py .",
    "cd server && uv run ruff check --diff --cache-dir=modules/assistant/x",
    "cd server && uv run ruff check --diff .",
    "cd server && uv run ruff format --diff .",
    // git with any argument at all.
    "cd server && git diff HEAD",
    "cd server && git show HEAD --stat",
    "cd server && git log --oneline -5",
    "cd server && git status --short",
    // Bare read-only primitives with any argument at all.
    "cd server && ls -la",
    "cd server && cat routes.ts",
  ])("%s -> ask in trusted mode", (command) => {
    const d = decide(
      "trusted",
      "Bash",
      { command },
      { sessionAllow: new Set(), denyCount: 0, repoRoot: "/repo" },
    );
    expect(d.action).toBe("ask");
  });
});

describe("G5 batch-11 (10th audit) item 6 MINOR: unicode line separator in tail asks in trusted", () => {
  it.each(["cd server && ls\u2028rm -rf .", "cd server && ls\u2029rm -rf ."])(
    "%s -> ask in trusted mode",
    (command) => {
      const d = decide(
        "trusted",
        "Bash",
        { command },
        { sessionAllow: new Set(), denyCount: 0, repoRoot: "/repo" },
      );
      expect(d.action).toBe("ask");
    },
  );
});

describe("G5 round 12 (11th audit) item 4: every allowlisted literal with an appended argument asks in trusted", () => {
  // The property, not just the proven spellings. KNOWN_READ_ONLY_TAILS
  // (server/permissions.ts) is a closed set of EXACT literal invocations
  // with no argument tail admitted at all -- for every one of them,
  // appending ANY token must ask, never allow, because the exact-string
  // comparison can never match a string that is longer than the literal it
  // is compared against. Mirrors the same literal set the source module
  // admits (not exported, so duplicated here deliberately -- a drift
  // between the two would itself be a bug this test should catch).
  const KNOWN_READ_ONLY_TAILS = [
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
    "ls",
    "cat",
    "git status",
    "git log",
    "git diff",
    "git show",
  ];

  it.each(KNOWN_READ_ONLY_TAILS)("cd server && %s --anything-at-all -> ask in trusted mode", (tail) => {
    const command = `cd server && ${tail} --anything-at-all`;
    const d = decide(
      "trusted",
      "Bash",
      { command },
      { sessionAllow: new Set(), denyCount: 0, repoRoot: "/repo" },
    );
    expect(d.action).toBe("ask");
  });
});

describe("G5 round 13 (12th audit) item 1 MAJOR: project-code tails outside the closed directory set ask in trusted", () => {
  it.each([
    // Proven-live exploit shapes: a scratch package.json/conftest.py under
    // an attacker-controlled directory executes on `npm run build`/`uv run
    // pytest`/etc.
    "cd /tmp/evil && npm run build",
    "cd C:/evil && npm test",
    "cd ../../evil && npx vitest run",
    "cd ~ && npm run build",
    "cd .. && npm run lint",
    // "server" is a source subdirectory of VST-Foundry-UI/VST-UI-FOUNDRY,
    // not a package/project root -- it has no server/package.json, so it
    // is not in SAFE_PROJECT_DIRS.
    "cd server && npm run test:sing",
    "cd server && uv run ruff format --check .",
    "cd server && uv run pytest",
    "cd server && uv run pytest tests/test_inference.py",
    "cd server && uv run pytest --save-audio",
    "cd server && uv run ruff check",
    "cd server && uv run ruff check .",
    "cd server && uv run ruff format --check",
    "cd server && npm run lint",
    "cd server && npm test",
    "cd server && npx vitest run",
  ])("%s -> ask in trusted mode", (command) => {
    const d = decide(
      "trusted",
      "Bash",
      { command },
      { sessionAllow: new Set(), denyCount: 0, repoRoot: "/repo" },
    );
    expect(d.action).toBe("ask");
  });
});

describe("G5 round 13 (12th audit) item 1 MAJOR: inert tails still allow from any directory", () => {
  it.each(["cd /tmp && ls", "cd /tmp/evil && cat", "cd ~ && git status", "cd .. && git log"])(
    "%s -> allow in trusted mode",
    (command) => {
      const d = decide(
        "trusted",
        "Bash",
        { command },
        { sessionAllow: new Set(), denyCount: 0, repoRoot: "/repo" },
      );
      expect(d.action).toBe("allow");
    },
  );
});

describe("G5 round 13 (12th audit) item 3 MINOR: NUL in the directory argument asks in trusted", () => {
  it.each(["cd back\x00end && npm test", "cd back\x00end && ls"])(
    "%s -> ask in trusted mode",
    (command) => {
      const d = decide(
        "trusted",
        "Bash",
        { command },
        { sessionAllow: new Set(), denyCount: 0, repoRoot: "/repo" },
      );
      expect(d.action).toBe("ask");
    },
  );
});

describe("G5 round 13 (12th audit) item 4 MINOR: cross-port whitespace/case normalisation matches the Python port", () => {
  it("npm\ufeffrun lint as a cd tail -> ask in trusted mode (BOM is not in the shared WS class)", () => {
    const d = decide(
      "trusted",
      "Bash",
      { command: "cd frontend && npm\ufeffrun lint" },
      { sessionAllow: new Set(), denyCount: 0, repoRoot: "/repo" },
    );
    expect(d.action).toBe("ask");
  });

  it("cd back\u0085end&&ls -> allow in trusted mode (NEL is not in the shared WS class)", () => {
    const d = decide(
      "trusted",
      "Bash",
      { command: "cd back\u0085end&&ls" },
      { sessionAllow: new Set(), denyCount: 0, repoRoot: "/repo" },
    );
    expect(d.action).toBe("allow");
  });
});

describe("G5 round 13 (12th audit) item 2 MAJOR: bare read commands with arguments allow in trusted", () => {
  it.each([
    "ls -la",
    "cat routes.ts",
    "head -40 routes.ts",
    "wc -l routes.ts",
    "git status --short",
    "git log --oneline -5",
    "git diff HEAD~1",
    "git show HEAD --stat",
  ])("%s -> allow in trusted mode", (command) => {
    const d = decide(
      "trusted",
      "Bash",
      { command },
      { sessionAllow: new Set(), denyCount: 0, repoRoot: "/repo" },
    );
    expect(d.action).toBe("allow");
  });

  it.each([
    "git diff --output=server/routes.ts HEAD",
    "git show --output=server/routes.ts HEAD --stat",
    "git diff -o server/routes.ts",
    "cat server/routes.ts > server/routes.ts",
    "cat server/routes.ts; rm -rf .",
  ])("%s -> ask in trusted mode (write primitive stays excluded)", (command) => {
    const d = decide(
      "trusted",
      "Bash",
      { command },
      { sessionAllow: new Set(), denyCount: 0, repoRoot: "/repo" },
    );
    expect(d.action).toBe("ask");
  });
});
