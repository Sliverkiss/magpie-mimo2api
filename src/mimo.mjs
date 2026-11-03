// src/mimo.mjs — upstream Xiaomi MiMo AI Studio client.
//
// Reverse-engineered from the live Studio SPA; protocol notes follow
// Sliverkiss/0xCost (mimo2api branch) docs. Everything here is transport:
// login chain, token renewal, chat over the two live channels, SSE parsing,
// the model catalog, and the attachment surface.
//
// Identity model (matches the web client):
//   - upstream calls authenticate with a Cookie header plus the
//     xiaomichatbot_ph value as a QUERY PARAMETER on every POST.
//   - passport/SSO calls authenticate with their own jar, walked manually so
//     every Set-Cookie lands in the jar instead of the transport.

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

export const UPSTREAM_BASE = "https://aistudio.xiaomimimo.com";
export const PASSPORT_HOST = "account.xiaomi.com";
export const SID = "xiaomichatbot";

const XSSI = "&&&START&&&";

// A browser UA; must stay consistent with sec-ch-ua (risk control).
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";
const SEC_CH_UA = `"Google Chrome";v="153", "Chromium";v="153", "Not)A;Brand";v="24"`;

// Accept headers captured from the live front end. The chat surface is
// fetch-based: Accept */*, no X-Requested-With, no Authorization.
const ACCEPT_FETCH = "*/*";
const ACCEPT_HTML =
  "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7";
const ACCEPT_JSON = "application/json, text/plain, */*";

// Passport device-identity cookies, harvested on login and replayed on every
// later login/renewal so the platform sees the same device, not new hardware.
const DEVICE_COOKIE_NAMES = ["deviceId", "pass_ua", "uLocale", "cUserId", "sdkVersion"];

const MAX_CHAIN_HOPS = 8;
const OTP_TTL_MS = 10 * 60 * 1000; // a code is valid ~10 minutes
const CHAT_IDLE_MS = 180_000; // no-SSE-event watchdog
const PARSE_ATTEMPTS = 3;

// The two live chat surfaces. The unprefixed v2 /open-apis/bot/chat is
// 451-blocked on current deployments and is not sent by this client.
const CHAT_PATH_REACT = "/open-apis/react/chat"; // v3, every non-ultraspeed model
const CHAT_PATH_FASTCHAT = "/fastchat/open-apis/bot/chat"; // v2 payload, ultraspeed only

export const DEFAULT_MODEL = "mimo-v2.6-pro";

// ---------------------------------------------------------------------------
// small utilities
// ---------------------------------------------------------------------------

export function randomHex32() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export function isFastchatModel(model) {
  return /ultraspeed/i.test(model);
}

function md5Upper(s) {
  return createHash("md5").update(s).digest("hex").toUpperCase();
}

function md5Hex(s) {
  return createHash("md5").update(s).digest("hex");
}

function unquoteCookie(v) {
  v = String(v ?? "").trim();
  while (v.length >= 2 && v[0] === '"' && v[v.length - 1] === '"') {
    v = v.slice(1, -1);
  }
  return v;
}

/** Strip the XSSI prefix and JSON-parse; both loose (no prefix) and strict dialects are accepted. */
export function parseLooseJSON(text) {
  let s = String(text ?? "").trim();
  if (s.startsWith(XSSI)) s = s.slice(XSSI.length).trim();
  return JSON.parse(s);
}

/** Strict XSSI parse for passport JSON: garbage before the prefix is rejected. */
function parseXSSI(text) {
  const s = String(text ?? "");
  const i = s.indexOf(XSSI);
  if (i < 0) throw new Error(`passport response missing ${XSSI} prefix: ${s.slice(0, 120)}`);
  if (s.slice(0, i).trim() !== "") throw new Error(`garbage before ${XSSI} prefix`);
  return JSON.parse(s.slice(i + XSSI.length));
}

/** Pass through JSON string/number as a token string (userId arrives as a number). */
function scalarString(v) {
  if (typeof v === "string") return v;
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(v);
  return "";
}

/** Deep-scan a JSON tree for passToken/userId (case-insensitive keys).
 *  Tombstone values (the passport's literal "EXPIRED" marker) are skipped. */
function findTokens(root) {
  let passToken = "";
  let userID = "";
  const walk = (v) => {
    if (Array.isArray(v)) {
      for (const x of v) walk(x);
      return;
    }
    if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        const s = scalarString(x);
        if (s && s !== "EXPIRED") {
          const lk = k.toLowerCase();
          if (lk === "passtoken" && !passToken) passToken = s;
          if (lk === "userid" && !userID) userID = s;
        }
        walk(x);
      }
    }
  };
  walk(root);
  return [passToken, userID];
}

/** The reference rule: fail when code is present and is neither -1 nor 0. */
function codeCheck(m, what) {
  if (!m) return;
  if (typeof m.code === "number" && m.code !== -1 && m.code !== 0) {
    throw new Error(`${what} failed: code=${m.code} ${m.desc || m.description || ""}`.trimEnd());
  }
}

function absURL(base, ref) {
  if (!ref) return "";
  if (/^https?:\/\//.test(ref)) return ref;
  try {
    return new URL(ref, base).toString();
  } catch {
    return ref;
  }
}

/** Set-Cookie headers → name→value map. Expired-tombstone cookies (the
 *  passport clears a cookie by re-setting it to the literal value EXPIRED)
 *  are dropped, not harvested — replaying a dead passToken back would both
 *  poison the jar and leak "EXPIRED" into the saved auth. */
function collectCookies(resp) {
  const out = {};
  const raw = typeof resp.headers?.getSetCookie === "function" ? resp.headers.getSetCookie() : [];
  const list = raw.length ? raw : resp.headers?.get("set-cookie") ? [resp.headers.get("set-cookie")] : [];
  for (const sc of list) {
    const head = sc.split(";")[0] ?? "";
    const eq = head.indexOf("=");
    if (eq <= 0) continue;
    const name = head.slice(0, eq).trim();
    const val = head.slice(eq + 1).trim();
    if (!val || val === '""' || val === "EXPIRED") continue;
    out[name] = val;
  }
  return out;
}

/** Sorted jar → Cookie header (order is irrelevant to the server, determinism is nice for tests). */
function cookieHeader(jar) {
  return Object.keys(jar)
    .sort()
    .map((k) => `${k}=${jar[k]}`)
    .join("; ");
}

function mergeJars(a, b) {
  return Object.assign({}, a ?? {}, b ?? {});
}

function harvestDevice(jar) {
  const out = {};
  for (const k of DEVICE_COOKIE_NAMES) {
    if (jar[k]) out[k] = jar[k];
  }
  return Object.keys(out).length ? out : undefined;
}

function seedDeviceJar(device) {
  return Object.assign({}, device ?? {});
}

/** Merge a freshly harvested device identity over the stored one; fresh wins, stored survives silence. */
export function mergeDevice(stored, fresh) {
  const out = Object.assign({}, stored ?? {}, fresh ?? {});
  for (const k of Object.keys(out)) if (!out[k]) delete out[k];
  return Object.keys(out).length ? out : undefined;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function truncateForLog(s, n) {
  const r = Array.from(String(s ?? ""));
  return r.length <= n ? String(s ?? "") : r.slice(0, n).join("") + "…";
}

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------

export class UpstreamError extends Error {
  constructor(status, body, headers) {
    super(`upstream ${status}: ${truncateForLog(body, 200)}`);
    this.name = "UpstreamError";
    this.status = status;
    this.body = body;
    this.headers = headers;
  }
}

export class AuthExpiredError extends Error {
  constructor(message) {
    super(message ?? "session expired");
    this.name = "AuthExpiredError";
    this.signIn = "expired";
  }
}

export class BizError extends Error {
  constructor(code, msg) {
    super(`upstream code ${code}: ${msg}`);
    this.name = "BizError";
    this.code = code;
  }
}

export class ModelNotFoundError extends Error {
  constructor(requested, available) {
    super(
      `model "${requested}" not found; available models: ${available && available.length ? available.join(", ") : "(none)"}`,
    );
    this.name = "ModelNotFoundError";
  }
}

/** An `event:error` frame mid-stream; `kind` classifies busy vs model-rejected vs generic. */
export class StreamFrameError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = "StreamFrameError";
    this.kind = kind; // "busy" | "model-rejected" | "stream"
  }
}

export class ContentFilterError extends Error {
  constructor(reason, message) {
    super(`content filtered by upstream (${reason})${message ? `: ${message}` : ""}`);
    this.name = "ContentFilterError";
  }
}

export class OTPRequiredError extends Error {
  constructor(challenge) {
    super(
      challenge?.notify
        ? `new-device verification required; code sent to ${challenge.notify}`
        : "new-device verification required",
    );
    this.name = "OTPRequiredError";
    this.challenge = challenge; // serializable; carried back to the login method
  }
}

// ---------------------------------------------------------------------------
// think-marker splitter (v2 dialect: " sparks\0" markers inside content deltas)
// ---------------------------------------------------------------------------

// The raw v2 stream sends the marker followed by a NUL byte
// (" spark-open\0" … " spark-close\0"); NULs are stripped on input and the
// bare markers are matched (PROTOCOL.md:79-84). The live markers are:
const THINK_OPEN_TAG = "<think";
const THINK_CLOSE_TAG = "</think";

/** Longest suffix of `s` that is a proper prefix of either marker (0 when none). */
function markerPrefixLen(s) {
  const max = Math.min(s.length, THINK_CLOSE_TAG.length - 1); // both markers are 6/7 chars; check up to 6
  for (let n = max; n > 0; n--) {
    const tail = s.slice(-n);
    if (THINK_OPEN_TAG.startsWith(tail) || THINK_CLOSE_TAG.startsWith(tail)) return n;
  }
  return 0;
}

export class ThinkSplitter {
  constructor() {
    this.buf = "";
    this.state = "outside"; // outside | thinking | answer
  }

  push(delta) {
    if (!delta) return [];
    this.buf += String(delta).replace(/\x00/g, "");
    return this.#drain(false);
  }

  flush() {
    const out = this.#drain(true);
    const rem = this.buf;
    this.buf = "";
    if (rem) out.push({ type: this.state === "thinking" ? "reasoning" : "content", text: rem });
    return out;
  }

  #drain(final) {
    const out = [];
    for (;;) {
      const openIdx = this.buf.indexOf(THINK_OPEN_TAG);
      const closeIdx = this.buf.indexOf(THINK_CLOSE_TAG);
      if (openIdx >= 0 && (closeIdx < 0 || openIdx < closeIdx)) {
        if (openIdx > 0) out.push(this.#take(this.state === "thinking" ? "reasoning" : "content", openIdx));
        this.#take(null, THINK_OPEN_TAG.length); // drop the marker
        this.state = "thinking";
        continue;
      }
      if (closeIdx >= 0) {
        if (closeIdx > 0) out.push(this.#take(this.state === "thinking" ? "reasoning" : "content", closeIdx));
        this.#take(null, THINK_CLOSE_TAG.length);
        this.state = "answer";
        continue;
      }
      // No complete marker: hold back only a tail that could be a marker
      // prefix (the longest suffix of the buffer matching a marker prefix).
      if (!final) {
        const keep = markerPrefixLen(this.buf);
        const emit = this.buf.length - keep;
        if (emit > 0) out.push(this.#take(this.state === "thinking" ? "reasoning" : "content", emit));
      } else if (this.buf) {
        out.push(this.#take(this.state === "thinking" ? "reasoning" : "content", this.buf.length));
      }
      break;
    }
    return out;
  }

  #take(type, n) {
    const text = this.buf.slice(0, n);
    this.buf = this.buf.slice(n);
    return { type, text };
  }
}

// ---------------------------------------------------------------------------
// SSE parsing (MiMo dialect: `event:name` without the space; `event: name`
// and CRLF tolerated; comment lines are keepalives)
// ---------------------------------------------------------------------------

/**
 * Parse an SSE byte stream into frames. Returns when the stream ends; calls
 * `onEvent({ id, event, data })` per frame. Frames separate on blank lines.
 */
export async function parseSSE(body, onEvent, signal) {
  const decoder = new TextDecoder();
  let buf = "";
  let cur = { id: "", event: "", data: "" };
  const flush = async () => {
    if (cur.event || cur.data) {
      await onEvent({ id: cur.id, event: cur.event, data: cur.data });
      cur = { id: "", event: "", data: "" };
    }
  };
  const reader = body.getReader();
  try {
    for (;;) {
      if (signal?.aborted) throw new DOMException("aborted", "AbortError");
      const { done, value } = await reader.read();
      if (value) buf += decoder.decode(value, { stream: true });
      if (done) buf += decoder.decode();
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (line === "") {
          await flush();
        } else if (line[0] !== ":") {
          const i = line.indexOf(":");
          if (i >= 0) {
            const name = line.slice(0, i);
            let val = line.slice(i + 1);
            if (val.startsWith(" ")) val = val.slice(1);
            if (name === "id") cur.id = val;
            else if (name === "event") cur.event = val;
            else if (name === "data") cur.data = cur.data ? cur.data + "\n" + val : val;
          }
        }
      }
      if (done) {
        await flush();
        return;
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// web_search citations
// ---------------------------------------------------------------------------

export function parseWebSearch(data) {
  const trimmed = String(data ?? "").trim();
  if (!trimmed || trimmed === "null") return [];
  let items;
  try {
    items = JSON.parse(trimmed);
  } catch {
    return [];
  }
  if (items && typeof items === "object" && !Array.isArray(items) && Array.isArray(items.data)) {
    items = items.data;
  }
  if (!Array.isArray(items)) return [];
  const out = [];
  for (const it of items) {
    if (!it || typeof it !== "object") continue;
    const url = typeof it.url === "string" ? it.url : "";
    if (!url) continue;
    out.push({
      title: typeof it.name === "string" ? it.name : "",
      url,
      displayUrl: typeof it.displayUrl === "string" ? it.displayUrl : "",
      snippet: typeof it.snippet === "string" ? it.snippet : "",
      used: it.usedContent === true || String(it.usedContent).toLowerCase() === "true",
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// turn planning: OpenAI messages → upstream queries
// ---------------------------------------------------------------------------

export const DEFAULT_IMAGE_ONLY_QUERY = "请描述这张图片。";

/** One message of the normalized OpenAI conversation. */
export function normalizeMessages(messages) {
  const out = [];
  for (const m of messages ?? []) {
    const role = m?.role;
    if (role !== "system" && role !== "user" && role !== "assistant") continue;
    let text = "";
    const media = [];
    if (typeof m.content === "string") {
      text = m.content;
    } else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (!part || typeof part !== "object") continue;
        if (part.type === "text" && typeof part.text === "string") text += part.text;
        else if (part.type === "image_url") {
          const u = part.image_url?.url;
          if (typeof u === "string" && u) media.push(u);
        }
      }
    }
    out.push({ role, text, media });
  }
  return out;
}

/**
 * Full chain replay: one upstream query per user message, chained via
 * previousDialogueId. System messages splice into the first user query.
 * Returns { turns: [{ query, media }], systemsJoined }.
 */
export function planFullReplay(messages, maxTurns = 20) {
  const norm = normalizeMessages(messages);
  const systems = norm.filter((m) => m.role === "system" && m.text.trim()).map((m) => m.text.trim());
  const users = norm.filter((m) => m.role === "user" && (m.text.trim() || m.media.length));
  if (!users.length) {
    const e = new Error("messages contains no sendable user message");
    e.code = "no_user_message";
    throw e;
  }
  if (maxTurns > 0 && users.length > maxTurns) {
    throw new Error(`conversation has ${users.length} user turns, exceeding the replay cap of ${maxTurns}`);
  }
  const preamble = systems.length ? systems.join("\n\n---\n\n") + "\n\n---\n\n" : "";
  const turns = users.map((m, i) => ({
    // An image-only turn is a legal request (IMG-007): it enters the plan
    // with the neutral query below, not a 400.
    query: i === 0 ? preamble + (m.text || (m.media.length ? DEFAULT_IMAGE_ONLY_QUERY : "")) : m.text || (m.media.length ? DEFAULT_IMAGE_ONLY_QUERY : ""),
    media: m.media,
  }));
  return { turns, systemsJoined: preamble.length > 0 };
}

// ---------------------------------------------------------------------------
// attachments (image_url → upload → parse → multiMedias handle)
// ---------------------------------------------------------------------------

/** Image download ceiling: chat attachments have no business being larger. */
const IMAGE_MAX_BYTES = 20 * 1024 * 1024;

/** SSRF guard: the client hands us arbitrary image URLs — never dial the
 *  loopback / link-local / private ranges (cloud metadata endpoints included).
 *  Accepts a bare hostname (already bracket-stripped for IPv6 literals) or a
 *  resolved address; both go through the same literal checks so DNS results
 *  are held to the same standard as the URL the client typed. */
export function assertPublicHost(hostname) {
  // WHATWG URL keeps brackets on IPv6 literals ("[::1]"); strip them so every
  // caller can pass either form.
  let h = String(hostname).toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal") || h.endsWith(".local")) {
    throw new Error(`image URL host not allowed: ${truncateForLog(hostname, 80)}`);
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
    if (!isPublicIPv4(h)) throw new Error(`image URL host not allowed: ${truncateForLog(hostname, 80)}`);
    return;
  }
  if (h.includes(":")) {
    if (!isPublicIPv6(h)) throw new Error(`image URL host not allowed: ${truncateForLog(hostname, 80)}`);
  }
}

function isPublicIPv4(ip) {
  const [a, b] = ip.split(".").map(Number);
  return !(a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224);
}

function isPublicIPv6(h) {
  // Unspecified / loopback
  if (h === "::" || h === "::1") return false;
  // IPv4-mapped / IPv4-compatible: "::ffff:127.0.0.1" or "::ffff:7f00:1" —
  // both dial 127.0.0.1. Extract the embedded v4 and re-check it. Bun reaches
  // these addresses, so string-prefix checks on "fc"/"fd"/"fe80" alone leak.
  const v4Match = h.match(/(?:^|:)((?:\d{1,3}\.){3}\d{1,3})$/);
  if (v4Match && h.includes("::")) {
    return isPublicIPv4(v4Match[1]);
  }
  const mapped = h.match(/::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mapped) {
    const hi = parseInt(mapped[1], 16), lo = parseInt(mapped[2], 16);
    return isPublicIPv4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  // ULA fc00::/7 (fc/fd), link-local fe80::/10 (fe80–febf), multicast ff00::/8
  if (/^(fc|fd)/.test(h) || /^fe[89ab]/.test(h) || /^ff/.test(h)) return false;
  return true;
}

/**
 * Fetch an image the client handed us (http(s) or data: URL) into bytes.
 *
 * Redirects are walked MANUALLY (redirect:"manual" + per-hop guard) instead of
 * letting fetch follow them: Bun's fetch follows redirects transparently, and
 * a guard on the initial URL never sees the redirect target — a public host
 * answering 302 → http://127.0.0.1/ (or 169.254.169.254) would leak the
 * private response body. Name-based hosts additionally get a DNS pre-flight:
 * any A/AAAA record in a private range kills the request, closing the
 * "public-looking name resolves to loopback" bypass (nip.io-style).
 */
async function fetchImageBytes(url, headers, signal, dnsResolve) {
  if (url.startsWith("data:")) {
    const i = url.indexOf(",");
    if (i < 0) throw new Error(`bad data URL: ${truncateForLog(url, 60)}`);
    const meta = url.slice(5, i);
    const b64 = url.slice(i + 1);
    const buf = Buffer.from(b64, "base64");
    if (buf.length > IMAGE_MAX_BYTES) throw new Error(`image exceeds ${IMAGE_MAX_BYTES} bytes`);
    const mime = meta.split(";")[0] || "image/png";
    return { bytes: buf, mime };
  }
  // Whole-fetch deadline armed ONCE for all hops (image downloads are one-shot,
  // no SSE under it): an absolute timer across the redirect loop is what we
  // want here, unlike chat streams.
  const deadline = signal ?? AbortSignal.timeout(20_000);
  let current = new URL(url);
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    if (current.protocol !== "http:" && current.protocol !== "https:") {
      throw new Error(`image URL scheme not allowed: ${truncateForLog(current.protocol, 20)}`);
    }
    await assertResolvablePublicHost(current.hostname, dnsResolve);
    const resp = await fetch(current, {
      headers: { "User-Agent": USER_AGENT, ...headers },
      redirect: "manual",
      signal: deadline,
    });
    if (resp.status >= 300 && resp.status < 400) {
      const location = resp.headers.get("location");
      try {
        await resp.body?.cancel();
      } catch {}
      if (!location) throw new Error(`fetch image ${truncateForLog(url, 120)}: ${resp.status} redirect without location`);
      let next;
      try {
        next = new URL(location, current);
      } catch {
        throw new Error(`fetch image ${truncateForLog(url, 120)}: bad redirect location`);
      }
      if (next.protocol !== "http:" && next.protocol !== "https:") {
        throw new Error(`image URL scheme not allowed: ${truncateForLog(next.protocol, 20)}`);
      }
      current = next;
      continue;
    }
    if (!resp.ok) throw new Error(`fetch image ${truncateForLog(url, 120)}: ${resp.status}`);
    const declared = Number(resp.headers.get("content-length") ?? 0);
    if (declared > IMAGE_MAX_BYTES) throw new Error(`image exceeds ${IMAGE_MAX_BYTES} bytes`);
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length > IMAGE_MAX_BYTES) throw new Error(`image exceeds ${IMAGE_MAX_BYTES} bytes`);
    const mime = resp.headers.get("content-type")?.split(";")[0] || "image/png";
    return { bytes: buf, mime };
  }
  throw new Error(`fetch image ${truncateForLog(url, 120)}: too many redirects`);
}

const MAX_REDIRECT_HOPS = 5;

/** Guard a hostname: literal addresses go straight through the range checks;
 *  name-based hosts get DNS-resolved first and every record must be public.
 *  Unresolvable names are left for fetch itself to fail on. `dnsResolve` is an
 *  injectable async (hostname) => string[] (test hook; defaults to real DNS). */
async function assertResolvablePublicHost(hostname, dnsResolve) {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) && !hostname.includes(":") && !isLocalishName(hostname)) {
    const resolve = dnsResolve ?? resolveHostAddresses;
    const records = await resolve(hostname).catch(() => null);
    if (records) for (const addr of records) assertPublicHost(addr);
  } else {
    assertPublicHost(hostname);
  }
}

function isLocalishName(hostname) {
  const h = String(hostname).toLowerCase();
  return h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal") || h.endsWith(".local");
}

async function resolveHostAddresses(hostname) {
  const { promises: dns } = await import("node:dns");
  const results = await Promise.allSettled([dns.resolve4(hostname), dns.resolve6(hostname)]);
  const out = [];
  for (const r of results) if (r.status === "fulfilled") out.push(...r.value);
  return out;
}

/**
 * Resolve image URLs into chat `multiMedias` handles: upload → parse.
 * `resolve` is an injected { upload, parse } pair so tests can stub the surface.
 */
export async function resolveImages(imageUrls, session, client, opts = {}) {
  const out = [];
  for (const url of imageUrls) {
    let media;
    if (typeof url === "object" && url?.handle) {
      media = url.handle; // already-resolved handle (from a previous pass)
    } else {
      const { bytes, mime } = await fetchImageBytes(url, opts.proxyHeaders, opts.signal, opts.dnsResolve);
      const name = opts.fileName ?? `image-${randomHex32().slice(0, 8)}.${mime.includes("jpeg") ? "jpg" : mime.includes("webp") ? "webp" : mime.includes("gif") ? "gif" : "png"}`;
      const up = await client.uploadFile(session, name, bytes, opts.signal);
      const parsed = await client.parseResource(session, up.resourceUrl, up.objectName, opts.model, opts.signal);
      media = attachmentItem("image", name, bytes.length, up, parsed);
    }
    out.push(media);
  }
  return out;
}

/** The field set the live platform accepts for one chat attachment. */
export function attachmentItem(mediaType, name, size, uploaded, parsed) {
  return {
    mediaType,
    fileUrl: uploaded.resourceUrl,
    compressedVideoUrl: "",
    audioTrackUrl: mediaType === "audio" ? uploaded.resourceUrl : "",
    name,
    size,
    status: "completed",
    objectName: uploaded.objectName,
    tokenUsage: parsed.tokenUsage,
    url: parsed.id,
  };
}

// ---------------------------------------------------------------------------
// the client
// ---------------------------------------------------------------------------

/**
 * A MiMo Studio upstream client. Stateless with respect to accounts: every
 * call takes the account's `session` ({ cookie, ph, userId?, passToken?,
 * device? }) explicitly, so one client serves a whole account pool.
 *
 * @param {{ base?: string, idleMs?: number, onLog?: (level, msg) => void }} opts
 */
export class MimoClient {
  constructor(opts = {}) {
    this.base = (opts.base || UPSTREAM_BASE).replace(/\/+$/, "");
    this.idleMs = opts.idleMs ?? CHAT_IDLE_MS;
    this.onLog = opts.onLog ?? (() => {});
    this.passportBase = opts.passportBase || `https://${PASSPORT_HOST}`;
    this.allowHosts = new Set([PASSPORT_HOST, new URL(this.base).hostname]);
    this.upstreamHost = new URL(this.base).hostname;
  }

  log(level, msg) {
    this.onLog?.(level, msg);
  }

  #hostOK(host) {
    host = String(host ?? "").toLowerCase().replace(/\.$/, "");
    return host === "xiaomi.com" || host.endsWith(".xiaomi.com") || this.allowHosts.has(host);
  }

  #absPassport(maybe) {
    const s = String(maybe ?? "").trim();
    if (!s) return "";
    if (/^https?:\/\//.test(s)) return s;
    return `https://${PASSPORT_HOST}${s.startsWith("/") ? "" : "/"}${s}`;
  }

  // ---- header sets (kept apart on purpose; the surfaces differ) ----

  /** The Studio chat/JSON surface: fetch-based, no X-Requested-With, no Authorization. */
  #studioHeaders(h, { json = true } = {}) {
    h.set("Accept", ACCEPT_FETCH);
    h.set("Accept-Language", "zh-CN");
    h.set("x-timeZone", "Asia/Shanghai");
    h.set("Origin", this.base);
    h.set("Referer", this.base + "/");
    h.set("User-Agent", USER_AGENT);
    h.set("sec-ch-ua", SEC_CH_UA);
    h.set("sec-ch-ua-mobile", "?0");
    h.set("sec-ch-ua-platform", '"Windows"');
    h.set("sec-fetch-dest", "empty");
    h.set("sec-fetch-mode", "cors");
    h.set("sec-fetch-site", "same-origin");
    if (json) h.set("Content-Type", "application/json");
  }

  /** Chrome navigating to a document (login page, serviceLogin). */
  #navHeaders(h, referer) {
    h.set("Accept", ACCEPT_HTML);
    h.set("Accept-Language", "zh-CN,zh;q=0.9");
    h.set("Upgrade-Insecure-Requests", "1");
    h.set("User-Agent", USER_AGENT);
    h.set("sec-ch-ua", SEC_CH_UA);
    h.set("sec-ch-ua-mobile", "?0");
    h.set("sec-ch-ua-platform", '"Windows"');
    h.set("sec-fetch-dest", "document");
    h.set("sec-fetch-mode", "navigate");
    h.set("sec-fetch-site", "cross-site");
    h.set("sec-fetch-user", "?1");
    if (referer) h.set("Referer", referer);
  }

  /** Same-origin XHR on the passport SPA (identity endpoints): X-Requested-With mandatory. */
  #xhrHeaders(h, origin, referer) {
    h.set("Accept", ACCEPT_JSON);
    h.set("Accept-Language", "zh-CN,zh;q=0.9");
    h.set("User-Agent", USER_AGENT);
    h.set("X-Requested-With", "XMLHttpRequest");
    h.set("sec-ch-ua", SEC_CH_UA);
    h.set("sec-ch-ua-mobile", "?0");
    h.set("sec-ch-ua-platform", '"Windows"');
    h.set("sec-fetch-dest", "empty");
    h.set("sec-fetch-mode", "cors");
    h.set("sec-fetch-site", "same-origin");
    if (origin) h.set("Origin", origin);
    if (referer) h.set("Referer", referer);
  }

  /** The one storage PUT: cross-site, no Cookie, octet-stream + content-md5. */
  #storageHeaders(h) {
    h.set("Accept", ACCEPT_FETCH);
    h.set("Accept-Language", "zh-CN");
    h.set("x-timeZone", "Asia/Shanghai");
    h.set("Origin", this.base);
    h.set("Referer", this.base + "/");
    h.set("User-Agent", USER_AGENT);
    h.set("sec-ch-ua", SEC_CH_UA);
    h.set("sec-ch-ua-mobile", "?0");
    h.set("sec-ch-ua-platform", '"Windows"');
    h.set("sec-fetch-dest", "empty");
    h.set("sec-fetch-mode", "cors");
    h.set("sec-fetch-site", "cross-site");
  }

  /**
   * One manual-redirect GET/POST against the passport, with jar cookies in
   * and Set-Cookie harvested out. Redirects are NEVER followed by the
   * transport: intermediate Locations carry the sign/token/context the
   * later hops need.
   */
  async #ssoDo(jar, method, target, form, extra, signal) {
    const headers = new Headers();
    const u = new URL(target);
    if (form) {
      this.#xhrHeaders(headers, u.origin, u.origin + "/");
      headers.set("Content-Type", "application/x-www-form-urlencoded");
    } else {
      this.#xhrHeaders(headers, u.origin, u.origin + "/");
    }
    for (const [k, v] of Object.entries(extra ?? {})) headers.set(k, v);
    if (Object.keys(jar).length) headers.set("Cookie", cookieHeader(jar));

    const resp = await fetch(target, {
      method,
      headers,
      body: form ? form.toString() : undefined,
      redirect: "manual",
      signal,
    });
    for (const [k, v] of Object.entries(collectCookies(resp))) jar[k] = v;
    const body = await resp.text();
    return { status: resp.status, body, headers: resp.headers, finalURL: target };
  }

  /** Walk a redirect chain by hand (host-allowlisted); returns the last URL.
   *  Relative Locations resolve against the CURRENT hop's host — the STS
   *  landing chain crosses hosts (passport → upstream /sts), and anchoring
   *  every hop to the passport would miss the upstream cookie plant. */
  async #followChain(jar, start, maxHops = MAX_CHAIN_HOPS, signal) {
    let target = this.#absPassport(start);
    for (let i = 0; i < maxHops; i++) {
      const u = new URL(target);
      if (!this.#hostOK(u.hostname)) throw new Error(`chain hop ${i}: host ${u.hostname} not allowlisted`);
      const { status, headers } = await this.#ssoDo(jar, "GET", target, null, null, signal);
      const loc = headers.get("location");
      if (status < 300 || status > 399 || !loc) return target;
      target = absURL(target, loc);
    }
    throw new Error(`redirect chain exceeded ${maxHops} hops`);
  }

  // ---- session plumbing ----

  /** Compose the working upstream Cookie header from a chain jar. */
  #sessionFromJar(jar) {
    const token = unquoteCookie(jar["xiaomichatbot_serviceToken"]);
    if (!token) throw new Error("sts response did not plant xiaomichatbot_serviceToken");
    const ph = unquoteCookie(jar["xiaomichatbot_ph"]);
    const slh = unquoteCookie(jar["xiaomichatbot_slh"]);
    const parts = [];
    if (jar["cUserId"]) parts.push(`cUserId=${jar["cUserId"]}`);
    if (jar["userId"]) parts.push(`userId=${jar["userId"]}`);
    parts.push(`serviceToken=${token}`);
    parts.push(`xiaomichatbot_serviceToken="${token}"`);
    if (slh) parts.push(`xiaomichatbot_slh="${slh}"`);
    if (ph) parts.push(`xiaomichatbot_ph="${ph}"`);
    return { cookie: parts.join("; "), ph, device: harvestDevice(jar) };
  }

  /**
   * Follow the STS landing chain to its end; the xiaomichatbot_* session
   * cookies are planted at the UPSTREAM hop, not the first redirect:
   * /identity/result/check → /pass/serviceLoginAuth2/end → <upstream>/sts?…
   * → /open-apis/user/mi/get.
   */
  async #stsExchange(location, seedJar, signal, { issuerBase } = {}) {
    const jar = { ...(seedJar ?? {}) };
    // A relative location is anchored at the host that ISSUED it. Pass the
    // issuer's base when the caller knows it (renew: the loginUrl host;
    // submitOTP: the passport base); otherwise the passport default applies.
    let start = location;
    if (!/^https?:\/\//.test(start) && issuerBase) {
      start = absURL(issuerBase, start);
    }
    await this.#followChain(jar, start, MAX_CHAIN_HOPS, signal);
    return this.#sessionFromJar(jar);
  }

  /**
   * Password login for one account (steps per the reverse doc): context
   * probe → serviceLoginAuth2 (hash = upper MD5(password)) → STS exchange.
   * May reject with OTPRequiredError when the platform demands new-device
   * verification — the returned challenge is completed by submitOTP().
   *
   * @returns session { cookie, ph, userId, passToken, device }
   */
  async login(account, signal) {
    const { phone, password } = account;
    if (!phone || !password) throw new Error("login requires phone and password");
    // The whole login chain is short JSON/redirect hops (no SSE) — a default
    // timeout keeps a hung passport from wedging authorize/renewal forever.
    signal ??= AbortSignal.timeout(30_000);

    // Step 1: probe /open-apis/user/mi/get unauthenticated → 401 with loginUrl.
    const probeHeaders = new Headers();
    this.#studioHeaders(probeHeaders, { json: false });
    const probeResp = await fetch(`${this.base}/open-apis/user/mi/get`, {
      headers: probeHeaders,
      signal,
    });
    const probeBody = await probeResp.text();
    let loginURL = "";
    try {
      loginURL = JSON.parse(probeBody).loginUrl ?? "";
    } catch {}
    if (!loginURL) {
      try {
        loginURL = parseXSSI(probeBody).loginUrl ?? "";
      } catch {}
    }
    if (!loginURL) throw new Error("login context: no loginUrl in probe response");

    const pu = new URL(loginURL);
    if (!this.#hostOK(pu.hostname)) throw new Error(`loginUrl host ${pu.hostname} not in allowlist`);
    const lctx = pu.searchParams;

    // Step 2: prime the login page like a browser navigation (device anchor).
    const jar = seedDeviceJar(account.device);
    await this.#primeLoginPage(jar, loginURL, signal);

    // Step 3: POST /pass/serviceLoginAuth2 as an HTML form.
    const form = new URLSearchParams({
      _json: "true",
      callback: lctx.get("callback") ?? "",
      sid: lctx.get("sid") ?? SID,
      qs: lctx.get("qs") ?? "",
      _sign: lctx.get("_sign") ?? "",
      serviceParam: lctx.get("serviceParam") ?? "",
      user: phone,
      hash: md5Upper(password),
      policyName: "miaccount",
      captCode: "",
      _group: lctx.get("_group") ?? "",
    });
    const authHeaders = new Headers();
    this.#navHeaders(authHeaders, loginURL);
    authHeaders.set("sec-fetch-site", "same-origin");
    authHeaders.set("Origin", pu.origin);
    authHeaders.set("Content-Type", "application/x-www-form-urlencoded");
    if (Object.keys(jar).length) authHeaders.set("Cookie", cookieHeader(jar));

    const authResp = await fetch(`${pu.origin}/pass/serviceLoginAuth2`, {
      method: "POST",
      headers: authHeaders,
      body: form.toString(),
      redirect: "manual",
      signal,
    });
    for (const [k, v] of Object.entries(collectCookies(authResp))) jar[k] = v;
    const authBody = await authResp.text();
    if (authResp.status >= 500 || authResp.status === 429) {
      throw new Error(`serviceLoginAuth2: upstream status ${authResp.status}`);
    }
    const m = parseXSSI(authBody);
    const code = typeof m.code === "number" ? m.code : -1;

    // Step 4: dispatch on the answer.
    if (code !== 0) {
      if (m.captchaUrl) {
        throw new Error(`login failed: slider captcha required (${m.description || "see " + m.captchaUrl})`);
      }
      if (m.notificationUrl) {
        throw new Error(`login failed: code=${code} ${m.description || ""} (verification demand: ${truncateForLog(m.notificationUrl, 80)})`.trimEnd());
      }
      throw new Error(`login failed: code=${code} ${m.description || ""}`.trimEnd());
    }

    let location = m.location ?? "";
    if (!location && m.notificationUrl) {
      // New-device OTP demand arrives with code=0, securityStatus=128,
      // empty location. Start the challenge; complete via submitOTP().
      const challenge = await this.#startOTP(m.notificationUrl, lctx.get("sid") ?? SID, jar, signal);
      const err = new OTPRequiredError({ method: challenge.method, notify: challenge.notify });
      err.challenge = challenge;
      throw err;
    }
    if (!location) throw new Error("login succeeded but no location for STS exchange");

    // Step 5: STS exchange → upstream session. The location came from
    // serviceLoginAuth2 on the passport host.
    const sess = await this.#stsExchange(location, jar, signal, { issuerBase: pu.origin });
    let userId = scalarString(m.userId) || jar["userId"] || "";
    if (!userId) {
      const probe = await this.whoami({ ...sess, userId: "", passToken: "" }, signal).catch(() => null);
      userId = probe?.userId ?? "";
    }
    return { ...sess, userId, passToken: jar["passToken"] ?? "" };
  }

  async #primeLoginPage(jar, loginURL, signal) {
    let target = loginURL;
    for (let hop = 0; hop < 2; hop++) {
      const headers = new Headers();
      this.#navHeaders(headers, hop > 0 ? loginURL : this.base + "/");
      if (Object.keys(jar).length) headers.set("Cookie", cookieHeader(jar));
      let resp;
      try {
        resp = await fetch(target, { headers, redirect: "manual", signal });
      } catch {
        return; // best-effort: a login without device cookies still proceeds
      }
      for (const [k, v] of Object.entries(collectCookies(resp))) jar[k] = v;
      try {
        await resp.arrayBuffer();
      } catch {}
      const loc = resp.headers.get("location");
      if (resp.status < 300 || resp.status > 399 || !loc) return;
      target = absURL(target, loc);
      if (!this.#hostOK(new URL(target).hostname)) return;
    }
  }

  // ---- new-device OTP challenge (steps 1–4) ----

  /**
   * Start the verification session and send the code. Returns a
   * serializable challenge; submitOTP() completes it.
   */
  async #startOTP(notificationURL, sidFallback, seedJar, signal) {
    const jar = { ...(seedJar ?? {}) };
    const ntf = this.#absPassport(notificationURL);
    const nu = new URL(ntf);
    if (!this.#hostOK(nu.hostname)) throw new Error(`notification url host ${nu.hostname} not allowlisted`);
    const passBase = nu.origin;
    let sid = nu.searchParams.get("sid") || sidFallback || SID;

    // Step 1: walk the notificationUrl chain (plain identity entry, or the
    // cross-region consent page — agreed automatically — then authStart).
    let context = "";
    let page = "";
    {
      let target = ntf;
      const hops = [];
      for (let i = 0; i < MAX_CHAIN_HOPS; i++) {
        const u = new URL(target);
        if (!this.#hostOK(u.hostname)) throw new Error(`notification chain: host ${u.hostname} not allowlisted`);
        const { status, headers, finalURL } = await this.#ssoDo(jar, "GET", target, null, null, signal);
        const loc = headers.get("location");
        hops.push({ status, url: finalURL, location: loc });
        if (status < 300 || status > 399 || !loc) {
          page = finalURL;
          break;
        }
        target = absURL(target, loc);
        page = target;
      }
      // authStart entry: the context rides the query (possibly behind
      // ?callback= indirection).
      for (let cur = page, depth = 0; depth < 3 && cur; depth++) {
        const q = new URL(cur).searchParams;
        if (q.get("context")) {
          context = q.get("context");
          sid = q.get("sid") || sid;
          break;
        }
        cur = q.get("callback");
      }
      // Cross-region consent page?
      if (!context) {
        const biz = hops.find((h) => new URL(absURL(h.url, h.location ?? "")).searchParams.get("bizType") === "UserCross");
        const onConsentPage = page.includes("/fe/service/userCross");
        if (biz || onConsentPage) {
          const userId = biz ? new URL(absURL(biz.url, biz.location)).searchParams.get("userId") : new URL(page).searchParams.get("userId");
          if (!userId) throw new Error("cross-region consent page carried no userId");
          const agreeForm = new URLSearchParams({ userId, status: "1", needClose: "false" });
          const { body } = await this.#ssoDo(
            jar,
            "POST",
            `${passBase}/pass2/userCrossAgreement/update`,
            agreeForm,
            { "X-Requested-With": "XMLHttpRequest", Referer: page },
            signal,
          );
          const agree = parseLooseJSON(body);
          codeCheck(agree, "cross-region consent");
          const loc = agree.location;
          if (!loc) throw new Error("cross-region consent accepted but no location returned");
          await this.#followChain(jar, loc, MAX_CHAIN_HOPS, signal);
          for (let cur = absURL(passBase + "/", loc), depth = 0; depth < 3 && cur; depth++) {
            const q = new URL(cur).searchParams;
            if (q.get("context")) {
              context = q.get("context");
              sid = q.get("sid") || sid;
              break;
            }
            cur = q.get("callback");
          }
          if (!context) throw new Error("consent chain landed without an identity context");
        }
      }
      if (!context) throw new Error(`login chain landed on ${truncateForLog(page, 80)} without an identity context`);
    }

    // Step 2: identity/list — verification method (flag 4=phone, 8=email).
    const listURL = `${passBase}/identity/list?sid=${encodeURIComponent(sid)}&supportedMask=0&_locale=zh_CN&context=${encodeURIComponent(context)}`;
    const listResp = await this.#ssoDo(jar, "GET", listURL, null, null, signal);
    let list = parseLooseJSON(listResp.body);
    if (list.flag == null && list.data && typeof list.data === "object") Object.assign(list, list.data);
    const flag = Number(list.flag) === 8 ? 8 : 4;
    const method = flag === 8 ? "Email" : "Phone";
    let notify = "";
    for (const k of ["notify", "notifyPhone", "notifyEmail", "maskedPhone", "maskedEmail", "phone", "email", "tips", "description", "desc"]) {
      if (typeof list[k] === "string" && list[k]) {
        notify = list[k];
        break;
      }
    }

    // Step 3: trigger the session (masked destination comes back here).
    const trigURL = `${passBase}/identity/auth/verify${method}?_flag=${flag}&_json=true`;
    const trigResp = await this.#ssoDo(jar, "GET", trigURL, null, null, signal);
    try {
      const trig = parseLooseJSON(trigResp.body);
      codeCheck(trig, "otp verify trigger");
      for (const k of ["maskedPhone", "maskedEmail", "notify", "notifyPhone", "notifyEmail"]) {
        if (typeof trig[k] === "string" && trig[k]) {
          notify = trig[k];
          break;
        }
      }
    } catch {}

    // Step 4: send the code (X-Requested-With mandatory — email send fails 66108 without it).
    const sendURL = `${passBase}/identity/auth/send${method}Ticket?_dc=${Date.now()}`;
    const sendForm = new URLSearchParams({ retry: "0", icode: "", _json: "true" });
    const sendResp = await this.#ssoDo(jar, "POST", sendURL, sendForm, { "X-Requested-With": "XMLHttpRequest" }, signal);
    try {
      codeCheck(parseLooseJSON(sendResp.body), "otp code send");
    } catch (e) {
      throw e;
    }

    return { method, notify, sid, passBase, flag, jar, expiresAt: Date.now() + OTP_TTL_MS };
  }

  /**
   * Complete a challenge from #startOTP with the received code (steps 5–8):
   * verify ticket → landing chain → serviceLogin → STS → session.
   */
  async submitOTP(challenge, code, signal) {
    signal ??= AbortSignal.timeout(30_000); // login-class chain: same ceiling as login()/renew()
    if (!challenge?.jar) throw new Error("otp challenge is missing its verification jar");
    if (Date.now() > (challenge.expiresAt ?? 0)) throw new Error("otp challenge expired (10-minute window)");
    code = String(code ?? "").trim();
    if (!code) throw new Error("otp code is empty");
    const jar = challenge.jar;
    const { passBase, method, flag } = challenge;

    // Step 5: submit the ticket.
    const vForm = new URLSearchParams({ _flag: String(flag), ticket: code, trust: "true", _json: "true" });
    const vResp = await this.#ssoDo(
      jar,
      "POST",
      `${passBase}/identity/auth/verify${method}?_dc=${Date.now()}`,
      vForm,
      { "X-Requested-With": "XMLHttpRequest" },
      signal,
    );
    const vm = parseLooseJSON(vResp.body);
    let loc = vm.location ?? "";
    if (!loc) {
      codeCheck(vm, "otp verify");
      throw new Error("otp verify: response carried no location");
    }

    // Step 6: walk the landing chain; fall back to the explicit
    // serviceLogin hop for passport variants that need it. The verify
    // location is relative to the passport base.
    let sess;
    try {
      sess = await this.#stsExchange(loc, jar, signal, { issuerBase: passBase });
    } catch (e) {
      sess = await this.#otpServiceLoginSession(jar, challenge, signal);
      if (!sess) throw e;
    }

    // Step 7: identity — prefer what the chain planted in the jar.
    let [passToken, userId] = [jar["passToken"] ?? "", jar["userId"] ?? ""];
    if (!userId && sess.userId) userId = sess.userId;
    if (!passToken && sess.passToken) passToken = sess.passToken;
    if (!userId || !passToken) {
      const [pt, uid] = await this.#collectTokens(jar, vm.location ?? loc, signal);
      passToken = passToken || pt;
      userId = userId || uid;
    }
    return {
      cookie: sess.cookie,
      ph: sess.ph,
      device: mergeDevice(sess.device, harvestDevice(jar)),
      userId,
      passToken,
    };
  }

  async #otpServiceLoginSession(jar, challenge, signal) {
    const { passBase, sid } = challenge;
    const slURL = `${passBase}/pass/serviceLogin?sid=${encodeURIComponent(sid)}&_json=true&_locale=zh_CN`;
    for (let i = 0; i < 2; i++) {
      const { body } = await this.#ssoDo(jar, "GET", slURL, null, null, signal);
      let m;
      try {
        m = parseLooseJSON(body);
      } catch {
        continue;
      }
      codeCheck(m, "otp serviceLogin");
      const loc = m.location;
      if (loc && i === 1) return await this.#stsExchange(loc, jar, signal, { issuerBase: passBase });
      if (loc && i === 0) {
        // first pass harvests tokens via the offered location
        const [pt, uid] = await this.#collectTokens(jar, loc, signal);
        if (pt) jar["passToken"] = pt;
        if (uid) jar["userId"] = uid;
      }
    }
    return null;
  }

  async #collectTokens(jar, location, signal) {
    let next = this.#absPassport(location);
    for (let hop = 0; hop < 2 && next; hop++) {
      let u;
      try {
        u = new URL(next);
      } catch {
        break;
      }
      if (!this.#hostOK(u.hostname)) break;
      let body = "";
      let headers;
      try {
        ({ body, headers } = await this.#ssoDo(jar, "GET", next, null, null, signal));
      } catch {
        break;
      }
      let [pt, uid] = ["", ""];
      try {
        [pt, uid] = findTokens(parseLooseJSON(body));
      } catch {}
      if (pt && uid) return [pt, uid];
      if (jar["passToken"] && jar["userId"]) return [jar["passToken"], jar["userId"]];
      if (u.searchParams.get("passToken") && u.searchParams.get("userId")) {
        return [u.searchParams.get("passToken"), u.searchParams.get("userId")];
      }
      let loc = headers?.get("location") ?? "";
      if (!loc) {
        try {
          loc = parseLooseJSON(body).location ?? "";
        } catch {}
      }
      next = loc ? absURL(next, loc) : "";
    }
    return ["", ""];
  }

  // ---- renewal ----

  /**
   * Renew a session from userId + passToken (no password needed): probe the
   * official loginUrl, serviceLogin with _json=true and the passToken
   * cookie, then STS exchange. Rejects with AuthExpiredError on code 70016
   * (passToken dead — full re-login needed).
   */
  async renew(session, signal) {
    const { userId, passToken } = session;
    if (!userId || !passToken) throw new AuthExpiredError("no passToken stored for renewal");
    // Renewal chain is short JSON/redirect hops (no SSE) — default timeout.
    signal ??= AbortSignal.timeout(30_000);

    // Step 1: probe for the official loginUrl.
    let loginURL = "";
    {
      const headers = new Headers();
      this.#studioHeaders(headers, { json: false });
      headers.set("Cookie", `userId=${userId};`);
      const resp = await fetch(`${this.base}/open-apis/user/mi/get`, { headers, signal });
      const body = await resp.text();
      try {
        loginURL = JSON.parse(body).loginUrl ?? "";
      } catch {}
    }
    if (!loginURL) {
      const cb = encodeURIComponent(
        `${this.base}/sts?sign=%2FKuvzNMEPYoLWPMSl3fRtWQeN%2Bo%3D&followup=${encodeURIComponent(this.base + "/")}`,
      );
      loginURL = `https://${PASSPORT_HOST}/pass/serviceLogin?callback=${cb}&sid=${SID}&_group=DEFAULT`;
    }

    // Step 2: serviceLogin with _json=true and the passToken cookie.
    const pu = new URL(loginURL);
    if (!this.#hostOK(pu.hostname)) throw new Error(`renewal loginUrl host ${pu.hostname} not in allowlist`);
    pu.searchParams.set("_json", "true");
    const navHeaders = new Headers();
    this.#navHeaders(navHeaders, this.base + "/");
    const ck = [`userId=${userId}`, `passToken=${passToken}`];
    for (const [k, v] of Object.entries(session.device ?? {})) ck.push(`${k}=${v}`);
    navHeaders.set("Cookie", ck.join("; "));
    const resp2 = await fetch(pu.toString(), { headers: navHeaders, redirect: "manual", signal });
    const jar = seedDeviceJar(session.device);
    for (const [k, v] of Object.entries(collectCookies(resp2))) jar[k] = v;
    const body2 = await resp2.text();
    const m = parseXSSI(body2);
    if (typeof m.code === "number" && m.code !== 0) {
      if (m.code === 70016) throw new AuthExpiredError(`passToken expired (code 70016): ${m.description ?? ""}`);
      throw new Error(`renewal failed: code=${m.code} ${m.description ?? ""}`.trimEnd());
    }
    const loc = m.location ?? "";
    if (!loc) throw new Error("renewal response missing location");

    // Step 3: STS exchange seeded with the device identity. The location is
    // relative to the loginUrl host that issued it.
    const sess = await this.#stsExchange(loc, jar, signal, { issuerBase: pu.origin });
    return {
      cookie: sess.cookie,
      ph: sess.ph,
      device: mergeDevice(session.device, sess.device),
      userId: sess.userId || userId,
      passToken: jar["passToken"] && jar["passToken"] !== passToken ? jar["passToken"] : passToken,
    };
  }

  /** Probe session health: 200 + code==0 means healthy. */
  async validate(session, signal) {
    const headers = new Headers();
    this.#studioHeaders(headers, { json: false });
    headers.set("Cookie", session.cookie);
    // Short probe: default 15s timeout (no SSE under this signal).
    const resp = await fetch(`${this.base}/open-apis/user/mi/get`, { headers, signal: signal ?? AbortSignal.timeout(15_000) });
    if (resp.status === 401) throw new AuthExpiredError("session expired (401)");
    if (resp.status !== 200) throw new Error(`validate: status ${resp.status}`);
    const body = await resp.text();
    let result;
    try {
      result = JSON.parse(body);
    } catch {
      return;
    }
    if (typeof result.code === "number" && result.code !== 0) {
      throw new AuthExpiredError(`validate: business code ${result.code}`);
    }
  }

  /** Who the session belongs to (used to name accounts). */
  async whoami(session, signal) {
    const headers = new Headers();
    this.#studioHeaders(headers, { json: false });
    headers.set("Cookie", session.cookie);
    const resp = await fetch(`${this.base}/open-apis/user/mi/get`, { headers, signal: signal ?? AbortSignal.timeout(15_000) });
    if (resp.status !== 200) throw new UpstreamError(resp.status, "", resp.headers);
    const body = JSON.parse(await resp.text());
    if (body.code !== 0) throw new AuthExpiredError(`whoami: business code ${body.code}`);
    return { userId: scalarString(body.userId) || scalarString(body.data?.userId) || "" };
  }

  // ---- JSON envelope surface ----

  async #callJSON(session, method, path, { query, body } = {}, signal) {
    const q = new URLSearchParams(query ?? {});
    if (session.ph) q.set("xiaomichatbot_ph", session.ph);
    const headers = new Headers();
    this.#studioHeaders(headers);
    headers.set("Cookie", session.cookie);
    // Short JSON endpoints (catalog/upload/parse): default 15s timeout. Safe
    // to wrap the whole fetch — no active SSE runs under this signal (that
    // is the chat-only pitfall where a whole-fetch timeout kills a live
    // stream).
    const resp = await fetch(`${this.base}${path}?${q}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: signal ?? AbortSignal.timeout(15_000),
    });
    const raw = await resp.text();
    if (resp.status !== 200) {
      const ue = new UpstreamError(resp.status, raw, resp.headers);
      if (resp.status === 401) throw new AuthExpiredError(`upstream 401 on ${path}`);
      throw ue;
    }
    let env;
    try {
      env = JSON.parse(raw);
    } catch {
      throw new Error(`${method} ${path}: bad envelope: ${truncateForLog(raw, 200)}`);
    }
    if (env.code !== 0) throw new BizError(env.code, env.msg ?? "");
    return env.data ?? null;
  }

  // ---- model catalog ----

  /**
   * The account's own catalog — the single source of truth. Rows from
   * modelConfigList carry the capability defaults; entries with redirectTo
   * are superseded ids and are not advertised.
   */
  async fetchCatalog(session, signal) {
    const data = await this.#callJSON(session, "GET", "/open-apis/bot/config", {}, signal);
    const rows = Array.isArray(data?.modelConfigList) ? data.modelConfigList : [];
    const ngRows = Array.isArray(data?.modelConfigListNg) ? data.modelConfigListNg : [];
    const ngByID = new Map(ngRows.map((r) => [r?.model, r]));
    const models = [];
    for (const r of rows) {
      if (!r?.model) continue;
      // Superseded rows are dropped: the redirect marker lives in the ng
      // table (live probe 2026-11: every legacy id — v2/v2.1/v2.5, claw
      // alphas — carries redirectTo there; modelConfigList rows carry none).
      // Requests naming a dropped id still resolve via gateway normalization
      // to the target, but the listing only offers current models.
      const ng = ngByID.get(r.model) ?? {};
      if (ng.redirectTo || r.redirectTo) continue;
      const ws = r.webSearchDefaultStatus;
      models.push({
        id: r.model,
        name: r.name || ng.name || r.model,
        pageType: ng.pageType || r.pageType || "chat",
        thinkingDefault: r.thinkingDefaultOn === true,
        webSearch: ws === "auto" ? 2 : ws === "disabled" ? 1 : 0,
        nToken: typeof r.nToken === "string" ? r.nToken : "",
      });
    }
    return { models, ext: data?.ext ?? {} };
  }

  // ---- chat ----

  /** Build one upstream chat payload (shared by both channels). */
  #chatPayload({ query, model, conversationId, previousDialogId, enableThinking, webSearchStatus, temperature, topP, multiMedias }) {
    return {
      msgId: randomHex32(),
      conversationId: conversationId || randomHex32(),
      query,
      isEditedQuery: false,
      previousDialogueId: previousDialogId || null,
      sceneType: null,
      params: {},
      modelConfig: {
        model,
        enableThinking: !!enableThinking,
        webSearchStatus: webSearchStatus || "disabled",
        ...(temperature !== undefined ? { temperature } : {}),
        ...(topP !== undefined ? { topP } : {}),
      },
      multiMedias: multiMedias ?? [],
    };
  }

  /**
   * One upstream chat turn over the react channel. Streams
   * { type: "reasoning"|"content", text } pieces; resolves with the turn
   * result { dialogId, content, reasoning, usage, citations }.
   */
  async chatStream(session, req, signal) {
    const path = isFastchatModel(req.model) ? CHAT_PATH_FASTCHAT : CHAT_PATH_REACT;
    const q = new URLSearchParams();
    // URLSearchParams applies the application/x-www-form-urlencoded encoding
    // itself (space → '+'), which matches the SPA's encodeURIComponent
    // semantics for this value — do NOT pre-encode (double encoding → 401).
    if (session.ph) q.set("xiaomichatbot_ph", session.ph);
    const headers = new Headers();
    this.#studioHeaders(headers);
    headers.set("Cookie", session.cookie);

    const payload = this.#chatPayload(req);
    const ctrl = new AbortController();
    const onSignal = () => ctrl.abort(signal?.reason);
    // Already-aborted external signal: fail fast instead of firing an
    // upstream request that is doomed to be cancelled.
    if (signal?.aborted) {
      throw signal.reason ?? new Error("aborted before upstream call");
    }
    signal?.addEventListener("abort", onSignal, { once: true });

    // Idle watchdog: every byte resets it; silence past the window aborts.
    let idleTimer = null;
    let gotAny = false;
    const armIdle = () => {
      if (!this.idleMs || this.idleMs <= 0) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        ctrl.abort(new Error(`upstream silent for ${Math.round(this.idleMs / 1000)}s`));
      }, this.idleMs);
    };
    armIdle();

    let resp;
    try {
      resp = await fetch(`${this.base}${path}?${q}`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
    } catch (e) {
      if (idleTimer) clearTimeout(idleTimer);
      signal?.removeEventListener("abort", onSignal);
      throw e;
    }

    if (resp.status !== 200) {
      if (idleTimer) clearTimeout(idleTimer);
      signal?.removeEventListener("abort", onSignal);
      const body = await resp.text().catch(() => "");
      if (resp.status === 401) throw new AuthExpiredError("chat: upstream 401");
      throw new UpstreamError(resp.status, body, resp.headers);
    }

    const state = {
      dialogId: "",
      content: "",
      reasoning: "",
      usage: null,
      citations: [],
      sawDeltas: false,
      splitter: new ThinkSplitter(),
      done: false,
    };

    const handle = async (ev) => {
      gotAny = true;
      armIdle();
      switch (ev.event) {
        case "dialogId": {
          try {
            const p = JSON.parse(ev.data);
            if (p.content) state.dialogId = p.content;
          } catch {}
          return;
        }
        case "message": {
          let p;
          try {
            p = JSON.parse(ev.data);
          } catch {
            return; // malformed delta: skip, never kill the stream
          }
          if (!p.reasoningContent && !p.content) return; // tool frames carry no text
          state.sawDeltas = true;
          if (p.reasoningContent) {
            state.reasoning += p.reasoningContent;
            req.onPiece?.({ type: "reasoning", text: p.reasoningContent });
          }
          for (const piece of state.splitter.push(p.content)) {
            if (piece.type === "reasoning") state.reasoning += piece.text;
            else state.content += piece.text;
            req.onPiece?.(piece);
          }
          return;
        }
        case "usage": {
          try {
            state.usage = JSON.parse(ev.data); // last one wins
          } catch {}
          return;
        }
        case "finish": {
          try {
            const p = JSON.parse(ev.data);
            if (p.content === "[DONE]") state.done = true;
          } catch {}
          return;
        }
        case "error": {
          let msg = "";
          try {
            msg = JSON.parse(ev.data).content ?? "";
          } catch {
            msg = ev.data;
          }
          if (msg.includes("繁忙") || msg.includes("稍后再试")) throw new StreamFrameError("busy", msg);
          if (msg.includes("模型名称") || msg.includes("模型不存在")) throw new StreamFrameError("model-rejected", msg);
          throw new StreamFrameError("stream", msg);
        }
        case "sensitive_query":
        case "sensitive_title": {
          let msg = "";
          try {
            msg = JSON.parse(ev.data).content ?? "";
          } catch {}
          throw new ContentFilterError(ev.event, msg);
        }
        case "web_search": {
          state.citations.push(...parseWebSearch(ev.data));
          return;
        }
        // doc / tip_ratio / tip_truncate: search progress, nothing client-visible
      }
    };

    try {
      await parseSSE(resp.body, handle, ctrl.signal);
      // flush an unterminated think block
      for (const piece of state.splitter.flush()) {
        if (piece.type === "reasoning") state.reasoning += piece.text;
        else state.content += piece.text;
        req.onPiece?.(piece);
      }
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      signal?.removeEventListener("abort", onSignal);
      try {
        await resp.body.cancel();
      } catch {}
    }

    if (!state.sawDeltas && !state.done) throw new Error("upstream returned an empty response");
    return {
      dialogId: state.dialogId,
      content: state.content,
      reasoning: state.reasoning,
      usage: state.usage,
      citations: state.citations,
    };
  }

  // ---- attachments surface ----

  async uploadFile(session, fileName, bytes, signal) {
    const digest = md5Hex(bytes);
    const data = await this.#callJSON(
      session,
      "POST",
      "/open-apis/resource/genUploadInfo",
      { body: { fileName, fileContentMd5: digest } },
      signal,
    );
    const uploadURL = data?.uploadUrl ?? "";
    const resourceURL = data?.resourceUrl ?? "";
    const objectName = data?.objectName ?? "";
    if (!uploadURL || !resourceURL) throw new Error("resource upload: genUploadInfo returned no uploadUrl/resourceUrl");

    const headers = new Headers();
    this.#storageHeaders(headers);
    headers.set("Content-Type", "application/octet-stream");
    headers.set("content-md5", digest);
    const resp = await fetch(uploadURL, { method: "PUT", headers, body: bytes, signal });
    if (resp.status < 200 || resp.status > 299) {
      const t = await resp.text().catch(() => "");
      throw new Error(`resource upload: storage ${resp.status}: ${truncateForLog(t, 200)}`);
    }
    try {
      await resp.arrayBuffer();
    } catch {}
    return { resourceUrl: resourceURL, objectName };
  }

  /** Ask the platform to parse an uploaded file; retry on transient failures. */
  async parseResource(session, fileURL, objectName, model, signal) {
    const query = { fileUrl: fileURL, objectName };
    if (model) query.model = model;
    let lastErr = null;
    for (let attempt = 0; attempt < PARSE_ATTEMPTS; attempt++) {
      if (attempt > 0) await sleep(attempt * 500);
      try {
        const data = await this.#callJSON(session, "POST", "/open-apis/resource/parse", { query, body: {} }, signal);
        const id = data?.id ?? "";
        if (!id) throw new Error("resource parse: no parse result id (the platform parsed nothing)");
        return { id, tokenUsage: data?.tokenUsage ?? 0 };
      } catch (e) {
        lastErr = e;
        if (e instanceof AuthExpiredError) throw e;
        if (e instanceof BizError) continue; // transient under load
        if (e instanceof UpstreamError && e.status >= 500) continue;
        throw e;
      }
    }
    throw lastErr ?? new Error("resource parse failed");
  }
}

