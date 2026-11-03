// src/gateway.mjs — OpenAI Chat Completions ⇄ MiMo Studio translation.
//
// magpie's gateway hands the plugin's fetch a Chat Completions request body
// (the loader npm is @ai-sdk/openai-compatible) and expects an OpenAI Chat
// Completions reply back — streamed SSE chunks or a single JSON completion.
// This module does the translation and the OpenAI-shaped error answers.
//
// Turn model (SDD §5.3 of the reference gateway): one upstream call per user
// message, all inside ONE upstream conversation, chained via
// previousDialogueId. System messages splice into the first user query.
// Assistant history is not re-sent — the upstream conversation already holds
// it on later turns of the same request.

import {
  MimoClient,
  UpstreamError,
  AuthExpiredError,
  ModelNotFoundError,
  StreamFrameError,
  ContentFilterError,
  randomHex32,
  planFullReplay,
  resolveImages,
  DEFAULT_MODEL,
} from "./mimo.mjs";

// ---- OpenAI shaping ----

function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

function chatID() {
  return "chatcmpl-" + randomHex32();
}

export function mapUsage(u) {
  if (!u) return undefined;
  const out = {
    prompt_tokens: u.promptTokens ?? 0,
    completion_tokens: u.completionTokens ?? 0,
    total_tokens: u.totalTokens ?? (u.promptTokens ?? 0) + (u.completionTokens ?? 0),
  };
  const details = u.nativeUsage?.prompt_tokens_details;
  if (details) {
    out.prompt_tokens_details = {
      cached_tokens: details.cachedTokens ?? details.cached_tokens ?? 0,
    };
  }
  return out;
}

// ---- usage estimation fallback ----
// Not every model/channel emits the upstream `usage` event (fastchat often
// sends none), and a missing one leaves magpie's quota display at zero. When
// that happens we estimate — the same convention as the sibling reverse
// proxies: ~4 chars per Unicode code point (UTF-16 .length overcounts CJK
// ~2x). A display-and-quota figure, not a billing one. Text only: an
// attachment's real cost is the platform's own parse tokenUsage, which the
// upstream does not surface in `usage` either.
const CHARS_PER_TOKEN = 4;

function countChars(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    n++;
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) i++; // surrogate pair = one code point
    }
  }
  return n;
}

const tokensOf = (chars) => Math.ceil(chars / CHARS_PER_TOKEN);

function messageTexts(messages) {
  let chars = 0;
  for (const m of messages ?? []) {
    const c = m?.content;
    if (typeof c === "string") chars += countChars(c);
    else if (Array.isArray(c)) {
      for (const p of c) if (p?.type === "text" && typeof p.text === "string") chars += countChars(p.text);
    }
  }
  return tokensOf(chars);
}

/** Fill whatever the upstream usage event did not carry. */
function usageWithEstimate(upstreamUsage, promptTokens, completionChars) {
  const estCompletion = tokensOf(completionChars);
  const u = mapUsage(upstreamUsage) ?? {};
  const prompt_tokens = u.prompt_tokens || promptTokens;
  const completion_tokens = u.completion_tokens || estCompletion;
  return { prompt_tokens, completion_tokens, total_tokens: prompt_tokens + completion_tokens };
}

function textChunk(id, model, created, delta, finishReason = null, usage) {
  const body = {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
  if (usage) body.usage = usage;
  return body;
}

function citationsChunk(id, model, created, cits) {
  // Gateway extension (choices: []): standard clients ignore a chunk with no
  // choices, so the stream stays compatible.
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [],
    citations: cits.map((c, i) => ({
      index: i,
      title: c.title,
      url: c.url,
      displayUrl: c.displayUrl || undefined,
      snippet: c.snippet || undefined,
      used: c.used || undefined,
    })),
  };
}

function completionBody(id, model, created, content, reasoning, usage, cits) {
  const message = { role: "assistant", content };
  if (reasoning) message.reasoning_content = reasoning;
  const body = {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [{ index: 0, message, finish_reason: "stop" }],
    usage: usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
  if (cits?.length) body.citations = cits;
  return body;
}

/** An OpenAI-shaped error so agents show the platform's own words. */
export function openaiError(status, message, type = "upstream_error", code) {
  return new Response(JSON.stringify({ error: { message, type, code: code ?? status } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export class GatewayError extends Error {
  constructor(status, message, type, code) {
    super(message);
    this.status = status;
    this.type = type;
    this.code = code;
  }
  toResponse() {
    return openaiError(this.status, this.message, this.type, this.code);
  }
}

/** Map an upstream failure onto an OpenAI error status. 401 is reserved for auth. */
export function errorStatus(err) {
  if (err instanceof AuthExpiredError) return 401;
  if (err instanceof ModelNotFoundError) return 404;
  if (err instanceof ContentFilterError) return 400;
  if (err instanceof GatewayError) return err.status;
  if (err instanceof StreamFrameError) {
    if (err.kind === "busy") return 503; // transient throttle: retry/failover
    if (err.kind === "model-rejected") return 403; // deterministic: never retry
    return 502;
  }
  if (err instanceof UpstreamError) return err.status;
  // Client-conversation problems (no_user_message / replay-cap) are the
  // caller's fault → 400 invalid_request_error, not a 502 upstream error.
  if (err?.code === "no_user_message" || /exceeding the replay cap/.test(String(err?.message))) return 400;
  return 502;
}

/** Resolve the requested model id against the account's catalog. */
export function resolveModel(requested, catalogModels) {
  const ids = (catalogModels ?? []).map((m) => m.id);
  if (!ids.length) return requested || DEFAULT_MODEL; // degraded mode: upstream is the authority
  if (!requested || requested.toLowerCase() === "auto") {
    return ids.includes(DEFAULT_MODEL) ? DEFAULT_MODEL : ids[0];
  }
  const candidates = [requested, requested.replace(/-studio$/, "")];
  let model = candidates.find((c) => ids.includes(c));
  if (!model) {
    const lower = new Map(ids.map((id) => [id.toLowerCase(), id]));
    model = candidates.map((c) => lower.get(c.toLowerCase())).find(Boolean);
  }
  if (!model) throw new ModelNotFoundError(requested, [...ids].sort());
  return model;
}

/**
 * Handle one Chat Completions request against one account session.
 *
 * @param {MimoClient} client
 * @param {{ cookie, ph, device?, userId?, passToken? }} session
 * @param {{ catalog?: { models: Array<{id, name, thinkingDefault, webSearch}> } }} accountState
 * @param {object} body — the Chat Completions request object
 * @param {{ signal?: AbortSignal, maxTurns?: number }} opts
 */
export async function handleChatCompletion(client, session, accountState, body, { signal, maxTurns = 20 } = {}) {
  if (!body || !Array.isArray(body.messages)) {
    throw new GatewayError(400, "request body must carry a messages array", "invalid_request_error");
  }
  const stream = body.stream === true;

  const requested = typeof body.model === "string" ? body.model.trim() : "";
  const model = resolveModel(requested, accountState?.catalog?.models);

  const row = (accountState?.catalog?.models ?? []).find((m) => m.id === model) ?? {};
  const effort = typeof body.reasoning_effort === "string" ? body.reasoning_effort.toLowerCase() : "";
  const enableThinking =
    effort === "none" || effort === "off"
      ? false
      : body.chat_template_kwargs?.thinking !== undefined
        ? !!body.chat_template_kwargs.thinking
        : (row.thinkingDefault ?? false);
  const webSearchStatus = typeof body.web_search_status === "string" ? body.web_search_status : row.webSearch >= 2 ? "auto" : "disabled";

  const plan = (() => {
    try {
      return planFullReplay(body.messages, maxTurns);
    } catch (e) {
      // Client-conversation problems (no user message / replay cap): 400
      // invalid_request_error, not an upstream failure.
      if (e?.code === "no_user_message" || /exceeding the replay cap/.test(String(e?.message))) {
        throw new GatewayError(400, e.message, "invalid_request_error", e.code);
      }
      throw e;
    }
  })();
  const temperature = typeof body.temperature === "number" ? body.temperature : undefined;
  const topP = typeof body.top_p === "number" ? body.top_p : undefined;

  const id = chatID();
  const created = nowUnix();

  // Internal abort linked to the caller's signal. It exists so a consumer
  // that cancels our Response (ReadableStream.cancel) tears down the upstream
  // chat too: without it the pump keeps streaming (or, worse, keeps dialing
  // the remaining replay turns) against a dead consumer — the connection /
  // turn-storm leak the sibling gateways hit. The composite carries BOTH
  // aborts into chatStream; the stream itself still has no absolute timer
  // (idle watchdog governs it), so long live streams are unaffected.
  const pumpAbort = new AbortController();
  const effSignal = signal ? AbortSignal.any([signal, pumpAbort.signal]) : pumpAbort.signal;

  // One turn of the replay: its attachments resolve under their own deadline,
  // then the turn streams under the linked signal.
  //
  // Why the image deadline: fetchImageBytes/uploadFile/parseResource only
  // apply their short whole-fetch defaults when NO signal is passed — handed
  // the caller's signal, a stalled upload or parse chain had no ceiling of its
  // own and parked the whole request forever in the gap between turns. An
  // AbortSignal.timeout gives the image chain a bound (re-armed per turn, so
  // an earlier turn can't expire a later turn's uploads).
  const IMAGE_CHAIN_MS = 180_000;
  const runTurns = async (onPiece) => {
    const conversationId = randomHex32(); // one upstream conversation for the whole request
    let previousDialogId = "";
    let last = null;
    for (let i = 0; i < plan.turns.length; i++) {
      const turn = plan.turns[i];
      const imgSignal = AbortSignal.any([effSignal, AbortSignal.timeout(IMAGE_CHAIN_MS)]);
      const multiMedias = turn.media?.length ? await resolveImages(turn.media, session, client, { model, signal: imgSignal }) : [];
      const result = await client.chatStream(
        session,
        {
          query: turn.query,
          model,
          conversationId,
          previousDialogId,
          enableThinking: i === 0 ? enableThinking : false,
          webSearchStatus,
          temperature,
          topP,
          multiMedias,
          onPiece,
        },
        effSignal,
      );
      previousDialogId = result.dialogId || previousDialogId;
      last = result;
    }
    return last ?? { dialogId: "", content: "", reasoning: "", usage: null, citations: [] };
  };

  // ---- streaming ----
  if (stream) {
    const encoder = new TextEncoder();
    let ctrl = null;
    let closed = false;
    const send = (obj) => {
      if (!closed && ctrl) ctrl.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
    };
    // The OpenAI stream terminator is the BARE literal `data: [DONE]` — not a
    // JSON string. `JSON.stringify("[DONE]")` emits `"\"[DONE]\""` which the
    // AI SDK's parseJsonEventStream treats as a data frame, fails its chunk
    // schema with "expected object, received string", and the run ends in an
    // error instead of a clean stop (verified against @ai-sdk/provider-utils
    // `if (data === "[DONE]") return;` — the comparison is against the bare
    // literal, so JSON.stringify must never touch it).
    const sendDone = () => {
      if (!closed && ctrl) ctrl.enqueue(encoder.encode("data: [DONE]\n\n"));
    };
    const readable = new ReadableStream({
      start(c) {
        ctrl = c;
      },
      cancel() {
        closed = true;
        pumpAbort.abort(new Error("consumer cancelled the response")); // tear the upstream down too
      },
    });

    // Gate the 200 on the first upstream event: auth failures (session
    // expired) must throw out of handleChatCompletion so the loader can map
    // them to signIn:"expired" and magpie marks the account — not vanish as
    // an error frame inside an already-200 SSE stream. Once the first piece
    // (or the headers-first failure) is in, errors go back to in-stream
    // frames (headers are committed by then).
    let gotFirst = false;
    let completionChars = 0;
    const firstGate = new Promise((resolve, reject) => {
      const pump = (async () => {
        try {
          send(textChunk(id, model, created, { role: "assistant", content: "" }));
          const result = await runTurns((piece) => {
            completionChars += countChars(piece.text);
            const delta = piece.type === "reasoning" ? { reasoning_content: piece.text } : { content: piece.text };
            send(textChunk(id, model, created, delta));
            if (!gotFirst) {
              gotFirst = true;
              resolve();
            }
          });
          if (result.citations?.length) send(citationsChunk(id, model, created, result.citations));
          send(textChunk(id, model, created, {}, "stop", usageWithEstimate(result.usage, messageTexts(body.messages), completionChars)));
          sendDone();
          closed = true;
          try {
            ctrl.close();
          } catch {}
          if (!gotFirst) {
            gotFirst = true;
            resolve(); // degenerate empty turn: still gate-open, headers 200
          }
        } catch (err) {
          if (!gotFirst) {
            gotFirst = true;
            reject(err); // nothing sent yet → throw to the caller (signIn:expired 等)
            return;
          }
          // Mid-stream failures: emit an OpenAI error OBJECT as a data frame
          // (headers are already sent), then close.
          if (!closed) {
            const status = errorStatus(err);
            send({ error: { message: err.message, type: "upstream_error", code: status } });
            sendDone();
            closed = true;
          }
          try {
            ctrl.close();
          } catch {}
        }
      })();
      pump.catch(() => {}); // rejections are consumed via firstGate
    });
    await firstGate;
    return new Response(readable, {
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" },
    });
  }

  // ---- non-streaming ----
  try {
    let content = "";
    let reasoning = "";
    const result = await runTurns((piece) => {
      if (piece.type === "reasoning") reasoning += piece.text;
      else content += piece.text;
    });
    const usage = usageWithEstimate(
      result.usage,
      messageTexts(body.messages),
      countChars(content) + countChars(reasoning),
    );
    return new Response(
      JSON.stringify(completionBody(id, model, created, content, reasoning, usage, result.citations)),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  } catch (err) {
    // AuthExpiredError must NOT be swallowed into a GatewayError: the loader
    // turns it into signIn:"expired" so magpie marks the account. Rethrow as-is.
    if (err instanceof AuthExpiredError) throw err;
    const status = errorStatus(err);
    throw new GatewayError(
      status,
      err.message,
      status === 400 || status === 404 ? "invalid_request_error" : "upstream_error",
    );
  }
}
