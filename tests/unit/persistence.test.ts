import { describe, expect, it } from "vitest";
import { loadTemplateSnapshot, saveTemplateSnapshot, storageKeyForTemplate, type StorageLike } from "../../src/domain/persistence";
import { createFactoryState } from "../../src/domain/templates";

class TrackingStorage implements StorageLike {
  readonly values = new Map<string, string>();
  readonly reads: string[] = [];
  readonly writes: string[] = [];
  setError: Error | null = null;

  getItem(key: string): string | null {
    this.reads.push(key);
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.writes.push(key);
    if (this.setError) throw this.setError;
    this.values.set(key, value);
  }
}

describe("strict, namespaced local persistence", () => {
  it("uses exactly one versioned Elnuva key per template and persists only the strict envelope", () => {
    expect(storageKeyForTemplate("home-office")).toBe("elnuva:v1:template:home-office");
    expect(storageKeyForTemplate("bedroom")).toBe("elnuva:v1:template:bedroom");
    const storage = new TrackingStorage();
    storage.values.set("unrelated", "keep-me");
    const state = createFactoryState("home-office");
    expect(saveTemplateSnapshot(storage, state)).toStrictEqual({ ok: true });
    expect(JSON.parse(storage.values.get("elnuva:v1:template:home-office")!)).toStrictEqual({ storageVersion: 1, templateId: "home-office", state });
    expect(storage.writes).toStrictEqual(["elnuva:v1:template:home-office"]);
    expect(storage.values.get("unrelated")).toBe("keep-me");
  });

  it("falls back only for the affected corrupt, unknown-field, wrong-template, or version-mismatched snapshot", () => {
    const storage = new TrackingStorage();
    storage.values.set("elnuva:v1:template:home-office", "{bad json");
    expect(loadTemplateSnapshot(storage, "home-office")).toMatchObject({ ok: false, fallback: true, state: createFactoryState("home-office") });
    storage.values.set("elnuva:v1:template:bedroom", JSON.stringify({ storageVersion: 2, templateId: "bedroom", state: createFactoryState("bedroom") }));
    expect(loadTemplateSnapshot(storage, "bedroom")).toMatchObject({ ok: false, fallback: true });
    storage.values.set("elnuva:v1:template:study", JSON.stringify({ storageVersion: 1, templateId: "study", state: { ...createFactoryState("study"), room: { ...createFactoryState("study").room, extra: true } } }));
    expect(loadTemplateSnapshot(storage, "study")).toMatchObject({ ok: false, fallback: true, state: createFactoryState("study") });
    expect(storage.reads).toStrictEqual(["elnuva:v1:template:home-office", "elnuva:v1:template:bedroom", "elnuva:v1:template:study"]);
  });

  it("keeps in-memory state on quota/security failures with bounded sanitized errors", () => {
    const storage = new TrackingStorage();
    storage.setError = new Error("quota secret://token");
    const result = saveTemplateSnapshot(storage, createFactoryState("home-office"));
    expect(result).toMatchObject({ ok: false, error: { code: "STORAGE_UNAVAILABLE" } });
    expect((result as { error: { message: string } }).error.message).not.toContain("quota");
    expect((result as { error: { message: string } }).error.message).not.toContain("token");
    expect((result as { error: { message: string } }).error.message.length).toBeLessThanOrEqual(160);
  });
});
