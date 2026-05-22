#!/usr/bin/env python3
"""
Assistant Chat Routes - Multi-provider LLM streaming with model discovery.

Provides:
- /api/assistant/chat       POST  - Stream chat completions (SSE) from any provider
- /api/assistant/providers   GET  - List all available providers
- /api/assistant/models/{id} GET  - Discover models for a given provider
- /api/assistant/openrouter-models GET - Backward-compat OpenRouter model list
"""

import asyncio
import json
import logging
import os
import time
import uuid
from typing import Any, Optional, List

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from backend.key_pool import key_pool, _key_id

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/assistant", tags=["assistant"])

STABLEDAW_SYSTEM_PROMPT = """You are the StableDAW Assistant — an expert AI companion for the Stable Audio 3 audio generation system.

## Your Capabilities
- Answer any question about StableDAW, Stable Audio 3, and audio generation
- Explain every parameter and what it does
- Recommend optimal settings for different use cases
- Diagnose issues (CUDA, VRAM, model loading, audio artifacts)
- Control the app: set parameters, start/stop generation, navigate tabs, manage playback

## Stable Audio 3 Architecture
Two-stage pipeline:
1. DiT (Diffusion Transformer) generates latents from text prompts using T5Gemma conditioning
2. SAME Autoencoder decodes latents to 44.1kHz stereo audio at 4096x downsampling

Models: Small (433M params), Medium (1.4B params). ARC checkpoints (post-trained, 8-step, cfg_scale=1). RF checkpoints (base, for LoRA training, cfg_scale=7).

## Key Parameters
- **Model**: small, medium (ARC), small-rf, medium-rf (RF/base)
- **Duration**: 1-180 seconds. Determines latent sequence length directly.
- **Steps**: Diffusion sampling steps. ARC default=8, RF needs more (20-50).
- **CFG Scale**: Classifier-free guidance. ARC=1.0 (no guidance needed). RF=7.0.
- **Seed**: -1 for random, or fixed integer for reproducibility.
- **Sampler**: pingpong (default), euler, rk4, dpmpp.
- **Shift Mode**: LogSNR (default), Flux, Full, None. Warps timestep schedule based on sequence length.
- **APG Scale**: Adaptive Projected Guidance strength. Default 1.0.
- **Init Audio**: Audio-to-audio mode. Upload source audio + set noise level (0=keep original, 1=full noise).
- **Inpainting**: Upload audio, set mask start/end to regenerate a specific section.
- **LoRA**: Load trained adapters with per-slot weight control. Supports stacking multiple LoRAs.

## Communication Style
- Professional, direct, knowledgeable
- Give specific parameter values, not vague suggestions
- When recommending settings, explain WHY
- If the user's request is ambiguous, ask one clarifying question
- For errors: diagnose first, then suggest fixes
"""

CLAUDE_CMD = r"C:\Users\skream\AppData\Roaming\npm\claude.cmd"
PROJECT_CWD = r"C:\Users\skream\projects\StableDAW"

KEEPALIVE_INTERVAL = 15.0
CLAUDE_MAX_TURNS = 25
CLAUDE_TIMEOUT_S = 900  # 15 minutes
CLAUDE_MAX_STDOUT_BYTES = 10_485_760  # 10 MB safety limit
CLAUDE_CRASH_WINDOW_S = 60.0
CLAUDE_CRASH_THRESHOLD = 3

# ---------------------------------------------------------------------------
# Provider catalog
# ---------------------------------------------------------------------------
PROVIDERS = {
    "gemini": {
        "label": "Google Gemini",
        "base_url": "https://generativelanguage.googleapis.com/v1beta/openai",
        "env_key": "GEMINI_API_KEY",
        "models_path": None,  # uses google-specific endpoint
        "default_model": "gemini-flash-recent",
    },
    "openai": {
        "label": "OpenAI",
        "base_url": "https://api.openai.com",
        "env_key": "OPENAI_API_KEY",
        "models_path": "/v1/models",
        "default_model": "gpt-4.1-mini",
    },
    "anthropic": {
        "label": "Anthropic",
        "base_url": "https://api.anthropic.com",
        "env_key": "ANTHROPIC_API_KEY",
        "models_path": "/v1/models",
        "default_model": "claude-sonnet-4-20250514",
    },
    "grok": {
        "label": "xAI Grok",
        "base_url": "https://api.x.ai",
        "env_key": "XAI_API_KEY",
        "models_path": "/v1/models",
        "default_model": "grok-3-mini-fast",
    },
    "groq": {
        "label": "Groq",
        "base_url": "https://api.groq.com/openai",
        "env_key": "GROQ_API_KEY",
        "models_path": "/v1/models",
        "default_model": "llama-3.3-70b-versatile",
    },
    "openrouter": {
        "label": "OpenRouter",
        "base_url": "https://openrouter.ai/api",
        "env_key": "OPENROUTER_API_KEY",
        "models_path": "/v1/models",
        "default_model": "google/gemma-3-1b-it:free",
    },
    "openrouter-free": {
        "label": "OpenRouter Free",
        "base_url": "https://openrouter.ai/api",
        "env_key": "OPENROUTER_API_KEY",
        "models_path": "/v1/models",
        "default_model": "google/gemma-3-1b-it:free",
    },
    "ollama": {
        "label": "Ollama (Local)",
        "base_url": "http://localhost:11434",
        "env_key": None,
        "models_path": None,  # uses /api/tags
        "default_model": "",
    },
    "lmstudio": {
        "label": "LM Studio (Local)",
        "base_url": "http://localhost:1234",
        "env_key": None,
        "models_path": "/v1/models",
        "default_model": "",
    },
    "llamacpp": {
        "label": "llama.cpp (Local)",
        "base_url": "http://localhost:8080",
        "env_key": None,
        "models_path": "/v1/models",
        "default_model": "",
    },
    "vllm": {
        "label": "vLLM (Local)",
        "base_url": "http://localhost:8000",
        "env_key": None,
        "models_path": "/v1/models",
        "default_model": "",
    },
}

# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------


class ChatMessage(BaseModel):
    role: str
    content: (
        Any  # str or list of content blocks for multimodal (audio_url, image_url, text)
    )


class ChatRequest(BaseModel):
    messages: List[ChatMessage]
    conversationId: Optional[str] = None
    provider: Optional[str] = "gemini"
    model: Optional[str] = None
    apiKey: Optional[str] = None
    claudeMode: Optional[str] = "oneshot"  # oneshot | resume | persistent | interactive
    claudeSessionId: Optional[str] = None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _sse_frame(data: dict) -> str:
    """Format a dict as an SSE data frame."""
    return f"data: {json.dumps(data)}\n\n"


def _extract_text(content: Any) -> str:
    """Extract plain text from content (str or multimodal content blocks list)."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, dict):
                if block.get("type") == "text":
                    parts.append(block.get("text", ""))
            elif isinstance(block, str):
                parts.append(block)
        return " ".join(parts)
    return str(content)


def _build_prompt(messages: List[ChatMessage]) -> str:
    """
    Build a prompt string from the message list.

    Takes the last user message as the primary prompt.
    If there are prior messages, prepends them as conversation context.
    """
    if not messages:
        return ""

    last_user_msg = ""
    for msg in reversed(messages):
        if msg.role == "user":
            last_user_msg = _extract_text(msg.content)
            break

    if not last_user_msg and messages:
        last_user_msg = _extract_text(messages[-1].content)

    context_parts: list[str] = []
    for msg in messages:
        text = _extract_text(msg.content)
        if text == last_user_msg and msg.role == "user":
            break
        context_parts.append(f"[{msg.role}]: {text}")

    if context_parts:
        context_block = "\n".join(context_parts)
        return f"<conversation_context>\n{context_block}\n</conversation_context>\n\n{last_user_msg}"

    return last_user_msg


def _get_api_key(provider_id: str, request_key: Optional[str] = None) -> str:
    """Resolve API key: request-provided > pool rotation > env var > empty."""
    if request_key:
        return request_key
    pool_key = key_pool.get_next_key(provider_id)
    if pool_key:
        return pool_key
    cfg = PROVIDERS.get(provider_id)
    if not cfg:
        return ""
    env_key = cfg.get("env_key")
    if not env_key:
        return ""
    return os.environ.get(env_key, "")


def _chat_url(provider_id: str) -> str:
    """Build the chat completions URL for a provider."""
    cfg = PROVIDERS[provider_id]
    base = cfg["base_url"]
    # Gemini base_url already ends with /openai -- just append /chat/completions
    if provider_id == "gemini":
        return f"{base}/chat/completions"
    return f"{base}/v1/chat/completions"


# ---------------------------------------------------------------------------
# Claude Code CLI — process management for persistent/interactive modes
# ---------------------------------------------------------------------------

# Running persistent/interactive processes keyed by session_id
_claude_processes: dict[str, asyncio.subprocess.Process] = {}
# Crash timestamps per session_id for backoff detection
_claude_crash_log: dict[str, list[float]] = {}


def _claude_should_refuse_restart(session_id: str) -> bool:
    """Return True if the session has crashed >= CLAUDE_CRASH_THRESHOLD times within the window."""
    now = time.monotonic()
    timestamps = _claude_crash_log.get(session_id, [])
    # Prune old entries
    timestamps = [t for t in timestamps if now - t < CLAUDE_CRASH_WINDOW_S]
    _claude_crash_log[session_id] = timestamps
    return len(timestamps) >= CLAUDE_CRASH_THRESHOLD


def _claude_record_crash(session_id: str) -> None:
    """Record a crash timestamp for a session."""
    _claude_crash_log.setdefault(session_id, []).append(time.monotonic())


def _claude_base_cmd_args(req: ChatRequest) -> list[str]:
    """Build common CLI args shared across all Claude modes."""
    args = [
        "cmd",
        "/c",
        CLAUDE_CMD,
        "--print",
        "--output-format",
        "stream-json",
        "--verbose",
        "--max-turns",
        str(CLAUDE_MAX_TURNS),
        "--dangerously-skip-permissions",
    ]
    model = req.model or ""
    if model.startswith("claude-code-"):
        model = "opus"
    if not model:
        model = "opus"
    args.extend(["--model", model])
    return args


async def _terminate_claude_process(process: asyncio.subprocess.Process) -> None:
    """Gracefully terminate a Claude CLI process."""
    if process.returncode is not None:
        return
    try:
        process.terminate()
        await asyncio.wait_for(process.wait(), timeout=5.0)
    except (asyncio.TimeoutError, ProcessLookupError):
        try:
            process.kill()
        except ProcessLookupError:
            pass


def _parse_claude_event(data: dict) -> list[dict]:
    """
    Parse a stream-json event from Claude CLI into SSE frames.

    Returns a list of SSE-ready dicts (may be empty).
    """
    frames: list[dict] = []
    msg_type = data.get("type", "")

    if msg_type == "assistant":
        # Full assistant message with content blocks
        message = data.get("message", data)
        content_blocks = message.get("content", data.get("content", []))
        for block in content_blocks:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "text":
                text = block.get("text", "")
                if text:
                    frames.append({"type": "text_delta", "delta": text})
            elif block.get("type") == "tool_use":
                frames.append(
                    {
                        "type": "function_call",
                        "name": block.get("name", ""),
                        "id": block.get("id", ""),
                        "input": block.get("input", {}),
                    }
                )

    elif msg_type == "content_block_delta":
        delta = data.get("delta", {})
        if delta.get("type") == "text_delta":
            text = delta.get("text", "")
            if text:
                frames.append({"type": "text_delta", "delta": text})

    elif msg_type == "tool_result":
        frames.append(
            {
                "type": "function_result",
                "tool_use_id": data.get("tool_use_id", ""),
                "content": data.get("content", ""),
            }
        )

    elif msg_type == "system":
        subtype = data.get("subtype", "")
        if subtype == "init":
            session_id = data.get("session_id", "")
            if session_id:
                frames.append(
                    {
                        "type": "status",
                        "message": "session initialized",
                        "session_id": session_id,
                    }
                )

    elif msg_type == "result":
        usage = data.get("usage", {})
        session_id = data.get("session_id", "")
        done_frame: dict = {
            "type": "done",
            "usage": {
                "prompt_tokens": usage.get("input_tokens", 0),
                "completion_tokens": usage.get("output_tokens", 0),
            },
        }
        if session_id:
            done_frame["session_id"] = session_id
        frames.append(done_frame)

    return frames


async def _stream_claude_spawn(req: ChatRequest, request: Request):
    """
    Stream Claude Code CLI for oneshot and resume modes.

    Spawns a new process per message. For resume mode, passes --resume or
    --session-id to maintain conversation continuity. Prompt is piped via
    stdin (not as a CLI argument) to avoid shell escaping issues.
    """
    prompt = _build_prompt(req.messages)
    if not prompt:
        yield _sse_frame(
            {"type": "error", "error": "No prompt content found in messages"}
        )
        return

    mode = req.claudeMode or "oneshot"
    session_id = req.claudeSessionId

    cmd_args = _claude_base_cmd_args(req)

    if mode == "resume":
        if session_id:
            cmd_args.extend(["--resume", session_id])
        else:
            session_id = str(uuid.uuid4())
            cmd_args.extend(["--session-id", session_id])
            yield _sse_frame(
                {
                    "type": "status",
                    "message": f"new session: {session_id}",
                    "session_id": session_id,
                }
            )

    yield _sse_frame({"type": "status", "message": f"thinking ({mode})..."})

    process = None
    try:
        process = await asyncio.create_subprocess_exec(
            *cmd_args,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            limit=10
            * 1024
            * 1024,  # 10 MB — avoids ValueError on long Claude JSON lines
            cwd=PROJECT_CWD,
        )

        if process.stdout is None:
            yield _sse_frame(
                {"type": "error", "error": "Failed to capture Claude CLI stdout"}
            )
            return

        # Pipe prompt via stdin and close
        if process.stdin is not None:
            process.stdin.write(prompt.encode("utf-8"))
            process.stdin.close()

        last_keepalive = time.monotonic()
        start_time = time.monotonic()
        total_bytes_read = 0

        while True:
            # Check client disconnect
            if await request.is_disconnected():
                logger.info(
                    "[AssistantChat] Client disconnected, terminating Claude process"
                )
                await _terminate_claude_process(process)
                return

            # Check timeout
            elapsed = time.monotonic() - start_time
            if elapsed > CLAUDE_TIMEOUT_S:
                logger.warning(
                    "[AssistantChat] Claude stream timed out after %ds", int(elapsed)
                )
                yield _sse_frame(
                    {
                        "type": "error",
                        "error": f"Claude stream timed out after {int(elapsed)}s",
                    }
                )
                await _terminate_claude_process(process)
                break

            # Read a line with timeout for keepalive
            try:
                line_bytes = await asyncio.wait_for(
                    process.stdout.readline(),
                    timeout=KEEPALIVE_INTERVAL,
                )
            except asyncio.TimeoutError:
                yield ": ping\n\n"
                last_keepalive = time.monotonic()
                continue

            if not line_bytes:
                break  # EOF

            total_bytes_read += len(line_bytes)
            if total_bytes_read > CLAUDE_MAX_STDOUT_BYTES:
                logger.warning(
                    "[AssistantChat] Claude stdout exceeded %d bytes, terminating",
                    CLAUDE_MAX_STDOUT_BYTES,
                )
                yield _sse_frame(
                    {
                        "type": "error",
                        "error": "Claude output exceeded 10MB safety limit",
                    }
                )
                await _terminate_claude_process(process)
                break

            line = line_bytes.decode("utf-8", errors="replace").strip()
            if not line:
                continue

            try:
                data = json.loads(line)
            except json.JSONDecodeError:
                logger.debug(
                    "[AssistantChat] Non-JSON line from Claude CLI: %s", line[:200]
                )
                continue

            # Parse and emit SSE frames
            for frame in _parse_claude_event(data):
                yield _sse_frame(frame)
                if frame.get("type") == "done":
                    return

            # Keepalive
            now = time.monotonic()
            if now - last_keepalive > KEEPALIVE_INTERVAL:
                yield ": ping\n\n"
                last_keepalive = now

        # Process ended without a result event
        await process.wait()

        stderr_output = ""
        if process.stderr:
            stderr_bytes = await process.stderr.read()
            stderr_output = stderr_bytes.decode("utf-8", errors="replace").strip()

        if process.returncode != 0 and stderr_output:
            logger.error(
                "[AssistantChat] Claude CLI exited with code %d: %s",
                process.returncode,
                stderr_output[:500],
            )
            yield _sse_frame(
                {"type": "error", "error": f"Claude CLI error: {stderr_output[:500]}"}
            )
            return

        done_frame: dict = {
            "type": "done",
            "usage": {"prompt_tokens": 0, "completion_tokens": 0},
        }
        if session_id:
            done_frame["session_id"] = session_id
        yield _sse_frame(done_frame)

    except asyncio.CancelledError:
        logger.info("[AssistantChat] Claude spawn stream cancelled")
        if process and process.returncode is None:
            await _terminate_claude_process(process)
        raise

    except Exception as exc:
        logger.exception("[AssistantChat] Error in Claude spawn stream")
        yield _sse_frame({"type": "error", "error": str(exc)})
        yield _sse_frame(
            {"type": "done", "usage": {"prompt_tokens": 0, "completion_tokens": 0}}
        )

    finally:
        if process and process.returncode is None:
            await _terminate_claude_process(process)


# ---------------------------------------------------------------------------
# Claude Code CLI — persistent & interactive modes (long-lived process)
# ---------------------------------------------------------------------------


async def _stream_claude_persistent(req: ChatRequest, request: Request):
    """
    Stream Claude Code CLI for persistent and interactive modes.

    Keeps a single process alive across multiple messages. Messages are
    sent as JSON lines to stdin. The process stays running between requests.
    """
    mode = req.claudeMode or "persistent"
    session_id = req.claudeSessionId or str(uuid.uuid4())

    # Check crash backoff
    if _claude_should_refuse_restart(session_id):
        yield _sse_frame(
            {
                "type": "error",
                "error": f"Session {session_id} crashed {CLAUDE_CRASH_THRESHOLD}+ times "
                f"in {int(CLAUDE_CRASH_WINDOW_S)}s. Refusing restart. "
                "Try a new session or switch to oneshot mode.",
            }
        )
        yield _sse_frame(
            {"type": "done", "usage": {"prompt_tokens": 0, "completion_tokens": 0}}
        )
        return

    # Get or create persistent process
    process = _claude_processes.get(session_id)

    if process is None or process.returncode is not None:
        # Need a new process
        if process is not None and process.returncode is not None:
            logger.info(
                "[AssistantChat] Claude persistent process for %s died (rc=%d), respawning",
                session_id,
                process.returncode,
            )
            _claude_record_crash(session_id)
            _claude_processes.pop(session_id, None)

        cmd_args = [
            "cmd",
            "/c",
            CLAUDE_CMD,
            "--output-format",
            "stream-json",
            "--input-format",
            "stream-json",
            "--max-turns",
            str(CLAUDE_MAX_TURNS),
            "--dangerously-skip-permissions",
            "--session-id",
            session_id,
            "--verbose",
        ]
        # persistent mode includes --print; interactive does not
        if mode == "persistent":
            cmd_args.insert(3, "--print")

        model = req.model or ""
        if model.startswith("claude-code-"):
            model = "opus"
        if model:
            cmd_args.extend(["--model", model])
            fallbacks = {
                "opus": "sonnet",
                "claude-opus-4-6": "claude-sonnet-4-6",
                "sonnet": "haiku",
                "claude-sonnet-4-6": "claude-haiku-4-5",
            }
            fb = fallbacks.get(model)
            if fb:
                cmd_args.extend(["--fallback-model", fb])

        process = await asyncio.create_subprocess_exec(
            *cmd_args,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            limit=10
            * 1024
            * 1024,  # 10 MB — avoids ValueError on long Claude JSON lines
            cwd=PROJECT_CWD,
        )
        _claude_processes[session_id] = process

        yield _sse_frame(
            {
                "type": "status",
                "message": f"spawned {mode} process (session={session_id})",
                "session_id": session_id,
            }
        )

    if process.stdout is None or process.stdin is None:
        yield _sse_frame(
            {"type": "error", "error": "Failed to capture Claude CLI stdio"}
        )
        return

    # Build and send the user message as a JSON line
    prompt = _build_prompt(req.messages)
    if not prompt:
        yield _sse_frame(
            {"type": "error", "error": "No prompt content found in messages"}
        )
        return

    user_payload = {
        "type": "user",
        "message": {
            "role": "user",
            "content": [{"type": "text", "text": prompt}],
        },
    }
    message_line = json.dumps(user_payload) + "\n"

    try:
        process.stdin.write(message_line.encode("utf-8"))
        await process.stdin.drain()
    except (BrokenPipeError, ConnectionResetError, OSError) as exc:
        logger.error(
            "[AssistantChat] Failed to write to Claude persistent stdin: %s", exc
        )
        _claude_record_crash(session_id)
        _claude_processes.pop(session_id, None)
        yield _sse_frame(
            {"type": "error", "error": f"Claude process stdin broken: {exc}"}
        )
        yield _sse_frame(
            {
                "type": "done",
                "usage": {"prompt_tokens": 0, "completion_tokens": 0},
                "session_id": session_id,
            }
        )
        return

    yield _sse_frame({"type": "status", "message": f"thinking ({mode})..."})

    # Read stdout lines until we get a result event for this turn
    start_time = time.monotonic()
    last_keepalive = time.monotonic()
    total_bytes_read = 0

    try:
        while True:
            # Check client disconnect
            if await request.is_disconnected():
                logger.info(
                    "[AssistantChat] Client disconnected during persistent stream"
                )
                # Don't kill the process — it stays alive for future messages.
                # But we do stop reading.
                return

            # Check timeout
            elapsed = time.monotonic() - start_time
            if elapsed > CLAUDE_TIMEOUT_S:
                logger.warning(
                    "[AssistantChat] Claude persistent stream timed out after %ds",
                    int(elapsed),
                )
                yield _sse_frame(
                    {
                        "type": "error",
                        "error": f"Claude stream timed out after {int(elapsed)}s",
                    }
                )
                # Kill the process on timeout — it's stuck
                await _terminate_claude_process(process)
                _claude_processes.pop(session_id, None)
                _claude_record_crash(session_id)
                break

            # Read with keepalive timeout
            try:
                line_bytes = await asyncio.wait_for(
                    process.stdout.readline(),
                    timeout=KEEPALIVE_INTERVAL,
                )
            except asyncio.TimeoutError:
                yield ": ping\n\n"
                last_keepalive = time.monotonic()
                continue

            if not line_bytes:
                # EOF — process died
                logger.warning(
                    "[AssistantChat] Claude persistent process EOF (session=%s)",
                    session_id,
                )
                _claude_record_crash(session_id)
                _claude_processes.pop(session_id, None)
                yield _sse_frame(
                    {"type": "error", "error": "Claude process exited unexpectedly"}
                )
                break

            total_bytes_read += len(line_bytes)
            if total_bytes_read > CLAUDE_MAX_STDOUT_BYTES:
                logger.warning(
                    "[AssistantChat] Claude persistent stdout exceeded %d bytes",
                    CLAUDE_MAX_STDOUT_BYTES,
                )
                yield _sse_frame(
                    {
                        "type": "error",
                        "error": "Claude output exceeded 10MB safety limit",
                    }
                )
                await _terminate_claude_process(process)
                _claude_processes.pop(session_id, None)
                break

            line = line_bytes.decode("utf-8", errors="replace").strip()
            if not line:
                continue

            try:
                data = json.loads(line)
            except json.JSONDecodeError:
                logger.debug(
                    "[AssistantChat] Non-JSON line from Claude persistent: %s",
                    line[:200],
                )
                continue

            # Parse and emit SSE frames
            for frame in _parse_claude_event(data):
                yield _sse_frame(frame)
                if frame.get("type") == "done":
                    # Turn complete — process stays alive for next message
                    return

            # Keepalive
            now = time.monotonic()
            if now - last_keepalive > KEEPALIVE_INTERVAL:
                yield ": ping\n\n"
                last_keepalive = now

        # Fell through without a result event
        yield _sse_frame(
            {
                "type": "done",
                "usage": {"prompt_tokens": 0, "completion_tokens": 0},
                "session_id": session_id,
            }
        )

    except asyncio.CancelledError:
        logger.info(
            "[AssistantChat] Claude persistent stream cancelled (session=%s)",
            session_id,
        )
        # Don't kill the process on cancel — it persists
        raise

    except Exception as exc:
        logger.exception(
            "[AssistantChat] Error in Claude persistent stream (session=%s)", session_id
        )
        _claude_record_crash(session_id)
        _claude_processes.pop(session_id, None)
        yield _sse_frame({"type": "error", "error": str(exc)})
        yield _sse_frame(
            {
                "type": "done",
                "usage": {"prompt_tokens": 0, "completion_tokens": 0},
                "session_id": session_id,
            }
        )


# ---------------------------------------------------------------------------
# Claude Code CLI — dispatcher
# ---------------------------------------------------------------------------


async def _stream_claude(req: ChatRequest, request: Request):
    """
    Dispatch to the appropriate Claude streaming strategy.

    Modes:
      - oneshot:     Spawn per message, no session persistence.
      - resume:      Spawn per message, reuse session via --resume.
      - persistent:  Long-lived process with --print, messages via stdin JSON.
      - interactive: Long-lived process without --print, messages via stdin JSON.
    """
    mode = req.claudeMode or "oneshot"

    if mode in ("oneshot", "resume"):
        async for frame in _stream_claude_spawn(req, request):
            yield frame
    elif mode in ("persistent", "interactive"):
        async for frame in _stream_claude_persistent(req, request):
            yield frame
    else:
        yield _sse_frame({"type": "error", "error": f"Unknown claudeMode: {mode}"})
        yield _sse_frame(
            {"type": "done", "usage": {"prompt_tokens": 0, "completion_tokens": 0}}
        )


# ---------------------------------------------------------------------------
# Generic OpenAI-compatible streamer
# ---------------------------------------------------------------------------


async def _stream_openai_compat(req: ChatRequest, request: Request, provider_id: str):
    """
    Stream chat completions from any OpenAI-compatible API.

    Works for: openai, gemini, grok, groq, openrouter, openrouter-free,
    ollama, lmstudio, llamacpp, vllm.
    """
    cfg = PROVIDERS.get(provider_id)
    if not cfg:
        yield _sse_frame({"type": "error", "error": f"Unknown provider: {provider_id}"})
        return

    is_local = cfg["base_url"].startswith("http://localhost")
    model = req.model or cfg["default_model"]
    if not model:
        yield _sse_frame(
            {"type": "error", "error": f"No model specified for {provider_id}"}
        )
        return

    messages_payload = [{"role": m.role, "content": m.content} for m in req.messages]
    url = _chat_url(provider_id)
    label = cfg["label"]

    max_key_retries = (
        (len(key_pool.get_raw_keys(provider_id)) or 1) if provider_id == "gemini" else 1
    )

    for key_attempt in range(max_key_retries):
        api_key = _get_api_key(provider_id, getattr(req, "apiKey", None))

        if not is_local and not api_key:
            env_key = cfg.get("env_key", "???")
            yield _sse_frame({"type": "error", "error": f"{env_key} not set"})
            return

        headers: dict[str, str] = {"Content-Type": "application/json"}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        if provider_id in ("openrouter", "openrouter-free"):
            headers["HTTP-Referer"] = "https://stabledaw.local"
            headers["X-Title"] = "StableDAW Assistant"

        if key_attempt == 0:
            yield _sse_frame(
                {"type": "status", "message": f"Connecting to {label} ({model})..."}
            )

        try:
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(120.0, connect=10.0)
            ) as client:
                async with client.stream(
                    "POST",
                    url,
                    headers=headers,
                    json={
                        "model": model,
                        "messages": messages_payload,
                        "stream": True,
                    },
                ) as response:
                    if (
                        response.status_code == 429
                        and key_attempt + 1 < max_key_retries
                    ):
                        body = await response.aread()
                        if api_key:
                            key_pool.report_failure(provider_id, api_key, 429)
                        logger.info(
                            "[AssistantChat] %s 429 on key attempt %d, rotating",
                            label,
                            key_attempt + 1,
                        )
                        yield _sse_frame(
                            {
                                "type": "status",
                                "message": f"Key rate-limited, trying next key ({key_attempt + 2}/{max_key_retries})...",
                            }
                        )
                        continue

                    if response.status_code != 200:
                        body = await response.aread()
                        yield _sse_frame(
                            {
                                "type": "error",
                                "error": f"{label} {response.status_code}: {body.decode('utf-8', errors='replace')[:500]}",
                            }
                        )
                        return

                    buffer = ""
                    async for chunk in response.aiter_text():
                        if await request.is_disconnected():
                            return

                        buffer += chunk
                        while "\n" in buffer:
                            line, buffer = buffer.split("\n", 1)
                            line = line.strip()

                            if not line or line == "data: [DONE]":
                                continue
                            if not line.startswith("data: "):
                                continue

                            try:
                                data = json.loads(line[6:])
                                choices = data.get("choices", [])
                                if choices:
                                    delta = choices[0].get("delta", {})
                                    text = delta.get("content", "")
                                    if text:
                                        yield _sse_frame(
                                            {"type": "text_delta", "delta": text}
                                        )

                                    finish_reason = choices[0].get("finish_reason")
                                    if finish_reason:
                                        usage = data.get("usage") or {}
                                        yield _sse_frame(
                                            {
                                                "type": "done",
                                                "usage": {
                                                    "prompt_tokens": usage.get(
                                                        "prompt_tokens", 0
                                                    ),
                                                    "completion_tokens": usage.get(
                                                        "completion_tokens", 0
                                                    ),
                                                },
                                            }
                                        )
                                        return
                            except json.JSONDecodeError:
                                continue

            yield _sse_frame(
                {"type": "done", "usage": {"prompt_tokens": 0, "completion_tokens": 0}}
            )
            return

        except httpx.ConnectError:
            if is_local:
                yield _sse_frame(
                    {
                        "type": "error",
                        "error": f"{label} is not running at {cfg['base_url']}",
                    }
                )
            else:
                yield _sse_frame(
                    {"type": "error", "error": f"Cannot connect to {label}"}
                )
            yield _sse_frame(
                {"type": "done", "usage": {"prompt_tokens": 0, "completion_tokens": 0}}
            )
            return

        except Exception as exc:
            logger.exception(
                "[AssistantChat] %s streaming error (key attempt %d)",
                label,
                key_attempt + 1,
            )
            yield _sse_frame({"type": "error", "error": str(exc)})
            yield _sse_frame(
                {"type": "done", "usage": {"prompt_tokens": 0, "completion_tokens": 0}}
            )
            return


# ---------------------------------------------------------------------------
# Anthropic streamer (different API format)
# ---------------------------------------------------------------------------


async def _stream_anthropic(req: ChatRequest, request: Request):
    """
    Stream chat completions from the Anthropic Messages API.

    Anthropic uses a non-OpenAI format:
    - System messages go in a top-level `system` parameter
    - SSE events use `content_block_delta` with `delta.text`
    - Requires `x-api-key` and `anthropic-version` headers
    """
    cfg = PROVIDERS["anthropic"]
    api_key = _get_api_key("anthropic", getattr(req, "apiKey", None))
    if not api_key:
        yield _sse_frame({"type": "error", "error": "ANTHROPIC_API_KEY not set"})
        return

    model = req.model or cfg["default_model"]

    # Extract system messages from the conversation
    system_parts: list[str] = []
    non_system_messages: list[dict[str, str]] = []
    for m in req.messages:
        if m.role == "system":
            system_parts.append(m.content)
        else:
            non_system_messages.append({"role": m.role, "content": m.content})

    # Anthropic requires at least one non-system message
    if not non_system_messages:
        yield _sse_frame(
            {"type": "error", "error": "No user/assistant messages provided"}
        )
        return

    url = f"{cfg['base_url']}/v1/messages"
    headers = {
        "x-api-key": api_key,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
    }

    body: dict = {
        "model": model,
        "messages": non_system_messages,
        "max_tokens": 4096,
        "stream": True,
    }
    if system_parts:
        body["system"] = "\n\n".join(system_parts)

    yield _sse_frame(
        {"type": "status", "message": f"Connecting to Anthropic ({model})..."}
    )

    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(120.0, connect=10.0)
        ) as client:
            async with client.stream(
                "POST",
                url,
                headers=headers,
                json=body,
            ) as response:
                if response.status_code != 200:
                    err_body = await response.aread()
                    yield _sse_frame(
                        {
                            "type": "error",
                            "error": f"Anthropic {response.status_code}: {err_body.decode('utf-8', errors='replace')[:500]}",
                        }
                    )
                    return

                buffer = ""
                usage_data: dict[str, int] = {
                    "prompt_tokens": 0,
                    "completion_tokens": 0,
                }

                async for chunk in response.aiter_text():
                    if await request.is_disconnected():
                        return

                    buffer += chunk
                    while "\n" in buffer:
                        line, buffer = buffer.split("\n", 1)
                        line = line.strip()

                        if not line:
                            continue
                        if line.startswith("event: "):
                            continue  # We parse data lines; event type is in the data
                        if not line.startswith("data: "):
                            continue

                        try:
                            data = json.loads(line[6:])
                        except json.JSONDecodeError:
                            continue

                        event_type = data.get("type", "")

                        if event_type == "content_block_delta":
                            delta = data.get("delta", {})
                            if delta.get("type") == "text_delta":
                                text = delta.get("text", "")
                                if text:
                                    yield _sse_frame(
                                        {"type": "text_delta", "delta": text}
                                    )

                        elif event_type == "message_delta":
                            # Contains final usage info
                            usage = data.get("usage", {})
                            if usage.get("output_tokens"):
                                usage_data["completion_tokens"] = usage["output_tokens"]

                        elif event_type == "message_start":
                            # Contains input token count
                            msg = data.get("message", {})
                            usage = msg.get("usage", {})
                            if usage.get("input_tokens"):
                                usage_data["prompt_tokens"] = usage["input_tokens"]

                        elif event_type == "message_stop":
                            yield _sse_frame({"type": "done", "usage": usage_data})
                            return

        # Fallback done
        yield _sse_frame({"type": "done", "usage": usage_data})

    except httpx.ConnectError:
        yield _sse_frame({"type": "error", "error": "Cannot connect to Anthropic API"})
        yield _sse_frame(
            {"type": "done", "usage": {"prompt_tokens": 0, "completion_tokens": 0}}
        )

    except Exception as exc:
        logger.exception("[AssistantChat] Anthropic streaming error")
        yield _sse_frame({"type": "error", "error": str(exc)})
        yield _sse_frame(
            {"type": "done", "usage": {"prompt_tokens": 0, "completion_tokens": 0}}
        )


# ---------------------------------------------------------------------------
# Capability metadata for model discovery
# ---------------------------------------------------------------------------

CLAUDE_MODELS = [
    {
        "id": "claude-sonnet-4-6",
        "name": "Claude Sonnet 4.6",
        "capabilities": ["tools", "reasoning", "vision", "code", "long_context"],
    },
    {
        "id": "claude-opus-4-6",
        "name": "Claude Opus 4.6",
        "capabilities": ["tools", "reasoning", "vision", "code", "long_context"],
    },
    {
        "id": "claude-haiku-4-5",
        "name": "Claude Haiku 4.5",
        "capabilities": ["tools", "vision", "code", "fast"],
    },
    {
        "id": "sonnet",
        "name": "Sonnet (Latest)",
        "capabilities": ["tools", "reasoning", "vision", "code", "long_context"],
    },
    {
        "id": "opus",
        "name": "Opus (Latest)",
        "capabilities": ["tools", "reasoning", "vision", "code", "long_context"],
    },
    {
        "id": "haiku",
        "name": "Haiku (Latest)",
        "capabilities": ["tools", "vision", "code", "fast"],
    },
]

GEMINI_MODELS = [
    {
        "id": "gemini-2.5-flash",
        "name": "Gemini 2.5 Flash",
        "capabilities": [
            "tools",
            "reasoning",
            "vision",
            "audio_in",
            "video_in",
            "code",
            "long_context",
            "fast",
        ],
    },
    {
        "id": "gemini-2.5-pro",
        "name": "Gemini 2.5 Pro",
        "capabilities": [
            "tools",
            "reasoning",
            "vision",
            "audio_in",
            "video_in",
            "code",
            "long_context",
        ],
    },
    {
        "id": "gemini-flash-recent",
        "name": "Gemini Flash (Latest)",
        "capabilities": [
            "tools",
            "reasoning",
            "vision",
            "audio_in",
            "video_in",
            "code",
            "long_context",
            "fast",
        ],
    },
]

OPENAI_CAPS: dict[str, list[str]] = {
    "gpt-4.1": ["tools", "reasoning", "vision", "code", "long_context"],
    "gpt-4.1-mini": ["tools", "vision", "code", "fast"],
    "gpt-4.1-nano": ["tools", "code", "fast"],
    "o3": ["tools", "reasoning", "vision", "code", "long_context"],
    "o3-mini": ["tools", "reasoning", "code", "fast"],
    "o4-mini": ["tools", "reasoning", "vision", "code", "fast"],
    "gpt-image-1": ["image_gen"],
}

GROK_CAPS: dict[str, list[str]] = {
    "grok-3": ["tools", "reasoning", "vision", "code", "long_context"],
    "grok-3-mini": ["tools", "reasoning", "code", "fast"],
    "grok-3-mini-fast": ["tools", "code", "fast"],
}

GROQ_CAPS: dict[str, list[str]] = {
    "llama-3.3-70b-versatile": ["tools", "code", "fast"],
    "llama-3.1-8b-instant": ["tools", "code", "fast"],
    "gemma2-9b-it": ["code", "fast"],
    "mixtral-8x7b-32768": ["tools", "code", "long_context"],
}

# Map provider_id -> caps lookup dict for OpenAI-compatible providers
_PROVIDER_CAPS_MAP: dict[str, dict[str, list[str]]] = {
    "openai": OPENAI_CAPS,
    "grok": GROK_CAPS,
    "groq": GROQ_CAPS,
}

# OpenRouter model data cache (5-minute TTL)
_openrouter_cache: dict = {"data": None, "ts": 0.0}
_OPENROUTER_CACHE_TTL = 300.0  # seconds


def _match_caps(
    model_id: str, caps_map: dict[str, list[str]], default: list[str]
) -> list[str]:
    """Look up capabilities for a model ID using longest-prefix match.

    Checks if any key in caps_map is a prefix of model_id, preferring the
    longest matching key. Falls back to *default* if no match.
    """
    best_key = ""
    for key in caps_map:
        if model_id.startswith(key) and len(key) > len(best_key):
            best_key = key
    return caps_map[best_key] if best_key else list(default)


def _enrich_models_with_caps(
    models: list[dict],
    caps_map: dict[str, list[str]],
    default_caps: list[str],
) -> list[dict]:
    """Add a 'capabilities' field to each model dict using prefix-match lookup."""
    for m in models:
        if "capabilities" not in m:
            m["capabilities"] = _match_caps(m.get("id", ""), caps_map, default_caps)
    return models


def _build_openrouter_capabilities(m: dict) -> list[str]:
    """Extract capability tags from an OpenRouter model metadata dict."""
    caps: list[str] = []
    arch = m.get("architecture", {}) or {}
    input_mods = arch.get("input_modalities", []) or []
    output_mods = arch.get("output_modalities", []) or []
    supported = m.get("supported_parameters", []) or []
    ctx_len = m.get("context_length", 0) or 0

    if "tools" in supported:
        caps.append("tools")
    if "reasoning" in supported:
        caps.append("reasoning")
    if "image" in input_mods:
        caps.append("vision")
    if "audio" in input_mods:
        caps.append("audio_in")
    if "audio" in output_mods:
        caps.append("audio_out")
    if "video" in input_mods:
        caps.append("video_in")
    if "image" in output_mods:
        caps.append("image_gen")
    if "structured_outputs" in supported:
        caps.append("structured_output")
    if "web_search_options" in supported:
        caps.append("web_search")
    if ctx_len >= 200_000:
        caps.append("long_context")

    return caps


def _enrich_anthropic_models(models: list[dict]) -> list[dict]:
    """Enrich Anthropic API-fetched models with known Claude capabilities.

    The Anthropic API returns IDs like 'claude-sonnet-4-20250514' while our
    CLAUDE_MODELS use short IDs like 'claude-sonnet-4-6'. We match by checking
    if a CLAUDE_MODELS id (minus trailing version segment) is a prefix of the
    API-returned id.
    """
    for m in models:
        mid = m.get("id", "")
        matched = False
        for cm in CLAUDE_MODELS:
            # e.g. 'claude-sonnet-4' prefix matches 'claude-sonnet-4-20250514'
            # Extract base prefix: 'claude-sonnet-4-6' -> 'claude-sonnet-4'
            cm_id = cm["id"]
            parts = cm_id.rsplit("-", 1)
            prefix = parts[0] if len(parts) > 1 else cm_id
            if mid.startswith(prefix):
                m["capabilities"] = list(cm["capabilities"])
                matched = True
                break
        if not matched:
            # Default for unknown Anthropic models
            m["capabilities"] = ["tools", "vision", "code"]
    return models


# ---------------------------------------------------------------------------
# Model discovery
# ---------------------------------------------------------------------------

# Models to exclude from listings (non-chat)
_SKIP_MODEL_KEYWORDS = (
    "embed",
    "rerank",
    "whisper",
    "tts",
    "sdxl",
    "flux",
    "stable-diffusion",
)


async def _fetch_openai_compat_models(
    base_url: str, models_path: str, api_key: str
) -> list[dict]:
    """Fetch models from a standard OpenAI-compatible /v1/models endpoint."""
    url = f"{base_url}{models_path}"
    headers: dict[str, str] = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    async with httpx.AsyncClient(timeout=8.0) as client:
        resp = await client.get(url, headers=headers)
        if resp.status_code != 200:
            raise ValueError(f"HTTP {resp.status_code}: {resp.text[:200]}")
        data = resp.json().get("data", [])

    models = []
    for m in data:
        mid = m.get("id", "")
        if any(kw in mid.lower() for kw in _SKIP_MODEL_KEYWORDS):
            continue
        models.append(
            {
                "id": mid,
                "name": m.get("name", mid),
                "context_length": m.get("context_length", 0),
            }
        )
    return models


async def _fetch_openrouter_models(free_only: bool = False) -> dict:
    """Fetch models from OpenRouter (cached 5 min), split into free/paid with capabilities."""
    global _openrouter_cache

    now = time.monotonic()
    if (
        _openrouter_cache["data"] is not None
        and (now - _openrouter_cache["ts"]) < _OPENROUTER_CACHE_TTL
    ):
        data = _openrouter_cache["data"]
    else:
        cfg = PROVIDERS["openrouter"]
        url = f"{cfg['base_url']}/v1/models"
        async with httpx.AsyncClient(timeout=12.0) as client:
            resp = await client.get(url)
            if resp.status_code != 200:
                raise ValueError(f"HTTP {resp.status_code}: {resp.text[:200]}")
            data = resp.json().get("data", [])
        _openrouter_cache = {"data": data, "ts": now}

    free_models: list[dict] = []
    paid_models: list[dict] = []

    for m in data:
        mid = m.get("id", "")
        if any(kw in mid.lower() for kw in _SKIP_MODEL_KEYWORDS):
            continue

        pricing = m.get("pricing", {})
        prompt_cost = float(pricing.get("prompt", "1") or "1")
        completion_cost = float(pricing.get("completion", "1") or "1")

        entry = {
            "id": mid,
            "name": m.get("name", mid),
            "context_length": m.get("context_length", 0),
            "capabilities": _build_openrouter_capabilities(m),
        }

        if prompt_cost == 0 and completion_cost == 0:
            free_models.append(entry)
        else:
            paid_models.append(entry)

    free_models.sort(key=lambda x: x.get("context_length", 0), reverse=True)
    paid_models.sort(key=lambda x: x.get("name", ""))

    if free_only:
        all_models = free_models
    else:
        all_models = free_models + paid_models[:50]

    return {
        "models": all_models,
        "model_ids": [m["id"] for m in all_models],
        "error": None,
        "free": free_models,
        "paid": paid_models[:50],
    }


async def _fetch_ollama_models(base_url: str) -> list[dict]:
    """Fetch models from Ollama's /api/tags endpoint."""
    url = f"{base_url}/api/tags"
    async with httpx.AsyncClient(timeout=8.0) as client:
        resp = await client.get(url)
        if resp.status_code != 200:
            raise ValueError(f"HTTP {resp.status_code}: {resp.text[:200]}")
        data = resp.json().get("models", [])

    return [
        {"id": m.get("name", ""), "name": m.get("name", ""), "context_length": 0}
        for m in data
    ]


async def _fetch_gemini_models(api_key: str) -> list[dict]:
    """Fetch models from Google's Gemini API."""
    url = f"https://generativelanguage.googleapis.com/v1beta/models?key={api_key}"
    async with httpx.AsyncClient(timeout=8.0) as client:
        resp = await client.get(url)
        if resp.status_code != 200:
            raise ValueError(f"HTTP {resp.status_code}: {resp.text[:200]}")
        data = resp.json().get("models", [])

    models = []
    for m in data:
        name = m.get("name", "")
        # Strip "models/" prefix (e.g. "models/gemini-2.0-flash" -> "gemini-2.0-flash")
        if name.startswith("models/"):
            name = name[7:]
        display = m.get("displayName", name)
        models.append({"id": name, "name": display, "context_length": 0})
    return models


async def _fetch_anthropic_models(api_key: str) -> list[dict]:
    """Fetch models from the Anthropic /v1/models endpoint."""
    cfg = PROVIDERS["anthropic"]
    url = f"{cfg['base_url']}/v1/models"
    headers = {
        "x-api-key": api_key,
        "anthropic-version": "2023-06-01",
    }
    async with httpx.AsyncClient(timeout=8.0) as client:
        resp = await client.get(url, headers=headers)
        if resp.status_code != 200:
            raise ValueError(f"HTTP {resp.status_code}: {resp.text[:200]}")
        data = resp.json().get("data", [])

    return [
        {"id": m.get("id", ""), "name": m.get("id", ""), "context_length": 0}
        for m in data
    ]


# ---------------------------------------------------------------------------
# Route: provider catalog
# ---------------------------------------------------------------------------


@router.get("/reindex")
async def reindex_rag():
    from backend.rag import initialize_rag

    n = initialize_rag(force=True)
    return {"status": "ok", "chunks_indexed": n}


@router.get("/providers")
async def get_providers():
    """Return the provider catalog for frontend dropdowns."""
    result = []
    for pid, cfg in PROVIDERS.items():
        has_key = True
        result.append(
            {
                "id": pid,
                "label": cfg["label"],
                "default_model": cfg["default_model"],
                "has_key": has_key,
                "is_local": cfg["base_url"].startswith("http://localhost"),
            }
        )
    # Claude Code (CLI-based, always available)
    result.append(
        {
            "id": "claude",
            "label": "Claude Code",
            "default_model": "claude-sonnet-4-6",
            "has_key": True,
            "is_local": False,
        }
    )
    return {"providers": result}


# ---------------------------------------------------------------------------
# Route: model discovery (generic)
# ---------------------------------------------------------------------------


@router.get("/models/{provider_id}")
async def get_provider_models(provider_id: str):
    """Fetch available models with capability metadata for a given provider."""
    cfg = PROVIDERS.get(provider_id)

    # --- Claude Code (CLI-based) ---
    if provider_id == "claude":
        models = [dict(m) for m in CLAUDE_MODELS]  # shallow copy
        return {
            "models": models,
            "model_ids": [m["id"] for m in models],
            "modes": ["oneshot", "resume", "persistent", "interactive"],
            "note": "Set claudeMode in chat request. oneshot/resume spawn per message; "
            "persistent/interactive keep a long-lived process.",
            "error": None,
        }

    if not cfg:
        return {
            "models": [],
            "model_ids": [],
            "error": f"Unknown provider: {provider_id}",
        }

    api_key = _get_api_key(provider_id)
    is_local = cfg["base_url"].startswith("http://localhost")

    # Check key requirement for remote providers
    if not is_local and cfg["env_key"] and not api_key:
        return {"models": [], "model_ids": [], "error": f"{cfg['env_key']} not set"}

    try:
        # --- OpenRouter (with free/paid split, already enriched) ---
        if provider_id in ("openrouter", "openrouter-free"):
            result = await _fetch_openrouter_models(
                free_only=(provider_id == "openrouter-free")
            )
            return result

        # --- Ollama (local, default capabilities) ---
        if provider_id == "ollama":
            models = await _fetch_ollama_models(cfg["base_url"])
            for m in models:
                m["capabilities"] = ["tools", "code"]
            return {
                "models": models,
                "model_ids": [m["id"] for m in models],
                "error": None,
            }

        # --- Gemini (try key pool, enrich with known caps) ---
        if provider_id == "gemini":
            # Build a caps map from GEMINI_MODELS for prefix matching
            gemini_caps = {gm["id"]: gm["capabilities"] for gm in GEMINI_MODELS}
            last_err = None
            for _attempt in range(max(1, key_pool.get_pool_status("gemini")["total"])):
                try:
                    k = key_pool.get_next_key("gemini") or api_key
                    models = await _fetch_gemini_models(k)
                    if models:
                        key_pool.report_success("gemini", k)
                        _enrich_models_with_caps(
                            models, gemini_caps, ["tools", "vision", "code"]
                        )
                        return {
                            "models": models,
                            "model_ids": [m["id"] for m in models],
                            "error": None,
                        }
                except Exception as e:
                    last_err = e
                    if k:
                        key_pool.report_failure("gemini", k, http_status=403)
            # All keys failed -- return known models as fallback (with caps)
            fallback = [dict(m) for m in GEMINI_MODELS]
            return {
                "models": fallback,
                "model_ids": [m["id"] for m in fallback],
                "error": f"Model list from API failed ({last_err}), showing known models",
            }

        # --- Anthropic (enrich with Claude caps) ---
        if provider_id == "anthropic":
            models = await _fetch_anthropic_models(api_key)
            _enrich_anthropic_models(models)
            return {
                "models": models,
                "model_ids": [m["id"] for m in models],
                "error": None,
            }

        # --- LM Studio (native API with rich metadata) ---
        if provider_id == "lmstudio":
            try:
                async with httpx.AsyncClient(timeout=httpx.Timeout(10.0)) as client:
                    resp = await client.get(f"{cfg['base_url']}/api/v0/models")
                    resp.raise_for_status()
                    data = resp.json()
                    raw_models = data.get("data", [])

                    models = []
                    for m in raw_models:
                        model_type = m.get("type", "llm")
                        caps = []

                        lms_caps = m.get("capabilities", [])
                        if "tool_use" in lms_caps:
                            caps.append("tools")

                        if model_type == "vlm":
                            caps.append("vision")
                        if model_type == "embeddings":
                            caps.append("structured_output")

                        arch = m.get("arch", "")
                        if (
                            "qwen3vl" in arch
                            or "glm4" in arch
                            or "llava" in arch
                            or "pixtral" in arch
                        ):
                            caps.append("vision")

                        ctx = m.get("max_context_length", 0)
                        if ctx >= 200000:
                            caps.append("long_context")

                        caps.append("code")

                        state = m.get("state", "not-loaded")
                        quant = m.get("quantization", "")
                        name_parts = [m.get("id", "")]
                        if quant:
                            name_parts.append(f"[{quant}]")
                        if state == "loaded":
                            name_parts.append("(active)")

                        models.append(
                            {
                                "id": m.get("id", ""),
                                "name": " ".join(name_parts),
                                "capabilities": list(dict.fromkeys(caps)),
                                "context_length": ctx,
                                "state": state,
                                "type": model_type,
                                "arch": arch,
                                "quantization": quant,
                                "publisher": m.get("publisher", ""),
                            }
                        )

                    models.sort(
                        key=lambda x: (0 if x["state"] == "loaded" else 1, x["id"])
                    )

                    return {
                        "models": models,
                        "model_ids": [m["id"] for m in models],
                        "error": None,
                    }
            except Exception as lms_err:
                logger.warning(
                    "[AssistantChat] LM Studio native API failed (%s), falling back to OpenAI compat",
                    lms_err,
                )

        # --- Standard OpenAI-compatible (openai, grok, groq, llamacpp, vllm) ---
        models_path = cfg.get("models_path")
        if models_path:
            models = await _fetch_openai_compat_models(
                cfg["base_url"], models_path, api_key
            )
            caps_map = _PROVIDER_CAPS_MAP.get(provider_id, {})
            default_caps = ["tools", "code"]
            _enrich_models_with_caps(models, caps_map, default_caps)
            return {
                "models": models,
                "model_ids": [m["id"] for m in models],
                "error": None,
            }

        return {
            "models": [],
            "model_ids": [],
            "error": f"No model discovery for {provider_id}",
        }

    except httpx.ConnectError:
        label = cfg["label"]
        if is_local:
            return {
                "models": [],
                "model_ids": [],
                "error": f"{label} is not running at {cfg['base_url']}",
            }
        return {"models": [], "model_ids": [], "error": f"Cannot connect to {label}"}

    except Exception as exc:
        logger.exception("[AssistantChat] Failed to fetch models for %s", provider_id)
        return {"models": [], "model_ids": [], "error": str(exc)}


# ---------------------------------------------------------------------------
# Route: backward-compatible OpenRouter models
# ---------------------------------------------------------------------------


@router.get("/openrouter-models")
async def get_openrouter_free_models():
    """Fetch available free models from OpenRouter API (backward-compat)."""
    try:
        result = await _fetch_openrouter_models(free_only=False)
        # Return the legacy shape: {free: [...], paid: [...]}
        return {"free": result.get("free", []), "paid": result.get("paid", [])}
    except Exception as exc:
        logger.exception("[AssistantChat] Failed to fetch OpenRouter models")
        return {"free": [], "paid": [], "error": str(exc)}


# ---------------------------------------------------------------------------
# Route: chat stream
# ---------------------------------------------------------------------------

_SSE_HEADERS = {
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
}


@router.post("/chat")
async def chat_stream(req: ChatRequest, request: Request):
    """
    Stream an assistant chat response via SSE.

    Routes to the appropriate streamer based on the provider field.
    """
    provider = req.provider or "gemini"

    # RAG: two-tier strategy
    # - Claude Code: breadcrumbs (file paths + section names) appended to user message — it has Read tool access
    # - All others: full chunks injected as system message — they can't read files
    if req.messages:
        user_text = ""
        for msg in reversed(req.messages):
            if msg.role == "user":
                user_text = _extract_text(msg.content)
                break
        if user_text:
            try:
                from backend.rag import retrieve, format_context

                rag_chunks = await asyncio.to_thread(retrieve, user_text, 5)

                if provider == "claude":
                    if rag_chunks:
                        refs = "\n".join(
                            f"- {c['source']} § {c['section']}" for c in rag_chunks
                        )
                        breadcrumb = f"\n\n[Relevant docs — read these files for details:\n{refs}]"
                        for msg in reversed(req.messages):
                            if msg.role == "user":
                                msg.content = _extract_text(msg.content) + breadcrumb
                                break
                else:
                    rag_context = format_context(rag_chunks)
                    if rag_context:
                        system_msg = ChatMessage(
                            role="system",
                            content=STABLEDAW_SYSTEM_PROMPT + "\n\n" + rag_context,
                        )
                        req.messages = [system_msg] + list(req.messages)
            except Exception:
                pass

    if provider == "claude":
        mode = req.claudeMode or "oneshot"
        logger.info(
            "[AssistantChat] Claude %s mode (model=%s, session=%s, messages=%d)",
            mode,
            req.model,
            req.claudeSessionId,
            len(req.messages),
        )
        return StreamingResponse(
            _stream_claude(req, request),
            media_type="text/event-stream",
            headers=_SSE_HEADERS,
        )

    if provider == "anthropic":
        logger.info(
            "[AssistantChat] Starting Anthropic stream (model=%s, messages=%d)",
            req.model,
            len(req.messages),
        )
        return StreamingResponse(
            _stream_anthropic(req, request),
            media_type="text/event-stream",
            headers=_SSE_HEADERS,
        )

    if provider in PROVIDERS:
        logger.info(
            "[AssistantChat] Starting %s stream (model=%s, messages=%d)",
            PROVIDERS[provider]["label"],
            req.model,
            len(req.messages),
        )
        return StreamingResponse(
            _stream_openai_compat(req, request, provider),
            media_type="text/event-stream",
            headers=_SSE_HEADERS,
        )

    # Unknown provider -- let frontend handle
    return {"status": "use_client_side", "provider": provider}


# ---------------------------------------------------------------------------
# Key Pool Management Routes
# ---------------------------------------------------------------------------


@router.post("/keys/{provider_id}/ingest")
async def ingest_keys(provider_id: str, request: Request):
    """Ingest one or more API keys (comma/newline/semicolon separated)."""
    body = await request.json()
    raw = body.get("keys", "")
    added = key_pool.ingest_keys(provider_id, raw)
    return {"added": added, "status": key_pool.get_pool_status(provider_id)}


@router.delete("/keys/{provider_id}/{key_hash}")
async def remove_key(provider_id: str, key_hash: str):
    """Remove a specific key by its hash prefix."""
    pool = key_pool._pools.get(provider_id, [])
    for entry in pool:
        if _key_id(entry.key) == key_hash:
            key_pool.remove_key(provider_id, entry.key)
            return {"removed": True, "status": key_pool.get_pool_status(provider_id)}
    return {"removed": False}


@router.delete("/keys/{provider_id}")
async def clear_keys(provider_id: str):
    """Clear all user-added keys for a provider."""
    key_pool.clear_provider(provider_id)
    return {"cleared": True, "status": key_pool.get_pool_status(provider_id)}


@router.get("/keys")
async def get_all_key_status():
    """Get key pool status for all providers."""
    return {"pools": key_pool.get_all_status()}


@router.get("/keys/{provider_id}")
async def get_key_status(provider_id: str):
    """Get key pool status for a specific provider."""
    return key_pool.get_pool_status(provider_id)


@router.get("/keys/{provider_id}/raw")
async def get_raw_keys(provider_id: str):
    """Return raw key strings for frontend sync. Local-only endpoint."""
    keys = key_pool.get_raw_keys(provider_id)
    return {"provider": provider_id, "keys": keys, "count": len(keys)}
