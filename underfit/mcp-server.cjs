#!/usr/bin/env node
'use strict'

/*
 * underfit — stdio MCP server
 * --------------------------------------------------------------------------
 * Claude Code (or theDAW's assistant) spawns this file as a subprocess and
 * speaks the Model Context Protocol (JSON-RPC 2.0) over stdin/stdout
 * (newline-delimited JSON). Every tool is a direct HTTP call to the underfit
 * dashboard control plane (dashboard/server.py) — no browser relay.
 *
 *   Usage: node mcp-server.cjs [PORT]
 *   PORT defaults to $UNDERFIT_DASHBOARD_PORT or 8791 (underfit's port in theDAW).
 *
 * Mirrors VST-UI-FOUNDRY/mcp-server.cjs (protocol skeleton, serverSideCall,
 * clampStrings/serializePayload). Tool contract is documented in
 * ~/.claude/skills/underfit/api.md.
 *
 * IMPORTANT: stdout is reserved exclusively for protocol messages. All
 * diagnostics go to stderr, otherwise the JSON-RPC stream is corrupted.
 */

const http = require('http')
const fs = require('fs')

const PORT = process.argv[2] || process.env.UNDERFIT_DASHBOARD_PORT || '8791'
const HOST = process.env.UNDERFIT_DASHBOARD_HOST_MCP || 'localhost'
// Pre-encoding / scans can run long; training launch returns fast (it only
// spawns the subprocess). 5 min covers the slowest single call.
const CALL_TIMEOUT_MS = 300000

// ---------------------------------------------------------------------------
// HTTP helper — one request/response round-trip to the underfit control plane.
// Resolves parsed JSON; tolerates NDJSON (scan) by taking the last JSON line;
// falls back to raw text. Rejects on non-2xx (surfacing {error} when present).
// ---------------------------------------------------------------------------

function serverSideCall(method, path, body) {
  return new Promise((resolve, reject) => {
    const hasBody = body !== undefined && body !== null
    const payload = hasBody ? JSON.stringify(body) : null
    const headers = {}
    if (hasBody) {
      headers['Content-Type'] = 'application/json'
      headers['Content-Length'] = Buffer.byteLength(payload)
    }
    const req = http.request(
      { hostname: HOST, port: parseInt(PORT, 10), path, method, headers, timeout: CALL_TIMEOUT_MS },
      (res) => {
        let data = ''
        res.setEncoding('utf8')
        res.on('data', (c) => { data += c })
        res.on('end', () => {
          const ok = res.statusCode >= 200 && res.statusCode < 300
          const parse = (s) => { try { return JSON.parse(s) } catch (e) { return undefined } }
          if (!ok) {
            const p = parse(data)
            const errVal = p && p.error !== undefined ? p.error : `HTTP ${res.statusCode}`
            reject(new Error(`underfit error (${method} ${path}): ${typeof errVal === 'string' ? errVal : JSON.stringify(errVal)} ${data.slice(0, 200)}`))
            return
          }
          if (!data) { resolve({}); return }
          const whole = parse(data)
          if (whole !== undefined) { resolve(whole); return }
          // NDJSON (e.g. /api/datasets/scan streams progress lines, final = result)
          const lines = data.split('\n').map((l) => l.trim()).filter(Boolean)
          for (let i = lines.length - 1; i >= 0; i--) {
            const p = parse(lines[i])
            if (p !== undefined) { resolve(p); return }
          }
          resolve(data)
        })
      }
    )
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout after ${CALL_TIMEOUT_MS}ms for ${method} ${path}`)) })
    if (hasBody) req.write(payload)
    req.end()
  })
}

// Upload a local .safetensors file as a raw octet-stream (validate_seed_lora).
function uploadBinary(path, filePath) {
  return new Promise((resolve, reject) => {
    let buf
    try { buf = fs.readFileSync(filePath) } catch (e) { reject(new Error(`Cannot read ${filePath}: ${e.message}`)); return }
    const req = http.request(
      {
        hostname: HOST, port: parseInt(PORT, 10), path, method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': buf.length },
        timeout: CALL_TIMEOUT_MS,
      },
      (res) => {
        let data = ''
        res.setEncoding('utf8')
        res.on('data', (c) => { data += c })
        res.on('end', () => { try { resolve(JSON.parse(data)) } catch (e) { resolve(data) } })
      }
    )
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('upload timeout')) })
    req.write(buf); req.end()
  })
}

const qs = (obj) => {
  const parts = []
  for (const k of Object.keys(obj || {})) {
    const v = obj[k]
    if (v === undefined || v === null || v === '') continue
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
  }
  return parts.length ? '?' + parts.join('&') : ''
}
const enc = encodeURIComponent

// ---------------------------------------------------------------------------
// Tools — each maps MCP args to a serverSideCall. Request fields are ground
// truth from dashboard/server.py (body.get / params.get). POSIX-only actions
// (pause/continue/save_checkpoint) return HTTP 400 on Windows.
// ---------------------------------------------------------------------------

const TOOLS = [
  { name: 'list_runs', description: 'List all training runs (id, status, base_model, max_steps, dataset).',
    inputSchema: { type: 'object', properties: {} },
    run: () => serverSideCall('GET', '/api/runs') },

  { name: 'get_run_status', description: 'Live progress + metrics + log tail for a run. Omit run_id for the active run.',
    inputSchema: { type: 'object', properties: { run_id: { type: 'string' } } },
    run: (a) => serverSideCall('GET', '/api/status' + qs({ run_id: a.run_id })) },

  { name: 'launch_finetune', description: 'Launch a new LoRA finetune (POST /api/runs/new). Mirrors the dashboard "New Finetune" form.',
    inputSchema: { type: 'object', required: ['name', 'base_model', 'dataset_id'], properties: {
      name: { type: 'string', description: 'Run name (slugified).' },
      base_model: { type: 'string', enum: ['sa3-medium', 'sa3-sm-music', 'sa3-sm-sfx'], description: 'Base model key.' },
      dataset_id: { type: 'string', description: 'Dataset id from list_datasets.' },
      lora_type: { type: 'string', enum: ['lora', 'dora', 'dora-rows', 'dora-cols', 'bora', 'lora-xs', 'dora-rows-xs', 'dora-cols-xs', 'bora-xs'], description: 'Adapter type (default lora).' },
      rank: { type: 'integer', description: 'LoRA rank (default 16).' },
      alpha: { type: ['number', 'string'], description: 'Alpha; defaults to rank.' },
      lr: { type: 'string', description: 'Learning rate, e.g. "1e-4".' },
      max_steps: { type: 'integer', description: 'Absolute global-step target (default 20000).' },
      batch_size: { type: 'integer', description: 'Batch size (default 8).' },
      checkpoint_every: { type: 'integer', description: 'Steps between checkpoints (default 1000).' },
      demo_every: { type: 'integer', description: 'Steps between demo generations (default 1000).' },
      gpu: { type: 'integer', description: 'CUDA device index.' },
      base_precision: { type: ['string', 'null'], enum: [null, 'bf16', 'fp16'], description: 'Frozen-base precision.' },
      lora_include: { type: 'string', description: 'Comma-separated include filter (layer substrings).' },
      lora_exclude: { type: 'string', description: 'Comma-separated exclude filter.' },
      latent_crop_length: { type: 'integer', description: 'Latent sequence length to crop to.' },
      random_crop: { type: 'boolean', description: 'Random vs start crop (default true).' },
      seed_lora_path: { type: 'string', description: 'Path to a seed LoRA .safetensors to start from (see validate_seed_lora).' },
      prompt_config: { type: 'object', description: 'Prompt-composition config (tags/paths/fixed/trigger + balance).' },
      demo_cond: { type: 'array', description: 'Demo prompts: [{prompt, cfg, steps, arc?, fixed_prompt?}].' },
      ground_truth: { type: 'array', description: 'Ground-truth reference tracks for A/B in the demo panel.' },
    } },
    run: (a) => serverSideCall('POST', '/api/runs/new', a) },

  { name: 'control_run', description: 'Control a run: pause/continue/kill/resume/delete. pause & continue are POSIX-only (400 on Windows). For resume pass max_steps (+ optional batch_size, checkpoint_every, demo_every, lr, checkpoint_path, gpu, latent_crop_length, random_crop). For delete pass delete_files.',
    inputSchema: { type: 'object', required: ['run_id', 'action'], properties: {
      run_id: { type: 'string' },
      action: { type: 'string', enum: ['pause', 'continue', 'kill', 'resume', 'delete'] },
      max_steps: { type: 'integer' }, batch_size: { type: 'integer' }, checkpoint_every: { type: 'integer' },
      demo_every: { type: 'integer' }, lr: { type: 'string' }, checkpoint_path: { type: 'string' },
      gpu: { type: 'integer' }, latent_crop_length: { type: 'integer' }, random_crop: { type: 'boolean' },
      delete_files: { type: 'boolean' },
    } },
    run: (a) => {
      const body = { ...a }; delete body.run_id; delete body.action
      const b = Object.keys(body).length ? body : undefined
      return serverSideCall('POST', `/api/runs/${enc(a.run_id)}/${a.action}`, b)
    } },

  { name: 'clone_settings', description: 'Full config of a run, to pre-fill a clone.',
    inputSchema: { type: 'object', properties: { run_id: { type: 'string' } } },
    run: (a) => serverSideCall('GET', '/api/clone_settings' + qs({ run_id: a.run_id })) },

  { name: 'list_checkpoints', description: 'Saved LoRA checkpoints for a run (with effective steps across sessions).',
    inputSchema: { type: 'object', properties: { run_id: { type: 'string' } } },
    run: (a) => serverSideCall('GET', '/api/checkpoints' + qs({ run_id: a.run_id })) },

  { name: 'save_checkpoint', description: 'Trigger a manual checkpoint save (SIGUSR1; POSIX-only, 400 on Windows).',
    inputSchema: { type: 'object', required: ['run_id'], properties: { run_id: { type: 'string' } } },
    run: (a) => serverSideCall('POST', '/api/save_checkpoint', { run_id: a.run_id }) },

  { name: 'list_datasets', description: 'List datasets (id, name, model, num_files, status).',
    inputSchema: { type: 'object', properties: {} },
    run: () => serverSideCall('GET', '/api/datasets') },

  { name: 'dataset_progress', description: 'Encoding progress + log tail for a dataset.',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    run: (a) => serverSideCall('GET', `/api/datasets/${enc(a.id)}/progress`) },

  { name: 'scan_dataset', description: 'Scan a directory for audio (or a pre-encoded latent dir). Returns the final scan result.',
    inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } },
    run: (a) => serverSideCall('POST', '/api/datasets/scan', { path: a.path }) },

  { name: 'encode_dataset', description: 'Launch pre-encoding of an audio dir into latents on N GPUs.',
    inputSchema: { type: 'object', required: ['name', 'input_dir', 'gpus'], properties: {
      name: { type: 'string' }, input_dir: { type: 'string' },
      model: { type: 'string', enum: ['sa3-medium', 'sa3-sm-music', 'sa3-sm-sfx'], description: 'default sa3-medium' },
      gpus: { type: 'array', items: { type: 'integer' } }, half: { type: 'boolean', description: 'default true' },
      default_prompt: { type: 'string' }, exclude: { type: 'array', items: { type: 'string' } },
    } },
    run: (a) => serverSideCall('POST', '/api/datasets/encode', a) },

  { name: 'import_dataset', description: 'Register a pre-encoded / native latent directory as a dataset.',
    inputSchema: { type: 'object', required: ['name', 'path', 'mode', 'model'], properties: {
      name: { type: 'string' }, path: { type: 'string' },
      mode: { type: 'string', enum: ['underfit_native_import', 'preencoded_import', 'bare_import'] },
      model: { type: 'string', enum: ['sa3-medium', 'sa3-sm-music', 'sa3-sm-sfx'] },
    } },
    run: (a) => serverSideCall('POST', '/api/datasets/import', a) },

  { name: 'delete_dataset', description: 'Delete a dataset. Use dry_run:true first to check if a run depends on it.',
    inputSchema: { type: 'object', required: ['id'], properties: {
      id: { type: 'string' }, dry_run: { type: 'boolean' }, delete_files: { type: 'boolean' },
    } },
    run: (a) => serverSideCall('POST', `/api/datasets/${enc(a.id)}/delete`, { dry_run: a.dry_run, delete_files: a.delete_files }) },

  { name: 'list_models', description: 'Available base models + per-model UI/config payload.',
    inputSchema: { type: 'object', properties: {} },
    run: () => serverSideCall('GET', '/api/models') },

  { name: 'estimate_vram', description: 'Estimate training VRAM for a config.',
    inputSchema: { type: 'object', properties: {
      model: { type: 'string' }, batch_size: { type: 'integer' }, rank: { type: 'integer' }, precision: { type: 'string' },
    } },
    run: (a) => serverSideCall('GET', '/api/estimate_vram' + qs({ model: a.model, batch_size: a.batch_size, rank: a.rank, precision: a.precision })) },

  { name: 'gpu_status', description: 'nvidia-smi snapshot: per-GPU VRAM/util + which runs/encodes/gradios use each.',
    inputSchema: { type: 'object', properties: {} },
    run: () => serverSideCall('GET', '/api/gpu') },

  { name: 'get_demos', description: 'Ground-truth + per-step demo clips (audio + spectrogram URLs) for a run.',
    inputSchema: { type: 'object', properties: { run_id: { type: 'string' }, nocache: { type: 'boolean' } } },
    run: (a) => serverSideCall('GET', '/api/demos' + qs({ run_id: a.run_id, nocache: a.nocache ? 1 : undefined })) },

  { name: 'loss_by_timestep', description: 'Loss split across 5 sigma buckets (the loss-by-timestep chart data).',
    inputSchema: { type: 'object', properties: { run_id: { type: 'string' } } },
    run: (a) => serverSideCall('GET', '/api/loss_by_timestep' + qs({ run_id: a.run_id })) },

  { name: 'get_log_tail', description: 'Tail of a run\'s training log. Pass file_size:0 for the full log. When a launch died before/outside normal logging, the response also carries bash_err (<log>.bash.err — the launch shell\'s own stderr) and/or exit_info (<log>.exit — the trainer\'s crash traceback); read those to self-diagnose launch failures.',
    inputSchema: { type: 'object', properties: { run_id: { type: 'string' }, file_size: { type: 'integer' } } },
    run: (a) => serverSideCall('GET', '/api/log_tail' + qs({ run_id: a.run_id, file_size: a.file_size == null ? 0 : a.file_size })) },

  { name: 'server_log', description: 'Tail the dashboard server\'s own log (startup/errors).',
    inputSchema: { type: 'object', properties: {} },
    run: () => serverSideCall('GET', '/api/server_log') },

  { name: 'validate_seed_lora', description: 'Upload + validate a local seed LoRA .safetensors; returns its adapter config. Use the returned path as launch_finetune.seed_lora_path.',
    inputSchema: { type: 'object', required: ['file_path'], properties: {
      file_path: { type: 'string', description: 'Absolute path to a .safetensors LoRA on this machine.' },
    } },
    run: (a) => uploadBinary('/api/lora/validate_seed?filename=' + enc(require('path').basename(a.file_path)), a.file_path) },

  { name: 'launch_inference_ui', description: 'Launch a Gradio inference UI for a trained checkpoint so the user can LISTEN to it. Each instance holds ~10-12 GB VRAM; stop instances before training.',
    inputSchema: { type: 'object', required: ['checkpoint_path', 'gpu'], properties: {
      checkpoint_path: { type: 'string', description: 'Path from list_checkpoints.' },
      gpu: { type: 'integer' }, run_id: { type: 'string' }, checkpoint_name: { type: 'string' },
      title: { type: 'string' }, model_variant: { type: 'string' }, verbose: { type: 'boolean' },
    } },
    run: (a) => serverSideCall('POST', '/api/gradio', a) },

  { name: 'list_inference_uis', description: 'List running Gradio inference UI instances (id, checkpoint, GPU, status).',
    inputSchema: { type: 'object', properties: {} },
    run: () => serverSideCall('GET', '/api/gradio') },

  { name: 'stop_inference_ui', description: 'Stop a running Gradio inference UI instance and free its VRAM.',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    run: (a) => serverSideCall('DELETE', '/api/gradio/' + enc(a.id)) },

  { name: 'dataset_files', description: "List a dataset's files with tag/caption coverage (ID3/JSON/none per file). Judge caption quality before training.",
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    run: (a) => serverSideCall('GET', `/api/datasets/${enc(a.id)}/files`) },

  { name: 'rare_tokens', description: 'Rare-token suggestions for trigger words (prompt_config.trigger) — style-handle words the base model barely knows.',
    inputSchema: { type: 'object', properties: {} },
    run: () => serverSideCall('GET', '/api/rare_tokens') },

  { name: 'read_guide', description: "Read Underfit's own documentation. topic: 'app' (tab guide), 'training' (LoRA walkthrough), 'readme' (upstream README), 'user-guide' (full manual). Read FIRST for app/UI questions.",
    inputSchema: { type: 'object', properties: {
      topic: { type: 'string', enum: ['app', 'training', 'readme', 'user-guide'], description: 'Default: app.' },
    } },
    run: (a) => {
      const path = require('path')
      const root = process.env.UNDERFIT_ROOT || path.resolve(__dirname)
      const topics = {
        app: path.join(root, 'docs', 'thedaw-style', 'underfit.md'),
        training: path.join(root, 'docs', 'thedaw-style', 'underfit-lora-training.md'),
        readme: path.join(root, 'README.md'),
        'user-guide': path.join(root, 'dashboard', 'assistant', 'USER_GUIDE.md'),
      }
      const file = topics[String((a && a.topic) || 'app')] || topics.app
      const text = fs.readFileSync(file, 'utf8')
      const CAP = 30000
      return Promise.resolve(text.length <= CAP ? text : text.slice(0, CAP) + `\n\n[truncated ${text.length - CAP} of ${text.length} chars — ask for a specific section]`)
    } },
]

const TOOL_MAP = Object.fromEntries(TOOLS.map((t) => [t.name, t]))
const TOOL_SCHEMAS = TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))

// ---------------------------------------------------------------------------
// JSON-RPC plumbing (mirrors VST-UI-FOUNDRY)
// ---------------------------------------------------------------------------

function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n') }
function log(...args) { process.stderr.write('[underfit mcp] ' + args.join(' ') + '\n') }

const MAX_RESPONSE_CHARS = 200000
const MAX_STRING_FIELD_CHARS = 4000
function clampStrings(value) {
  if (typeof value === 'string') {
    if (value.length <= MAX_STRING_FIELD_CHARS) return value
    return value.slice(0, MAX_STRING_FIELD_CHARS) + `… [truncated ${value.length - MAX_STRING_FIELD_CHARS} of ${value.length} chars]`
  }
  if (Array.isArray(value)) return value.map(clampStrings)
  if (value && typeof value === 'object') {
    const out = {}
    for (const k of Object.keys(value)) out[k] = clampStrings(value[k])
    return out
  }
  return value
}
function serializePayload(payload) {
  const raw = JSON.stringify(payload === undefined ? { ok: true } : payload)
  if (raw.length <= MAX_RESPONSE_CHARS) return raw
  const clamped = JSON.stringify(clampStrings(payload === undefined ? { ok: true } : payload))
  if (clamped.length <= MAX_RESPONSE_CHARS) return clamped
  return JSON.stringify({ error: 'response_too_large', message: `Result is ${raw.length} chars. Narrow the query.`, truncatedPreview: clamped.slice(0, 8000) })
}

async function handleMessage(msg) {
  if (msg.id === undefined || msg.id === null) return // notification — no response

  switch (msg.method) {
    case 'initialize':
      send({ jsonrpc: '2.0', id: msg.id, result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'underfit', version: '1.0.0' },
      } })
      return

    case 'ping':
      send({ jsonrpc: '2.0', id: msg.id, result: {} })
      return

    case 'tools/list':
      send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOL_SCHEMAS } })
      return

    case 'tools/call': {
      const params = msg.params || {}
      const tool = TOOL_MAP[params.name]
      if (!tool) {
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: `Unknown tool: ${params.name}` } })
        return
      }
      try {
        const payload = await tool.run(params.arguments || {})
        const text = typeof payload === 'string' ? payload : serializePayload(payload)
        send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text }] } })
      } catch (e) {
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: e && e.message ? e.message : String(e) } })
      }
      return
    }

    default:
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } })
  }
}

// stdin reader (line-delimited JSON)
let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  const lines = buf.split('\n')
  buf = lines.pop()
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let parsed
    try { parsed = JSON.parse(trimmed) } catch (e) { log('parse fail:', trimmed.slice(0, 200)); continue }
    Promise.resolve().then(() => handleMessage(parsed)).catch((e) => log('handleMessage error:', e && e.message ? e.message : String(e)))
  }
})
process.stdin.on('end', () => process.exit(0))
process.stdin.on('error', (e) => { log('stdin error:', e && e.message ? e.message : String(e)); process.exit(1) })
process.on('uncaughtException', (e) => log('uncaughtException:', e && e.stack ? e.stack : String(e)))
process.on('unhandledRejection', (e) => log('unhandledRejection:', e && e.message ? e.message : String(e)))

log(`ready — ${TOOLS.length} tools, target http://${HOST}:${PORT}`)
