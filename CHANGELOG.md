# Changelog

## 0.2.0 — 2026-11-03

Review hardening + first GitHub release.

- **Context corrected**: web reverse proxy ≈ 50k context (was advertised 1M) — the Studio web conversation is the ceiling, not the model card.
- **Parameter alignment**: `reasoning_effort` now maps onto magpie's effort picker via `variants` (none/off → thinking off, low/medium/high → thinking on — the upstream exposes only a boolean); `temperature`/`top_p` pass through; `max_tokens`/`stop`/penalties/`seed`/`logit_bias` are documented as ignored (no upstream field).
- **Memory-leak guard**: per-account in-memory state (client/catalog/promises) is dropped when usage()/models() hit an unrevivable session, instead of accumulating forever.
- **No logs**: every console.log path removed (the plugin surface has no log reader); renewal/catalog/saveAuth failures stay visible through their return values and error envelopes.
- Tool calls remain unsupported by the upstream web surface (`tool_call: false`), now stated in the README.
- Tests: 63 cases green.

## 0.1.0 — 2026-11-01

Initial release.

- Phone + password login with new-device SMS/email two-stage verification (OTP contract against the decompiled magpie host).
- OpenAI Chat Completions over the react (v3) and fastchat (v2, ultraspeed) channels; multi-turn replay chained by `previousDialogueId` inside one upstream conversation.
- Thinking (`reasoning_content`, spark-marker splitter for the v2 dialect), image understanding (upload → parse → multiMedias, SSRF-guarded), web-search citations.
- Session renewal (passToken → serviceLogin → STS), password re-login fallback (70016), single-flight renewal shared by loader and refresh hook.
- Account import from a mimo2api Upstash/Redis store; magpie contract hooks (keyless-less oauth login, usage without balance, refresh with lead).
