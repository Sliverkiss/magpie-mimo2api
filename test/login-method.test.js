// test/login-method.test.js — the plugin's single login method end-to-end against a
// mock passport/upstream: password → OTP demand → code-contract callback → saved session.
import { describe, test, expect, afterEach } from "bun:test";
import { Mimo2ApiPlugin } from "../index.mjs";

const servers = [];
afterEach(() => {
  while (servers.length) servers.pop().stop(true);
});

const XSSI = "&&&START&&&";

/** Mock passport + upstream implementing the OTP-demand chain (same shape as login.test.js).
 *  direct: auth2 answers with a location (plain login, no new-device demand). */
function mockUpstream({ wrongCode = false, direct = false } = {}) {
  let landingNext = false;
  let sentCodes = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      const S = (o) => new Response(XSSI + JSON.stringify(o));
      if (u.pathname === "/open-apis/user/mi/get") {
        if (landingNext) {
          landingNext = false;
          const h = new Headers();
          for (const c of [
            "userId=2652042633; Path=/",
            'xiaomichatbot_serviceToken="stok"; Path=/',
            'xiaomichatbot_ph="ph9"; Path=/',
            "deviceId=wb_x; Path=/",
          ]) h.append("set-cookie", c);
          return Response.json({ code: 0 }, { headers: h });
        }
        const cb = encodeURIComponent(`http://localhost:${server.port}/sts?sign=x&followup=/`);
        return new Response(JSON.stringify({ code: 401, loginUrl: `http://localhost:${server.port}/pass/serviceLogin?callback=${cb}&sid=xiaomichatbot&_group=DEFAULT` }), { status: 401 });
      }
      if (u.pathname === "/pass/serviceLoginAuth2") {
        const h = new Headers({ "content-type": "text/html" });
        h.append("set-cookie", "userId=2652042633; Path=/");
        h.append("set-cookie", "passToken=ptok2; Path=/");
        return new Response(XSSI + JSON.stringify(direct
          ? { code: 0, location: "/identity/result/check", userId: 2652042633 }
          : {
              code: 0, securityStatus: 128, location: "",
              notificationUrl: `http://localhost:${server.port}/fe/service/identity/authStart?sid=xiaomichatbot&context=CTX123`,
            }), { headers: h });
      }
      if (u.pathname === "/fe/service/identity/authStart") return S({ code: 0 });
      if (u.pathname === "/identity/list") return S({ code: 2, flag: 4 });
      if (u.pathname === "/identity/auth/verifyPhone" && req.method === "GET") return S({ code: 0, maskedPhone: "+86 182******16" });
      if (u.pathname === "/identity/auth/sendPhoneTicket") { sentCodes++; return S({ code: 0, data: { wt: 59 } }); }
      if (u.pathname === "/identity/auth/verifyPhone" && req.method === "POST") {
        const f = await req.text();
        const ok = wrongCode ? false : f.includes("ticket=123456");
        return ok ? S({ code: 0, location: "/identity/result/check" }) : S({ code: 700, desc: "bad code" });
      }
      if (u.pathname === "/identity/result/check") return new Response("", { status: 302, headers: { location: "/sts?sign=x" } });
      if (u.pathname === "/sts") {
        landingNext = true;
        return new Response("", { status: 307, headers: { location: "/open-apis/user/mi/get" } });
      }
      if (u.pathname === "/open-apis/bot/config") {
        return Response.json({ code: 0, data: { modelConfigList: [{ model: "mimo-v2.6-pro", name: "Pro", thinkingDefaultOn: true, webSearchDefaultStatus: "auto" }] } });
      }
      return new Response("mock 404", { status: 404 });
    },
  });
  servers.push(server);
  return { server, sentCodes: () => sentCodes };
}

function pluginFor(port, saved) {
  return Mimo2ApiPlugin(
    { client: { auth: { set: async (req) => saved.push(req) } } },
    { _upstreamBase: `http://localhost:${port}`, _passportBase: `http://localhost:${port}` },
  );
}

describe("plugin login method (phone+password, OTP two-stage)", () => {
  test("single method declared; prompts collect phone/password", async () => {
    const hooks = await pluginFor(1, []);
    expect(hooks.auth.methods).toHaveLength(1);
    expect(hooks.auth.methods[0].type).toBe("oauth");
    expect(hooks.auth.methods[0].prompts.map((p) => p.key)).toEqual(["phone", "password"]);
  });

  test("happy path: password OK → authorize returns {callback}; the host calls it for the success auth", async () => {
    // Direct (non-OTP) login: auth2 answers with a location, so no
    // verification demand fires. magpie's host contract (confirmed against
    // the binary): authorize must NOT return a terminal {type:...} — the
    // host always calls a.callback() itself and reads the terminal shape
    // from ITS return value.
    const { server } = mockUpstream({ direct: true });
    const saved = [];
    const hooks = await pluginFor(server.port, saved);
    const method = hooks.auth.methods[0];

    const r1 = await method.authorize({ phone: "13800000000", password: "pw" });
    expect(r1.method).toBeUndefined(); // not a code contract
    expect(typeof r1.callback).toBe("function");

    // The host's move: callback() with no argument → success auth.
    const auth = await r1.callback();
    expect(auth.type).toBe("success");
    expect(auth.accountId).toBe("2652042633");
    expect(auth.ph).toBe("ph9");
    expect(auth.cookie).toContain("serviceToken=stok");
    expect(auth.userId).toBe("2652042633");
    expect(auth.passToken).toBe("ptok2");
    expect(auth.metadata).toEqual({ phone: "13800000000", password: "pw" });
  });

  test("OTP demand: authorize returns the code contract, callback(code) completes", async () => {
    const { server, sentCodes } = mockUpstream();
    const saved = [];
    const hooks = await pluginFor(server.port, saved);
    const method = hooks.auth.methods[0];

    // Stage 1: password triggers the new-device demand → code contract, NOT saved.
    const r1 = await method.authorize({ phone: "13800000000", password: "pw" });
    expect(r1.type).toBeUndefined(); // not a terminal result
    expect(r1.method).toBe("code");
    expect(typeof r1.callback).toBe("function");
    expect(r1.instructions).toContain("+86 182******16");
    expect(sentCodes()).toBe(1); // the code was dispatched
    expect(saved).toHaveLength(0);

    // Stage 2: user pastes the received code → success with full session.
    const r2 = await r1.callback("123456");
    expect(r2.type).toBe("success");
    expect(r2.accountId).toBe("2652042633");
    expect(r2.ph).toBe("ph9");
    expect(r2.cookie).toContain("serviceToken=stok");
    expect(r2.userId).toBe("2652042633");
    expect(r2.passToken).toBe("ptok2");
    expect(r2.metadata).toEqual({ phone: "13800000000", password: "pw" });
  });

  test("wrong code → callback returns failed with the upstream's own reason", async () => {
    const bad = mockUpstream({ wrongCode: true });
    const hooks = await pluginFor(bad.server.port, []);
    const b1 = await hooks.auth.methods[0].authorize({ phone: "13800000000", password: "pw" });
    const b2 = await b1.callback("123456");
    expect(b2.type).toBe("failed");
    expect(b2.error).toContain("bad code");
  });

  test("empty code input → failed with a clear reason", async () => {
    const { server } = mockUpstream();
    const hooks = await pluginFor(server.port, []);
    const r1 = await hooks.auth.methods[0].authorize({ phone: "13800000000", password: "pw" });
    const r2 = await r1.callback("   ");
    expect(r2.type).toBe("failed");
    expect(r2.error).toContain("验证码");
  });

  test("missing prompts → authorize throws (the host shows the message)", async () => {
    const hooks = await pluginFor(1, []);
    expect(hooks.auth.methods[0].authorize({})).rejects.toThrow(/phone and password/);
  });
});
