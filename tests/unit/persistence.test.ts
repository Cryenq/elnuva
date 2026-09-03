import { describe, expect, it } from "vitest";
import { MemoryStorage, loadTemplateSnapshot, saveTemplateSnapshot, storageKeyForTemplate } from "../../src/domain/persistence";
import { createFactoryState } from "../../src/domain/templates";

describe("strict, namespaced local persistence", () => {
  it("uses exactly one versioned Elnuva key per template and persists only the strict envelope", () => {
    expect(storageKeyForTemplate("home-office")).toBe("elnuva:v1:template:home-office");
    expect(storageKeyForTemplate("bedroom")).toBe("elnuva:v1:template:bedroom");
    const storage = new MemoryStorage(); const state = createFactoryState("home-office");
    expect(saveTemplateSnapshot(storage, state)).toStrictEqual({ ok: true });
    expect(JSON.parse(storage.getItem("elnuva:v1:template:home-office")!)).toStrictEqual({ storageVersion: 1, templateId: "home-office", state });
    expect(storage.clearCalls).toBe(0);
  });

  it("falls back only for the affected corrupt, unknown-field, wrong-template, or version-mismatched snapshot", () => {
    const storage = new MemoryStorage(); storage.setItem("elnuva:v1:template:home-office", "{bad json");
    expect(loadTemplateSnapshot(storage, "home-office")).toMatchObject({ ok: false, fallback: true, state: createFactoryState("home-office") });
    storage.setItem("elnuva:v1:template:bedroom", JSON.stringify({ storageVersion: 2, templateId: "bedroom", state: createFactoryState("bedroom") }));
    expect(loadTemplateSnapshot(storage, "bedroom")).toMatchObject({ ok: false, fallback: true });
    storage.setItem("elnuva:v1:template:study", JSON.stringify({ storageVersion: 1, templateId: "home-office", state: createFactoryState("study"), extra: true }));
    expect(loadTemplateSnapshot(storage, "study")).toMatchObject({ ok: false, fallback: true, state: createFactoryState("study") });
  });

  it("keeps in-memory state on quota/security failures with bounded errors and never exposes raw storage data", () => {
    const storage = new MemoryStorage({ setItemError: new Error("quota secret://token") });
    const result = saveTemplateSnapshot(storage, createFactoryState("home-office"));
    expect(result).toMatchObject({ ok: false, error: { code: "STORAGE_UNAVAILABLE" } });
    expect((result as any).error.message).not.toContain("quota");
    expect((result as any).error.message).not.toContain("token");
    expect(storage.clearCalls).toBe(0);
  });
});
