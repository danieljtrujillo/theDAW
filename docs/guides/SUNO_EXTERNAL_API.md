# Suno External API Reference

A short guide to generating music through Suno's public API. Covers authentication, the four generation modes (Simple, Custom, Cover, Mashup), polling, and account usage. Voice presets are available on Simple, Custom, and Cover modes (not Mashup).

---

## Prerequisite

You need to have a Suno account that can use Google to login.

Contact Suno for access to the online portal [platform.suno.com](https://platform.suno.com). You need to provide the email address you used for Suno login. 

---

## Online Portal

Once an external API account is set up for you, you should be able to login [platform.suno.com](https://platform.suno.com) with your suno account email via Google OAuth. You should be able to view plans, current usage, and manage secret keys for API access. Create an API key and use it as a bearer token in your request's `Authorization` header.

---

## Base URL

`https://api.suno.com/`

---

## Authentication

Every request must include your API key in the `Authorization` header:

```
Authorization: Bearer <secret_key>
```

Keys should look like `sk_live_` followed by 64 hex characters. Treat them as secrets — do not check them into source control or expose them in client-side code. Rotate them through the Suno platform console.

---

## Generation Flow

All generation endpoints are asynchronous:

1. `POST` to the generation endpoint → returns `{ "id", "status": "submitted" }`  
2. Poll `GET /v0/audio/{id}` until `status` is `"complete"` (or `"error"`)  
3. When `status` is `"streaming"` or `"complete"`, `audio_url` is populated

Typical wall-clock time from submit to `complete` is under a minute.

### Status values

| Status | Meaning |
| :---- | :---- |
| `submitted` | Accepted; job has not started yet |
| `queued` | Waiting to start |
| `streaming` | Partial audio is available at `audio_url` (live progressive stream) |
| `complete` | Final CDN URL is available at `audio_url` |
| `error` | Failed; see `error` field |

---

## Preset Voice IDs

Custom voice cloning is not yet open to partners. You can pass any one of these three preset voice UUIDs in the optional `voice_id` field. Omitting `voice_id` lets the model pick a voice based on style and lyrics.

| `voice_id` | Description |
| :---- | :---- |
| `5b915c6d-8d96-416c-9755-eba65868cfef` | Preset voice A (female voice) |
| `c036ce3a-55e4-4690-9b8d-4516b37a96d5` | Preset voice B (weird kid voice) |
| `27f5465b-73c3-4134-b11e-70b0bd571c6c` | Preset voice C (low male voice) |

Any other value returns `400 Bad Request` with `{"error":"custom voice is not currently supported"}`.

---

## 1. Simple mode — `POST /v0/audio` with `description`

Let the model generate both the lyrics and the style from a single natural-language prompt. Do **not** combine `description` with `style` — the API will reject it.

```shell
curl -X POST https://api.suno.com/v0/audio \
  -H "Authorization: Bearer sk_live_<your-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "description": "upbeat synthwave track about driving through Tokyo at night",
    "title": "Neon Drive"
  }'
```

Optional: add `"voice_id": "<uuid>"` to pin a preset voice.

Response: `{ "id": "...", "status": "submitted", "created_at": "..." }`

---

## 2. Custom mode — `POST /v0/audio` with `lyrics` + `style`

Supply your own lyrics and a style string. `title` is optional.

```shell
curl -X POST https://api.suno.com/v0/audio \
  -H "Authorization: Bearer sk_live_<your-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "lyrics": "[Verse]\nWalking through the static glow\n[Chorus]\nWe are the signal",
    "style": "dreampop, reverb-heavy guitars, melancholic",
    "title": "Signal & Noise"
  }'
```

### Instrumental (no vocals)

Set `"instrumental": true`. Lyrics and description are then optional.

---

## 3. Cover mode — `POST /v0/audio/{id}/covers`

Re-generate an existing clip with optionally new lyrics, style, and/or voice. The `{id}` must be a clip returned by a prior `POST /v0/audio` call.

```shell
curl -X POST https://api.suno.com/v0/audio/<clip-id>/covers \
  -H "Authorization: Bearer sk_live_<your-key>" \
  -H "Content-Type: application/json" \
  -d '{ "style": "acoustic folk, fingerpicked guitar" }'
```

---

## 4. Mashup mode — `POST /v0/audio/{id}/mashups`

Blend two clips into a new track. `voice_id` is NOT supported on mashups.

```shell
curl -X POST https://api.suno.com/v0/audio/<clip-id>/mashups \
  -H "Authorization: Bearer sk_live_<your-key>" \
  -H "Content-Type: application/json" \
  -d '{ "additional_audio_id": "<second-clip-id>" }'
```

Optional: `lyrics`, `style`, `title`.

---

## 5. Polling — `GET /v0/audio/{id}`

```shell
curl https://api.suno.com/v0/audio/<clip-id> \
  -H "Authorization: Bearer sk_live_<your-key>"
```

Complete response includes: `id`, `status`, `audio_url`, `title`, `created_at`, `error`, `metadata` (lyrics, style, description, voice_id, cover_audio_id, mashup_clip_ids).

Recommended polling interval: **every 3–5 seconds**. Typical generation completes in under 60 seconds. Do not poll faster than 1 req/s to stay well within rate limits.

---

## 6. Account usage — `GET /v0/account/usage`

```shell
curl https://api.suno.com/v0/account/usage \
  -H "Authorization: Bearer sk_live_<your-key>"
```

Returns per-feature usage counters and plan limits. Response shape includes `plan_id` and `metered_features` with `limits.per_lifetime` and `usage.lifetime` per feature.

---

## Parameter Summary

| Parameter | Type | Simple | Custom | Cover | Mashup |
|-----------|------|--------|--------|-------|--------|
| `description` | string | Required | — | — | — |
| `lyrics` | string | — | Required* | Optional | Optional |
| `style` | string | — | Required | Optional | Optional |
| `title` | string | Optional | Optional | Optional | Optional |
| `voice_id` | UUID | Optional | Optional | Optional | **Not supported** |
| `instrumental` | bool | — | Optional | — | — |
| `additional_audio_id` | UUID | — | — | — | Required |

*Required unless `instrumental: true` is set.

`description` and `style` are mutually exclusive — sending both returns 400.

---

## Errors

| Status | Common causes |
| :---- | :---- |
| 400 | Missing both `lyrics` and `description`; using `style` with `description`; disallowed `voice_id` |
| 401 | Missing or invalid `Authorization` header |
| 403 | Plan does not include the feature (e.g. `generate.cover`) |
| 404 | Source clip not found or not owned by your account |
| 429 | Rate limit (10 req/s sustained, 20 burst) or quota exceeded |
| 500 | Server error — safe to retry |

---

## Rate Limits

- 10 requests/second sustained, 20-request burst, per IP.
