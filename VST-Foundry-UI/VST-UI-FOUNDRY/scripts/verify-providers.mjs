#!/usr/bin/env node
/**
 * verify-providers.mjs — standalone provider verification harness for theDAW Foundry app.
 *
 * Proves that each available AI provider (Claude Code / Gemini / OpenRouter) can complete a
 * real CLIENT tool round-trip through the SSE chat endpoint, and that Claude's persistent
 * relay process retains conversation context across turns.
 *
 * This script simulates the BROWSER: it opens the chat SSE stream, watches for a
 * `client_tool_call` frame, and POSTs a canned tool result back via the mcp-relay so the
 * agentic turn can finish. It uses ONLY Node built-ins (`fetch`, web streams, `process`).
 *
 * ── HOW TO RUN ────────────────────────────────────────────────────────────────────────────
 *   1. Start the Foundry server first (in another terminal):   npm run dev
 *   2. Then run this harness:                                   node scripts/verify-providers.mjs
 *
 * ── ENVIRONMENT VARIABLES ───────────────────────────────────────────────────────────────────
 *   FOUNDRY_PORT        Port the Foundry server listens on. Falls back to PORT, then 5472.
 *   PORT                Secondary fallback for the server port.
 *   GEMINI_API_KEY      Required to test the `gemini` provider. Skipped (not failed) if unset.
 *   OPENROUTER_API_KEY  Required to test the `openrouter` provider. Skipped if unset.
 *   (Claude needs no API key — it runs through the local Claude Code relay process.)
 *
 * Exit code: 0 when there are no FAILs (SKIPs are acceptable); 1 if any check FAILs.
 *
 * NOTE: This harness does NOT start the server. The server must already be running.
 */

// ── Configuration ──────────────────────────────────────────────────────────────────────────
const PORT = process.env.FOUNDRY_PORT || process.env.PORT || 5472;
const BASE = `http://localhost:${PORT}`;
const CHAT_TIMEOUT_MS = 150_000; // long agentic turns are expected — do NOT shorten
const EMPTY_TURN_FALLBACK = "I've completed the adjustments on your layout.";
const CLAUDE_MODEL_FALLBACK = 'claude-opus-4-8';
const TOOL_PROMPT =
  'Call the getCanvasState tool, then in one sentence tell me the canvas background color you got back.';
const PERSIST_PROMPT =
  'Without using any tools, what tool did I ask you to call in my previous message?';

// ── Tiny logging helpers ───────────────────────────────────────────────────────────────────
const log = (...a) => console.log(...a);
const section = (title) => log(`\n=== ${title} ===`);

/**
 * Canned tool result payloads = the tool's BARE return value.
 * Verified contract (recon of AIAssistantOrb.tsx relayToolResult): the browser POSTs
 *   { sessionId, toolCallId, result: <tool return value> }
 * i.e. the `result` field holds the tool's return value DIRECTLY (single-nested). The
 * relay POST below already wraps these under `result`, so do NOT add another `result` key.
 */
function cannedResultFor(toolName) {
  switch (toolName) {
    case 'getCanvasState':
      return { elements: [], canvas: { width: 1920, height: 1080, background: '#111' } };
    case 'getElements':
      return { elements: [] };
    default:
      return { ok: true };
  }
}

// ── HTTP helpers ───────────────────────────────────────────────────────────────────────────
async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return res.json();
}

/**
 * GET /api/assistant/models/:provider — pick a sensible default model id.
 * For claude, prefer an id containing "opus"; otherwise the first listed id.
 * Falls back to CLAUDE_MODEL_FALLBACK for claude only; returns null for others on failure.
 */
async function pickModel(provider, apiKey) {
  const qs = apiKey ? `?apiKey=${encodeURIComponent(apiKey)}` : '';
  let raw = [];
  try {
    const data = await getJson(`${BASE}/api/assistant/models/${provider}${qs}`);
    // ASSUMPTION (flag): model list may arrive as a bare array, or wrapped in { models }
    // or { data }. Each entry may be a string id or an object with id/model/name.
    raw = Array.isArray(data) ? data : data.models || data.data || data.results || [];
  } catch (err) {
    log(`  [models] ${provider}: lookup failed (${err.message})`);
  }
  const ids = raw
    .map((m) => (typeof m === 'string' ? m : m && (m.id || m.model || m.name)))
    .filter((x) => typeof x === 'string' && x.length > 0);

  if (provider === 'claude') {
    return ids.find((id) => /opus/i.test(id)) || ids[0] || CLAUDE_MODEL_FALLBACK;
  }
  return ids[0] || null;
}

/**
 * POST the canned tool result back to the relay so the agentic turn can continue.
 * Records outcome onto the shared stream `state`.
 */
async function postToolResult(state, name, toolCallId, conversationId) {
  // ASSUMPTION (flag): if the session_id frame has not arrived before the tool call,
  // we fall back to conversationId as the relay key. Reconcile against the live server —
  // the relay may key strictly on the SSE-issued sessionId.
  const sessionId = state.sessionId || conversationId;
  if (!state.sessionId) {
    state.notes.push(`session_id not seen before tool call; used conversationId as relay key`);
  }
  const body = { sessionId, toolCallId, result: cannedResultFor(name) };
  try {
    const res = await fetch(`${BASE}/api/mcp-relay/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    state.toolResultPosted = true;
    state.toolResultOk = res.ok;
    if (!res.ok) state.notes.push(`relay POST -> HTTP ${res.status}`);
  } catch (err) {
    state.notes.push(`relay POST error: ${err.message}`);
  }
}

/**
 * Dispatch a single decoded SSE frame, mutating `state`.
 */
async function handleFrame(frame, state, ctx) {
  state.frames++;
  const type = frame.type || frame.event;

  // Capture the relay session id from ANY frame that carries it (variants per contract).
  const sid =
    frame.sessionId || frame.session_id || (frame.data && (frame.data.sessionId || frame.data.session_id));
  if (sid && !state.sessionId) state.sessionId = sid;

  switch (type) {
    case 'session_id':
    case 'session':
      // session id already captured above
      break;

    case 'status':
      if (frame.message || frame.status) state.statuses.push(frame.message || frame.status);
      break;

    case 'thinking':
      // ignore reasoning frames for pass/fail accounting
      break;

    case 'text':
    case 'text_delta':
    case 'delta': {
      // Accumulate textual content. Field name varies across providers/frames.
      const t = frame.text ?? frame.delta ?? frame.content ?? frame.value ?? '';
      if (typeof t === 'string') state.text += t;
      break;
    }

    case 'client_tool_call':
    case 'function_call':
    case 'tool_call': {
      state.sawToolCall = true;
      const name =
        frame.name || frame.tool || frame.toolName || frame.tool_name || (frame.function && frame.function.name);
      const toolCallId =
        frame.toolCallId ||
        frame.id ||
        frame.tool_call_id ||
        frame.callId ||
        frame.call_id ||
        (frame.function && frame.function.id);
      state.toolCallName = name || state.toolCallName;
      if (ctx.allowTools) {
        await postToolResult(state, name, toolCallId, ctx.conversationId);
      }
      break;
    }

    case 'tool_result':
    case 'function_result':
      // server acknowledging the relayed result — informational
      break;

    case 'done':
    case 'result':
    case 'complete':
      state.done = true;
      break;

    case 'error':
      state.error = frame.error || frame.message || 'stream error';
      state.done = true;
      break;

    default:
      // Unknown frame type: salvage any obvious text payload, otherwise ignore.
      if (typeof frame.text === 'string') state.text += frame.text;
      break;
  }
}

/**
 * Open POST /api/assistant/chat as an SSE stream and drive it to completion.
 * Returns a state object describing what happened.
 */
async function streamChat({ provider, model, apiKey, conversationId, prompt, allowTools, effort }) {
  const state = {
    text: '',
    frames: 0,
    statuses: [],
    notes: [],
    sessionId: null,
    sawToolCall: false,
    toolCallName: null,
    toolResultPosted: false,
    toolResultOk: false,
    done: false,
    error: null,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS);

  try {
    const reqBody = {
      messages: [{ role: 'user', content: prompt }],
      provider,
      model,
      apiKey: apiKey || undefined,
      conversationId,
      appState: { app: 'foundry', surface: 'verify-providers-harness' },
    };
    if (effort) reqBody.effort = effort;

    const res = await fetch(`${BASE}/api/assistant/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(reqBody),
      signal: controller.signal,
    });

    if (!res.ok) {
      state.error = `chat -> HTTP ${res.status}`;
      return state;
    }
    if (!res.body) {
      state.error = 'chat response had no body stream';
      return state;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finished = false;

    while (!finished) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);

        if (line === '') continue; // event separator (blank line)
        if (line.startsWith(':')) continue; // SSE keepalive comment
        if (!line.startsWith('data:')) continue; // only data: lines carry frames

        const payload = line.slice(5).trim();
        if (!payload) continue;
        if (payload === '[DONE]') {
          state.done = true;
          finished = true;
          break;
        }

        let frame;
        try {
          frame = JSON.parse(payload);
        } catch {
          continue; // partial/garbled JSON — skip this line
        }

        await handleFrame(frame, state, { provider, conversationId, allowTools });
        if (state.done) {
          finished = true;
          break;
        }
      }
    }

    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
  } catch (err) {
    if (err && err.name === 'AbortError') {
      state.error = state.error || `chat timed out after ${CHAT_TIMEOUT_MS / 1000}s`;
    } else {
      state.error = state.error || (err && err.message) || String(err);
    }
  } finally {
    clearTimeout(timer);
  }

  return state;
}

// ── Per-provider checks ────────────────────────────────────────────────────────────────────

/**
 * Evaluate the tool round-trip stream state into PASS/FAIL plus a reason.
 */
function evaluateToolRoundtrip(state) {
  if (state.error) return { status: 'FAIL', reason: state.error };
  if (!state.sawToolCall) return { status: 'FAIL', reason: 'no tool call emitted' };
  if (!state.toolResultPosted) return { status: 'FAIL', reason: 'tool call seen but no relay POST attempted' };
  if (!state.toolResultOk) return { status: 'FAIL', reason: 'relay POST not ok' };
  const text = state.text.trim();
  if (!text) return { status: 'FAIL', reason: 'empty turn (no final text)' };
  if (text === EMPTY_TURN_FALLBACK) return { status: 'FAIL', reason: 'empty-turn fallback string returned' };
  return { status: 'PASS', reason: `tool=${state.toolCallName || '?'}` };
}

/**
 * Run the full check set for one provider. Never throws — captures errors into the row.
 */
async function runProvider(plan) {
  const { provider, apiKey } = plan;
  const row = {
    provider,
    model: '-',
    tool: 'FAIL',
    toolReason: '',
    persist: provider === 'claude' ? 'FAIL' : 'N/A',
    persistReason: '',
    notes: [],
  };

  try {
    section(`Provider: ${provider}`);

    const model = await pickModel(provider, apiKey);
    if (!model) {
      row.tool = 'FAIL';
      row.toolReason = 'no model available from /models endpoint';
      row.persist = provider === 'claude' ? 'FAIL' : 'N/A';
      log(`  [model] none resolved — aborting checks for ${provider}`);
      return row;
    }
    row.model = model;
    log(`  [model] using "${model}"`);

    // 1) Tool round-trip
    log(`  [tool ] opening chat (conversationId=verify-${provider}-1)...`);
    const toolState = await streamChat({
      provider,
      model,
      apiKey,
      conversationId: `verify-${provider}-1`,
      prompt: TOOL_PROMPT,
      allowTools: true,
    });
    const toolEval = evaluateToolRoundtrip(toolState);
    row.tool = toolEval.status;
    row.toolReason = toolEval.reason;
    row.notes.push(...toolState.notes);
    log(
      `  [tool ] ${toolEval.status} — frames=${toolState.frames} sawToolCall=${toolState.sawToolCall} ` +
        `relayOk=${toolState.toolResultOk} textLen=${toolState.text.trim().length} (${toolEval.reason})`,
    );

    // 2) Persistence (claude only)
    if (provider === 'claude') {
      log(`  [persist] re-using conversationId=verify-claude-1...`);
      const persistState = await streamChat({
        provider,
        model,
        apiKey,
        conversationId: 'verify-claude-1',
        prompt: PERSIST_PROMPT,
        allowTools: true, // relay any unexpected tool call so the turn cannot hang
      });
      row.notes.push(...persistState.notes);

      if (persistState.error) {
        row.persist = 'FAIL';
        row.persistReason = persistState.error;
      } else {
        const t = persistState.text.toLowerCase();
        const retained = /getcanvasstate|canvas\s*state|canvas/.test(t);
        row.persist = retained ? 'PASS' : 'FAIL';
        row.persistReason = retained ? 'referenced canvas/getCanvasState' : 'did not reference prior tool';
      }
      log(`  [persist] ${row.persist} — textLen=${persistState.text.trim().length} (${row.persistReason})`);

      // Clean up the persistent relay session.
      try {
        const closeRes = await fetch(`${BASE}/api/assistant/session/close`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ conversationId: 'verify-claude-1' }),
        });
        log(`  [close ] session/close -> HTTP ${closeRes.status}`);
      } catch (err) {
        log(`  [close ] session/close error: ${err.message}`);
        row.notes.push(`session/close error: ${err.message}`);
      }
    }
  } catch (err) {
    // Defensive: one provider's failure must not abort the others.
    row.toolReason = row.toolReason || `unexpected error: ${(err && err.message) || err}`;
    log(`  [ERROR] ${provider}: ${(err && err.message) || err}`);
  }

  return row;
}

// ── Table rendering ────────────────────────────────────────────────────────────────────────
function pad(s, w) {
  s = String(s == null ? '' : s);
  return s.length >= w ? s.slice(0, w) : s + ' '.repeat(w - s.length);
}

function renderTable(rows) {
  const headers = ['provider', 'model', 'tool-roundtrip', 'persistence', 'notes'];
  const data = rows.map((r) => {
    const tool = r.tool + (r.toolReason ? ` (${r.toolReason})` : '');
    const persist = r.persist + (r.persistReason ? ` (${r.persistReason})` : '');
    const notes = r.notes.length ? r.notes.join('; ') : '';
    return [r.provider, r.model, tool, persist, notes];
  });

  const widths = headers.map((h, i) =>
    Math.min(60, Math.max(h.length, ...data.map((row) => String(row[i]).length))),
  );

  const line = (cols) => '| ' + cols.map((c, i) => pad(c, widths[i])).join(' | ') + ' |';
  const sep = '+' + widths.map((w) => '-'.repeat(w + 2)).join('+') + '+';

  section('RESULTS');
  log(sep);
  log(line(headers));
  log(sep);
  for (const row of data) log(line(row));
  log(sep);
}

// ── Main ───────────────────────────────────────────────────────────────────────────────────
async function main() {
  log(`verify-providers — target server: ${BASE}`);

  // Light pre-flight: confirm the provider catalog endpoint responds (non-fatal).
  try {
    const providers = await getJson(`${BASE}/api/assistant/providers`);
    const count = Array.isArray(providers)
      ? providers.length
      : Object.keys(providers || {}).length;
    log(`[preflight] /api/assistant/providers responded (${count} entries)`);
  } catch (err) {
    log(`[preflight] WARNING: /api/assistant/providers did not respond cleanly: ${err.message}`);
    log(`[preflight] Is the server running?  Start it with:  npm run dev`);
  }

  // Decide which providers to test.
  const plans = [{ provider: 'claude', apiKey: undefined, run: true }];

  if (process.env.GEMINI_API_KEY) {
    plans.push({ provider: 'gemini', apiKey: process.env.GEMINI_API_KEY, run: true });
  } else {
    plans.push({ provider: 'gemini', run: false, skipReason: 'set GEMINI_API_KEY to test gemini' });
  }

  if (process.env.OPENROUTER_API_KEY) {
    plans.push({ provider: 'openrouter', apiKey: process.env.OPENROUTER_API_KEY, run: true });
  } else {
    plans.push({ provider: 'openrouter', run: false, skipReason: 'set OPENROUTER_API_KEY to test openrouter' });
  }

  const rows = [];
  for (const plan of plans) {
    if (!plan.run) {
      log(`\n=== Provider: ${plan.provider} ===`);
      log(`  [SKIP] ${plan.skipReason}`);
      rows.push({
        provider: plan.provider,
        model: '-',
        tool: 'SKIP',
        toolReason: plan.skipReason,
        persist: 'N/A',
        persistReason: '',
        notes: [],
      });
      continue;
    }
    // eslint-disable-next-line no-await-in-loop -- providers run sequentially on purpose
    const row = await runProvider(plan);
    rows.push(row);
  }

  renderTable(rows);

  // Exit code: FAIL anywhere -> 1. SKIP / N/A / PASS are all acceptable.
  const hasFail = rows.some((r) => r.tool === 'FAIL' || r.persist === 'FAIL');
  log(`\nOverall: ${hasFail ? 'FAIL (see table)' : 'OK (no failures)'}`);
  process.exit(hasFail ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal harness error:', err);
  process.exit(1);
});
