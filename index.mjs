// index.mjs — magpie plugin: Xiaomi MiMo Studio web reverse proxy.
//
// Turn a MiMo Studio account into a magpie provider: password login (with
// new-device SMS/email verification), Upstash/Redis account import, session
// renewal, the account's own model catalog, OpenAI Chat Completions over the
// live react/fastchat channels, thinking, image understanding, web-search
// citations, and quota windows.
//
// Session shape (stored per account by magpie, plugin-auth.json):
//   { type: "oauth",                          ← the oauth method saves here
//     access, refresh, expires,               ← compatibility fields
//     cookie, ph, userId, passToken, device,  ← the real session material
//     catalog, fetchedAt }
// The loader always reads `cookie`/`ph`; `access` mirrors `cookie` so the
// account stays legible in magpie's UI.

import { MimoClient, AuthExpiredError, mergeDevice, truncateForLog, DEFAULT_MODEL } from "./src/mimo.mjs";
import { handleChatCompletion, errorStatus, GatewayError } from "./src/gateway.mjs";
import { searchMimo } from "./src/search.mjs";

const PROVIDER = "mimo";
const UPSTREAM = "https://aistudio.xiaomimimo.com";
const BASE = UPSTREAM; // loader baseURL: chat completions arrive here

const CATALOG_TTL_MS = 6 * 60 * 60 * 1000; // re-learn a catalog after 6 h
const SESSION_REFRESH_LEAD_MS = 30 * 60 * 1000; // treat sessions older than 30 min as stale
const REACT_ENABLED_TTL_MS = 30 * 1000;

// Per-account in-memory state. Keyed by a per-account scope key — never by
// provider id — because magpie runs every call inside an account scope.
const state = new Map(); // key → { client, catalog, catalogAt, catalogPromise, refreshPromise }

function scopeKey(auth) {
  return auth?.userId || auth?.accountId || auth?.cookie?.slice(0, 48) || "default";
}

function acctState(auth, client) {
  const key = scopeKey(auth);
  let s = state.get(key);
  if (!s) {
    s = { client, catalog: undefined, catalogAt: 0, catalogPromise: null, refreshPromise: null, lastSession: null };
    state.set(key, s);
  }
  if (client && !s.client) s.client = client;
  return s;
}

function makeClient(opts = {}) {
  return new MimoClient({
    // Test-only overrides (never set by magpie): point the client at a mock
    // upstream/passport so the login chain can be exercised end-to-end.
    ...(opts._upstreamBase ? { base: opts._upstreamBase } : {}),
    ...(opts._passportBase ? { passportBase: opts._passportBase } : {}),
  });
}

// ---------------------------------------------------------------------------
// session material helpers
// ---------------------------------------------------------------------------

function sessionOf(auth) {
  // The oauth method saves { access, refresh, expires, cookie, ph, ... }.
  // An api-type key (manual paste of a full cookie) is also accepted.
  const cookie = auth?.cookie || (auth?.type === "api" && auth?.key?.startsWith("cUserId=") ? auth.key : "");
  const ph = auth?.ph || "";
  if (!cookie) return null;
  return {
    cookie,
    ph,
    userId: auth?.userId || "",
    passToken: auth?.passToken || "",
    device: auth?.device || undefined,
  };
}

/** Saved auth object updated with a fresh session (full replace semantics). */
function authWithSession(prev, sess, { keepExpires = false } = {}) {
  const next = {
    ...prev,
    cookie: sess.cookie,
    ph: sess.ph ?? "",
    userId: sess.userId ?? prev?.userId ?? "",
    passToken: sess.passToken ?? "",
    device: mergeDevice(prev?.device, sess.device),
    // mirror into the OAuth-shaped fields magpie knows how to display/renew
    access: sess.cookie,
    refresh: sess.passToken ?? prev?.refresh ?? "",
    expires: keepExpires ? prev?.expires : 0, // 0 = no automatic OAuth refresh; renewal is freshness-driven
    fetchedAt: Date.now(),
  };
  delete next.error;
  return next;
}

async function saveAuth(opencodeClient, auth, patch) {
  try {
    await opencodeClient.auth.set({ path: { id: PROVIDER }, body: patch });
  } catch {}
}

// ---------------------------------------------------------------------------
// catalog
// ---------------------------------------------------------------------------

async function loadCatalog(auth, s, client, { force = false } = {}) {
  const session = auth ? sessionOf(auth) : s.lastSession;
  if (!session) return undefined;
  if (auth) s.lastSession = session;
  const fresh = !force && s.catalog && Date.now() - s.catalogAt < CATALOG_TTL_MS;
  if (fresh) return s.catalog;
  if (s.catalogPromise) return s.catalogPromise; // one fetch at a time
  s.catalogPromise = (async () => {
    try {
      const catalog = await s.client.fetchCatalog(session);
      s.catalog = catalog;
      s.catalogAt = Date.now();
      return catalog;
    } catch (e) {
      if (e instanceof AuthExpiredError) throw e;
      return s.catalog; // degraded: keep whatever we last learned
    } finally {
      s.catalogPromise = null;
    }
  })();
  return s.catalogPromise;
}

// ---------------------------------------------------------------------------
// renewal / freshness
// ---------------------------------------------------------------------------

/**
 * Keep the session working, in order of preference:
 *   1. fresh cookie (fetched recently) → nothing to do
 *   2. renew from userId + passToken (no password involved)
 *   3. password login (phone + password from auth.metadata)
 * Rejects with signIn:"expired" when nothing works — magpie marks the
 * account and stops routing to it until a re-login.
 *
 * Single-flight per account (s.refreshPromise): the request loader's
 * freshness gate and magpie's refresh hook can fire at the same moment;
 * without the shared promise both run the full renew → login chain and the
 * two saveAuth writes race (last-write wins can resurrect a stale cookie).
 * Late joiners await the in-flight renewal and get its session.
 */
async function ensureFreshSession(getAuth, opencodeClient, auth, mimoClient, s) {
  const session = sessionOf(auth);
  if (!session) throw Object.assign(new Error("no session material on the account; sign in again"), { signIn: "expired" });

  const meta = auth?.metadata ?? {};
  const age = Date.now() - (auth?.fetchedAt ?? 0);
  if (auth?.cookie && age < SESSION_REFRESH_LEAD_MS) return session; // fresh enough

  // A renewal is already running for this account → ride along.
  if (s?.refreshPromise) return sessionOf(await s.refreshPromise);

  const doRefresh = (async () => {
    // Try renewal from passToken first (cheap, no password).
    if (auth?.userId && auth?.passToken) {
      try {
        const sess = await mimoClient.renew(session);
        const next = authWithSession(auth, sess);
        await saveAuth(opencodeClient, auth, next);
        Object.assign(auth, next); // the current scope's getAuth() sees it too
        return next;
      } catch {
        // passToken dead (AuthExpiredError) → password login below;
        // other renewal failures → password login below too.
      }
    }

    // Password login as the last resort. The saved device identity is
    // replayed so the platform sees the same hardware as before — a fresh
    // device is what trips the SMS/email verification in the first place.
    if (meta.phone && meta.password) {
      const sess = await mimoClient.login({ phone: meta.phone, password: meta.password, device: auth?.device });
      const next = authWithSession(auth, sess);
      await saveAuth(opencodeClient, auth, next);
      Object.assign(auth, next);
      return next;
    }

    // Nothing renewed; the cookie is stale. Hand back the auth — the
    // upstream's own 401 will tell magpie what happened.
    return auth;
  })();

  if (s) {
    s.refreshPromise = doRefresh;
    doRefresh.finally(() => {
      if (s.refreshPromise === doRefresh) s.refreshPromise = null;
    }).catch(() => {});
  }

  const next = await doRefresh;
  return sessionOf(next) || session;
}

// ---------------------------------------------------------------------------
// the plugin
// ---------------------------------------------------------------------------

// Web reverse proxy: the Studio web client is the upstream conversation — its
// real context ceiling is ~50k tokens, far below the model cards' spec sheet.
const CONTEXT_LIMIT = 50_000;
const OUTPUT_LIMIT = 64_000;

export const Mimo2ApiPlugin = async ({ client }, options) => {
  const shared = makeClient(options);

  return {
    // ---- provider declaration ----
    config: async (cfg) => {
      cfg.provider ??= {};
      cfg.provider[PROVIDER] ??= {
        name: "MiMo Studio",
        npm: "@ai-sdk/openai-compatible", // chat completions
        api: BASE,
        models: {
          [DEFAULT_MODEL]: {
            name: "MiMo v2.6 Pro",
            limit: { context: CONTEXT_LIMIT, output: OUTPUT_LIMIT },
            reasoning: true,
            // The Studio surface searches the web itself when asked to, so
            // magpie hands a search request straight to this model instead of
            // running its own search first. Without this flag the model is
            // silently kept off the search path and answers from memory.
            searches: true,
            tool_call: false,
            free: true,
            // Image understanding: the plugin takes image_url parts, uploads
            // them (resource/genUploadInfo), parses them (resource/parse) and
            // rides the handle on multiMedias — see src/mimo.mjs. Said here,
            // because a config-hook model that names no modality is not
            // "text only", it is "the vendor never spoke": magpie falls back
            // to voting models.dev by bare model id, and the same model under
            // a text-only vendor silently loses the capability — screenshots
            // go straight upstream and are refused.
            attachment: true,
            modalities: { input: ["text", "image"], output: ["text"] },
            // The upstream exposes thinking as a boolean only — every effort
            // level maps to "thinking on"; none/off turns it off.
            variants: { none: {}, low: {}, medium: {}, high: {} },
          },
          "mimo-v2.6-flash": {
            name: "MiMo v2.6 Flash",
            limit: { context: CONTEXT_LIMIT, output: OUTPUT_LIMIT },
            reasoning: true,
            searches: true,
            tool_call: false,
            free: true,
            // Same as Pro: image parts are uploaded and parsed upstream.
            attachment: true,
            modalities: { input: ["text", "image"], output: ["text"] },
            variants: { none: {}, low: {}, medium: {}, high: {} },
          },
        },
      };
    },

    // ---- login ----
    auth: {
      provider: PROVIDER,
      icon: undefined, // package.json magpie.icon already covers the plugin

      methods: [
        // 手机号 + 密码；风控触发（新设备短信/邮箱验证）时进入验证码两段式：
        // authorize 返回 method:"code" 契约，magpie 展示提示并让用户贴码，
        // callback(code) 完成登录。
        {
          type: "oauth",
          label: "手机号 + 密码登录 / Phone & password",
          prompts: [
            { type: "text", key: "phone", message: "手机号 / Phone number", placeholder: "1xxxxxxxxxx" },
            { type: "password", key: "password", message: "密码 / Password" },
          ],
          // magpie 宿主的契约（反编译确认）：authorize 的返回值一律被存入
          // 会话，之后宿主自己调用 a.callback() —— 终态（success/failed）
          // 只能由 callback 的返回值表达；authorize 阶段的失败必须 throw。
          // 风控两段式：authorize 返回 { instructions, method: "code",
          // callback(code) }，宿主展示 instructions 并让用户贴码。
          async authorize(inputs) {
            if (!inputs?.phone || !inputs?.password) {
              throw new Error("手机号和密码都需要填写 / phone and password are required");
            }
            try {
              const auth = await finishPasswordLogin({ phone: inputs.phone, password: inputs.password });
              return {
                async callback() {
                  return auth; // { type: "success", ... } — save() 认这个形状
                },
              };
            } catch (e) {
              if (e?.name === "OTPRequiredError" && e.challenge) {
                // 风控：验证码已发往绑定手机/邮箱。走 code 契约：
                // 用户输入收到的验证码 → callback(code) 完成登录。
                const { challenge } = e;
                return {
                  instructions:
                    `新设备验证：验证码已发送到 ${challenge.notify || "绑定手机/邮箱"}（10 分钟内有效）。` +
                    `请输入收到的验证码。`,
                  method: "code",
                  async callback(code) {
                    if (!code || !String(code).trim()) {
                      return { type: "failed", error: "请输入收到的验证码" };
                    }
                    try {
                      return await finishPasswordLogin(
                        { phone: inputs.phone, password: inputs.password },
                        { challenge, code: String(code).trim() },
                      );
                    } catch (err) {
                      return { type: "failed", error: truncateForLog(err.message, 500) };
                    }
                  },
                };
              }
              // 密码错误、网络失败等：throw，宿主会把原话展示给用户。
              throw new Error(truncateForLog(e.message, 500));
            }
          },
        },
      ],

      // ---- per-request loader ----
      async loader(getAuth) {
        const auth = await getAuth();
        const session = sessionOf(auth);
        if (!session) return {}; // no session → magpie's standard handling

        const s = acctState(auth, shared);
        const c = s.client;

        // Keep the catalog warm in the background; never block the request.
        loadCatalog(auth, s, c).catch(() => {});

        return {
          baseURL: BASE,
          // magpie 只会把 @ai-sdk/openai-compatible 构造的 chat completions
          // 请求发进这个 fetch（POST {baseURL}/chat/completions，字符串 body）；
          // 模型列表由 provider.models 钩子供出、/v1/models 由 magpie 网关自己
          // 应答——插件不开任何端口，也不需要处理其他路径。
          async fetch(input, init) {
            let body;
            try {
              body = JSON.parse(String(init?.body ?? "{}"));
            } catch {
              return openaiBadRequest("request body is not valid JSON");
            }

            // Freshness gate: renew/re-login before the upstream sees a dead cookie.
            let fresh;
            try {
              fresh = await ensureFreshSession(getAuth, client, auth, c, s);
            } catch (e) {
              if (e?.signIn === "expired") throw e;
              fresh = sessionOf(auth); // renewal infrastructure failed; let the request try the stale cookie
            }

            try {
              return await handleChatCompletion(c, fresh, s, body, { signal: init?.signal });
            } catch (err) {
              if (err instanceof GatewayError) return err.toResponse();
              const status = errorStatus(err);
              if (err instanceof AuthExpiredError) {
                throw Object.assign(new Error(`MiMo Studio refused the sign-in; sign in again (${err.message})`), {
                  signIn: "expired",
                });
              }
              return new Response(
                JSON.stringify({ error: { message: err.message, type: "upstream_error", code: status } }),
                { status, headers: { "content-type": "application/json" } },
              );
            }
          },
        };
      },

      // ---- quota ----
      async usage(getAuth) {
        const auth = await getAuth();
        const session = sessionOf(auth);
        if (!session) return { error: "未登录", windows: [] };
        const s = acctState(auth, shared);
        try {
          // Session health doubles as the quota read: the Studio surface has
          // no numeric plan endpoint, so we report freshness + catalog.
          // A stale-but-renewable session gets one renewal attempt first
          // (single-flight; rides along if a renewal is already running) —
          // otherwise usage() reports "expired" for accounts the next chat
          // request would have silently healed.
          try {
            await s.client.validate(session);
          } catch (e) {
            if (e instanceof AuthExpiredError && (auth?.userId || auth?.passToken) && !s.refreshPromise) {
              const next = await ensureFreshSession(getAuth, client, auth, s.client, s);
              await s.client.validate(next);
            } else {
              throw e;
            }
          }
          const catalog = await loadCatalog(auth, s, s.client, { force: !s.catalog });
          const modelCount = catalog?.models?.length ?? 0;
          return {
            plan: "MiMo Studio",
            user: auth?.userId || undefined,
            windows: [
              {
                name: "会话状态",
                used: 0,
                display: `${modelCount} 个模型 · 会话有效`,
                span: 24 * 3600,
                aside: true,
              },
            ],
          };
        } catch (e) {
          if (e instanceof AuthExpiredError) {
            // Unrevivable account: drop its in-memory state (client/catalog/
            // promises) so a logged-out or replaced account does not leak its
            // entry forever — acctState() rebuilds it on the next request.
            state.delete(scopeKey(auth));
            return { error: "登录已过期，请重新登录", windows: [], signIn: "expired" };
          }
          return { error: truncateForLog(e.message, 200), windows: [] };
        }
      },

      // ---- token renewal (magpie-owned hook; OpenCode ignores it) ----
      refreshLead: 30 * 60 * 1000,
      async refresh(auth) {
        const session = sessionOf(auth);
        if (!session) return; // nothing to renew
        if (!auth?.userId || !auth?.passToken) return; // cookie-only account: nothing cheap to do
        // Same single-flight chain as the loader's freshness gate: shared
        // refreshPromise per account, no renew/login storm, no racing
        // saveAuth writes. AuthExpiredError propagates → magpie marks the
        // account.
        const s = acctState(auth, shared);
        await ensureFreshSession(() => Promise.resolve(auth), client, auth, shared, s);
      },
    },

    // ---- per-account models ----
    provider: {
      id: PROVIDER,
      async models(provider, { auth } = {}) {
        const session = sessionOf(auth);
        if (!session) return provider.models;
        const s = acctState(auth, shared);
        try {
          const catalog = await loadCatalog(auth, s, s.client, { force: !s.catalog });
          if (!catalog?.models?.length) {
            if (s.catalog) return listFromCatalog(s.catalog, provider);
            return provider.models; // request failed → magpie keeps the original list
          }
          return listFromCatalog(catalog, provider);
        } catch (e) {
          if (e instanceof AuthExpiredError) {
            state.delete(scopeKey(auth)); // leak guard, same as usage()
            throw Object.assign(new Error("MiMo Studio session expired; sign in again"), { signIn: "expired" });
          }
          return provider.models;
        }
      },
    },

    // ---- web search API ----
    // Adds "MiMo Studio" to magpie's search API list next to Tavily and
    // Brave. The entry carries no key of its own: `auth` binds it to this
    // plugin's signed-in accounts, so magpie picks one that is on, renews it
    // first if it is due, and hands it over through ctx.getAuth(). That is
    // also why the search shares the account's own in-memory state — a search
    // and a chat on the same account must not race two renewals.
    search: {
      [PROVIDER]: {
        name: "MiMo Studio 联网搜索 / Web search",
        auth: PROVIDER,
        async execute({ query, count }, ctx) {
          const auth = await ctx?.getAuth?.();
          const s = acctState(auth, shared);
          try {
            // Same freshness gate as the loader: a due renewal runs before the
            // search's own clock, exactly as it would for a chat request.
            const session = await ensureFreshSession(ctx?.getAuth, client, auth, shared, s);
            return await searchMimo({ query, count }, { client: shared, session, signal: ctx?.abort });
          } catch (e) {
            // Same leak guard as usage()/models(): an account magpie can no
            // longer route to must not keep its client and catalog alive.
            if (e instanceof AuthExpiredError || e?.signIn === "expired") state.delete(scopeKey(auth));
            throw e; // the search path never swallows — magpie shows the reason
          }
        },
      },
    },
  };

  // ---------------------------------------------------------------------------

  /** Shared tail of the password logins: run the chain, save the account.
   *  completion: { challenge, code } — finish a pending new-device
   *  verification via submitOTP instead of starting a fresh login. */
  async function finishPasswordLogin(account, completion) {
    const sess = completion?.challenge
      ? await shared.submitOTP(completion.challenge, completion.code)
      : await shared.login(account);
    const auth = {
      type: "success",
      refresh: sess.passToken ?? "",
      access: sess.cookie,
      expires: 0,
      accountId: sess.userId || undefined,
      cookie: sess.cookie,
      ph: sess.ph ?? "",
      userId: sess.userId ?? "",
      passToken: sess.passToken ?? "",
      device: sess.device,
      // keep the credentials for transparent re-login on the account
      metadata: { phone: account.phone ?? "", password: account.password ?? "" },
      fetchedAt: Date.now(),
    };
    // Warm the catalog so magpie shows the account's real models right away.
    try {
      const s = acctState(auth, shared);
      await loadCatalog(auth, s, shared, { force: true });
    } catch {}
    return auth;
  }
};

function listFromCatalog(catalog, provider) {
  const out = {};
  for (const m of catalog.models) {
    if (m.pageType && m.pageType !== "chat") continue; // TTS/ASR rows are not chat models
    const base = provider.models[m.id] ?? {};
    out[m.id] = {
      ...base,
      id: m.id,
      name: m.name || m.id,
      limit: {
        context: parseNToken(m.nToken) ?? base.limit?.context ?? CONTEXT_LIMIT,
        output: base.limit?.output ?? OUTPUT_LIMIT,
      },
      reasoning: true,
      searches: true,
      tool_call: false,
      free: true,
      // Same declaration as the static entries, repeated here because the
      // catalog carries rows that have no static counterpart — the upstream
      // adds models under us, and a row that reaches magpie saying nothing of
      // its modalities is read as "the vendor never spoke", not "text only".
      // A static entry's own word wins where it has one.
      attachment: base.attachment ?? true,
      modalities: base.modalities ?? { input: ["text", "image"], output: ["text"] },
      variants: base.variants ?? { none: {}, low: {}, medium: {}, high: {} },
    };
  }
  return Object.keys(out).length ? out : provider.models;
}

function parseNToken(nToken) {
  if (typeof nToken !== "string") return undefined;
  const m = nToken.match(/^([\d.]+)\s*([MmKk]?)/);
  if (!m) return undefined;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return undefined;
  const unit = m[2].toUpperCase();
  const mult = unit === "M" ? 1_000_000 : unit === "K" ? 1000 : 1;
  return Math.round(n * mult);
}

function openaiBadRequest(message) {
  return new Response(JSON.stringify({ error: { message, type: "invalid_request_error", code: 400 } }), {
    status: 400,
    headers: { "content-type": "application/json" },
  });
}

// Test seam only. The host collects plugin functions by scanning the module's
// exports for functions (`servers()` in the plugin host), so a plain object
// here is invisible to it — no test-only hook ever reaches magpie.
export const _internal = { searchMimo, listFromCatalog };

