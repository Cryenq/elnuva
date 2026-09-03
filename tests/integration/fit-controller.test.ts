import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFitController } from "../../src/domain/fit-controller";
import type { DomainStore } from "../../src/domain/store";
import type { FitInput, FitProgress, FitRequest, FitWorkerRequest } from "../../src/domain/fit-contract";
import type { CommandFailureCode, CommandResult, WorkingState } from "../../src/domain/types";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
// Explicit Worker/EventTarget and parent-clock doubles. These check lifecycle
// and trust boundaries, not native Worker execution, SAT or GPU capability.
class ControlledWorker extends EventTarget {
  static instances: ControlledWorker[] = [];
  static posted = deferred<ControlledWorker>();
  readonly terminate = vi.fn();
  readonly postMessage = vi.fn((value: FitWorkerRequest) => { this.request = structuredClone(value.request); ControlledWorker.posted.resolve(this); });
  request!: FitRequest;
  constructor(readonly url: URL, readonly options: WorkerOptions) { super(); ControlledWorker.instances.push(this); }
  message(data: unknown): void { this.dispatchEvent(new MessageEvent("message", { data })); }
  fail(type: "error" | "messageerror"): void { this.dispatchEvent(new Event(type, { cancelable: true })); }
}
const baseline = (): WorkingState => ({ schemaVersion: 1, templateId: "home-office", room: { widthMm: 3000, depthMm: 3000 },
  furniture: [{ id: "chair-a", catalogId: "chair-600x600", xMm: 1000, yMm: 1000, rotationDeg: 0, locked: false }], features: [], constraints: [] });
const input = (): FitInput => ({ targetRoom: { widthMm: 3500, depthMm: 3500 }, additions: [{ id: "requested-chair", catalogId: "chair-600x600", locked: false }] });
const request = (value = input(), state = baseline()): FitRequest => ({ contractVersion: "human-fit/1", requestId: "controller-request-01", generation: 1,
  templateId: state.templateId, baseRevision: 1, baseHash: "a".repeat(64), baseline: state, targetRoom: value.targetRoom, additions: value.additions });
const target = (req: FitRequest): WorkingState => ({ ...req.baseline, room: req.targetRoom, furniture: [...req.baseline.furniture,
  ...req.additions.map(addition => ({ ...addition, xMm: 2500, yMm: 2500, rotationDeg: 0 as const }))] });
const response = (worker: ControlledWorker, status = "FOUND") => ({ kind: "result", requestId: worker.request.requestId, generation: worker.request.generation,
  status, ...(status === "FOUND" ? { target: target(worker.request) } : {}) });
const controllers: Array<ReturnType<typeof createFitController>> = [];
let now = 0;
function harness(req = request()) {
  const signalOwner = new AbortController();
  const prepareHumanFit = vi.fn(async (_input: FitInput, _caller: AbortSignal): Promise<CommandResult<{ request: FitRequest; signal: AbortSignal }>> =>
    ({ ok: true, data: { request: req, signal: signalOwner.signal } }));
  const stageHumanFit = vi.fn(async (_request: FitRequest, _target: unknown, _deadline: number): Promise<CommandResult> => ({ ok: true, data: undefined }));
  const finishHumanFit = vi.fn(() => { signalOwner.abort(); }), invalidateHumanFit = vi.fn(() => { signalOwner.abort(); });
  const store = { prepareHumanFit, stageHumanFit, finishHumanFit, invalidateHumanFit } as unknown as DomainStore;
  const progress = vi.fn<(value: FitProgress) => void>(), controller = createFitController(store, progress); controllers.push(controller);
  return { controller, signalOwner, prepareHumanFit, stageHumanFit, finishHumanFit, invalidateHumanFit, progress };
}
beforeEach(() => {
  now = 0; ControlledWorker.instances = []; ControlledWorker.posted = deferred<ControlledWorker>();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  vi.spyOn(performance, "now").mockImplementation(() => now); vi.stubGlobal("Worker", ControlledWorker);
});
afterEach(() => { for (const controller of controllers.splice(0)) controller.dispose(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("parent-only human fit worker lifecycle", () => {
  it("creates exactly one static module worker and latches FOUND before releasing its own aborting reservation", async () => {
    const h = harness(), result = h.controller.start(input()), worker = await ControlledWorker.posted.promise;
    expect(ControlledWorker.instances).toHaveLength(1); expect(worker.options).toEqual({ type: "module" }); expect(worker.url.pathname).toMatch(/\/fit-worker\.ts$/);
    expect(worker.postMessage).toHaveBeenCalledTimes(1); expect(worker.postMessage.mock.calls[0][0]).toEqual({ kind: "solve", request: worker.request });
    now = 14999; worker.message(response(worker));
    expect(await result).toMatchObject({ status: "FOUND", elapsedMs: 14999, requestId: worker.request.requestId });
    expect(h.stageHumanFit).toHaveBeenCalledExactlyOnceWith(worker.request, target(worker.request), 15000);
    expect(h.finishHumanFit).toHaveBeenCalledExactlyOnceWith(worker.request.requestId); expect(h.signalOwner.signal.aborted).toBe(true);
    expect(worker.terminate).toHaveBeenCalledTimes(1); expect(h.progress.mock.lastCall?.[0].status).toBe("FOUND");
    worker.message(response(worker, "PROVEN_IMPOSSIBLE")); worker.fail("error"); now = 30000; vi.advanceTimersByTime(30000);
    expect(h.progress.mock.lastCall?.[0].status).toBe("FOUND"); expect(worker.terminate).toHaveBeenCalledTimes(1); expect(h.stageHumanFit).toHaveBeenCalledTimes(1);
  });

  it("treats a queued result at15000 as RESOURCE_LIMIT before a throttled timeout callback fires", async () => {
    const h = harness(), result = h.controller.start(input()), worker = await ControlledWorker.posted.promise;
    now = 15000; worker.message(response(worker));
    expect(await result).toMatchObject({ status: "RESOURCE_LIMIT", message: "Not determined within 15 seconds." });
    expect(h.stageHumanFit).not.toHaveBeenCalled(); expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("expires a silent worker at the parent timer boundary and cleans up exactly once", async () => {
    const h = harness(), result = h.controller.start(input()), worker = await ControlledWorker.posted.promise;
    let settled = false; void result.then(() => { settled = true; });
    now = 14999; await vi.advanceTimersByTimeAsync(14999);
    expect(settled).toBe(false);
    expect(h.progress.mock.lastCall?.[0]).toMatchObject({ status: "RUNNING", elapsedMs: 14999, budgetMs: 15000 });
    expect(worker.terminate).not.toHaveBeenCalled(); expect(h.finishHumanFit).not.toHaveBeenCalled();
    expect(h.stageHumanFit).not.toHaveBeenCalled(); expect(h.signalOwner.signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    now = 15000; await vi.advanceTimersByTimeAsync(1);
    expect(await result).toEqual({ status: "RESOURCE_LIMIT", requestId: worker.request.requestId,
      elapsedMs: 15000, message: "Not determined within 15 seconds." });
    expect(h.progress.mock.lastCall?.[0]).toEqual({ status: "RESOURCE_LIMIT", requestId: worker.request.requestId,
      elapsedMs: 15000, budgetMs: 15000, message: "Not determined within 15 seconds." });
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(h.finishHumanFit).toHaveBeenCalledExactlyOnceWith(worker.request.requestId);
    expect(h.signalOwner.signal.aborted).toBe(true); expect(h.prepareHumanFit.mock.calls[0][1].aborted).toBe(true);
    expect(h.stageHumanFit).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);

    const notifications = h.progress.mock.calls.length;
    worker.message(response(worker)); worker.message(response(worker, "PROVEN_IMPOSSIBLE"));
    worker.fail("error"); worker.fail("messageerror"); now = 30000; await vi.advanceTimersByTimeAsync(15000);
    expect(h.progress).toHaveBeenCalledTimes(notifications); expect(h.stageHumanFit).not.toHaveBeenCalled();
    expect(worker.terminate).toHaveBeenCalledTimes(1); expect(h.finishHumanFit).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("maps a deadline crossing during the held store stage to RESOURCE_LIMIT, never FOUND or impossible", async () => {
    const h = harness(), entered = deferred<void>(), release = deferred<CommandResult>();
    h.stageHumanFit.mockImplementationOnce(async () => { entered.resolve(); return release.promise; });
    const result = h.controller.start(input()), worker = await ControlledWorker.posted.promise;
    now = 14999; worker.message(response(worker)); await entered.promise; now = 15000;
    release.resolve({ ok: false, error: { code: "OPTION_INVALID", message: "untrusted store text" } });
    expect(await result).toMatchObject({ status: "RESOURCE_LIMIT", message: "Not determined within 15 seconds." });
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it.each(["cancel", "stale", "dispose"] as const)("keeps earlier %s cancellation terminal despite timeout and late success", async reason => {
    const h = harness(), result = h.controller.start(input()), worker = await ControlledWorker.posted.promise;
    now = 14999;
    if (reason === "cancel") h.controller.cancel(); else if (reason === "stale") h.signalOwner.abort(); else h.controller.dispose();
    now = 15000; worker.message(response(worker)); vi.advanceTimersByTime(15000);
    expect(await result).toMatchObject({ status: "CANCELLED" }); expect(h.stageHumanFit).not.toHaveBeenCalled(); expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("cancels during preparation before any request or worker exists, and ignores the delayed preparation result", async () => {
    const h = harness(), release = deferred<Awaited<ReturnType<typeof h.prepareHumanFit>>>();
    h.prepareHumanFit.mockReturnValueOnce(release.promise);
    const result = h.controller.start(input()); expect(h.prepareHumanFit).toHaveBeenCalledTimes(1);
    const caller = h.prepareHumanFit.mock.calls[0][1]; h.controller.cancel(); expect(caller.aborted).toBe(true);
    expect(await result).toMatchObject({ status: "CANCELLED", requestId: null });
    release.resolve({ ok: true, data: { request: request(), signal: h.signalOwner.signal } }); await release.promise; await Promise.resolve();
    expect(ControlledWorker.instances).toHaveLength(0); expect(h.stageHumanFit).not.toHaveBeenCalled();
  });

  it("takes ALREADY_FITS only for unchanged room, no additions and all required satisfied, with no worker or preview", async () => {
    const state = baseline(), value = { targetRoom: state.room, additions: [] }, h = harness(request(value, state));
    expect(await h.controller.start(value)).toMatchObject({ status: "ALREADY_FITS" });
    expect(ControlledWorker.instances).toHaveLength(0); expect(h.stageHumanFit).not.toHaveBeenCalled(); expect(h.finishHumanFit).toHaveBeenCalledTimes(1);
  });

  it("searches unchanged inventory when an existing required constraint fails", async () => {
    const state: WorkingState = { ...baseline(), features: [{ id: "window", catalogId: "window-1400", wall: "north", offsetMm: 0 }],
      constraints: [{ constraintId: "near-window", type: "feature_distance", strength: "required", itemId: "chair-a", featureId: "window", relation: "near", thresholdMm: 0 }] };
    const value = { targetRoom: state.room, additions: [] }, h = harness(request(value, state));
    const result = h.controller.start(value), worker = await ControlledWorker.posted.promise;
    expect(ControlledWorker.instances).toHaveLength(1); worker.message(response(worker, "PROVEN_IMPOSSIBLE"));
    expect(await result).toMatchObject({ status: "PROVEN_IMPOSSIBLE", message: "No arrangement exists within this 2D model and its required constraints." });
  });

  it.each(["error", "messageerror"] as const)("terminates exactly once on worker %s with fixed text", async kind => {
    const h = harness(), result = h.controller.start(input()), worker = await ControlledWorker.posted.promise; worker.fail(kind);
    expect(await result).toMatchObject({ status: "INTERNAL_ERROR" }); expect(worker.terminate).toHaveBeenCalledTimes(1); expect(h.stageHumanFit).not.toHaveBeenCalled();
  });

  it.each(["protocol-error", "unknown-key", "oversized", "bad-generation", "bad-request", "bad-target", "raw-string"] as const)("fails closed on %s without reflecting backend text", async kind => {
    const h = harness(), result = h.controller.start(input()), worker = await ControlledWorker.posted.promise;
    const good = response(worker), malicious = "<script>private-stack-token</script>";
    const data: unknown = kind === "protocol-error" ? { kind: "protocol-error", status: "INTERNAL_ERROR" }
      : kind === "unknown-key" ? { ...good, message: malicious }
      : kind === "oversized" ? { ...good, requestId: malicious.repeat(10000) }
      : kind === "bad-generation" ? { ...good, generation: worker.request.generation + 1 }
      : kind === "bad-request" ? { ...good, requestId: "another-request-0001" }
      : kind === "bad-target" ? { ...good, target: { ...target(worker.request), furniture: [] } } : malicious;
    worker.message(data); const outcome = await result;
    expect(outcome.status).toBe("INTERNAL_ERROR"); expect(JSON.stringify(outcome)).not.toMatch(/private-stack|script|backend|exception/);
    expect(h.stageHumanFit).not.toHaveBeenCalled(); expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it.each(["INVALID_INPUT", "PENDING_REVIEW", "IDEMPOTENCY_CONFLICT", "REVISION_CONFLICT", "STATE_UNAVAILABLE"] as const)("maps preparation %s without leaking command text", async code => {
    const h = harness(); h.prepareHumanFit.mockResolvedValueOnce({ ok: false, error: { code, message: "private-command-token" } });
    const outcome = await h.controller.start(input()); expect(outcome.status).toBe(code === "INVALID_INPUT" ? "INVALID_REQUEST" : "CANCELLED");
    expect(outcome.message).not.toContain("private-command-token"); expect(ControlledWorker.instances).toHaveLength(0);
  });

  it.each(["OPTION_INVALID", "REVISION_CONFLICT", "PENDING_REVIEW"] as const)("maps nonexpired stage refusal%s correctly", async (code: CommandFailureCode) => {
    const h = harness(); h.stageHumanFit.mockResolvedValueOnce({ ok: false, error: { code, message: "not public" } });
    const result = h.controller.start(input()), worker = await ControlledWorker.posted.promise; worker.message(response(worker));
    expect((await result).status).toBe(code === "OPTION_INVALID" ? "INTERNAL_ERROR" : "CANCELLED"); expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("replaces one active run without accepting a late message from the previous worker", async () => {
    const h = harness(), firstResult = h.controller.start(input()), first = await ControlledWorker.posted.promise;
    const nextSignal = new AbortController(); h.prepareHumanFit.mockResolvedValueOnce({ ok: true, data: { request: { ...request(), requestId: "controller-request-02", generation: 2 }, signal: nextSignal.signal } });
    ControlledWorker.posted = deferred<ControlledWorker>(); const secondResult = h.controller.start(input()), second = await ControlledWorker.posted.promise;
    expect((await firstResult).status).toBe("CANCELLED"); first.message(response(first)); expect(h.stageHumanFit).not.toHaveBeenCalled();
    second.message(response(second, "PROVEN_IMPOSSIBLE")); expect((await secondResult).status).toBe("PROVEN_IMPOSSIBLE");
    expect(first.terminate).toHaveBeenCalledTimes(1); expect(second.terminate).toHaveBeenCalledTimes(1); expect(ControlledWorker.instances).toHaveLength(2);
  });
});
