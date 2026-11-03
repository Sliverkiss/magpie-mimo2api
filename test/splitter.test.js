// test/splitter.test.js — think-marker splitter, SSE parser, citations, turn planning.
import { describe, test, expect } from "bun:test";
import { ThinkSplitter, parseWebSearch, planFullReplay, normalizeMessages } from "../src/mimo.mjs";

describe("ThinkSplitter", () => {
  // Real deltas carry the marker followed by a NUL byte; NULs are stripped
  // on entry and the bare markers are matched.
  test("no marker: plain content", () => {
    const s = new ThinkSplitter();
    expect(s.push("hello world")).toEqual([{ type: "content", text: "hello world" }]);
  });

  test("marker-dotted deltas split reasoning from content", () => {
    const s = new ThinkSplitter();
    expect(s.push("<think\x00let me think")).toEqual([{ type: "reasoning", text: "let me think" }]);
    expect(s.push("</think\x00Hi!")).toEqual([{ type: "content", text: "Hi!" }]);
    expect(s.flush()).toEqual([]);
  });

  test("stray NUL deltas and embedded NULs are stripped", () => {
    const s = new ThinkSplitter();
    const out = [...s.push("<think\x00deep"), ...s.push("\x00"), ...s.push("</think\x00answer"), ...s.flush()];
    expect(out.map((p) => p.type)).toEqual(["reasoning", "content"]);
    expect(out[0].text).toBe("deep");
    expect(out[1].text).toBe("answer");
  });

  test("marker split across pushes is recognized", () => {
    const s = new ThinkSplitter();
    expect(s.push("abc</thi")).toEqual([{ type: "content", text: "abc" }]); // partial marker held back
    expect(s.push("nk\x00answer")).toEqual([{ type: "content", text: "answer" }]);
  });

  test("unterminated think block flushes as reasoning", () => {
    const s = new ThinkSplitter();
    const out = [...s.push("<think\x00still thinking"), ...s.flush()];
    expect(out).toEqual([{ type: "reasoning", text: "still thinking" }]);
  });
});

describe("parseWebSearch", () => {
  test("bare array", () => {
    const cits = parseWebSearch(JSON.stringify([{ name: "t", url: "https://a", displayUrl: "a", snippet: "s", usedContent: true }]));
    expect(cits).toEqual([{ title: "t", url: "https://a", displayUrl: "a", snippet: "s", used: true }]);
  });
  test("data-wrapped array", () => {
    const cits = parseWebSearch(JSON.stringify({ data: [{ url: "https://b" }] }));
    expect(cits[0].url).toBe("https://b");
  });
  test("tolerates junk fields and entries without url", () => {
    const cits = parseWebSearch(JSON.stringify([{ name: 42, url: "https://c", usedContent: "True" }, { name: "no url" }]));
    expect(cits.length).toBe(1);
    expect(cits[0].used).toBe(true);
  });
  test("empty and malformed payloads are silent no-ops", () => {
    expect(parseWebSearch("")).toEqual([]);
    expect(parseWebSearch("null")).toEqual([]);
    expect(parseWebSearch("not json")).toEqual([]);
  });
});

describe("planFullReplay", () => {
  test("one query per user message; systems splice into the first", () => {
    const plan = planFullReplay([
      { role: "system", content: "be brief" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "more" },
    ]);
    expect(plan.turns).toHaveLength(2);
    expect(plan.turns[0].query).toBe("be brief\n\n---\n\nhi");
    expect(plan.turns[1].query).toBe("more");
    expect(plan.systemsJoined).toBe(true);
  });

  test("image-only user message gets the neutral query", () => {
    const plan = planFullReplay([{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,xx" } }] }]);
    expect(plan.turns[0].query).toBe("请描述这张图片。");
    expect(plan.turns[0].media).toEqual(["data:image/png;base64,xx"]);
  });

  test("no user message rejects", () => {
    expect(() => planFullReplay([{ role: "system", content: "x" }])).toThrow(/no sendable user message/);
  });

  test("turn cap", () => {
    const msgs = Array.from({ length: 25 }, () => ({ role: "user", content: "x" }));
    expect(() => planFullReplay(msgs, 20)).toThrow(/replay cap/);
  });

  test("string and array content both normalize", () => {
    const norm = normalizeMessages([
      { role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] },
      { role: "assistant", content: "ignored in plan" },
    ]);
    expect(norm[0].text).toBe("ab");
  });
});
