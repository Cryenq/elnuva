import { describe, expect, it, vi } from "vitest";
import { createDocumentStore, type DomainStore, type StoreSnapshot } from "../../src/domain/store";
import { MemoryStorage, storageKeyForTemplate, type StorageLike } from "../../src/domain/persistence";
import { createTemplateState } from "../../src/domain/templates";
import type { PreviewState, StageRequest, StageSuccessData, StageVerifier, VerifiedStageData } from "../../src/domain/types";

const homeDigest = "0a1cb9ff5ba7bd65c1bdcb478bf53c55dc8c01a1605fe02fc2147151fe0db68f";

function homeStage(snapshot: StoreSnapshot, key = "fixture-home-0001"): { request: StageRequest; preview: PreviewState; response: StageSuccessData; verified: VerifiedStageData } {
  const validation = {
    optionId: "home-valid",
    hardValid: true as const,
    stageable: true as const,
    issues: [] as const,
    constraintResults: [
      { constraintId: "c-door", type: "door_path_clear" as const, strength: "required" as const, satisfied: true, operator: "clear" as const, actualMm: null, targetMm: 900 },
      { constraintId: "c-radiator", type: "feature_distance" as const, strength: "required" as const, satisfied: true, operator: "gte" as const, actualMm: 850, targetMm: 800 },
      { constraintId: "c-window", type: "feature_distance" as const, strength: "preferred" as const, satisfied: true, operator: "lte" as const, actualMm: 150, targetMm: 700 },
      { constraintId: "c-chair", type: "item_distance" as const, strength: "preferred" as const, satisfied: true, operator: "lte" as const, actualMm: 150, targetMm: 500 },
    ],
    required: { satisfied: 2, total: 2 },
    preferred: { satisfied: 2, total: 2 },
    movedCount: 1,
    rotatedCount: 0,
    totalMovementMm: 600,
    minimumClearanceMm: 100,
    proposalDigest: homeDigest,
  };
  const preview: PreviewState = {
    status: "pending-review",
    baseRevision: snapshot.baseRevision,
    baseHash: snapshot.baseHash,
    optionId: "home-valid",
    moves: [{ itemId: "desk-main", pose: { xMm: 1900, yMm: 500, rotationDeg: 0 } }],
    constraints: snapshot.workingState.constraints,
    proposalDigest: homeDigest,
    idempotencyKey: key,
    validation,
    projectedFurniture: snapshot.workingState.furniture.map((item) => item.id === "desk-main" ? { ...item, xMm: 1900 } : item),
    notApplied: true,
    notSaved: true,
    requiresHumanAction: true,
  };
  const response: StageSuccessData = {
    previewId: homeDigest,
    optionId: "home-valid",
    proposalDigest: homeDigest,
    validation,
    notApplied: true,
    notSaved: true,
    requiresHumanAction: true,
    allowedHumanActions: ["apply", "discard"],
  };
  const request: StageRequest = {
    baseRevision: snapshot.baseRevision,
    baseHash: snapshot.baseHash,
    constraints: snapshot.workingState.constraints,
    optionId: "home-valid",
    moves: preview.moves,
    proposalDigest: homeDigest,
    idempotencyKey: key,
  };
  const verified: VerifiedStageData = {
    optionId: "home-valid",
    proposalDigest: homeDigest,
    moves: preview.moves,
    validation,
    projectedFurniture: preview.projectedFurniture,
  };
  return { request, preview, response, verified };
}

const authoritativeHomeVerifier: StageVerifier = (input) => {
  const move = input.request.moves[0];
  if (input.request.optionId !== "home-valid"
    || input.request.proposalDigest !== homeDigest
    || input.request.moves.length !== 1
    || move?.itemId !== "desk-main"
    || move.pose.xMm !== 1900
    || move.pose.yMm !== 500
    || move.pose.rotationDeg !== 0
    || JSON.stringify(input.request.constraints) !== JSON.stringify(input.workingState.constraints)) {
    return { ok: false, error: { code: "OPTION_INVALID", message: "The option is not stageable." } };
  }
  return { ok: true, data: homeStage({
    activeTemplateId: input.workingState.templateId,
    workingState: input.workingState,
    baseRevision: input.baseRevision,
    baseHash: input.baseHash,
    preview: null,
    error: null,
  }, input.request.idempotencyKey).verified };
};

const createVerifiedStore = (storage: MemoryStorage = new MemoryStorage(), stageVerifier: StageVerifier = authoritativeHomeVerifier) =>
  createDocumentStore({ storage, stageVerifier });

async function stageHome(store: DomainStore, key = "fixture-home-0001") {
  const fixture = homeStage(await store.snapshot(), key);
  return { fixture, result: await store.stage(fixture.request) };
}

describe("per-template command store", () => {
  it("initializes Home Office once at revision 1 and keeps drafts, saves, and revisions isolated", async () => {
    const storage = new MemoryStorage();
    const store = createDocumentStore({ storage });
    const home = await store.snapshot();
    expect(home).toMatchObject({ activeTemplateId: "home-office", baseRevision: 1, preview: null });
    expect(store.activateTemplate("bedroom")).toMatchObject({ ok: true });
    expect(await store.snapshot()).toMatchObject({ activeTemplateId: "bedroom", baseRevision: 1 });
    expect(store.updateFurniturePose("nightstand-main", { xMm: 3950, yMm: 2500, rotationDeg: 90 })).toMatchObject({ ok: true });
    expect((await store.snapshot()).baseRevision).toBe(2);
    expect(store.save()).toMatchObject({ ok: true });
    expect(store.activateTemplate("home-office")).toMatchObject({ ok: true });
    expect(await store.snapshot()).toMatchObject({ activeTemplateId: "home-office", baseRevision: 1, baseHash: home.baseHash });
    const fresh = createDocumentStore({ storage });
    expect(fresh.activateTemplate("bedroom")).toMatchObject({ ok: true });
    expect(await fresh.snapshot()).toMatchObject({ baseRevision: 1, workingState: { furniture: expect.arrayContaining([expect.objectContaining({ id: "nightstand-main", xMm: 3950, rotationDeg: 90 })]) } });
  });

  it("increments once for edit/reset/apply/undo while switch, save, stage, and discard do not", async () => {
    const store = createDocumentStore({ storage: new MemoryStorage() });
    const before = await store.snapshot();
    expect(store.updateFurniturePose("desk-main", { xMm: 1900, yMm: 500, rotationDeg: 0 })).toMatchObject({ ok: true });
    expect((await store.snapshot()).baseRevision).toBe(2);
    expect(store.undo()).toMatchObject({ ok: true });
    expect((await store.snapshot()).baseRevision).toBe(3);
    expect(store.reset()).toMatchObject({ ok: true });
    const reset = await store.snapshot();
    expect(reset.baseRevision).toBe(4);
    expect(reset.workingState).toStrictEqual(before.workingState);
    expect(store.activateTemplate("study")).toMatchObject({ ok: true });
    expect((await store.snapshot()).baseRevision).toBe(1);
  });

  it("blocks every mutation except Apply/Discard while Stage leaves durable state unchanged", async () => {
    const store = createVerifiedStore();
    const initial = await store.snapshot();
    const { result } = await stageHome(store);
    expect(result).toMatchObject({ ok: true, data: { notApplied: true, notSaved: true, requiresHumanAction: true, allowedHumanActions: ["apply", "discard"] } });
    expect((await store.snapshot()).workingState).toStrictEqual(initial.workingState);
    expect((await store.snapshot()).baseRevision).toBe(1);
    const blocked = [
      () => store.save(),
      () => store.activateTemplate("bedroom"),
      () => store.updateFurniturePose("desk-main", { xMm: 1800, yMm: 500, rotationDeg: 0 }),
      () => store.setFurnitureLocked("desk-main", true),
      () => store.reset(),
      () => store.undo(),
      () => store.deleteConstraint("c-chair"),
    ];
    for (const action of blocked) expect(action()).toMatchObject({ ok: false, error: { code: "PENDING_REVIEW" } });
    expect(store.discard()).toMatchObject({ ok: true });
    expect(await store.snapshot()).toMatchObject({ baseRevision: 1, preview: null });
  });

  it("applies with a final CAS, creates one undo, and retains tombstones until a new Document", async () => {
    const storage = new MemoryStorage();
    const store = createVerifiedStore(storage);
    const { fixture, result: first } = await stageHome(store);
    expect(await store.apply()).toMatchObject({ ok: true });
    expect(await store.snapshot()).toMatchObject({ baseRevision: 2, preview: null });
    expect(store.undo()).toMatchObject({ ok: true });
    expect((await store.snapshot()).baseRevision).toBe(3);
    expect(store.reset()).toMatchObject({ ok: true });
    expect(await store.stage(fixture.request)).toStrictEqual(first);
    expect((await store.snapshot()).preview).toBeNull();
    expect(store.recordCount).toBe(1);

    const fresh = createVerifiedStore(storage);
    const freshFixture = homeStage(await fresh.snapshot());
    expect(await fresh.stage(freshFixture.request)).toMatchObject({ ok: true });
    expect((await fresh.snapshot()).preview).not.toBeNull();
  });

  it("captures coherent async snapshots and never delivers an older initial subscription after a newer template event", async () => {
    const realDigest = crypto.subtle.digest.bind(crypto.subtle);
    let releaseSnapshot!: () => void;
    const snapshotGate = new Promise<void>((resolve) => { releaseSnapshot = resolve; });
    let blockFirst = true;
    const digestSpy = vi.spyOn(crypto.subtle, "digest").mockImplementation(async (algorithm, data) => {
      if (blockFirst) {
        blockFirst = false;
        await snapshotGate;
      }
      return realDigest(algorithm, data);
    });

    try {
      const store = createDocumentStore({ storage: new MemoryStorage() });
      const pendingHome = store.snapshot();
      expect(store.activateTemplate("bedroom")).toMatchObject({ ok: true });
      releaseSnapshot();
      const capturedHome = await pendingHome;
      expect(capturedHome).toMatchObject({
        activeTemplateId: "home-office",
        baseRevision: 1,
        baseHash: "54314a64f990ba98d9244a679e81d4037fc97c6275936c12e38ec243ca6aeb2e",
        workingState: { templateId: "home-office" },
      });
    } finally {
      digestSpy.mockRestore();
    }

    let releaseInitial!: () => void;
    const initialGate = new Promise<void>((resolve) => { releaseInitial = resolve; });
    blockFirst = true;
    const subscriptionSpy = vi.spyOn(crypto.subtle, "digest").mockImplementation(async (algorithm, data) => {
      if (blockFirst) {
        blockFirst = false;
        await initialGate;
      }
      return realDigest(algorithm, data);
    });

    try {
      const store = createDocumentStore({ storage: new MemoryStorage() });
      const delivered: StoreSnapshot[] = [];
      let resolveBedroom!: () => void;
      const bedroomDelivered = new Promise<void>((resolve) => { resolveBedroom = resolve; });
      const unsubscribe = store.subscribe((snapshot) => {
        delivered.push(snapshot);
        if (snapshot.activeTemplateId === "bedroom") resolveBedroom();
      });
      expect(store.activateTemplate("bedroom")).toMatchObject({ ok: true });
      await bedroomDelivered;
      releaseInitial();
      await Promise.resolve();
      await Promise.resolve();
      expect(delivered.map((snapshot) => snapshot.activeTemplateId)).toStrictEqual(["bedroom"]);
      unsubscribe();
    } finally {
      releaseInitial();
      subscriptionSpy.mockRestore();
    }
  });

  it("fails closed without an authoritative verifier and never trusts a forged stageable summary", async () => {
    const unverifiedStore = createDocumentStore({ storage: new MemoryStorage() });
    const unverifiedFixture = homeStage(await unverifiedStore.snapshot());
    expect(await unverifiedStore.stage(unverifiedFixture.request)).toMatchObject({ ok: false, error: { code: "STATE_UNAVAILABLE" } });

    const store = createVerifiedStore();
    const snapshot = await store.snapshot();
    const invalidDigest = "cea21af76de525f9dce281bb4ed0c1cee13b2eb9f2fdd1933f44d0c9c27b0a5b";
    const invalidRequest: StageRequest = {
      baseRevision: snapshot.baseRevision,
      baseHash: snapshot.baseHash,
      constraints: snapshot.workingState.constraints,
      optionId: "home-invalid",
      moves: [{ itemId: "desk-main", pose: { xMm: 1100, yMm: 2400, rotationDeg: 0 } }],
      proposalDigest: invalidDigest,
      idempotencyKey: "fixture-invalid-01",
    };
    const forgedOldPayload = {
      ...invalidRequest,
      validation: {
        ...homeStage(snapshot).preview.validation,
        optionId: "home-invalid",
        proposalDigest: invalidDigest,
        stageable: true,
      },
    } as unknown as StageRequest;
    expect(await store.stage(forgedOldPayload)).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    expect(await store.stage(invalidRequest)).toMatchObject({ ok: false, error: { code: "OPTION_INVALID" } });
    expect(await store.snapshot()).toMatchObject({ baseRevision: 1, preview: null });
    expect(await store.apply()).toMatchObject({ ok: false, error: { code: "NO_PREVIEW" } });
    expect(store.recordCount).toBe(0);
  });

  it("revalidates through the authoritative dependency before human Apply and retains the preview on rejection", async () => {
    let verifierCalls = 0;
    const verifier: StageVerifier = (input) => {
      verifierCalls += 1;
      return verifierCalls === 1
        ? authoritativeHomeVerifier(input)
        : { ok: false, error: { code: "OPTION_INVALID", message: "No longer stageable." } };
    };
    const store = createVerifiedStore(new MemoryStorage(), verifier);
    expect((await stageHome(store)).result).toMatchObject({ ok: true });
    expect(await store.apply()).toMatchObject({ ok: false, error: { code: "OPTION_INVALID" } });
    expect(await store.snapshot()).toMatchObject({ baseRevision: 1, preview: { status: "pending-review" } });
    expect(verifierCalls).toBe(2);
  });

  it("settles rejecting Stage verification for the owner and joiners with abort precedence and redacted failures", async () => {
    const abortedSecret = "verifier-secret-aborted";
    const failedSecret = "verifier-secret-failed";
    let rejectFirst!: (reason?: unknown) => void;
    let markFirstEntered!: () => void;
    const firstEntered = new Promise<void>((resolve) => { markFirstEntered = resolve; });
    let verifierCalls = 0;
    const verifier: StageVerifier = (input) => {
      verifierCalls += 1;
      if (verifierCalls === 1) {
        markFirstEntered();
        return new Promise((_resolve, reject) => { rejectFirst = reject; });
      }
      if (verifierCalls === 2) return Promise.reject(new Error(failedSecret));
      return authoritativeHomeVerifier(input);
    };
    const store = createVerifiedStore(new MemoryStorage(), verifier);
    const firstFixture = homeStage(await store.snapshot(), "fixture-abort-0001");
    const controller = new AbortController();
    const owner = store.stage(firstFixture.request, controller.signal);
    await firstEntered;
    const joiner = store.stage(firstFixture.request);
    controller.abort();
    rejectFirst(new Error(abortedSecret));

    const cancelled = await Promise.all([owner, joiner]);
    for (const result of cancelled) {
      expect(result).toMatchObject({ ok: false, error: { code: "CANCELLED" } });
      expect(JSON.stringify(result)).not.toContain(abortedSecret);
    }
    expect(cancelled[1]).toStrictEqual(cancelled[0]);
    expect(await store.snapshot()).toMatchObject({ baseRevision: 1, preview: null });
    expect(store.recordCount).toBe(0);

    const failedFixture = homeStage(await store.snapshot(), "fixture-failed-0001");
    const failed = await store.stage(failedFixture.request);
    expect(failed).toMatchObject({ ok: false, error: { code: "INTERNAL_ERROR" } });
    expect(JSON.stringify(failed)).not.toContain(failedSecret);
    expect(await store.snapshot()).toMatchObject({ baseRevision: 1, preview: null });
    expect(store.recordCount).toBe(0);

    const recoveredFixture = homeStage(await store.snapshot(), "fixture-recover-001");
    expect(await store.stage(recoveredFixture.request)).toMatchObject({ ok: true });
    expect(await store.snapshot()).toMatchObject({ baseRevision: 1, preview: { status: "pending-review" } });
    expect(store.recordCount).toBe(1);
  });

  it("settles Stage snapshot failures, releases reservations, and gives abort the bounded result", async () => {
    const seed = createVerifiedStore();
    const fixture = homeStage(await seed.snapshot(), "fixture-hashfail-01");
    const store = createVerifiedStore();
    const digestSecret = "digest-secret-failed";
    const digestSpy = vi.spyOn(crypto.subtle, "digest").mockImplementationOnce(async () => {
      throw new Error(digestSecret);
    });
    try {
      const owner = store.stage(fixture.request);
      const joiner = store.stage(fixture.request);
      const failed = await Promise.all([owner, joiner]);
      for (const result of failed) {
        expect(result).toMatchObject({ ok: false, error: { code: "INTERNAL_ERROR" } });
        expect(JSON.stringify(result)).not.toContain(digestSecret);
      }
      expect(failed[1]).toStrictEqual(failed[0]);
    } finally {
      digestSpy.mockRestore();
    }
    expect(await store.snapshot()).toMatchObject({ baseRevision: 1, preview: null });
    expect(store.recordCount).toBe(0);

    const recovered = homeStage(await store.snapshot(), "fixture-hash-recover");
    expect(await store.stage(recovered.request)).toMatchObject({ ok: true });
    expect(store.recordCount).toBe(1);

    const abortedStore = createVerifiedStore();
    const abortedFixture = homeStage(await seed.snapshot(), "fixture-hashabort-1");
    const controller = new AbortController();
    const abortSecret = "digest-secret-aborted";
    let rejectDigest!: (reason?: unknown) => void;
    let markDigestEntered!: () => void;
    const digestEntered = new Promise<void>((resolve) => { markDigestEntered = resolve; });
    const abortedDigestSpy = vi.spyOn(crypto.subtle, "digest").mockImplementationOnce(() => {
      markDigestEntered();
      return new Promise<ArrayBuffer>((_resolve, reject) => { rejectDigest = reject; });
    });
    try {
      const owner = abortedStore.stage(abortedFixture.request, controller.signal);
      await digestEntered;
      const joiner = abortedStore.stage(abortedFixture.request);
      controller.abort();
      rejectDigest(new Error(abortSecret));
      const cancelled = await Promise.all([owner, joiner]);
      for (const result of cancelled) {
        expect(result).toMatchObject({ ok: false, error: { code: "CANCELLED" } });
        expect(JSON.stringify(result)).not.toContain(abortSecret);
      }
      expect(cancelled[1]).toStrictEqual(cancelled[0]);
    } finally {
      abortedDigestSpy.mockRestore();
    }
    expect(await abortedStore.snapshot()).toMatchObject({ baseRevision: 1, preview: null });
    expect(abortedStore.recordCount).toBe(0);
  });

  it("fails Apply safely when its snapshot rejects and preserves preview, working, undo, and saved state", async () => {
    const storage = new MemoryStorage();
    const store = createVerifiedStore(storage);
    expect(store.save()).toMatchObject({ ok: true });
    const savedKey = storageKeyForTemplate("home-office");
    const savedBefore = storage.getItem(savedKey);
    expect((await stageHome(store, "fixture-applyfail-1")).result).toMatchObject({ ok: true });
    const before = await store.snapshot();
    const snapshotSecret = "apply-snapshot-secret";
    const snapshotSpy = vi.spyOn(store, "snapshot").mockRejectedValueOnce(new Error(snapshotSecret));
    let result;
    try {
      result = await store.apply();
    } finally {
      snapshotSpy.mockRestore();
    }
    expect(result).toMatchObject({ ok: false, error: { code: "STATE_UNAVAILABLE" } });
    expect(JSON.stringify(result)).not.toContain(snapshotSecret);
    expect(await store.snapshot()).toStrictEqual(before);
    expect(storage.getItem(savedKey)).toBe(savedBefore);
    expect(store.recordCount).toBe(1);
    expect(store.discard()).toMatchObject({ ok: true });
    expect(store.undo()).toMatchObject({ ok: false, error: { code: "NOTHING_TO_UNDO" } });
  });

  it("keeps a newly activated corrupt template's fallback error without changing other drafts or storage", async () => {
    const bedroomKey = storageKeyForTemplate("bedroom");
    const studyKey = storageKeyForTemplate("study");
    const values = new Map<string, string>([
      [bedroomKey, "{corrupt-bedroom"],
      [studyKey, "leave-study-unread"],
    ]);
    const storage: StorageLike = {
      getItem: (key) => values.get(key) ?? null,
      setItem: () => { throw new Error("old-active-save-error"); },
    };
    const store = createDocumentStore({ storage });
    const homeBefore = await store.snapshot();
    expect(store.save()).toMatchObject({ ok: false, error: { code: "STORAGE_UNAVAILABLE" } });
    expect((await store.snapshot()).error).toBe("The template could not be saved locally.");
    const storageBefore = [...values.entries()];

    expect(store.activateTemplate("bedroom")).toMatchObject({ ok: true });
    const bedroom = await store.snapshot();
    expect(bedroom).toMatchObject({
      activeTemplateId: "bedroom",
      baseRevision: 1,
      preview: null,
      error: "Saved template data was invalid; factory data was loaded.",
    });
    expect(bedroom.workingState).toStrictEqual(createTemplateState("bedroom"));
    expect([...values.entries()]).toStrictEqual(storageBefore);

    expect(store.activateTemplate("home-office")).toMatchObject({ ok: true });
    const homeAfter = await store.snapshot();
    expect(homeAfter).toMatchObject({ activeTemplateId: "home-office", baseRevision: homeBefore.baseRevision, baseHash: homeBefore.baseHash });
    expect(homeAfter.workingState).toStrictEqual(homeBefore.workingState);
    expect([...values.entries()]).toStrictEqual(storageBefore);
  });

  it("returns immutable snapshots and rejects invalid or locked geometry without revision drift", async () => {
    const store = createDocumentStore({ storage: new MemoryStorage() });
    const before = await store.snapshot();
    expect(Object.isFrozen(before)).toBe(true);
    expect(Object.isFrozen(before.workingState.furniture[0])).toBe(true);
    expect(() => ((before.workingState.furniture[0] as { xMm: number }).xMm = 1)).toThrow();
    expect(store.updateFurniturePose("storage-main", { xMm: 800, yMm: 600, rotationDeg: 0 })).toMatchObject({ ok: false, error: { code: "OPTION_INVALID" } });
    expect(store.updateFurniturePose("chair-main", { xMm: -1, yMm: 1300, rotationDeg: 0 })).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    expect((await store.snapshot()).baseRevision).toBe(1);
  });
});
