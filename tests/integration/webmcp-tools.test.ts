import { describe, expect, it } from "vitest";

import { createDocumentStore } from "../../src/domain/store";
import { createHomeOfficeInspectData } from "../../src/domain/fixture";
import { verifyStageRequest, validateLayoutOptions, recomputeStageValidation } from "../../src/domain/validator";

describe("T06 tool/domain integration", () => {
  it("uses one shared injected store and Inspect is read-only", async () => {
    const store = createDocumentStore({ storage: null });
    const before = await store.snapshot();
    const inspected = await store.inspect();
    const after = await store.snapshot();
    expect(inspected.baseRevision).toBe(before.baseRevision);
    expect(inspected.baseHash).toBe(after.baseHash);
    expect(after.workingState).toStrictEqual(before.workingState);
    expect(after.preview).toBeNull();
    expect(store.recordCount).toBe(0);
  });

  it("rejects malformed/foreign Validate requests before evaluating options", async () => {
    const store = createDocumentStore({ storage: null });
    const snapshot = await store.snapshot();
    const malformed = await validateLayoutOptions({ workingState: snapshot.workingState, baseRevision: snapshot.baseRevision, baseHash: snapshot.baseHash }, {
      baseRevision: snapshot.baseRevision, baseHash: snapshot.baseHash, constraints: snapshot.workingState.constraints,
      options: [{ optionId: "one", moves: [] }], unknown: true,
    });
    expect(malformed).toStrictEqual({ ok: false, error: { code: "INVALID_INPUT", message: "The request is invalid." } });
    const stale = await validateLayoutOptions({ workingState: snapshot.workingState, baseRevision: snapshot.baseRevision + 1, baseHash: snapshot.baseHash }, {
      baseRevision: snapshot.baseRevision, baseHash: snapshot.baseHash, constraints: snapshot.workingState.constraints,
      options: [{ optionId: "one", moves: [{ itemId: "desk-main", pose: { xMm: 1900, yMm: 500, rotationDeg: 0 } }] }],
    });
    expect(stale).toMatchObject({ ok: false, error: { code: "REVISION_CONFLICT" } });
  });

  it("keeps Stage summary independent of prior option rank and only commits preview", async () => {
    const store = createDocumentStore({ storage: null, stageVerifier: verifyStageRequest });
    const snapshot = await store.snapshot();
    const request = {
      baseRevision: snapshot.baseRevision, baseHash: snapshot.baseHash, constraints: snapshot.workingState.constraints,
      optionId: "home-valid", moves: [{ itemId: "desk-main", pose: { xMm: 1900, yMm: 500, rotationDeg: 0 } }],
      proposalDigest: "0a1cb9ff5ba7bd65c1bdcb478bf53c55dc8c01a1605fe02fc2147151fe0db68f", idempotencyKey: "fixture-home-0001",
    } as const;
    const validation = await recomputeStageValidation(snapshot, request);
    expect(validation).toMatchObject({ ok: true, data: { optionId: "home-valid", hardValid: true, stageable: true, issues: [] } });
    const result = await store.stage(request);
    expect(result).toMatchObject({ ok: true, data: { notApplied: true, notSaved: true, requiresHumanAction: true, allowedHumanActions: ["apply", "discard"] } });
    const committed = await store.snapshot();
    expect(committed.baseRevision).toBe(snapshot.baseRevision);
    expect(committed.workingState).toStrictEqual(snapshot.workingState);
    expect(committed.preview).toMatchObject({ status: "pending-review", optionId: "home-valid" });
    expect(store.recordCount).toBe(1);
  });

  it("replays same key without a second verifier call and rejects digest swapping", async () => {
    const verifier = async (input: Parameters<typeof verifyStageRequest>[0]) => verifyStageRequest(input);
    const store = createDocumentStore({ storage: null, stageVerifier: verifier });
    const snapshot = await store.snapshot();
    const request = { baseRevision: snapshot.baseRevision, baseHash: snapshot.baseHash, constraints: snapshot.workingState.constraints, optionId: "home-valid", moves: [{ itemId: "desk-main", pose: { xMm: 1900, yMm: 500, rotationDeg: 0 } }], proposalDigest: "0a1cb9ff5ba7bd65c1bdcb478bf53c55dc8c01a1605fe02fc2147151fe0db68f", idempotencyKey: "fixture-home-0001" } as const;
    const first = await store.stage(request); expect(first.ok).toBe(true);
    expect(await store.stage(request)).toStrictEqual(first);
    expect(await store.stage({ ...request, proposalDigest: "f".repeat(64) })).toMatchObject({ ok: false, error: { code: "IDEMPOTENCY_CONFLICT" } });
  });
});
