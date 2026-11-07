# Changelog

## 0.3.1 — 2026-11-07

Model capabilities, declared.

- **Every model entry now says what it takes.** Neither the static config entries nor the catalog rows declared `modalities` or `attachment`, so magpie read them as *the vendor never spoke* — not as *text only* — and fell back to voting models.dev by bare model id. A same-named model under a text-only vendor would have taken image input away silently: the model runs, but a screenshot goes straight upstream and is refused, with nothing logged. Both static entries now declare `attachment: true` and `modalities: { input: ["text", "image"], output: ["text"] }`, which is what the plugin actually implements — `image_url` → `genUploadInfo` → `parse` → `multiMedias` (`src/mimo.mjs`).
- **Catalog rows with no static counterpart** (`listFromCatalog`) declare the same, so a model the upstream adds under us does not arrive blind. A static entry's own word wins where it has one — the default is the plugin's behavior, not a claim about every future MiMo model.
- **`_internal`** exports `listFromCatalog` alongside `searchMimo`, so the catalog path is reachable from a test without a session.
- Tests: 96 cases green (11 new in `test/capabilities.test.js`), covering the static declarations, the catalog fallback, a static entry overriding the default, and non-chat rows being left out.

## 0.3.0 — 2026-11-04

Web search API.

- **`search` hook**: the plugin now contributes "MiMo Studio 联网搜索" to magpie's search API list (Tavily/Brave row) under the id `mimo`. Keyless — the entry names `auth: "mimo"`, so magpie picks one of this plugin's signed-in accounts, renews it first if due, and hands it over via `ctx.getAuth()`. A search shares the account's in-memory state with chat, so the two never race two renewals.
- **What a search is**: one chat turn with `webSearchStatus: "auto"` over a fresh upstream conversation (no `conversationId`, no `previousDialogueId`). The `web_search` SSE events are the result; the answer text is discarded. Cost is stated in the README: one chat turn and one conversation of context per search, and the upstream may answer without searching at all — an empty list, not an error.
- **Page mapping**: citations → `{title, url, text}`, deduped by URL (first title/snippet wins), `count` default 10 / ceiling 20. MiMo citations carry no date, so `age` stays unset.
- **Error shape**: an upstream 401 is rethrown with numeric `status: 401` **and** `signIn: "expired"` — the host rests that account for search only, and the plugin's own convention is preserved. Busy (503), content-filter and upstream 5xx propagate as-is instead of degrading into "no results".
- **`searches: true`** on every model entry (static config, `provider.models`, catalog rows): without it magpie keeps the model off the search path and silently runs its own search instead.
- Tests: 85 cases green (20 new in `test/search.test.js`).

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
