import { afterEach, describe, expect, it, vi } from "vitest";
import { createDocumentStore } from "../../src/domain/store";
import * as hashes from "../../src/domain/hash";
import { MemoryStorage, storageKeyForTemplate } from "../../src/domain/persistence";
import { createStageTransactionBook } from "../../src/domain/preview";
import { verifyStageRequest } from "../../src/domain/validator";
import type { FitInput, FitRequest } from "../../src/domain/fit-contract";
import type { StageRequest, WorkingState } from "../../src/domain/types";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const initial = (): WorkingState => ({ schemaVersion: 1, templateId: "home-office", room: { widthMm: 3000, depthMm: 3000 },
  furniture: [{ id: "chair-a", catalogId: "chair-600x600", xMm: 1000, yMm: 1000, rotationDeg: 0, locked: false }], features: [], constraints: [] });
function harness(baseline = initial()) {
  const storage = new MemoryStorage(), key = storageKeyForTemplate(baseline.templateId);
  storage.setItem(key, JSON.stringify({ storageVersion: 1, templateId: baseline.templateId, state: baseline }));
  const writes = vi.spyOn(storage, "setItem"), store = createDocumentStore({ storage, stageVerifier: verifyStageRequest });
  return { store, storage, key, writes, baseline };
}
const input = (): FitInput => ({ targetRoom: { widthMm: 3500, depthMm: 3200 }, additions: [{ id: "requested-chair", catalogId: "chair-600x600", locked: false }] });
const target = (request: FitRequest): WorkingState => ({ ...request.baseline, room: request.targetRoom,
  furniture: [...request.baseline.furniture, ...request.additions.map(addition => ({ ...addition, xMm: 2500, yMm: 2500, rotationDeg: 90 as const }))] });
async function prepare(store: ReturnType<typeof createDocumentStore>, value = input()) {
  const caller = new AbortController(), result = await store.prepareHumanFit(value, caller.signal);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("Expected prepared fit reservation");
  return { ...result.data, caller };
}
async function stageFit(store: ReturnType<typeof createDocumentStore>, value = input()) {
  const prepared = await prepare(store, value), projected = target(prepared.request);
  expect(await store.stageHumanFit(prepared.request, projected, performance.now() + 15000)).toMatchObject({ ok: true });
  expect(prepared.signal.aborted, "staging must not cancel its own still-resolving success").toBe(false);
  store.finishHumanFit(prepared.request.requestId);
  expect(prepared.signal.aborted).toBe(true);
  return { ...prepared, projected };
}
async function nativeRequest(store: ReturnType<typeof createDocumentStore>, number: number): Promise<StageRequest> {
  const snapshot = await store.snapshot(), optionId = `native-${number}`;
  const moves = [{ itemId: "chair-a", pose: { xMm: 1050, yMm: 1000, rotationDeg: 0 as const } }];
  return { baseRevision: snapshot.baseRevision, baseHash: snapshot.baseHash, constraints: snapshot.workingState.constraints, optionId, moves,
    proposalDigest: await hashes.proposalDigest(snapshot.baseRevision, snapshot.baseHash, snapshot.workingState.constraints, optionId, moves),
    idempotencyKey: `native-fit-key-${String(number).padStart(4, "0")}` };
}
afterEach(() => { vi.restoreAllMocks(); });

describe("human fit domain transaction, full target and undo", () => {
  it("allocates collision-free requests without changing state, revision, hash, undo or storage", async () => {
    const { store, writes } = harness(), before = await store.snapshot();
    const ids = new Set(before.workingState.furniture.map(item => item.id));
    for (let i = 0; i < 8; i++) {
      const addition = store.createFitAddition("chair-600x600"); expect(addition.ok).toBe(true);
      if (!addition.ok) throw new Error("Expected identity allocation");
      expect(ids.has(addition.data.id)).toBe(false); ids.add(addition.data.id);
      expect(addition.data).toEqual({ id: addition.data.id, catalogId: "chair-600x600", locked: false });
    }
    expect(await store.snapshot()).toEqual(before); expect(writes).not.toHaveBeenCalled();
    expect(store.undo()).toMatchObject({ ok: false, error: { code: "NOTHING_TO_UNDO" } });
  });

  it("captures a deeply immutable request independently of subsequent input-object edits", async () => {
    const { store, baseline } = harness();
    const value = { targetRoom: { widthMm: 3500, depthMm: 3200 }, additions: [{ id: "requested-chair", catalogId: "chair-600x600" as const, locked: false as const }] };
    const prepared = await prepare(store, value); value.targetRoom.widthMm = 4500; value.additions[0].id = "altered-outside";
    expect(prepared.request.targetRoom).toEqual({ widthMm: 3500, depthMm: 3200 }); expect(prepared.request.additions[0].id).toBe("requested-chair");
    expect(prepared.request.baseline).toEqual(baseline);
    for (const nested of [prepared.request, prepared.request.baseline, prepared.request.baseline.room, prepared.request.baseline.furniture,
      prepared.request.baseline.furniture[0], prepared.request.targetRoom, prepared.request.additions, prepared.request.additions[0]]) expect(Object.isFrozen(nested)).toBe(true);
    store.finishHumanFit(prepared.request.requestId);
  });

  it("previews the exact full target, exposes only the human Inspect summary, applies once, saves separately and fully undoes", async () => {
    const { store, storage, key, writes, baseline } = harness(), before = await store.snapshot(), savedBefore = storage.getItem(key);
    const fitted = await stageFit(store);
    const previewed = await store.snapshot();
    expect(previewed.workingState).toEqual(baseline); expect(previewed.baseRevision).toBe(before.baseRevision); expect(previewed.baseHash).toBe(before.baseHash);
    expect(previewed.preview).toMatchObject({ status: "pending-human-fit", request: fitted.request, projectedState: fitted.projected,
      assessment: { hardValid: true, requiredSatisfied: true }, notApplied: true, notSaved: true, requiresHumanAction: true });
    expect((await store.inspect()).preview).toEqual({ status: "pending-human-fit", notApplied: true, notSaved: true, requiresHumanAction: true });
    expect((await store.inspect()).contractVersion).toBe("1.1.0");
    expect(storage.getItem(key)).toBe(savedBefore); expect(writes).not.toHaveBeenCalled();
    for (const command of [() => store.updateRoom(baseline.room), () => store.addFurniture({ ...baseline.furniture[0], id: "new" }),
      () => store.updateFurniturePose("chair-a", { xMm: 1050, yMm: 1000, rotationDeg: 0 }), () => store.deleteFurniture("chair-a"),
      () => store.setFurnitureLocked("chair-a", true), () => store.undo(), () => store.reset(), () => store.save(), () => store.activateTemplate("bedroom")]) {
      expect(command()).toMatchObject({ ok: false, error: { code: "PENDING_REVIEW" } });
    }
    expect(await store.prepareHumanFit(input(), new AbortController().signal)).toMatchObject({ ok: false, error: { code: "PENDING_REVIEW" } });
    const results = await Promise.all([store.apply(), store.apply()]);
    expect(results.filter(result => result.ok)).toHaveLength(1);
    const applied = await store.snapshot();
    expect(applied.workingState).toEqual(fitted.projected); expect(applied.baseRevision).toBe(before.baseRevision + 1); expect(applied.preview).toBeNull();
    expect(writes).not.toHaveBeenCalled(); expect(storage.getItem(key)).toBe(savedBefore);
    expect(store.save().ok).toBe(true); expect(JSON.parse(storage.getItem(key)!).state).toEqual(fitted.projected);
    const savedTarget = storage.getItem(key); expect(store.undo().ok).toBe(true);
    const undone = await store.snapshot(); expect(undone.workingState).toEqual(baseline); expect(undone.baseRevision).toBe(before.baseRevision + 2);
    expect(undone.baseHash).toBe(before.baseHash); expect(storage.getItem(key)).toBe(savedTarget); expect(writes).toHaveBeenCalledTimes(1);
    expect(store.undo()).toMatchObject({ ok: false, error: { code: "NOTHING_TO_UNDO" } });
    expect(store.save().ok).toBe(true); expect(JSON.parse(storage.getItem(key)!).state).toEqual(baseline);
  });

  it("rejects returned partial/invented/physically-invalid targets without any mutation or implicit save", async () => {
    const { store, writes } = harness(), before = await store.snapshot(), { request } = await prepare(store), good = target(request);
    for (const bad of [{ ...good, furniture: good.furniture.slice(0, 1) }, { ...good, furniture: [...good.furniture].reverse() },
      { ...good, furniture: good.furniture.map(item => ({ ...item, xMm: 1000, yMm: 1000 })) },
      { ...good, room: request.baseline.room }, { ...good, extra: "not-authority" }]) {
      expect(await store.stageHumanFit(request, bad, performance.now() + 15000)).toMatchObject({ ok: false, error: { code: "OPTION_INVALID" } });
      expect(await store.snapshot()).toEqual(before); expect(writes).not.toHaveBeenCalled();
    }
    store.finishHumanFit(request.requestId);
  });

  it.each(["human", "native"] as const)("does not apply a discarded fit or erase its replacement %s preview at the same base", async replacementKind => {
    const { store, writes } = harness(), before = await store.snapshot(); await stageFit(store);
    const read = store.snapshot.bind(store), entered = deferred<void>(), release = deferred<void>();
    const spy = vi.spyOn(store, "snapshot").mockImplementationOnce(async () => { const captured = await read(); entered.resolve(); await release.promise; return captured; });
    const staleApply = store.apply(); await entered.promise;
    expect(store.discard().ok).toBe(true);
    if (replacementKind === "human") await stageFit(store, { ...input(), targetRoom: { widthMm: 3600, depthMm: 3300 } });
    else expect((await store.stage(await nativeRequest(store, 1))).ok).toBe(true);
    const replacement = await read(); expect(replacement.preview).not.toBeNull();
    release.resolve(); expect((await staleApply).ok).toBe(false); spy.mockRestore();
    expect(await store.snapshot()).toEqual(replacement); expect(replacement.workingState).toEqual(before.workingState);
    expect(replacement.baseRevision).toBe(before.baseRevision); expect(writes).not.toHaveBeenCalled();
  });

  it("abort during a delayed preparation hash releases ownership synchronously and cannot resurrect it", async () => {
    const { store, writes } = harness(), original = hashes.hashWorkingState, entered = deferred<void>(), release = deferred<void>();
    vi.spyOn(hashes, "hashWorkingState").mockImplementationOnce(async value => { entered.resolve(); await release.promise; return original(value); });
    const caller = new AbortController(), pending = store.prepareHumanFit(input(), caller.signal); await entered.promise;
    caller.abort();
    const next = await prepare(store); release.resolve();
    expect(await pending).toMatchObject({ ok: false, error: { code: "REVISION_CONFLICT" } });
    expect(next.signal.aborted).toBe(false); expect((await store.snapshot()).preview).toBeNull(); expect(writes).not.toHaveBeenCalled();
    store.finishHumanFit(next.request.requestId);
  });

  it("accepted human commands cancel a captured preparation before its delayed hash returns", async () => {
    const { store, writes, baseline } = harness(), original = hashes.hashWorkingState, entered = deferred<void>(), release = deferred<void>();
    vi.spyOn(hashes, "hashWorkingState").mockImplementationOnce(async value => { entered.resolve(); await release.promise; return original(value); });
    const pending = store.prepareHumanFit(input(), new AbortController().signal); await entered.promise;
    expect(store.updateRoom({ widthMm: 3100, depthMm: 3100 }).ok).toBe(true); release.resolve();
    expect(await pending).toMatchObject({ ok: false, error: { code: "REVISION_CONFLICT" } });
    expect(await store.snapshot()).toMatchObject({ workingState: { ...baseline, room: { widthMm: 3100, depthMm: 3100 } }, baseRevision: 2, preview: null });
    expect(writes).not.toHaveBeenCalled();
  });

  it.each([15000, Infinity, NaN])("refuses expired or non-finite parent deadline%s without staging", async deadlineAt => {
    const { store, writes } = harness(), prepared = await prepare(store), before = await store.snapshot();
    vi.spyOn(performance, "now").mockReturnValue(15000);
    expect(await store.stageHumanFit(prepared.request, target(prepared.request), deadlineAt)).toMatchObject({ ok: false, error: { code: "OPTION_INVALID" } });
    expect(await store.snapshot()).toEqual(before); expect(writes).not.toHaveBeenCalled(); store.finishHumanFit(prepared.request.requestId);
  });

  it("checks the parent deadline again after an explicitly held stage snapshot", async () => {
    const { store, writes } = harness(), prepared = await prepare(store), before = await store.snapshot();
    let now = 14999; vi.spyOn(performance, "now").mockImplementation(() => now);
    const read = store.snapshot.bind(store), entered = deferred<void>(), release = deferred<void>();
    vi.spyOn(store, "snapshot").mockImplementationOnce(async () => { const captured = await read(); entered.resolve(); await release.promise; return captured; });
    const staging = store.stageHumanFit(prepared.request, target(prepared.request), 15000); await entered.promise;
    now = 15000; release.resolve();
    expect(await staging).toMatchObject({ ok: false, error: { code: "OPTION_INVALID" } });
    expect(await read()).toEqual(before); expect(writes).not.toHaveBeenCalled();
  });

  it("rejects a held fit stage after an accepted human mutation without restoring its captured state", async () => {
    const { store, writes, storage, key, baseline } = harness();
    const recordedRequest = await nativeRequest(store, 0), recordedResponse = await store.stage(recordedRequest);
    expect(recordedResponse.ok).toBe(true); expect(store.discard().ok).toBe(true);
    const before = await store.snapshot(), saved = storage.getItem(key), prepared = await prepare(store);
    const read = store.snapshot.bind(store), entered = deferred<void>(), release = deferred<void>();
    vi.spyOn(store, "snapshot").mockImplementationOnce(async () => { const captured = await read(); entered.resolve(); await release.promise; return captured; });
    const staging = store.stageHumanFit(prepared.request, target(prepared.request), performance.now() + 15000); await entered.promise;

    const changed: WorkingState = { ...baseline, room: { widthMm: 3100, depthMm: 3100 } };
    expect(store.updateRoom(changed.room).ok).toBe(true); expect(prepared.signal.aborted).toBe(true);
    const newer = await read();
    expect(newer).toMatchObject({ workingState: changed, baseRevision: before.baseRevision + 1,
      baseHash: await hashes.hashWorkingState(changed), preview: null });
    expect(newer.baseHash).not.toBe(before.baseHash);
    release.resolve(); expect(await staging).toMatchObject({ ok: false, error: { code: "REVISION_CONFLICT" } });
    expect(await store.snapshot()).toEqual(newer); expect(storage.getItem(key)).toBe(saved); expect(writes).not.toHaveBeenCalled();
    expect(await store.stage(recordedRequest)).toEqual(recordedResponse);
    expect(await store.snapshot()).toEqual(newer); expect(storage.getItem(key)).toBe(saved); expect(writes).not.toHaveBeenCalled();
  });

  it.each(["reserved", "completed"] as const)("rejects a held fit stage while a newer native Stage is %s and preserves its records", async nativePhase => {
    const state = initial(), storage = new MemoryStorage(), key = storageKeyForTemplate(state.templateId);
    storage.setItem(key, JSON.stringify({ storageVersion: 1, templateId: state.templateId, state }));
    const writes = vi.spyOn(storage, "setItem"), nativeEntered = deferred<void>(), releaseNative = deferred<void>();
    let holdNative = false;
    const store = createDocumentStore({ storage, stageVerifier: async value => {
      if (holdNative) { nativeEntered.resolve(); await releaseNative.promise; }
      return verifyStageRequest(value);
    } });
    const recordedRequest = await nativeRequest(store, 0), recordedResponse = await store.stage(recordedRequest);
    expect(recordedResponse.ok).toBe(true); expect(store.discard().ok).toBe(true);
    const before = await store.snapshot(), saved = storage.getItem(key), native = await nativeRequest(store, 1), prepared = await prepare(store);
    const read = store.snapshot.bind(store), fitEntered = deferred<void>(), releaseFit = deferred<void>();
    vi.spyOn(store, "snapshot").mockImplementationOnce(async () => { const captured = await read(); fitEntered.resolve(); await releaseFit.promise; return captured; });
    const stagingFit = store.stageHumanFit(prepared.request, target(prepared.request), performance.now() + 15000); await fitEntered.promise;
    holdNative = true; const stagingNative = store.stage(native);
    expect(prepared.signal.aborted).toBe(true); await nativeEntered.promise;
    expect(await store.prepareHumanFit(input(), new AbortController().signal)).toMatchObject({ ok: false, error: { code: "PENDING_REVIEW" } });

    if (nativePhase === "reserved") {
      const reserved = await read(); expect(reserved).toEqual(before);
      releaseFit.resolve(); expect(await stagingFit).toMatchObject({ ok: false, error: { code: "REVISION_CONFLICT" } });
      expect(await read()).toEqual(reserved); expect(storage.getItem(key)).toBe(saved); expect(writes).not.toHaveBeenCalled();
    }
    releaseNative.resolve(); const nativeResponse = await stagingNative; expect(nativeResponse.ok).toBe(true);
    const newer = await read();
    expect(newer.workingState).toEqual(before.workingState); expect(newer.baseRevision).toBe(before.baseRevision); expect(newer.baseHash).toBe(before.baseHash);
    expect(newer.preview).toMatchObject({ status: "pending-review", optionId: native.optionId, proposalDigest: native.proposalDigest });
    if (nativePhase === "completed") {
      releaseFit.resolve(); expect(await stagingFit).toMatchObject({ ok: false, error: { code: "REVISION_CONFLICT" } });
    }
    expect(await store.snapshot()).toEqual(newer); expect(storage.getItem(key)).toBe(saved); expect(writes).not.toHaveBeenCalled();
    expect(await store.stage(recordedRequest)).toEqual(recordedResponse); expect(await store.stage(native)).toEqual(nativeResponse);
    expect(await store.snapshot()).toEqual(newer); expect(storage.getItem(key)).toBe(saved); expect(writes).not.toHaveBeenCalled();
  });

  it("invalidates only fit state on disposal and preserves native previews", async () => {
    const { store, writes } = harness(), before = await store.snapshot(); await stageFit(store);
    store.invalidateHumanFit(); expect(await store.snapshot()).toEqual(before);
    const native = await nativeRequest(store, 2); expect((await store.stage(native)).ok).toBe(true);
    const nativePreview = await store.snapshot(); store.invalidateHumanFit(); store.invalidateHumanFit();
    expect(await store.snapshot()).toEqual(nativePreview); expect(writes).not.toHaveBeenCalled();
  });
});

describe("native Stage arbitration and all16 retained successful records", () => {
  it("preserves active join/conflict/exclusion and abort precedence before the external-preview check", () => {
    const book = createStageTransactionBook<string>(), binding = { idempotencyKey: "native-book-key-0001", proposalDigest: "a".repeat(64), baseRevision: 1, baseHash: "b".repeat(64) };
    expect(book.hasActiveReservation()).toBe(false);
    const first = book.begin(binding); expect(first.kind).toBe("reserved");
    if (first.kind !== "reserved") throw new Error("Expected real reservation");
    expect(book.hasActiveReservation()).toBe(true);
    expect(book.begin(binding, { aborted: true }, true)).toEqual({ kind: "join", promise: first.promise });
    expect(book.begin({ ...binding, proposalDigest: "c".repeat(64) }, undefined, true)).toEqual({ kind: "failure", code: "IDEMPOTENCY_CONFLICT" });
    expect(book.begin({ ...binding, idempotencyKey: "native-book-key-0002" }, undefined, true)).toEqual({ kind: "failure", code: "STATE_UNAVAILABLE" });
    expect(book.cancel(first, "cancelled")).toBe(true); expect(book.hasActiveReservation()).toBe(false);
    expect(book.begin(binding, { aborted: true }, true)).toEqual({ kind: "failure", code: "CANCELLED" });
    expect(book.begin(binding, undefined, true)).toEqual({ kind: "failure", code: "PENDING_REVIEW" });
    expect(book.hasActiveReservation()).toBe(false);
  });

  it("refuses fit preparation while an actual native Stage verifier owns its reservation", async () => {
    const storage = new MemoryStorage(), state = initial(); storage.setItem(storageKeyForTemplate("home-office"), JSON.stringify({ storageVersion: 1, templateId: "home-office", state }));
    const entered = deferred<void>(), release = deferred<void>();
    const store = createDocumentStore({ storage, stageVerifier: async value => { entered.resolve(); await release.promise; return verifyStageRequest(value); } });
    const native = await nativeRequest(store, 1), staging = store.stage(native); await entered.promise;
    expect(await store.prepareHumanFit(input(), new AbortController().signal)).toMatchObject({ ok: false, error: { code: "PENDING_REVIEW" } });
    const joined = store.stage(native); release.resolve(); const result = await staging; expect(result.ok).toBe(true); expect(await joined).toEqual(result);
  });

  it("cancels fit synchronously only after a genuinely new native reservation, before its verifier awaits", async () => {
    const { store } = harness(), native = await nativeRequest(store, 1), fit = await prepare(store);
    const staging = store.stage(native);
    expect(fit.signal.aborted).toBe(true);
    expect((await staging).ok).toBe(true);
    expect(await store.stageHumanFit(fit.request, target(fit.request), performance.now() + 15000)).toMatchObject({ ok: false });
    expect((await store.snapshot()).preview?.status).toBe("pending-review");
  });

  it("retains all16 exact replays through fit apply/save/undo/reset/template changes and never cancels fit for replay/conflict/capacity", async () => {
    const { store } = harness();
    const records: Array<{ request: StageRequest; response: Awaited<ReturnType<typeof store.stage>> }> = [];
    for (let i = 0; i < 16; i++) {
      const request = await nativeRequest(store, i), response = await store.stage(request);
      expect(response.ok).toBe(true); records.push({ request, response }); expect(store.discard().ok).toBe(true);
    }
    const fit = await prepare(store);
    for (const record of records) { expect(await store.stage(record.request)).toEqual(record.response); expect(fit.signal.aborted).toBe(false); }
    expect(await store.stage({ ...records[0].request, proposalDigest: "b".repeat(64) })).toMatchObject({ ok: false, error: { code: "IDEMPOTENCY_CONFLICT" } });
    expect(fit.signal.aborted).toBe(false);
    expect(await store.stage(await nativeRequest(store, 17))).toMatchObject({ ok: false, error: { code: "STATE_UNAVAILABLE" } });
    expect(fit.signal.aborted).toBe(false);
    expect(await store.stageHumanFit(fit.request, target(fit.request), performance.now() + 15000)).toMatchObject({ ok: true });
    store.finishHumanFit(fit.request.requestId);
    for (const record of records) expect(await store.stage(record.request)).toEqual(record.response);
    expect((await store.apply()).ok).toBe(true); expect(store.save().ok).toBe(true); expect(store.undo().ok).toBe(true);
    expect(store.reset().ok).toBe(true); expect(store.activateTemplate("bedroom").ok).toBe(true); expect(store.activateTemplate("home-office").ok).toBe(true);
    const after = await store.snapshot();
    for (const record of records) expect(await store.stage(record.request)).toEqual(record.response);
    expect(await store.snapshot()).toEqual(after);
  });
});
