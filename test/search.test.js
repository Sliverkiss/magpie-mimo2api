// test/search.test.js — the `search` hook: web_search citations → the host's
// page list, over a scripted upstream chat stream.
import { describe, test, expect, afterEach } from "bun:test";
import { MimoClient } from "../src/mimo.mjs";
import { searchMimo, clampCount, pagesOf } from "../src/search.mjs";
import { parseWebSearch } from "../src/mimo.mjs";
import { Mimo2ApiPlugin, _internal } from "../index.mjs";

const SESSION = {
  cookie: 'cUserId=cu; userId=1; serviceToken=tok; xiaomichatbot_serviceToken="tok"',
  ph: "ph1",
};

const servers = [];
afterEach(() => {
  while (servers.length) servers.pop().stop(true);
});

/** SSE text from {event, data} frames, in the upstream's `event:name` dialect. */
function sse(frames) {
  return frames.map((f) => `event:${f.event}\ndata:${f.data}\n\n`).join("");
}

/** A scripted upstream chat channel that records every call. */
function upstream({ status = 200, body = "" } = {}) {
  const calls = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      calls.push({
        path: u.pathname,
        ph: u.searchParams.get("xiaomichatbot_ph"),
        cookie: req.headers.get("cookie") ?? "",
        body: await req.text(),
      });
      return new Response(body, { status, headers: { "content-type": "text/event-stream" } });
    },
  });
  servers.push(server);
  return { client: new MimoClient({ base: `http://localhost:${server.port}` }), calls, port: server.port };
}

describe("searchMimo", () => {
  test("web_search citations become {title, url, text} pages, in order", async () => {
    const pages = [
      { name: "Rust 1.80", url: "https://blog.rust-lang.org/1.80", snippet: "Lazy statics land", usedContent: true },
      { name: "std docs", url: "https://doc.rust-lang.org/std", snippet: "LazyLock" },
    ];
    const { client, calls } = upstream({
      body: sse([
        { event: "dialogId", data: '{"content":"17159858"}' },
        { event: "web_search", data: JSON.stringify(pages) },
        { event: "message", data: '{"content":"Rust 1.80 adds lazy statics."}' },
        { event: "finish", data: '{"content":"[DONE]"}' },
      ]),
    });
    const out = await searchMimo({ query: "  rust 1.80 lazy statics  ", count: 5 }, { client, session: SESSION });

    expect(out).toEqual([
      { title: "Rust 1.80", url: "https://blog.rust-lang.org/1.80", text: "Lazy statics land" },
      { title: "std docs", url: "https://doc.rust-lang.org/std", text: "LazyLock" },
    ]);
    // The search rides the react channel, with web search on and thinking off.
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe("/open-apis/react/chat");
    expect(calls[0].ph).toBe("ph1");
    expect(calls[0].cookie).toContain("serviceToken=tok");
    const payload = JSON.parse(calls[0].body);
    expect(payload.query).toBe("rust 1.80 lazy statics"); // trimmed
    expect(payload.modelConfig.webSearchStatus).toBe("auto");
    expect(payload.modelConfig.enableThinking).toBe(false);
    expect(payload.modelConfig.model).toBe("mimo-v2.6-pro");
  });

  test("every search opens its own upstream conversation (no history replayed)", async () => {
    const { client, calls } = upstream({
      body: sse([
        { event: "web_search", data: "[]" },
        { event: "finish", data: '{"content":"[DONE]"}' },
      ]),
    });
    await searchMimo({ query: "one" }, { client, session: SESSION });
    await searchMimo({ query: "two" }, { client, session: SESSION });

    expect(calls).toHaveLength(2);
    const [a, b] = calls.map((c) => JSON.parse(c.body));
    expect(a.conversationId).toMatch(/^[0-9a-f]{32}$/);
    expect(b.conversationId).toMatch(/^[0-9a-f]{32}$/);
    expect(a.conversationId).not.toBe(b.conversationId); // never the same conversation
    expect(a.previousDialogueId).toBeNull();
    expect(b.previousDialogueId).toBeNull();
  });

  test("count slices the page list", async () => {
    const pages = Array.from({ length: 6 }, (_, i) => ({ name: `p${i}`, url: `https://example.com/${i}` }));
    const { client } = upstream({
      body: sse([
        { event: "web_search", data: JSON.stringify(pages) },
        { event: "finish", data: '{"content":"[DONE]"}' },
      ]),
    });
    const out = await searchMimo({ query: "q", count: 2 }, { client, session: SESSION });
    expect(out.map((p) => p.url)).toEqual(["https://example.com/0", "https://example.com/1"]);
  });

  test("no citations is an empty list, not an error (upstream answered from memory)", async () => {
    const { client } = upstream({
      body: sse([
        { event: "message", data: '{"content":"2 + 2 = 4"}' },
        { event: "finish", data: '{"content":"[DONE]"}' },
      ]),
    });
    expect(await searchMimo({ query: "2+2" }, { client, session: SESSION })).toEqual([]);
  });

  test("upstream 401 → .status 401 and signIn:expired (the host rests the account)", async () => {
    const { client } = upstream({ status: 401, body: "unauthorized" });
    let err = null;
    try {
      await searchMimo({ query: "q" }, { client, session: SESSION });
    } catch (e) {
      err = e;
    }
    expect(err).toBeTruthy();
    // Numeric status is the host's rest-the-account signal; without it the
    // dead account keeps being handed searches.
    expect(err.status).toBe(401);
    expect(err.signIn).toBe("expired");
    expect(err.message).toContain("sign in again");
    expect(err.cause).toBeTruthy(); // the original AuthExpiredError survives
  });

  test("a session with no cookie is refused before any upstream call", async () => {
    const { client, calls } = upstream({ body: "" });
    let err = null;
    try {
      await searchMimo({ query: "q" }, { client, session: {} });
    } catch (e) {
      err = e;
    }
    expect(err.status).toBe(401);
    expect(err.signIn).toBe("expired");
    expect(calls).toHaveLength(0); // nothing dialed
  });

  test("an empty query never dials upstream", async () => {
    const { client, calls } = upstream({ body: "" });
    let err = null;
    try {
      await searchMimo({ query: "   " }, { client, session: SESSION });
    } catch (e) {
      err = e;
    }
    expect(err.message).toContain("query is empty");
    expect(err.status).toBeUndefined(); // a caller mistake, not an account refusal
    expect(calls).toHaveLength(0);
  });

  test("an in-band error frame propagates instead of becoming an empty page list", async () => {
    const { client } = upstream({
      body: sse([{ event: "error", data: '{"content":"服务器繁忙，请稍后再试"}' }]),
    });
    let err = null;
    try {
      await searchMimo({ query: "q" }, { client, session: SESSION });
    } catch (e) {
      err = e;
    }
    expect(err?.kind).toBe("busy");
    expect(err.status).toBeUndefined(); // transient, not a refusal — no rest
  });

  test("a content-filtered turn is not reported as 'no results'", async () => {
    const { client } = upstream({
      body: sse([{ event: "sensitive_query", data: '{"content":"blocked"}' }]),
    });
    let err = null;
    try {
      await searchMimo({ query: "q" }, { client, session: SESSION });
    } catch (e) {
      err = e;
    }
    expect(err?.name).toBe("ContentFilterError");
    expect(err.status).toBeUndefined();
  });

  test("a caller abort tears the upstream down", async () => {
    let aborted = false;
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        req.signal.addEventListener("abort", () => {
          aborted = true;
        });
        const body = new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode('event:web_search\ndata:[{"url":"https://a"}]\n\n'));
          },
        });
        return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
      },
    });
    servers.push(server);
    const client = new MimoClient({ base: `http://localhost:${server.port}` });
    const ctrl = new AbortController();
    const pending = searchMimo({ query: "q" }, { client, session: SESSION, signal: ctrl.signal });
    await new Promise((r) => setTimeout(r, 50));
    ctrl.abort(new Error("magpie search deadline"));
    let err = null;
    try {
      await pending;
    } catch (e) {
      err = e;
    }
    expect(err).toBeTruthy();
    await new Promise((r) => setTimeout(r, 100));
    expect(aborted).toBe(true);
  });
});

describe("pagesOf", () => {
  test("a URL seen twice is one page — the first title and snippet win", () => {
    expect(
      pagesOf(
        [
          { title: "a", url: "https://x", snippet: "1" },
          { title: "b", url: "https://x", snippet: "2" },
        ],
        10,
      ),
    ).toEqual([{ title: "a", url: "https://x", text: "1" }]);
  });

  test("a citation with no url is dropped — there is nothing to open in it", () => {
    expect(pagesOf([{ title: "no url" }, { title: "b", url: "https://y" }], 10).map((p) => p.url)).toEqual(["https://y"]);
  });

  test("non-string fields are narrowed, not forwarded", () => {
    expect(pagesOf([{ title: 42, url: "https://z", snippet: null }], 10)).toEqual([{ title: "", url: "https://z", text: "" }]);
  });

  test("an absent or non-array citation list is an empty page list", () => {
    expect(pagesOf(undefined, 10)).toEqual([]);
    expect(pagesOf(null, 10)).toEqual([]);
  });

  test("the limit is honoured, including zero", () => {
    const cits = Array.from({ length: 5 }, (_, i) => ({ url: `https://e/${i}` }));
    expect(pagesOf(cits, 3)).toHaveLength(3);
    expect(pagesOf(cits, 0)).toEqual([]);
  });
});

describe("clampCount", () => {
  test("defaults, floors and ceilings", () => {
    expect(clampCount(undefined)).toBe(6);
    expect(clampCount(null)).toBe(6);
    expect(clampCount(0)).toBe(6);
    expect(clampCount(-3)).toBe(6);
    expect(clampCount(Number.NaN)).toBe(6);
    expect(clampCount("4")).toBe(4);
    expect(clampCount(2.9)).toBe(2);
    expect(clampCount(999)).toBe(20);
  });
});

describe("the search hook through the plugin (index.mjs wiring)", () => {
  // Inside SESSION_REFRESH_LEAD_MS → ensureFreshSession returns the session
  // without a passport round-trip, so these tests exercise the wiring, not the
  // renewal chain (login.test.js owns that).
  const freshAuth = (id) => ({ fetchedAt: Date.now(), cookie: `serviceToken=${id}`, ph: `ph-${id}`, userId: id });

  /** A plugin instance whose shared client points at a mock upstream. */
  async function pluginFor(port) {
    const hooks = await Mimo2ApiPlugin({ client: {}, magpie: {} }, { _upstreamBase: `http://localhost:${port}` });
    return hooks;
  }

  test("the hook surface is one keyless, account-bound entry named mimo", async () => {
    const hooks = await pluginFor(1);
    expect(Object.keys(hooks.search)).toEqual(["mimo"]);
    expect(hooks.search.mimo.name).toContain("MiMo Studio");
    // Keyless: `auth` binds the entry to this plugin's accounts, so the host
    // hands over a signed-in account instead of a key.
    expect(hooks.search.mimo.auth).toBe("mimo");
    expect(hooks.search.mimo.keyOptional).toBeUndefined();
    expect(hooks.search.mimo.keysURL).toBeUndefined();
    expect(typeof hooks.search.mimo.execute).toBe("function");
    // The test seam is the same function, not a copy.
    expect(_internal.searchMimo).toBe(searchMimo);
  });

  test("execute searches as the account magpie hands over", async () => {
    const { calls, port } = upstream({
      body: sse([
        { event: "web_search", data: '[{"name":"A","url":"https://a","snippet":"s"}]' },
        { event: "finish", data: '{"content":"[DONE]"}' },
      ]),
    });
    const hooks = await pluginFor(port);
    const auth = freshAuth("wiring-happy");

    const pages = await hooks.search.mimo.execute({ query: "q", count: 3 }, { getAuth: async () => auth });
    expect(pages).toEqual([{ title: "A", url: "https://a", text: "s" }]);
    expect(calls).toHaveLength(1);
    expect(calls[0].cookie).toContain("serviceToken=wiring-happy");
    expect(JSON.parse(calls[0].body).modelConfig.webSearchStatus).toBe("auto");
  });

  test("a refused account comes back as the host's numeric refusal, never an empty list", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("unauthorized", { status: 401 }) });
    servers.push(server);
    const hooks = await pluginFor(server.port);

    let err = null;
    try {
      await hooks.search.mimo.execute({ query: "q" }, { getAuth: async () => freshAuth("wiring-dead") });
    } catch (e) {
      err = e;
    }
    expect(err).toBeTruthy();
    expect(err.status).toBe(401); // magpie rests the account for search
    expect(err.signIn).toBe("expired");
  });

  test("an account with no session material is refused before any upstream call", async () => {
    const { calls, port } = upstream({ body: "" });
    const hooks = await pluginFor(port);

    let err = null;
    try {
      await hooks.search.mimo.execute({ query: "q" }, { getAuth: async () => ({ fetchedAt: Date.now() }) });
    } catch (e) {
      err = e;
    }
    expect(err.signIn).toBe("expired");
    expect(err.status).toBeUndefined(); // no refusal from upstream — nothing was dialed
    expect(calls).toHaveLength(0);
  });
});

describe("parseWebSearch data shapes", () => {
  test("bare array, {data}, and empty/garbage payloads", () => {
    expect(parseWebSearch('[{"name":"a","url":"https://a"}]')).toHaveLength(1);
    expect(parseWebSearch('{"data":[{"name":"a","url":"https://a"}]}')).toHaveLength(1);
    expect(parseWebSearch("")).toEqual([]);
    expect(parseWebSearch("null")).toEqual([]);
    expect(parseWebSearch("not json")).toEqual([]);
    expect(parseWebSearch('"a bare string"')).toEqual([]);
    expect(parseWebSearch('{"other":1}')).toEqual([]);
  });

  test("rows without a url and non-object rows are skipped", () => {
    expect(parseWebSearch('[{"name":"no url"}]')).toEqual([]);
    expect(parseWebSearch('[null, 3, "s", {"url":"https://b"}]')).toHaveLength(1);
  });

  test("usedContent accepts the boolean and the string form", () => {
    expect(parseWebSearch('[{"url":"https://a","usedContent":true}]')[0].used).toBe(true);
    expect(parseWebSearch('[{"url":"https://a","usedContent":"true"}]')[0].used).toBe(true);
    expect(parseWebSearch('[{"url":"https://a"}]')[0].used).toBe(false);
  });

  test("missing display fields default to empty strings", () => {
    expect(parseWebSearch('[{"url":"https://a"}]')[0]).toEqual({
      title: "",
      url: "https://a",
      displayUrl: "",
      snippet: "",
      used: false,
    });
  });
});
