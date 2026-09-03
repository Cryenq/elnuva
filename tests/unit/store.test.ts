import { describe, expect, it } from "vitest";
import { createDocumentStore } from "../../src/domain/store";
import { MemoryStorage } from "../../src/domain/persistence";

describe("per-template command store", () => {
  it("initializes Home Office once at revision 1 and keeps each template draft/revision isolated", () => {
    const store = createDocumentStore({ storage: new MemoryStorage() });
    expect(store.snapshot()).toMatchObject({ activeTemplateId: "home-office", baseRevision: 1, preview: { status: "none" } });
    const homeHash = store.snapshot().baseHash;
    expect(store.activateTemplate("bedroom")).toMatchObject({ ok: true });
    expect(store.snapshot()).toMatchObject({ activeTemplateId: "bedroom", baseRevision: 1 });
    expect(store.updateFurniturePose("bed-main", { xMm: 2700, yMm: 2100, rotationDeg: 0 })).toMatchObject({ ok: true });
    expect(store.snapshot().baseRevision).toBe(2);
    expect(store.activateTemplate("home-office")).toMatchObject({ ok: true });
    expect(store.snapshot()).toMatchObject({ activeTemplateId: "home-office", baseRevision: 1, baseHash: homeHash });
  });

  it("increments only the active draft once per human edit/reset/apply/undo; switch, stage, discard do not", async () => {
    const store = createDocumentStore({ storage: new MemoryStorage() });
    const before = store.snapshot();
    expect(store.updateFurniturePose("desk-main", { xMm: 1900, yMm: 500, rotationDeg: 0 })).toMatchObject({ ok: true });
    expect(store.snapshot().baseRevision).toBe(2);
    expect(store.undo()).toMatchObject({ ok: true });
    expect(store.snapshot().baseRevision).toBe(3);
    expect(store.reset()).toMatchObject({ ok: true });
    expect(store.snapshot().baseRevision).toBe(4);
    expect(store.snapshot().workingState).toStrictEqual(before.workingState);
    expect(store.activateTemplate("study")).toMatchObject({ ok: true });
    expect(store.snapshot().baseRevision).toBe(1);
  });

  it("blocks all non-Apply/Discard mutations while a preview is pending and never lets Stage mutate durable state", async () => {
    const store = createDocumentStore({ storage: new MemoryStorage() });
    const initial = store.snapshot();
    const staged = await store.stage({ baseRevision: 1, baseHash: initial.baseHash, constraints: initial.workingState.constraints, optionId: "home-valid", moves: [{ itemId: "desk-main", pose: { xMm: 1900, yMm: 500, rotationDeg: 0 } }], proposalDigest: "0a1cb9ff5ba7bd65c1bdcb478bf53c55dc8c01a1605fe02fc2147151fe0db68f", idempotencyKey: "fixture-home-0001" });
    expect(staged).toMatchObject({ ok: true, data: { notApplied: true, notSaved: true, requiresHumanAction: true, allowedHumanActions: ["apply", "discard"] } });
    expect(store.snapshot().workingState).toStrictEqual(initial.workingState);
    expect(store.snapshot().baseRevision).toBe(1);
    for (const action of [() => store.save(), () => store.activateTemplate("bedroom"), () => store.updateFurniturePose("desk-main", { xMm: 1800, yMm: 500, rotationDeg: 0 }), () => store.reset(), () => store.undo()]) expect(action()).toMatchObject({ ok: false, error: { code: "PENDING_REVIEW" } });
    expect(store.discard()).toMatchObject({ ok: true });
    expect(store.snapshot()).toMatchObject({ baseRevision: 1, preview: { status: "none" } });
  });

  it("applies one preview with one undo snapshot, preserves successful-key tombstones through reset, and clears them only for a new Document", async () => {
    const storage = new MemoryStorage();
    const store = createDocumentStore({ storage }); const start = store.snapshot();
    const request = { baseRevision: 1, baseHash: start.baseHash, constraints: start.workingState.constraints, optionId: "home-valid", moves: [{ itemId: "desk-main", pose: { xMm: 1900, yMm: 500, rotationDeg: 0 } }], proposalDigest: "0a1cb9ff5ba7bd65c1bdcb478bf53c55dc8c01a1605fe02fc2147151fe0db68f", idempotencyKey: "fixture-home-0001" };
    const success = await store.stage(request); expect(store.apply()).toMatchObject({ ok: true }); expect(store.snapshot().baseRevision).toBe(2);
    expect(store.undo()).toMatchObject({ ok: true }); expect(store.snapshot().baseRevision).toBe(3);
    expect(store.reset()).toMatchObject({ ok: true });
    expect(await store.stage(request)).toStrictEqual(success);
    expect(store.snapshot().preview).toStrictEqual({ status: "none" });
    const fresh = createDocumentStore({ storage });
    expect(await fresh.stage({ ...request, baseHash: fresh.snapshot().baseHash })).toMatchObject({ ok: true });
  });
});
