import assert from "node:assert/strict";
import { test } from "node:test";
import { loadBundleBuilder, parseExportArgs, runPowerModeCli, type PowerModeIO } from "./cli.mts";

test("requires explicit paths and preserves the compatibility entry point", async () => {
  assert.throws(() => parseExportArgs([]), /--session/);
  assert.throws(() => parseExportArgs(["--session", "input.json"]), /--textures/);
  assert.throws(() => parseExportArgs(["--unknown"]), /Unknown/);
  assert.equal(parseExportArgs(["--help"]), null);
  const compatibility = await import("../export-powermode.mts");
  assert.equal(typeof compatibility.runPowerModeCli, "function");
});

test("explicit export orchestration uses only supplied IO and preserves raw project text", async () => {
  const calls: string[] = [];
  const raw = '{"elements":[],"canvasState":{"width":100,"height":100},"extra":true}';
  const io: PowerModeIO = {
    readSession: sessionPath => { calls.push(`read:${sessionPath}`); return raw; },
    readTexture: () => { assert.fail("empty synthetic source has no textures"); },
    buildFiles: async (_prepared, original) => {
      assert.equal(original, raw);
      return { "power-mode.project.json": original };
    },
    writeFiles: (output, files) => { calls.push(`write:${output}`); assert.equal(files["power-mode.project.json"], raw); },
    log: () => {},
  };
  await runPowerModeCli(["--session", "synthetic.json", "--textures", "synthetic-textures", "--out", "synthetic-output"], io);
  assert.deepEqual(calls, ["read:synthetic.json", "write:synthetic-output"]);
});

test("invalid arguments and help perform no source reads or writes", async () => {
  const unexpected = () => { assert.fail("unexpected IO"); };
  const messages: string[] = [];
  const io: PowerModeIO = {
    readSession: unexpected, readTexture: unexpected, buildFiles: async () => unexpected(), writeFiles: unexpected,
    log: message => { messages.push(message); },
  };
  await runPowerModeCli(["--help"], io);
  assert.match(messages.join("\n"), /--tsconfig scripts\/tsconfig\.export\.json/);
  assert.match(messages.join("\n"), /missing textures abort before building or writing/i);
  await assert.rejects(runPowerModeCli([], io), /--session/);
});

test("missing required textures abort before bundle building or output directory creation", async () => {
  const calls: string[] = [];
  const raw = JSON.stringify({
    elements: [],
    canvasState: { width: 100, height: 100, backgroundImage: "/textures/missing.png" },
  });
  const io: PowerModeIO = {
    readSession: () => raw,
    readTexture: (directory, filename) => { calls.push(`texture:${directory}/${filename}`); return undefined; },
    buildFiles: async () => { calls.push("build"); return {}; },
    writeFiles: () => { calls.push("create-output-and-write"); },
    log: message => { calls.push(`log:${message}`); },
  };
  await assert.rejects(
    runPowerModeCli(["--session", "synthetic.json", "--textures", "synthetic-textures", "--out", "new-output"], io),
    /Missing required textures: missing\.png.*before building or writing/,
  );
  assert.deepEqual(calls, ["texture:synthetic-textures/missing.png"]);
});

test("the real builder loads using the existing headless shim without creating a bundle", async () => {
  const builder = await loadBundleBuilder();
  assert.equal(typeof builder, "function");
});
