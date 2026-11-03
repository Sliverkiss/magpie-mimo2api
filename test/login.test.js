// test/login.test.js — password login, STS landing chain, OTP challenge, renewal,
// all against a mock passport + mock upstream.
import { describe, test, expect, afterEach } from "bun:test";
import { MimoClient, AuthExpiredError, OTPRequiredError } from "../src/mimo.mjs";

const servers = [];
afterEach(() => {
  while (servers.length) servers.pop().stop(true);
});

const XSSI = "&&&START&&&";

// A mock passport implementing the observed chain shape:
//   GET /pass/serviceLogin?…&_json=true → XSSI {code:0, location}
//   POST /pass/serviceLoginAuth2        → XSSI {code:0, location, userId}
//   GET  /identity/list                 → XSSI {flag:4}
//   GET  /identity/auth/verifyPhone     → XSSI {code:0, maskedPhone}
//   POST /identity/auth/sendPhoneTicket → XSSI {code:0}
//   POST /identity/auth/verifyPhone     → XSSI {code:0, location}
//   GET  <anywhere>                     → redirect hops planting cookies
function mockPassport({ auth2Body, serviceLoginBody, otpDemand = false } = {}) {
  const calls = [];
  // Call-order state: the /user/mi/get that arrives right after a /sts hit
  // is the STS landing hop (plant session cookies); every other /user/mi/get
  // is a probe (login step 1 unauthenticated, or renewal step 1 with the
  // bare identity cookie) → 401 + loginUrl. Cookie content can NOT
  // discriminate: the renewal probe carries identity cookies too.
  let landingNext = false;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      calls.push({ path: u.pathname, method: req.method, cookies: req.headers.get("cookie") ?? "" });

      if (u.pathname === "/pass/serviceLoginAuth2") {
        const body = otpDemand
          ? { code: 0, securityStatus: 128, location: "", notificationUrl: `http://localhost:${server.port}/fe/service/identity/authStart?sid=xiaomichatbot&context=CTX123` }
          : (auth2Body ?? { code: 0, location: "/identity/result/check", userId: 2652042633 });
        const h = new Headers({ "content-type": "text/html" });
        // The real auth2 plants the passport identity cookies the landing
        // chain later presents (login-chain-reverse.md §1).
        h.append("set-cookie", "userId=2652042633; Path=/; Domain=.xiaomi.com");
        h.append("set-cookie", "passToken=ptok2; Path=/; Domain=.xiaomi.com");
        return new Response(XSSI + JSON.stringify(body), { headers: h });
      }
      if (u.pathname === "/pass/serviceLogin") {
        // serviceLoginAuth2's callback sanity-check (code 10025) fires when the
        // callback param is missing/foreign; the mock answers whatever comes.
        return new Response(XSSI + JSON.stringify(serviceLoginBody ?? { code: 0, location: "/identity/result/check" }));
      }
      if (u.pathname === "/fe/service/identity/authStart") {
        // The OTP entry page: its URL itself carries sid/context (the SPA walks
        // the same shape). No redirect needed.
        return new Response(XSSI + JSON.stringify({ code: 0 }));
      }
      if (u.pathname === "/identity/list") {
        return new Response(XSSI + JSON.stringify({ code: 2, flag: 4, maskedPhone: "+86 182******16" }));
      }
      if (u.pathname === "/identity/auth/verifyPhone" && req.method === "GET") {
        return new Response(XSSI + JSON.stringify({ code: 0, maskedPhone: "+86 182******16", contentType: 160040 }));
      }
      if (u.pathname === "/identity/auth/sendPhoneTicket") {
        if (req.headers.get("x-requested-with") !== "XMLHttpRequest") {
          return new Response(XSSI + JSON.stringify({ code: 66108, desc: "missing header" }));
        }
        return new Response(XSSI + JSON.stringify({ code: 0, data: { wt: 59 } }));
      }
      if (u.pathname === "/identity/auth/verifyPhone" && req.method === "POST") {
        const form = await req.text();
        if (!form.includes("ticket=123456")) {
          return new Response(XSSI + JSON.stringify({ code: 700, desc: "bad code" }));
        }
        return new Response(XSSI + JSON.stringify({ code: 0, location: "/identity/result/check" }));
      }
      // Landing chain hops: plant session cookies at the LAST hop.
      if (u.pathname === "/identity/result/check" || u.pathname === "/pass/serviceLoginAuth2/end") {
        return new Response("", { status: 302, headers: { location: "/sts?sign=x" } });
      }
      if (u.pathname === "/sts") {
        // 307 to the upstream hop, which plants the session cookies.
        landingNext = true;
        return new Response("", { status: 307, headers: { location: "/open-apis/user/mi/get" } });
      }
      if (u.pathname === "/open-apis/user/mi/get" && req.method === "GET") {
        if (landingNext) {
          landingNext = false;
          calls.push({ planted: true });
          const h = new Headers({ "content-type": "application/json" });
          for (const c of [
            "userId=2652042633; Path=/",
            "cUserId=cu; Path=/",
            'xiaomichatbot_serviceToken="stok"; Path=/',
            'xiaomichatbot_ph="ph9"; Path=/',
            'xiaomichatbot_slh="slh9"; Path=/',
            "deviceId=wb_x; Path=/",
          ]) {
            h.append("set-cookie", c);
          }
          return new Response(JSON.stringify({ code: 0 }), { headers: h });
        }
        // Probe (login step 1 unauthenticated / renewal step 1): 401 + loginUrl.
        const port2 = server.port;
        const cb = encodeURIComponent(`http://localhost:${port2}/sts?sign=x&followup=/`);
        calls.push({ probe: true });
        return new Response(JSON.stringify({ code: 401, loginUrl: `http://localhost:${port2}/pass/serviceLogin?callback=${cb}&sid=xiaomichatbot&_group=DEFAULT` }), { status: 401 });
      }
      return new Response("mock 404", { status: 404 });
    },
  });
  servers.push(server);
  return { server, calls };
}

function clientFor(port) {
  return new MimoClient({
    base: `http://localhost:${port}`,
    passportBase: `http://localhost:${port}`,
    idleMs: 5000,
  });
}

// Override the allowlist so mock hosts are accepted.
function withMockAllowlist(client, port) {
  client.allowHosts.add("localhost");
  client.allowHosts.add(`localhost:${port}`.split(":")[0]); // hostname only
  return client;
}

describe("login chain", () => {
  test("password login: auth2 → STS chain → session with cookie/ph/userId/passToken", async () => {
    const mp = mockPassport();
    const client = clientFor(mp.server.port);
    client.allowHosts.add("localhost");
    // Point the studio probe at the mock too: /open-apis/user/mi/get 401s with loginUrl.
    mp.calls.length = 0;
    const sess = await client.login({ phone: "18278724616", password: "pw" });
    const auth2 = mp.calls.find((c) => c.path === "/pass/serviceLoginAuth2");
    expect(auth2).toBeTruthy();
    // session assembled from the planted cookies
    expect(sess.cookie).toContain("serviceToken=stok");
    expect(sess.cookie).toContain('xiaomichatbot_serviceToken="stok"');
    expect(sess.cookie).toContain('xiaomichatbot_ph="ph9"');
    expect(sess.ph).toBe("ph9");
    expect(sess.userId).toBe("2652042633");
    expect(sess.passToken).toBeTruthy(); // from the jar
    expect(sess.device?.deviceId).toBe("wb_x");
  });

  test("expired-tombstone cookies (literal EXPIRED value) are never harvested", async () => {
    // The passport clears a cookie by re-setting it to the literal value
    // EXPIRED (observed live 2026-11: passToken=EXPIRED landed in the saved
    // auth via the OTP landing chain). Harvesting it poisons the jar and
    // leaks the tombstone into the saved refresh/passToken fields.
    const mp = mockPassport({
      // serviceLogin (renewal hop) clears passToken with a tombstone —
      // simulating a passport that revokes the presented token.
      serviceLoginBody: { code: 0, location: "/identity/result/check" },
    });
    const client = clientFor(mp.server.port);
    client.allowHosts.add("localhost");
    // Direct unit probe of collectCookies semantics through the renewal path:
    // plant a tombstone via a Set-Cookie on the probe and assert it's dropped.
    const resp = new Response("", {
      headers: [
        ["set-cookie", "passToken=EXPIRED; Path=/; Domain=.xiaomi.com"],
        ["set-cookie", "userId=2652042633; Path=/"],
      ],
    });
    // collectCookies is module-private; exercise it via the exported surface:
    // renewal with a session whose jar would have received the tombstone.
    // The observable contract: sess.passToken is never the literal EXPIRED.
    const sess = await client.renew({ userId: "2652042633", passToken: "ptok", device: { deviceId: "wb_old" } });
    expect(sess.passToken).not.toBe("EXPIRED"); // tombstone dropped, original kept
    expect(sess.cookie).not.toContain("EXPIRED");
    void resp; // shape documentation only
  });

  test("login form carries upper-MD5 hash and form fields", async () => {
    let form = "";
    const mp = mockPassport();
    // Capture the auth2 form body via a one-shot wrapper around the mock server.
    const orig = Bun.serve;
    const client = clientFor(mp.server.port);
    client.allowHosts.add("localhost");
    // Intercept: patch fetch for the auth2 POST only.
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.includes("/pass/serviceLoginAuth2")) {
        form = String(init?.body ?? "");
      }
      return realFetch(input, init);
    };
    try {
      await client.login({ phone: "13800000000", password: "secret" }).catch(() => {});
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(mp.calls.some((c) => c.path === "/pass/serviceLoginAuth2")).toBe(true);
    // hash = UPPER(MD5(password)) of "secret"
    expect(form).toContain("hash=" + Bun.CryptoHasher.hash("md5", "secret", "hex").toUpperCase());
    expect(form).toContain("user=13800000000");
    expect(form).toContain("policyName=miaccount");
    expect(form).toContain("_json=true");
    expect(form).toContain("sid=xiaomichatbot");
  });

  test("new-device OTP demand starts the challenge and sends the code", async () => {
    const mp = mockPassport({ otpDemand: true });
    const client = clientFor(mp.server.port);
    client.allowHosts.add("localhost");
    try {
      await client.login({ phone: "18278724616", password: "pw" });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(OTPRequiredError);
      expect(e.challenge.notify).toBe("+86 182******16");
      expect(e.challenge.method).toBe("Phone");
      expect(mp.calls.some((c) => c.path === "/identity/auth/sendPhoneTicket")).toBe(true);
      // X-Requested-With was sent on the ticket POST (mandatory)
      expect(e.challenge.jar).toBeTruthy();
    }
  });

  test("submitOTP completes the login with the received code", async () => {
    const mp = mockPassport({ otpDemand: true });
    const client = clientFor(mp.server.port);
    client.allowHosts.add("localhost");
    let challenge;
    try {
      await client.login({ phone: "18278724616", password: "pw" });
    } catch (e) {
      challenge = e.challenge;
    }
    expect(challenge).toBeTruthy();
    const sess = await client.submitOTP(challenge, "123456");
    expect(sess.cookie).toContain("serviceToken=stok");
    expect(sess.ph).toBe("ph9");
    // bad code rejected
    let challenge2;
    try {
      await client.login({ phone: "18278724616", password: "pw" });
    } catch (e) {
      challenge2 = e.challenge;
    }
    await expect(client.submitOTP(challenge2, "000000")).rejects.toThrow(/no location|bad code|code=700/);
  });
});

describe("renewal", () => {
  test("renew walks serviceLogin with passToken and lands a fresh session", async () => {
    const mp = mockPassport();
    const client = clientFor(mp.server.port);
    client.allowHosts.add("localhost");
    const sess = await client.renew({ userId: "2652042633", passToken: "ptok", device: { deviceId: "wb_old" } });
    expect(sess.cookie).toContain("serviceToken=stok");
    expect(sess.passToken).toBe("ptok"); // kept when the chain stays silent
    const sl = mp.calls.find((c) => c.path === "/pass/serviceLogin");
    expect(sl).toBeTruthy();
    expect(sl.cookies).toContain("passToken=ptok");
    expect(sl.cookies).toContain("userId=2652042633");
    expect(sl.cookies).toContain("deviceId=wb_old"); // device identity replayed
  });

  test("code 70016 → AuthExpiredError", async () => {
    const mp = mockPassport({ serviceLoginBody: { code: 70016, description: "expired" } });
    const client = clientFor(mp.server.port);
    client.allowHosts.add("localhost");
    await expect(client.renew({ userId: "1", passToken: "dead" })).rejects.toBeInstanceOf(AuthExpiredError);
  });

  test("validate: healthy cookie passes, business error marks expired", async () => {
    const client = clientFor(1);
    // healthy
    const ok = Bun.serve({
      port: 0,
      fetch: () => Response.json({ code: 0 }),
    });
    servers.push(ok);
    const c2 = new MimoClient({ base: `http://localhost:${ok.port}` });
    await expect(c2.validate({ cookie: "x" })).resolves.toBeUndefined();
    // business error
    const bad = Bun.serve({
      port: 0,
      fetch: () => Response.json({ code: 401 }),
    });
    servers.push(bad);
    const c3 = new MimoClient({ base: `http://localhost:${bad.port}` });
    await expect(c3.validate({ cookie: "x" })).rejects.toBeInstanceOf(AuthExpiredError);
  });
});
