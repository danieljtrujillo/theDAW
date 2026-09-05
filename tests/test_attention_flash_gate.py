"""The flash-attention dispatch must be gated on the GPU, not on the import.

FlashAttention 2 wheels import fine on Turing / Volta cards and then raise
"FlashAttention only supports Ampere GPUs or newer" from inside the kernel
(seen on the RTX 2080 Ti while encoding Chimera init audio). These tests pin
the per-device gate and the correctness of the SDPA fallbacks it routes to.
CPU only; no model weights.
"""

from __future__ import annotations

import torch
import torch.nn.functional as F

from stable_audio_3.models import transformer as tr


def _reset_gate_cache():
    tr._flash_attn_device_ok.clear()


def test_flash_unusable_without_flash_attn(monkeypatch):
    _reset_gate_cache()
    monkeypatch.setattr(tr, "flash_attn_func", None)
    assert tr.flash_attn_usable(torch.device("cuda:0")) is False


def test_flash_unusable_on_cpu(monkeypatch):
    _reset_gate_cache()
    monkeypatch.setattr(tr, "flash_attn_func", object())
    assert tr.flash_attn_usable(torch.device("cpu")) is False
    assert tr.flash_attn_usable("cpu") is False


def test_flash_gate_follows_compute_capability(monkeypatch):
    _reset_gate_cache()
    monkeypatch.setattr(tr, "flash_attn_func", object())
    monkeypatch.setattr(torch.cuda, "get_device_capability", lambda idx=None: (7, 5))
    monkeypatch.setattr(torch.cuda, "get_device_name", lambda idx=None: "Turing")
    monkeypatch.setattr(torch.cuda, "is_available", lambda: True)
    assert tr.flash_attn_usable(torch.device("cuda:1")) is False
    # cached per device index: a later probe is not consulted again
    monkeypatch.setattr(torch.cuda, "get_device_capability", lambda idx=None: (8, 6))
    assert tr.flash_attn_usable(torch.device("cuda:1")) is False
    _reset_gate_cache()
    assert tr.flash_attn_usable(torch.device("cuda:1")) is True


def test_flash_gate_survives_probe_failure(monkeypatch):
    _reset_gate_cache()
    monkeypatch.setattr(tr, "flash_attn_func", object())

    def _boom(idx=None):
        raise RuntimeError("no CUDA")

    monkeypatch.setattr(torch.cuda, "get_device_capability", _boom)
    monkeypatch.setattr(torch.cuda, "is_available", lambda: False)
    assert tr.flash_attn_usable(torch.device("cuda:0")) is False


def test_chunked_halo_sdpa_matches_masked_reference():
    torch.manual_seed(0)
    b, h, n, d = 1, 2, 300, 16
    q, k, v = (torch.randn(b, h, n, d) for _ in range(3))
    wl, wr = 7, 5
    ref_mask = tr._sliding_window_additive_mask(n, n, wl, wr, q.device, q.dtype)
    ref = F.scaled_dot_product_attention(q, k, v, attn_mask=ref_mask, is_causal=False)
    out = tr._sliding_window_chunked_halo_sdpa(q, k, v, wl, wr, chunk_size=64)
    assert out.shape == ref.shape
    assert torch.allclose(out, ref, atol=1e-5, rtol=1e-4)


def test_apply_attn_sliding_window_without_flash_matches_reference(monkeypatch):
    """The whole dispatch, flash disabled: a windowed request must produce the
    masked-SDPA result (whichever fallback tier handled it)."""
    _reset_gate_cache()
    monkeypatch.setattr(tr, "flash_attn_func", None)
    attn = tr.Attention(dim=32, dim_heads=16)
    torch.manual_seed(1)
    n = 200
    q, k, v = (torch.randn(1, 2, n, 16) for _ in range(3))
    wl, wr = 6, 6
    out = attn.apply_attn(q, k, v, flash_attn_sliding_window=(wl, wr))
    ref_mask = tr._sliding_window_additive_mask(n, n, wl, wr, q.device, q.dtype)
    ref = F.scaled_dot_product_attention(q, k, v, attn_mask=ref_mask, is_causal=False)
    assert torch.allclose(out, ref, atol=1e-4, rtol=1e-3)


def test_apply_attn_full_attention_without_flash(monkeypatch):
    _reset_gate_cache()
    monkeypatch.setattr(tr, "flash_attn_func", None)
    attn = tr.Attention(dim=32, dim_heads=16)
    torch.manual_seed(2)
    q, k, v = (torch.randn(1, 2, 64, 16) for _ in range(3))
    out = attn.apply_attn(q, k, v)
    ref = F.scaled_dot_product_attention(q, k, v, is_causal=False)
    assert torch.allclose(out, ref, atol=1e-5, rtol=1e-4)
