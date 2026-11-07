// test/capabilities.test.js — every static model says what it takes.
//
// A config-hook model that names no modality is not "text only": it is "the
// vendor never spoke". magpie then votes models.dev by bare model id, and any
// text-only vendor serving the same id takes the capability away — the model
// runs, but screenshots go straight upstream and are refused. Nothing logs it.
//
// So the declaration is load-bearing, and this test is what makes a new model
// ship without one turn red instead of silent.
import { describe, test, expect } from "bun:test";
import { Mimo2ApiPlugin, _internal } from "../index.mjs";

const { listFromCatalog } = _internal;

const KINDS = ["text", "image", "audio", "video", "pdf"];

/** Every static model the config hook publishes, as [id, model]. */
async function configModels() {
  const cfg = {};
  const plugin = await Mimo2ApiPlugin({ client: {} }, {});
  await plugin.config(cfg);
  return Object.values(cfg.provider).flatMap((p) => Object.entries(p.models ?? {}));
}

describe("model capabilities", () => {
  test("every static model declares modalities and attachment", async () => {
    const models = await configModels();
    expect(models.length).toBeGreaterThan(0);

    for (const [id, m] of models) {
      expect({ id, input: Array.isArray(m.modalities?.input) }).toEqual({ id, input: true });
      expect({ id, output: Array.isArray(m.modalities?.output) }).toEqual({ id, output: true });
      expect({ id, attachment: typeof m.attachment }).toEqual({ id, attachment: "boolean" });
      for (const k of m.modalities.input) expect({ id, kind: KINDS.includes(k) }).toEqual({ id, kind: true });
      for (const k of m.modalities.output) expect({ id, kind: KINDS.includes(k) }).toEqual({ id, kind: true });
    }
  });

  test("every static model takes images", async () => {
    // The plugin implements image understanding end to end (image_url →
    // genUploadInfo → parse → multiMedias). If a model ever lands here that
    // genuinely cannot, this is where the exception gets written — not by
    // deleting the assertion.
    for (const [id, m] of await configModels()) {
      expect({ id, takesImages: m.modalities.input.includes("image") }).toEqual({ id, takesImages: true });
      expect({ id, attachment: m.attachment }).toEqual({ id, attachment: true });
    }
  });

  test("text is always among the kinds it takes", async () => {
    for (const [id, m] of await configModels()) {
      expect({ id, text: m.modalities.input.includes("text") }).toEqual({ id, text: true });
    }
  });
});

describe("catalog models", () => {
  // The upstream adds models under us. A catalog row with no static
  // counterpart reaches magpie with nothing said of its modalities, which
  // reads as "the vendor never spoke" — the same silent blindness, one
  // release later, wearing a different id.
  const provider = {
    models: {
      "static-capable": { modalities: { input: ["text", "image"], output: ["text"] }, attachment: true },
      "static-text-only": { modalities: { input: ["text"], output: ["text"] }, attachment: false },
    },
  };

  test("a catalog row with no static counterpart still declares what it takes", () => {
    const out = listFromCatalog(
      { models: [{ id: "brand-new", name: "Brand New", nToken: "1M" }] },
      provider,
    );
    const m = out["brand-new"];
    expect(m).toBeDefined();
    expect(m.modalities.input).toContain("image");
    expect(m.modalities.input).toContain("text");
    expect(Array.isArray(m.modalities.output)).toBe(true);
    expect(m.attachment).toBe(true);
  });

  test("a static entry's own word wins over the default", () => {
    const out = listFromCatalog(
      { models: [{ id: "static-text-only", name: "Text Only", nToken: "512K" }] },
      provider,
    );
    const m = out["static-text-only"];
    expect(m.modalities.input).toEqual(["text"]);
    expect(m.modalities.input).not.toContain("image");
    expect(m.attachment).toBe(false);
  });

  test("a catalog model keeps the static entry's image capability", () => {
    const out = listFromCatalog(
      { models: [{ id: "static-capable", name: "Capable", nToken: "1M" }] },
      provider,
    );
    expect(out["static-capable"].modalities.input).toContain("image");
  });

  test("a row that is not a chat model is left out", () => {
    const out = listFromCatalog(
      { models: [{ id: "tts-1", name: "TTS", pageType: "tts" }] },
      provider,
    );
    expect(out["tts-1"]).toBeUndefined();
  });
});
