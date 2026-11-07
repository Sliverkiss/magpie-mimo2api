// src/search.mjs — the `search` hook: MiMo Studio as one of magpie's web
// search APIs.
//
// Host contract (decompiled `runSearch` in the plugin host):
//   search: { <id>: { name, auth?, keysURL?, keyOptional?, url?, execute } }
//   <id> must match /^[a-z0-9][a-z0-9-]{0,31}$/; execute({query, count, key,
//   url}, ctx) returns [{title, url, text?, age?}] (or {results: [...]}).
//   The host maps exactly those four fields and drops the rest — extra
//   properties are not passed on. Its Go side is narrower still:
//   `plugin.SearchPage` is {Title, URL, PageAge `json:"page_age"`}, so `text`
//   has no field to land in and `age` is spelled `page_age` there. A snippet
//   or an age therefore dies at the plugin boundary; the consumer gets title
//   and url, and only those two.
//
//   An entry naming `auth: "<provider id>"` that this plugin's auth hook
//   signs in to takes NO key: magpie picks one of the provider's accounts
//   that are on, hands it over through ctx.getAuth(), and has renewed it
//   already if it was due. ctx.abort is the search's own deadline (default
//   60s) and the caller going away, whichever comes first.
//
//   A throw carrying a numeric `status` in [300, 600) is the API refusing
//   the account: the host turns it into {status, error, retryAfter} and
//   rests that account — for search only, never for its models.
//
// MiMo's Studio surface has no dedicated search endpoint. A search here IS a
// chat turn: `webSearchStatus: "auto"` lets the upstream decide to look
// things up, and the `web_search` SSE events it emits along the way carry the
// pages the model consulted. Those pages are the whole result — the answer
// text is discarded.
//
// Cost, plainly: one chat turn and one conversation's worth of context per
// search. `"auto"` also means the upstream may answer without searching at
// all, and then the result is an empty list rather than an error.

import { AuthExpiredError, DEFAULT_MODEL } from "./mimo.mjs";

/**
 * `magpie search count` documents "1 to 20, 6 by default", and magpie's own
 * settings UI writes that same 6 when nothing is set (`s.searchCount > 0 ?
 * Math.min(s.searchCount, 20) : 6`). The host fills a count in for most
 * clients, so this pair is only the fallback for one that names none — but it
 * is the number the docs promise, and a fallback that drifts from them is a
 * silent off-by-four.
 */
const DEFAULT_RESULTS = 6;
const MAX_RESULTS = 20;

/**
 * `count` as magpie passes it. Anything that is not a positive number falls
 * back to the default; the ceiling keeps one search from returning a wall.
 */
export function clampCount(count) {
  const n = Number(count);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_RESULTS;
  return Math.min(Math.floor(n), MAX_RESULTS);
}

/**
 * `web_search` citations → the host's page shape. A citation with no `url` is
 * dropped, and that is this plugin's own call, not a rule the host hands down:
 * `runSearch` asks only that each row be an object (`rs.filter((r) => r &&
 * typeof r === "object")`), so a blank row would go straight through. It is
 * dropped because a citation with no url is nothing anyone can open — not a
 * page. A URL seen twice is one page: the first title wins.
 *
 * `text` is filled and then lost. The host's JS maps it, but
 * `plugin.SearchPage` has no such field, so the snippet never survives the
 * plugin boundary and the consumer sees title + url only. It stays in the
 * return shape because the JS side does accept it — don't read it as data
 * anyone downstream can use.
 */
export function pagesOf(citations, limit = DEFAULT_RESULTS) {
  const out = [];
  const seen = new Set();
  for (const c of citations ?? []) {
    if (out.length >= limit) break;
    const url = typeof c?.url === "string" ? c.url : "";
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({
      title: typeof c.title === "string" ? c.title : "",
      url,
      text: typeof c.snippet === "string" ? c.snippet : "",
    });
  }
  return out;
}

/**
 * One search: a single chat turn with web search on, over a fresh upstream
 * conversation (no conversationId, no previousDialogueId — nothing a caller
 * asked before can bleed into this one).
 *
 * @param {{ query?: string, count?: number }} args the host's execute args
 * @param {{ client: import("./mimo.mjs").MimoClient, session: object, signal?: AbortSignal }} deps
 *   `session` is the account's already-renewed session material; the
 *   freshness gate belongs to the caller, where the account scope lives.
 * @returns {Promise<Array<{ title: string, url: string, text: string }>>}
 */
export async function searchMimo({ query, count } = {}, { client, session, signal } = {}) {
  const q = typeof query === "string" ? query.trim() : "";
  if (!q) throw new Error("search: query is empty");
  if (!client) throw new Error("search: no upstream client");

  if (!session?.cookie) {
    // Nothing was dialed, so there is no refusal to report — but the account
    // is in exactly the state that rests it, and the host only learns that
    // from the numeric status.
    throw Object.assign(new Error("search: MiMo Studio is not signed in"), { status: 401, signIn: "expired" });
  }

  let result;
  try {
    result = await client.chatStream(
      session,
      {
        query: q,
        model: DEFAULT_MODEL,
        webSearchStatus: "auto",
        enableThinking: false,
      },
      signal,
    );
  } catch (e) {
    if (e instanceof AuthExpiredError) {
      // Both shapes on purpose: `status` is how the host rests the account
      // for search, `signIn` is this plugin's own convention for the same
      // fact. Without the status the host sees a generic failure and keeps
      // routing searches to a dead account.
      throw Object.assign(new Error(`MiMo Studio refused the sign-in; sign in again (${e.message})`), {
        status: 401,
        signIn: "expired",
        cause: e,
      });
    }
    throw e; // busy / content-filtered / upstream 5xx: the caller's to see
  }

  return pagesOf(result.citations, clampCount(count));
}
