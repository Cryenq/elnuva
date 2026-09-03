import { describe, expect, it } from "vitest";
import { createDocumentStore } from "../../src/domain/store";
import { verifyStageRequest } from "../../src/domain/validator";
import { createWebMcpHandlers } from "../../src/webmcp/handlers";
import type { StageRequest, TemplateId } from "../../src/domain/types";

const HASHES: Record<TemplateId, string> = {
  "home-office": "54314a64f990ba98d9244a679e81d4037fc97c6275936c12e38ec243ca6aeb2e",
  bedroom: "bf71347d179de915dfb3976edd97e39da3673b35a94547dd51ed8ce3721a081b",
  study: "b2ba6f48701ab423805262c9136c6052ae3a5052da50448290124d087f764274",
};
const FIXTURES = {
  "home-office": { optionId: "home-valid", key: "fixture-home-0001", digest: "0a1cb9ff5ba7bd65c1bdcb478bf53c55dc8c01a1605fe02fc2147151fe0db68f", moves: [{ itemId: "desk-main", pose: { xMm: 1900, yMm: 500, rotationDeg: 0 } }] },
  bedroom: { optionId: "bedroom-valid", key: "fixture-bedroom-0001", digest: "ed108b27fb2579fd0984b3f1cc3ab2a658d0d530f8a0f1825971ac9f477f785e", moves: [{ itemId: "bed-main", pose: { xMm: 2700, yMm: 2100, rotationDeg: 0 } }, { itemId: "nightstand-main", pose: { xMm: 3950, yMm: 2500, rotationDeg: 90 } }] },
  study: { optionId: "study-valid", key: "fixture-study-0001", digest: "8492eb42816a0c8d1018410e7a5e16b120051a8166669ca9924a3d65d94fd24f", moves: [{ itemId: "table-main", pose: { xMm: 1500, yMm: 2100, rotationDeg: 0 } }, { itemId: "chair-main", pose: { xMm: 2300, yMm: 1400, rotationDeg: 0 } }] },
} as const;

async function stageFixture(templateId: TemplateId) {
  const store = createDocumentStore({ stageVerifier: verifyStageRequest });
  expect(store.activateTemplate(templateId)).toMatchObject({ ok: true });
  const handlers = createWebMcpHandlers(store);
  const before = await handlers.inspect({}, { signal: new AbortController().signal });
  expect(before.ok).toBe(true);
  const fixture = FIXTURES[templateId];
  const request: StageRequest = { baseRevision: 1, baseHash: HASHES[templateId], constraints: before.ok ? before.data.workingState.constraints : [], optionId: fixture.optionId, moves: fixture.moves, proposalDigest: fixture.digest, idempotencyKey: fixture.key };
  const result = await handlers.stage(request, { signal: new AbortController().signal });
  return { store, handlers, before, request, result };
}

describe("T07 real registered-tool preview transaction", () => {
  it.each(Object.keys(FIXTURES) as TemplateId[])("stages %s as an ephemeral, exact human review", async (templateId) => {
    const { store, handlers, before, request, result } = await stageFixture(templateId);
    expect(result).toMatchObject({ ok: true, data: { previewId: request.proposalDigest, optionId: request.optionId, proposalDigest: request.proposalDigest, notApplied: true, notSaved: true, requiresHumanAction: true, allowedHumanActions: ["apply", "discard"] } });
    const after = await handlers.inspect({}, { signal: new AbortController().signal });
    expect(after).toMatchObject({ ok: true, data: { baseRevision: 1, baseHash: request.baseHash, preview: { status: "pending-review", optionId: request.optionId, proposalDigest: request.proposalDigest, notApplied: true, notSaved: true } } });
    expect(after).toMatchObject({ ok: true, data: { workingState: before.ok ? before.data.workingState : undefined } });
    expect(store.recordCount).toBe(1);
    expect(store.discard()).toMatchObject({ ok: true });
    expect((await store.snapshot()).preview).toBeNull();
    expect(store.recordCount).toBe(1);
    expect(await handlers.stage(request, { signal: new AbortController().signal })).toStrictEqual(result);
    expect((await store.snapshot()).preview).toBeNull();
  });

  it("rejects a new Stage while review is pending and preserves protected state", async () => {
    const first = await stageFixture("home-office");
    const second = { ...first.request, idempotencyKey: "fixture-home-0002" };
    const result = await first.handlers.stage(second, { signal: new AbortController().signal });
    expect(result).toMatchObject({ ok: false, error: { code: "PENDING_REVIEW" } });
    expect((await first.store.snapshot()).baseRevision).toBe(1);
    expect(first.store.recordCount).toBe(1);
  });

  it("returns cancellation truth and never creates a ghost", async () => {
    const store = createDocumentStore({ stageVerifier: verifyStageRequest });
    const handlers = createWebMcpHandlers(store);
    const inspected = await handlers.inspect({}, { signal: new AbortController().signal });
    if (!inspected.ok) throw new Error("fixture inspect failed");
    const fixture = FIXTURES["home-office"];
    const request: StageRequest = { baseRevision: 1, baseHash: HASHES["home-office"], constraints: inspected.data.workingState.constraints, optionId: fixture.optionId, moves: fixture.moves, proposalDigest: fixture.digest, idempotencyKey: fixture.key };
    const controller = new AbortController(); controller.abort();
    expect(await handlers.stage(request, { signal: controller.signal })).toMatchObject({ ok: false, error: { code: "CANCELLED" } });
    expect((await store.snapshot()).preview).toBeNull();
    expect(store.recordCount).toBe(0);
  });

  it("Apply changes working revision once, leaves Save separate, and permits one Undo", async () => {
    const storage = new Map<string, string>();
    const { store, before } = await (async () => {
      const store = createDocumentStore({ storage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value); } }, stageVerifier: verifyStageRequest });
      expect(store.activateTemplate("home-office")).toMatchObject({ ok: true });
      const handlers = createWebMcpHandlers(store);
      const before = await handlers.inspect({}, { signal: new AbortController().signal });
      if (!before.ok) throw new Error("fixture inspect failed");
      const fixture = FIXTURES["home-office"];
      const request: StageRequest = { baseRevision: 1, baseHash: HASHES["home-office"], constraints: before.data.workingState.constraints, optionId: fixture.optionId, moves: fixture.moves, proposalDigest: fixture.digest, idempotencyKey: fixture.key };
      const result = await handlers.stage(request, { signal: new AbortController().signal });
      expect(result.ok).toBe(true);
      return { store, before };
    })();
    const applied = await store.apply();
    expect(applied).toMatchObject({ ok: true });
    const after = await store.snapshot();
    expect(after.baseRevision).toBe(2);
    expect(after.preview).toBeNull();
    expect(after.workingState.furniture).not.toStrictEqual(before.ok ? before.data.workingState.furniture : []);
    expect(store.save()).toMatchObject({ ok: true });
    expect(store.undo()).toMatchObject({ ok: true });
    expect((await store.snapshot()).baseRevision).toBe(3);
    expect(store.undo()).toMatchObject({ ok: false, error: { code: "NOTHING_TO_UNDO" } });
  });
});
