"""
Generic API Key Pool -- Round-robin rotation with smart cooldowns.

Keys are loaded from:
  1. Environment variables (highest priority)
  2. JSON file at data/api_key_pools.json (user-added keys via UI)
"""

import hashlib
import json
import logging
import os
import threading
import time
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

PROJECT_ROOT = Path(__file__).resolve().parent.parent
POOL_FILE = PROJECT_ROOT / "data" / "api_key_pools.json"

SHORT_COOLDOWN = 60.0
EXTENDED_COOLDOWN = 300.0
EXTENDED_THRESHOLD = 3
PERMANENT_COOLDOWN = 365 * 24 * 3600.0

PROVIDER_ENV_MAP = {
    "openrouter": ["OPENROUTER_API_KEY"],
    "openai": ["OPENAI_API_KEY"],
    "anthropic": ["ANTHROPIC_API_KEY"],
    "gemini": [
        "VITE_GEMINI_API_KEYS",
        "GEMINI_API_KEY",
        "GOOGLE_GENERATIVE_AI_API_KEY",
        "VITE_GEMINI_API_KEY",
    ],
    "groq": ["GROQ_API_KEY"],
    "grok": ["XAI_API_KEY"],
    "openrouter-free": ["OPENROUTER_API_KEY"],
}

PLACEHOLDERS = {"placeholder", "your-key-here", "sk-xxx", "not-set", ""}


def _key_id(key: str) -> str:
    """Return a short, safe identifier for a key (sha256 prefix)."""
    if not key:
        return "empty"
    return "key-" + hashlib.sha256(key.encode()).hexdigest()[:8]


def _is_valid(key: str) -> bool:
    """Check if a key string is non-placeholder and long enough."""
    return (
        bool(key) and key.strip().lower() not in PLACEHOLDERS and len(key.strip()) >= 8
    )


class KeyEntry:
    """Single key with its rotation/cooldown state."""

    def __init__(self, provider: str, key: str, source: str = "user"):
        self.provider = provider
        self.key = key
        self.source = source
        self.fail_count = 0
        self.last_failed_at: Optional[float] = None
        self.cooldown_until: float = 0.0

    @property
    def is_available(self) -> bool:
        return time.time() >= self.cooldown_until

    def to_dict(self) -> dict:
        return {"key": self.key, "source": self.source}


class KeyPoolManager:
    """
    Thread-safe API key pool with round-robin rotation and smart cooldowns.

    Cooldown tiers:
      - Generic failure: 60s (SHORT_COOLDOWN)
      - 3+ consecutive failures: 5min (EXTENDED_COOLDOWN)
      - 401/403: 1 year (PERMANENT_COOLDOWN) -- invalid or banned key
      - 429 daily quota: 8h
      - 429 rate limit: 2s
    """

    def __init__(self) -> None:
        self._pools: dict[str, list[KeyEntry]] = {}
        self._next_idx: dict[str, int] = {}
        self._lock = threading.Lock()
        self._load_from_file()

    # ------------------------------------------------------------------
    # Persistence
    # ------------------------------------------------------------------

    def _load_from_file(self) -> None:
        """Load user-added keys from the JSON pool file."""
        if not POOL_FILE.exists():
            return
        try:
            data = json.loads(POOL_FILE.read_text())
            for provider, keys in data.items():
                if not isinstance(keys, list):
                    continue
                for item in keys:
                    raw = (
                        item
                        if isinstance(item, str)
                        else (item.get("key", "") if isinstance(item, dict) else "")
                    )
                    if _is_valid(raw):
                        self._ensure_pool(provider)
                        if not any(e.key == raw for e in self._pools[provider]):
                            self._pools[provider].append(
                                KeyEntry(provider, raw, "file")
                            )
            logger.info(
                "[KeyPool] Loaded pools from %s: %s",
                POOL_FILE,
                {p: len(v) for p, v in self._pools.items()},
            )
        except Exception as e:
            logger.warning("[KeyPool] Failed to load %s: %s", POOL_FILE, e)

    def _save_to_file(self) -> None:
        """Persist user/file-sourced keys (not env keys) to JSON."""
        try:
            POOL_FILE.parent.mkdir(parents=True, exist_ok=True)
            data: dict[str, list[dict]] = {}
            for provider, entries in self._pools.items():
                user_keys = [e.to_dict() for e in entries if e.source != "env"]
                if user_keys:
                    data[provider] = user_keys
            POOL_FILE.write_text(json.dumps(data, indent=2))
        except Exception as e:
            logger.warning("[KeyPool] Failed to save: %s", e)

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _ensure_pool(self, provider: str) -> None:
        if provider not in self._pools:
            self._pools[provider] = []
            self._next_idx[provider] = 0

    def _load_env_keys(self, provider: str) -> None:
        """Inject keys from environment variables into the pool."""
        env_vars = PROVIDER_ENV_MAP.get(provider, [])
        for var in env_vars:
            val = os.environ.get(var, "").strip()
            if not val:
                continue
            for k in val.split(","):
                k = k.strip()
                if _is_valid(k) and not any(
                    e.key == k for e in self._pools.get(provider, [])
                ):
                    self._ensure_pool(provider)
                    self._pools[provider].append(KeyEntry(provider, k, "env"))

    # ------------------------------------------------------------------
    # Core rotation
    # ------------------------------------------------------------------

    def get_next_key(self, provider: str) -> Optional[str]:
        """
        Return the next available key via round-robin.

        If all keys are in cooldown, returns the one whose cooldown
        expires soonest (and clears its cooldown).
        """
        with self._lock:
            self._ensure_pool(provider)
            self._load_env_keys(provider)
            pool = self._pools[provider]
            if not pool:
                return None

            now = time.time()
            start = self._next_idx.get(provider, 0)
            for i in range(len(pool)):
                idx = (start + i) % len(pool)
                entry = pool[idx]
                if entry.cooldown_until > now:
                    continue
                self._next_idx[provider] = (idx + 1) % len(pool)
                return entry.key

            # All in cooldown -- use soonest to expire
            soonest = min(pool, key=lambda e: e.cooldown_until)
            logger.warning(
                "[KeyPool] All %d keys for %s in cooldown, using soonest",
                len(pool),
                provider,
            )
            soonest.cooldown_until = 0
            return soonest.key

    # ------------------------------------------------------------------
    # Failure / success reporting
    # ------------------------------------------------------------------

    def report_failure(
        self,
        provider: str,
        key: str,
        http_status: Optional[int] = None,
        error_body: str = "",
    ) -> None:
        """
        Mark a key as failed and apply the appropriate cooldown.

        Cooldown logic:
          401      -> permanent ban (1 year)
          403      -> permanent ban (1 year)
          429      -> 8h if daily quota, 2s if rate limit
          generic  -> 60s, or 5min after 3+ consecutive failures
        """
        with self._lock:
            pool = self._pools.get(provider, [])
            entry = next((e for e in pool if e.key == key), None)
            if not entry:
                return
            entry.fail_count += 1
            entry.last_failed_at = time.time()
            now = time.time()

            if http_status == 401:
                entry.cooldown_until = now + PERMANENT_COOLDOWN
                logger.warning(
                    "[KeyPool] Key %s for %s: 401 invalid, permanent ban",
                    _key_id(key),
                    provider,
                )
            elif http_status == 403:
                entry.cooldown_until = now + PERMANENT_COOLDOWN
                logger.warning(
                    "[KeyPool] Key %s for %s: 403 forbidden, permanent ban",
                    _key_id(key),
                    provider,
                )
            elif http_status == 429:
                body_lower = error_body.lower()
                is_daily = (
                    "quota" in body_lower
                    or "daily" in body_lower
                    or "free_tier" in body_lower
                )
                if is_daily:
                    entry.cooldown_until = now + 8 * 3600
                    logger.warning(
                        "[KeyPool] Key %s for %s: daily quota hit, 8h cooldown",
                        _key_id(key),
                        provider,
                    )
                else:
                    entry.cooldown_until = now + 2.0
                    logger.info(
                        "[KeyPool] Key %s for %s: rate limited, 2s cooldown",
                        _key_id(key),
                        provider,
                    )
            elif entry.fail_count >= EXTENDED_THRESHOLD:
                entry.cooldown_until = now + EXTENDED_COOLDOWN
                logger.warning(
                    "[KeyPool] Key %s for %s: %d failures, 5min cooldown",
                    _key_id(key),
                    provider,
                    entry.fail_count,
                )
            else:
                entry.cooldown_until = now + SHORT_COOLDOWN
                logger.info(
                    "[KeyPool] Key %s for %s: failed, 60s cooldown",
                    _key_id(key),
                    provider,
                )

    def report_success(self, provider: str, key: str) -> None:
        """Reset failure state on successful use."""
        with self._lock:
            pool = self._pools.get(provider, [])
            entry = next((e for e in pool if e.key == key), None)
            if entry:
                entry.fail_count = 0
                entry.last_failed_at = None
                entry.cooldown_until = 0.0

    # ------------------------------------------------------------------
    # Key management (add / remove / clear)
    # ------------------------------------------------------------------

    def ingest_keys(self, provider: str, raw: str) -> int:
        """
        Parse and add keys from raw text (comma, newline, or semicolon separated).
        Returns count of newly added keys.
        """
        keys: list[str] = []
        for line in raw.replace(";", "\n").replace(",", "\n").split("\n"):
            k = line.strip()
            if _is_valid(k):
                keys.append(k)

        added = 0
        with self._lock:
            self._ensure_pool(provider)
            existing = {e.key for e in self._pools[provider]}
            for k in keys:
                if k not in existing:
                    self._pools[provider].append(KeyEntry(provider, k, "user"))
                    existing.add(k)
                    added += 1
            if added:
                self._save_to_file()
                logger.info(
                    "[KeyPool] Ingested %d keys for %s (%d total)",
                    added,
                    provider,
                    len(self._pools[provider]),
                )
        return added

    def remove_key(self, provider: str, key: str) -> bool:
        """Remove a specific key from the pool. Returns True if found and removed."""
        with self._lock:
            pool = self._pools.get(provider, [])
            before = len(pool)
            self._pools[provider] = [e for e in pool if e.key != key]
            if len(self._pools[provider]) < before:
                self._save_to_file()
                return True
            return False

    def clear_provider(self, provider: str) -> None:
        """Clear all user-added keys for a provider (keeps env keys)."""
        with self._lock:
            env_keys = [e for e in self._pools.get(provider, []) if e.source == "env"]
            self._pools[provider] = env_keys
            self._next_idx[provider] = 0
            self._save_to_file()

    # ------------------------------------------------------------------
    # Status / introspection
    # ------------------------------------------------------------------

    def get_pool_status(self, provider: str) -> dict:
        """Return status dict for a single provider's key pool."""
        with self._lock:
            self._ensure_pool(provider)
            self._load_env_keys(provider)
            pool = self._pools.get(provider, [])
            now = time.time()
            return {
                "total": len(pool),
                "available": sum(1 for e in pool if e.cooldown_until <= now),
                "cooldown": sum(1 for e in pool if e.cooldown_until > now),
                "keys": [
                    {
                        "id": _key_id(e.key),
                        "masked": e.key[:6] + ".." + e.key[-4:]
                        if len(e.key) > 10
                        else "***",
                        "source": e.source,
                        "available": e.cooldown_until <= now,
                        "fail_count": e.fail_count,
                    }
                    for e in pool
                ],
            }

    def get_raw_keys(self, provider: str) -> list[str]:
        """Return raw key strings for a provider (for frontend sync)."""
        with self._lock:
            self._ensure_pool(provider)
            self._load_env_keys(provider)
            pool = self._pools.get(provider, [])
            return [e.key for e in pool]

    def get_all_status(self) -> dict:
        """Return summary status for all providers that have keys."""
        result: dict[str, dict] = {}
        with self._lock:
            for provider in list(PROVIDER_ENV_MAP.keys()):
                self._ensure_pool(provider)
                self._load_env_keys(provider)
            for provider, pool in self._pools.items():
                if pool:
                    now = time.time()
                    result[provider] = {
                        "total": len(pool),
                        "available": sum(1 for e in pool if e.cooldown_until <= now),
                    }
        return result


# ---------------------------------------------------------------------------
# Singleton
# ---------------------------------------------------------------------------

key_pool = KeyPoolManager()
