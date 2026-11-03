// test/gateway.test.js — OpenAI ⇄ MiMo translation over a scripted upstream.
import { describe, test, expect, afterEach } from "bun:test";
import { MimoClient, AuthExpiredError, resolveImages } from "../src/mimo.mjs";
import { handleChatCompletion, resolveModel, errorStatus, GatewayError } from "../src/gateway.mjs";
import { ModelNotFoundError } from "../src/mimo.mjs";

const COOKIE = 'cUserId=x; userId=1; serviceToken=tok; xiaomichatbot_serviceToken="tok"; xiaomichatbot_ph="ph1"';
const ENC = new TextEncoder();

const servers = [];
afterEach(() => {
  while (servers.length) servers.pop().stop(true);
});

function fakeUpstream(sseTextOrList) {
  const calls = [];
  const responses = Array.isArray(sseTextOrList) ? sseTextOrList : [sseTextOrList];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const i = Math.min(calls.length, responses.length - 1);
      calls.push({ path: new URL(req.url).pathname, body: await req.text() });
      return new Response(responses[i], { status: 200, headers: { "content-type": "text/event-stream" } });
    },
  });
  servers.push(server);
  return { server, calls };
}

function framesToSSE(frames) {
  const enc = new TextEncoder();
  const text = frames
    .map((f) => {
      let s = "";
      if (f.event) s += `event:${f.event}\n`;
      if (f.data !== undefined) s += `data:${f.data}\n`;
      return s;
    })
    .join("\n");
  return new TextDecoder().decode(enc.encode(text));
}

const happyFrames = [
  { event: "dialogId", data: '{"content":"17159858"}' },
  { event: "message", data: '{"reasoningContent":"thinking…"}' },
  { event: "message", data: '{"content":"Hello "}' },
  { event: "message", data: '{"content":"world"}' },
  { event: "usage", data: '{"promptTokens":10,"completionTokens":2,"totalTokens":12}' },
  { event: "finish", data: '{"content":"[DONE]"}' },
];

function setup(frames) {
  // frames: either a frame list (one scripted response) or a list of
  // already-encoded SSE texts (one per upstream call, in order).
  const up = fakeUpstream(Array.isArray(frames) && typeof frames[0] === "string" ? frames : framesToSSE(frames));
  const client = new MimoClient({ base: `http://localhost:${up.server.port}` });
  return { up, client };
}

describe("handleChatCompletion", () => {
  test("non-streaming: full OpenAI completion with reasoning_content and usage", async () => {
    const { client, up } = setup(happyFrames);
    const resp = await handleChatCompletion(
      client,
      { cookie: COOKIE, ph: "ph1" },
      { catalog: { models: [{ id: "mimo-v2.6-pro", name: "Pro", thinkingDefault: true, webSearch: 0 }] } },
      { model: "mimo-v2.6-pro", messages: [{ role: "user", content: "hi" }] },
    );
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0].message.content).toBe("Hello world");
    expect(body.choices[0].message.reasoning_content).toBe("thinking…");
    expect(body.usage.prompt_tokens).toBe(10);
    expect(body.model).toBe("mimo-v2.6-pro");
    // one upstream conversation, chained turn
    const payload = JSON.parse(up.calls[0].body);
    expect(payload.conversationId).toMatch(/^[0-9a-f]{32}$/);
    expect(payload.modelConfig.enableThinking).toBe(true); // catalog default on
  });

  test("streaming: role chunk → deltas → citations → stop with usage → [DONE]", async () => {
    const frames = [...happyFrames.slice(0, 4), { event: "web_search", data: '[{"name":"R","url":"https://x"}]' }, ...happyFrames.slice(4)];
    const { client } = setup(frames);
    const resp = await handleChatCompletion(
      client,
      { cookie: COOKIE, ph: "ph1" },
      { catalog: { models: [{ id: "m", name: "M", thinkingDefault: false, webSearch: 0 }] } },
      { model: "m", messages: [{ role: "user", content: "hi" }], stream: true },
    );
    expect(resp.headers.get("content-type")).toContain("text/event-stream");
    const text = await resp.text();
    // The terminator is the BARE literal `data: [DONE]` (not JSON-quoted) —
    // the AI SDK's parseJsonEventStream only recognizes the bare form and
    // fails chunk validation on `"\"[DONE]\""`. Regression: it used to be
    // sent through JSON.stringify.
    expect(text).toContain("data: [DONE]\n\n");
    expect(text).not.toContain('"[DONE]"');
    const lines = text.split("\n").filter((l) => l.startsWith("data: ") && l !== "data: [DONE]");
    const objs = lines.map((l) => JSON.parse(l.slice(6)));
    expect(objs[0].choices[0].delta).toEqual({ role: "assistant", content: "" });
    const deltas = objs.filter((o) => o.choices?.[0]?.delta?.reasoning_content !== undefined);
    expect(deltas[0].choices[0].delta.reasoning_content).toBe("thinking…");
    const contents = objs.filter((o) => o.choices?.[0]?.delta?.content !== undefined && o.choices[0].delta.content);
    expect(contents.map((o) => o.choices[0].delta.content).join("")).toBe("Hello world");
    const cits = objs.find((o) => o.citations);
    expect(cits.citations[0].url).toBe("https://x");
    const stop = objs.find((o) => o.choices?.[0]?.finish_reason === "stop");
    expect(stop.usage.total_tokens).toBe(12);
  });

  test("usage estimated at ~4 chars/token when the upstream sends no usage event", async () => {
    const frames = [
      { event: "dialogId", data: '{"content":"17159858"}' },
      { event: "message", data: '{"content":"Hello world"}' },
      { event: "finish", data: '{"content":"[DONE]"}' },
    ];
    const { client } = setup(frames);
    const resp = await handleChatCompletion(
      client,
      { cookie: COOKIE, ph: "ph1" },
      {},
      { model: "m", messages: [{ role: "user", content: "hi" }] },
    );
    const body = await resp.json();
    // "hi" = 2 chars → 1 prompt token; "Hello world" = 11 chars → 3 completion tokens.
    expect(body.usage).toEqual({ prompt_tokens: 1, completion_tokens: 3, total_tokens: 4 });
  });

  test("upstream usage fields survive when present; missing ones get estimated", async () => {
    // promptTokens only: completion side falls back to the estimate.
    const frames = [
      { event: "message", data: '{"content":"abcdefgh"}' }, // 8 chars → 2 tokens
      { event: "usage", data: '{"promptTokens":7}' },
      { event: "finish", data: '{"content":"[DONE]"}' },
    ];
    const { client } = setup(frames);
    const resp = await handleChatCompletion(
      client,
      { cookie: COOKIE, ph: "ph1" },
      {},
      { model: "m", messages: [{ role: "user", content: "hi" }] },
    );
    const body = await resp.json();
    expect(body.usage).toEqual({ prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 });
  });

  test("multi-turn conversation replays with chained previousDialogueId", async () => {
    const { client, up } = setup([
      framesToSSE([
        { event: "dialogId", data: '{"content":"111"}' },
        { event: "message", data: '{"content":"a"}' },
        { event: "finish", data: '{"content":"[DONE]"}' },
      ]),
      framesToSSE([
        { event: "dialogId", data: '{"content":"222"}' },
        { event: "message", data: '{"content":"b"}' },
        { event: "finish", data: '{"content":"[DONE]"}' },
      ]),
    ]);
    const resp = await handleChatCompletion(
      client,
      { cookie: COOKIE, ph: "ph1" },
      {},
      { model: "m", messages: [{ role: "user", content: "q1" }, { role: "assistant", content: "a" }, { role: "user", content: "q2" }] },
    );
    const body = await resp.json();
    expect(body.choices[0].message.content).toBe("ab");
    expect(up.calls).toHaveLength(2);
    const p1 = JSON.parse(up.calls[0].body);
    const p2 = JSON.parse(up.calls[1].body);
    expect(p1.previousDialogueId).toBeNull();
    expect(p2.previousDialogueId).toBe("111");
    expect(p2.conversationId).toBe(p1.conversationId); // same upstream conversation
    // assistant history is not re-sent; q2 is the second query
    expect(p1.query).toBe("q1");
    expect(p2.query).toBe("q2");
  });

  test("system messages splice into the first query", async () => {
    const { client, up } = setup(happyFrames);
    await handleChatCompletion(
      client,
      { cookie: COOKIE, ph: "ph1" },
      {},
      { model: "m", messages: [{ role: "system", content: "be brief" }, { role: "user", content: "hi" }] },
    );
    expect(JSON.parse(up.calls[0].body).query).toBe("be brief\n\n---\n\nhi");
  });

  test("unknown model → 404 with available list", async () => {
    const { client } = setup(happyFrames);
    let err = null;
    try {
      await handleChatCompletion(
        client,
        { cookie: COOKIE, ph: "ph1" },
        { catalog: { models: [{ id: "a" }, { id: "b" }] } },
        { model: "nope", messages: [{ role: "user", content: "hi" }] },
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ModelNotFoundError);
    expect(errorStatus(err)).toBe(404);
    expect(err.message).toContain("a, b");
  });

  test("-studio suffix is normalized away", () => {
    expect(resolveModel("mimo-v2.6-pro-studio", [{ id: "mimo-v2.6-pro" }])).toBe("mimo-v2.6-pro");
    expect(resolveModel("", [])).toBe("mimo-v2.6-pro"); // degraded default
    expect(resolveModel("auto", [{ id: "x" }])).toBe("x");
  });

  test("in-band busy frame maps to 503", async () => {
    const { client } = setup([{ event: "error", data: '{"content":"服务器繁忙"}' }]);
    let err = null;
    try {
      await handleChatCompletion(client, { cookie: COOKIE, ph: "ph1" }, {}, { model: "m", messages: [{ role: "user", content: "hi" }] });
    } catch (e) {
      err = e;
    }
    expect(errorStatus(err)).toBe(503);
  });

  test("missing messages array → 400", async () => {
    const { client } = setup(happyFrames);
    let err = null;
    try {
      await handleChatCompletion(client, { cookie: COOKIE, ph: "ph1" }, {}, { model: "m" });
    } catch (e) {
      err = e;
    }
    expect(errorStatus(err)).toBe(400);
  });

  test("no_user_message → 400 invalid_request_error (not 502)", async () => {
    const { client } = setup(happyFrames);
    let err = null;
    try {
      await handleChatCompletion(client, { cookie: COOKIE, ph: "ph1" }, {}, { model: "m", messages: [{ role: "assistant", content: "only assistant" }] });
    } catch (e) {
      err = e;
    }
    expect(errorStatus(err)).toBe(400);
    expect(err instanceof GatewayError ? err.type : err.type).toBe("invalid_request_error");
  });

  test("non-stream: upstream 401 → AuthExpiredError propagates (signIn:expired path, not GatewayError-wrapped)", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response("unauthorized", { status: 401 }),
    });
    servers.push(server);
    const client = new MimoClient({ base: `http://localhost:${server.port}` });
    let err = null;
    try {
      await handleChatCompletion(client, { cookie: COOKIE, ph: "ph1" }, {}, { model: "m", messages: [{ role: "user", content: "hi" }] });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AuthExpiredError); // loader turns this into signIn:"expired"
  });

  test("stream: upstream 401 before first frame → throws (200 not committed)", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response("unauthorized", { status: 401 }),
    });
    servers.push(server);
    const client = new MimoClient({ base: `http://localhost:${server.port}` });
    let err = null;
    try {
      await handleChatCompletion(client, { cookie: COOKIE, ph: "ph1" }, {}, { model: "m", messages: [{ role: "user", content: "hi" }], stream: true });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AuthExpiredError); // no swallowed-into-SSE-frame
  });

  test("stream: mid-stream error after first frame stays in-band (200 already sent)", async () => {
    const { client } = setup([{ event: "message", data: '{"content":"ok"}' }, { event: "error", data: '{"content":"服务器繁忙"}' }]);
    const resp = await handleChatCompletion(
      client,
      { cookie: COOKIE, ph: "ph1" },
      {},
      { model: "m", messages: [{ role: "user", content: "hi" }], stream: true },
    );
    expect(resp.status).toBe(200);
    const text = await resp.text();
    expect(text).toContain('"error"'); // in-band error frame after headers committed
  });

  test("chatStream with already-aborted signal fails fast (no upstream call)", async () => {
    const { client, up } = setup(happyFrames);
    const ctrl = new AbortController();
    ctrl.abort(new Error("client gone"));
    let err = null;
    try {
      await client.chatStream({ cookie: COOKIE, ph: "ph1" }, { query: "hi", model: "m" }, ctrl.signal);
    } catch (e) {
      err = e;
    }
    expect(err).toBeTruthy();
    expect(up.calls).toHaveLength(0); // doomed request never dialed
  });
});

describe("fetchImageBytes SSRF guard (via resolveImages)", () => {
  test("private/loopback/non-http image URLs are rejected", async () => {
    const { client } = setup(happyFrames);
    for (const url of [
      "http://127.0.0.1/x.png",
      "http://169.254.169.254/latest/meta-data",
      "http://10.0.0.1/x.png",
      "http://192.168.1.1/x.png",
      "file:///etc/passwd",
      "ftp://host/x.png",
    ]) {
      let err = null;
      try {
        await resolveImages([url], { cookie: COOKIE, ph: "ph1" }, client);
      } catch (e) {
        err = e;
      }
      expect(err?.message).toContain("not allowed");
    }
  });

  test("data: URL oversized → rejected", async () => {
    const { client } = setup(happyFrames);
    // 20 MiB cap: base64 inflates 4/3, so 28 MB of base64 ≈ 21 MB raw.
    const big = "data:image/png;base64," + "A".repeat(28 * 1024 * 1024);
    let err = null;
    try {
      await resolveImages([big], { cookie: COOKIE, ph: "ph1" }, client);
    } catch (e) {
      err = e;
    }
    expect(err?.message).toContain("exceeds");
  });
});

describe("streaming teardown regressions", () => {
  test("consumer cancel aborts the upstream and stops dialing remaining replay turns", async () => {
    // Turn 1: slow stream that never finishes on its own. Turn 2 must never
    // be dialed after the consumer cancels the response body.
    let serverAborted = false;
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        req.signal.addEventListener("abort", () => {
          serverAborted = true;
        });
        const body = new ReadableStream({
          start(c) {
            c.enqueue(ENC.encode('event:dialogId\ndata:{"content":"171"}\n\n'));
            c.enqueue(ENC.encode('event:message\ndata:{"content":"part1"}\n\n'));
            // no finish frame — the turn would hang forever without cancel
          },
        });
        return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
      },
    });
    servers.push(server);
    const client = new MimoClient({ base: `http://localhost:${server.port}` });
    const resp = await handleChatCompletion(
      client,
      { cookie: COOKIE, ph: "ph1" },
      {},
      {
        model: "m",
        stream: true,
        messages: [
          { role: "user", content: "q1" },
          { role: "assistant", content: "a1" },
          { role: "user", content: "q2" },
        ],
      },
    );
    const reader = resp.body.getReader();
    await reader.read(); // consume first chunk (role frame / first deltas)
    await reader.cancel(); // consumer walks away mid-stream
    // give the pump a moment to observe the abort
    await new Promise((r) => setTimeout(r, 100));
    expect(serverAborted).toBe(true); // upstream teardown happened
  });

  test("mid-stream upstream stall surfaces via idle watchdog as in-band error frame", async () => {
    // one message frame, then silence forever: the watchdog (idleMs) must
    // abort the upstream read, the pump emits an in-band error frame (headers
    // already committed by the first delta) and closes the stream.
    const server = Bun.serve({
      port: 0,
      async fetch() {
        const body = new ReadableStream({
          start(c) {
            c.enqueue(ENC.encode('event:dialogId\ndata:{"content":"171"}\n\n'));
            c.enqueue(ENC.encode('event:message\ndata:{"content":"part1"}\n\n'));
            // then silence forever
          },
        });
        return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
      },
    });
    servers.push(server);
    const client = new MimoClient({ base: `http://localhost:${server.port}`, idleMs: 150 });
    const resp = await handleChatCompletion(
      client,
      { cookie: COOKIE, ph: "ph1" },
      {},
      { model: "m", stream: true, messages: [{ role: "user", content: "hi" }] },
    );
    const text = await resp.text();
    expect(text).toContain("part1"); // the deltas that did arrive got through
    expect(text).toContain('"error"'); // in-band error frame (headers committed)
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true); // stream closed cleanly
  });

  test("stall before the first piece: watchdog throws out of the 200 gate (no 200 SSE)", async () => {
    const server = Bun.serve({
      port: 0,
      async fetch() {
        const body = new ReadableStream({ start() {} }); // opens, then silence forever
        return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
      },
    });
    servers.push(server);
    const client = new MimoClient({ base: `http://localhost:${server.port}`, idleMs: 150 });
    let err = null;
    try {
      await handleChatCompletion(
        client,
        { cookie: COOKIE, ph: "ph1" },
        {},
        { model: "m", stream: true, messages: [{ role: "user", content: "hi" }] },
      );
    } catch (e) {
      err = e;
    }
    // nothing was sent yet → the 200 gate rejects; the loader maps this to a
    // 502 JSON response (or signIn:expired), never a hanging 200 SSE.
    expect(err?.message).toContain("upstream silent");
  });
});

describe("SSRF redirect and DNS hardening", () => {
  test("302 from a public host to a private IP is rejected (never dialed)", async () => {
    // "203.0.113.7" is TEST-NET-3 (public range) so it passes the literal
    // guard. We patch globalThis.fetch only to emulate the attacker's public
    // server answering 302 → 169.254.169.254 (cloud metadata); the plugin's
    // own manual-redirect loop must reject the target BEFORE any fetch to it.
    const realFetch = globalThis.fetch;
    const dialed = [];
    let hop = 0;
    globalThis.fetch = async (input, init) => {
      const u = new URL(String(input instanceof URL ? input : input.url ?? input));
      dialed.push(u.hostname);
      if (hop === 0) {
        hop++;
        return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } });
      }
      return realFetch(input, init);
    };
    const { client } = setup(happyFrames);
    let err = null;
    try {
      await resolveImages(["http://203.0.113.7/x.png"], { cookie: COOKIE, ph: "ph1" }, client);
    } catch (e) {
      err = e;
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(err?.message).toContain("not allowed");
    expect(dialed.filter((h) => h.includes("169.254")).length).toBe(0); // private target never dialed
  });

  test("public-looking DNS name that resolves to loopback is rejected (nip.io-style bypass)", async () => {
    // DNS pre-flight (injected): the name passes all string checks, but the
    // resolver hands back a loopback address → must be rejected BEFORE any
    // fetch. fetch itself is poisoned so reaching it means the guard failed.
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error("fetch must not be reached for private-resolving names");
    };
    const { client } = setup(happyFrames);
    let err = null;
    try {
      await resolveImages(
        ["http://loopback-attacker.example.com/x.png"],
        { cookie: COOKIE, ph: "ph1" },
        client,
        { dnsResolve: async () => ["127.0.0.1"] },
      );
    } catch (e) {
      err = e;
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(err?.message).toContain("not allowed");
  });

  test("IPv6 private forms are rejected by the literal guard", async () => {
    const { client } = setup(happyFrames);
    for (const host of [
      "[::1]",                 // loopback
      "[::ffff:127.0.0.1]",    // v4-mapped loopback (dotted form)
      "[::ffff:7f00:1]",       // v4-mapped loopback (hex form)
      "[fd00::1]",             // ULA
      "[fe80::1]",             // link-local
      "[::]",                  // unspecified
    ]) {
      let err = null;
      try {
        await resolveImages([`http://${host}/x.png`], { cookie: COOKIE, ph: "ph1" }, client);
      } catch (e) {
        err = e;
      }
      expect(err?.message).toContain("not allowed");
    }
  });

  test("IPv6 v4-mapped form is blocked even though its hostname LOOKS public", async () => {
    // The old guard saw hostname "[::ffff:7f00:1]" → startsWith fc/fd/fe80
    // matched nothing → passed. Regression: isPublicIPv6 must decode the
    // embedded v4.
    const { client } = setup(happyFrames);
    let dialed = false;
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      dialed = true;
      return realFetch("http://127.0.0.1:1/x.png"); // port 1: nothing listens
    };
    let err = null;
    try {
      await resolveImages(["http://[::ffff:7f00:1]/x.png"], { cookie: COOKIE, ph: "ph1" }, client);
    } catch (e) {
      err = e;
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(err?.message).toContain("not allowed");
    expect(dialed).toBe(false); // guard rejected before any fetch
  });
});

