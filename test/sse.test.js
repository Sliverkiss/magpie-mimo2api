// test/sse.test.js — SSE wire parsing and chatStream event assembly.
import { describe, test, expect } from "bun:test";
import { parseSSE, MimoClient } from "../src/mimo.mjs";

const ENC = new TextEncoder();

function sseBody(frames) {
  // frames: [{event, data}] — MiMo dialect writes `event:x` without a space.
  return ENC.encode(
    frames
      .map((f) => {
        let s = "";
        if (f.event) s += `event:${f.event}\n`;
        if (f.data !== undefined) s += `data:${f.data}\n`;
        return s;
      })
      .join("\n"),
  );
}

describe("parseSSE", () => {
  test("MiMo dialect (no space after colon)", async () => {
    const seen = [];
    await parseSSE(
      new Blob([sseBody([{ event: "dialogId", data: '{"content":"123"}' }])]).stream(),
      async (ev) => seen.push(ev),
    );
    expect(seen).toEqual([{ id: "", event: "dialogId", data: '{"content":"123"}' }]);
  });

  test("standard dialect (space) and CRLF tolerated", async () => {
    const seen = [];
    const body = ENC.encode("event: message\r\ndata: {\"a\":1}\r\n\r\n");
    await parseSSE(new Blob([body]).stream(), async (ev) => seen.push(ev));
    expect(seen[0].event).toBe("message");
    expect(seen[0].data).toBe('{"a":1}');
  });

  test("comment lines and multi-line data", async () => {
    const seen = [];
    const body = ENC.encode(": keepalive\n\nevent:x\ndata:a\ndata:b\n\n");
    await parseSSE(new Blob([body]).stream(), async (ev) => seen.push(ev));
    expect(seen[0].event).toBe("x");
    expect(seen[0].data).toBe("a\nb"); // multi-line data joins with \n (SSE spec, as the Go reference does)
  });

  test("final frame without trailing blank line still flushes", async () => {
    const seen = [];
    const body = ENC.encode("event:finish\ndata:{\"content\":\"[DONE]\"}");
    await parseSSE(new Blob([body]).stream(), async (ev) => seen.push(ev));
    expect(seen).toHaveLength(1);
  });
});

// A scripted upstream for chatStream tests.
function fakeUpstream(sseText, { status = 200 } = {}) {
  const calls = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      calls.push({ path: new URL(req.url).pathname, body: await req.text(), headers: req.headers });
      return new Response(sseText, {
        status,
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  return { server, calls, stop: () => server.stop(true) };
}

const COOKIE = 'cUserId=x; userId=1; serviceToken=tok; xiaomichatbot_serviceToken="tok"; xiaomichatbot_ph="ph1"';

function reactFrames() {
  return [
    { event: "dialogId", data: '{"content":"17159858"}' },
    { event: "message", data: '{"reasoningContent":"thinking…"}' },
    { event: "message", data: '{"content":"Hello "}' },
    { event: "message", data: '{"content":"world"}' },
    { event: "web_search", data: '[{"name":"R","url":"https://www.example.cn/post","usedContent":true}]' },
    { event: "usage", data: '{"promptTokens":7888,"completionTokens":1230,"totalTokens":9118}' },
    { event: "finish", data: '{"content":"[DONE]"}' },
  ];
}

describe("MimoClient.chatStream", () => {
  test("react channel assembly: reasoning + content + dialogId + citations + usage", async () => {
    const up = fakeUpstream(sseBody(reactFrames()));
    const client = new MimoClient({ base: `http://localhost:${up.server.port}` });
    const pieces = [];
    const result = await client.chatStream(
      { cookie: COOKIE, ph: "ph1" },
      { query: "hi", model: "mimo-v2.6-flash", onPiece: (p) => pieces.push(p) },
    );
    up.stop();
    expect(result.dialogId).toBe("17159858");
    expect(result.reasoning).toBe("thinking…");
    expect(result.content).toBe("Hello world");
    expect(result.usage.promptTokens).toBe(7888);
    expect(result.citations).toHaveLength(1);
    expect(pieces.map((p) => p.type)).toEqual(["reasoning", "content", "content"]);
    // channel + query param + browser headers
    expect(up.calls[0].path).toBe("/open-apis/react/chat");
    expect(up.calls[0].headers.get("cookie")).toBe(COOKIE);
    const url = new URL(up.calls[0].url ?? `http://x${up.calls[0].path}`);
    const body = JSON.parse(up.calls[0].body);
    expect(body.multiMedias).toEqual([]);
    expect(body.modelConfig.model).toBe("mimo-v2.6-flash");
    expect(body.msgId).toMatch(/^[0-9a-f]{32}$/);
  });

  test("ultraspeed routes to fastchat", async () => {
    const up = fakeUpstream(sseBody(reactFrames()));
    const client = new MimoClient({ base: `http://localhost:${up.server.port}` });
    await client.chatStream({ cookie: COOKIE, ph: "ph1" }, { query: "hi", model: "mimo-v2.6-pro-ultraspeed-studio" });
    up.stop();
    expect(up.calls[0].path).toBe("/fastchat/open-apis/bot/chat");
  });

  test("in-band busy frame → StreamFrameError(kind=busy)", async () => {
    const up = fakeUpstream(sseBody([{ event: "error", data: '{"content":"服务器繁忙，请稍后再试"}' }]));
    const client = new MimoClient({ base: `http://localhost:${up.server.port}` });
    try {
      await client.chatStream({ cookie: COOKIE, ph: "ph" }, { query: "hi", model: "x" });
      expect.unreachable();
    } catch (e) {
      expect(e.name).toBe("StreamFrameError");
      expect(e.kind).toBe("busy");
    } finally {
      up.stop();
    }
  });

  test("in-band model-rejected frame → kind=model-rejected", async () => {
    const up = fakeUpstream(sseBody([{ event: "error", data: '{"content":"模型名称错误"}' }]));
    const client = new MimoClient({ base: `http://localhost:${up.server.port}` });
    try {
      await client.chatStream({ cookie: COOKIE, ph: "ph" }, { query: "hi", model: "x" });
      expect.unreachable();
    } catch (e) {
      expect(e.kind).toBe("model-rejected");
    } finally {
      up.stop();
    }
  });

  test("sensitive query → ContentFilterError", async () => {
    const up = fakeUpstream(sseBody([{ event: "sensitive_query", data: '{"content":"bad"}' }]));
    const client = new MimoClient({ base: `http://localhost:${up.server.port}` });
    try {
      await client.chatStream({ cookie: COOKIE, ph: "ph" }, { query: "hi", model: "x" });
      expect.unreachable();
    } catch (e) {
      expect(e.name).toBe("ContentFilterError");
    } finally {
      up.stop();
    }
  });

  test("non-200 passes through as UpstreamError", async () => {
    const up = fakeUpstream("nope", { status: 451 });
    const client = new MimoClient({ base: `http://localhost:${up.server.port}` });
    try {
      await client.chatStream({ cookie: COOKIE, ph: "ph" }, { query: "hi", model: "x" });
      expect.unreachable();
    } catch (e) {
      expect(e.name).toBe("UpstreamError");
      expect(e.status).toBe(451);
    } finally {
      up.stop();
    }
  });

  test("empty stream (no deltas) is an error", async () => {
    const up = fakeUpstream(sseBody([{ event: "doc", data: "{}" }]));
    const client = new MimoClient({ base: `http://localhost:${up.server.port}` });
    try {
      await client.chatStream({ cookie: COOKIE, ph: "ph" }, { query: "hi", model: "x" });
      expect.unreachable();
    } catch (e) {
      expect(e.message).toMatch(/empty response/);
    } finally {
      up.stop();
    }
  });
});

// A scripted JSON upstream for the JSON surface.
function fakeJSON(responseBody, { status = 200 } = {}) {
  const calls = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      calls.push({ path: new URL(req.url).pathname + new URL(req.url).search, body: await req.text() });
      return new Response(JSON.stringify(responseBody), { status, headers: { "content-type": "application/json" } });
    },
  });
  return { server, calls, stop: () => server.stop(true) };
}

describe("MimoClient catalog & attachments", () => {
  test("fetchCatalog drops redirectTo rows (either table) and reads defaults", async () => {
    const up = fakeJSON({
      code: 0,
      data: {
        modelConfigList: [
          { model: "mimo-v2.6-pro", name: "Pro", thinkingDefaultOn: true, webSearchDefaultStatus: "auto", nToken: "1M" },
          { model: "old-model", redirectTo: "mimo-v2.6-pro" },
          // live shape (2026-11): the redirect marker lives in the ng table
          { model: "mimo-v2-pro", name: "Legacy Pro" },
          { model: "mimo-v2.6-flash", name: "Flash", thinkingDefaultOn: false, webSearchDefaultStatus: "disabled" },
        ],
        modelConfigListNg: [
          { model: "mimo-v2.6-pro", pageType: "chat" },
          { model: "mimo-v2-pro", pageType: "chat", redirectTo: "mimo-v2.6-pro" },
        ],
      },
    });
    const client = new MimoClient({ base: `http://localhost:${up.server.port}` });
    const cat = await client.fetchCatalog({ cookie: COOKIE, ph: "ph" });
    up.stop();
    expect(cat.models.map((m) => m.id)).toEqual(["mimo-v2.6-pro", "mimo-v2.6-flash"]);
    expect(cat.models[0].thinkingDefault).toBe(true);
    expect(cat.models[0].webSearch).toBe(2);
    expect(cat.models[0].nToken).toBe("1M");
    expect(up.calls[0].path).toContain("/open-apis/bot/config");
    expect(up.calls[0].path).toContain("xiaomichatbot_ph=ph");
  });

  test("uploadFile PUTs bytes to storage with content-md5 and no cookie", async () => {
    const puts = [];
    const jsonServer = Bun.serve({
      port: 0,
      async fetch(req) {
        const u = new URL(req.url);
        if (u.pathname === "/open-apis/resource/genUploadInfo") {
          return Response.json({
            code: 0,
            data: { uploadUrl: `http://localhost:${up2.port}/put`, resourceUrl: "https://r/1", objectName: "o/1" },
          });
        }
        return Response.json({ code: 1, msg: "unexpected" });
      },
    });
    const up2 = Bun.serve({
      port: 0,
      async fetch(req) {
        puts.push({ headers: req.headers, body: new Uint8Array(await req.arrayBuffer()) });
        return new Response("ok", { status: 200 });
      },
    });
    const client = new MimoClient({ base: `http://localhost:${jsonServer.port}` });
    const up = await client.uploadFile({ cookie: COOKIE, ph: "ph" }, "x.png", new Uint8Array([1, 2, 3]));
    jsonServer.stop(true);
    up2.stop(true);
    expect(up.resourceUrl).toBe("https://r/1");
    expect(puts[0].headers.get("content-md5")).toBe(Bun.CryptoHasher.hash("md5", new Uint8Array([1, 2, 3]), "hex"));
    expect(puts[0].headers.get("cookie")).toBeNull();
    expect(puts[0].headers.get("sec-fetch-site")).toBe("cross-site");
    expect(puts[0].body).toEqual(new Uint8Array([1, 2, 3]));
  });
});
