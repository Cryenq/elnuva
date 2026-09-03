import { assessFitTarget } from "./layout-assessment";
import type { DomainStore } from "./store";
import type { FitInput, FitOutcome, FitProgress, FitRequest, FitTerminalStatus, FitWorkerRequest, FitWorkerResponse } from "./fit-contract";
import type { CommandFailureCode } from "./types";

const BUDGET_MS = 15000 as const;
const MESSAGES: Readonly<Record<FitTerminalStatus, string>> = Object.freeze({
  FOUND: "A fitting arrangement is ready for review. It has not been applied or saved.",
  ALREADY_FITS: "The current layout already fits this request.",
  PROVEN_IMPOSSIBLE: "No arrangement exists within this 2D model and its required constraints.",
  CANCELLED: "Make it Fit was cancelled. The working layout was not changed.",
  RESOURCE_LIMIT: "Not determined within 15 seconds.",
  INVALID_REQUEST: "The fit request is invalid. Check the target room and requested furniture.",
  INTERNAL_ERROR: "Make it Fit could not complete safely. The working layout was not changed.",
});

type Run = {
  caller: AbortController;
  signal: AbortSignal | null;
  request: FitRequest | null;
  worker: Worker | null;
  workerStartedAt: number | null;
  deadlineAt: number | null;
  timeout: ReturnType<typeof setTimeout> | null;
  progressTimer: ReturnType<typeof setInterval> | null;
  done: boolean;
  processing: boolean;
  resolve: (outcome: FitOutcome) => void;
  onAbort: () => void;
  onMessage: (event: MessageEvent<unknown>) => void;
  onError: (event: Event) => void;
};

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const own = Reflect.ownKeys(value);
  return own.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key) && Object.getOwnPropertyDescriptor(value, key)?.get === undefined);
}

function decodeResponse(value: unknown, request: FitRequest): FitWorkerResponse | null {
  if (exactObject(value, ["kind", "status"]) && value.kind === "protocol-error" && value.status === "INTERNAL_ERROR") return { kind: "protocol-error", status: "INTERNAL_ERROR" };
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const status = Object.getOwnPropertyDescriptor(value, "status")?.value as unknown;
  const keys = status === "FOUND" ? ["kind", "requestId", "generation", "status", "target"] : ["kind", "requestId", "generation", "status"];
  if (!exactObject(value, keys) || value.kind !== "result" || value.requestId !== request.requestId || value.generation !== request.generation) return null;
  if (status !== "FOUND" && status !== "PROVEN_IMPOSSIBLE" && status !== "INVALID_REQUEST" && status !== "INTERNAL_ERROR") return null;
  // The complete bounded target is independently decoded by assessFitTarget below.
  return value as FitWorkerResponse;
}

/** Parent-only orchestration. The generated solver is never imported here. */
export function createFitController(store: DomainStore, onProgress: (progress: FitProgress) => void): Readonly<{
  start: (input: FitInput) => Promise<FitOutcome>;
  cancel: () => void;
  dispose: () => void;
}> {
  let active: Run | null = null;
  let disposed = false;
  let invocation = 0;
  let hasStarted = false;

  const elapsed = (run: Run): number => run.workerStartedAt === null ? 0 : Math.max(0, performance.now() - run.workerStartedAt);
  const expired = (run: Run): boolean => run.deadlineAt !== null && performance.now() >= run.deadlineAt;
  const current = (run: Run): boolean => !disposed && active === run && !run.done;

  function notify(progress: FitProgress): void {
    if (disposed) return;
    // A consumer's rendering exception must not prevent worker/reservation cleanup.
    try { onProgress(Object.freeze(progress)); } catch { /* The returned outcome remains available to the caller. */ }
  }

  function stopWorker(run: Run): void {
    const worker = run.worker;
    run.worker = null;
    if (!worker) return;
    worker.removeEventListener("message", run.onMessage);
    worker.removeEventListener("error", run.onError);
    worker.removeEventListener("messageerror", run.onError);
    worker.terminate();
  }

  function finish(run: Run, status: FitTerminalStatus): void {
    if (run.done) return;
    // Latch before releasing our own signal: successful release is not cancellation.
    run.done = true;
    if (active === run) active = null;
    const outcome = Object.freeze({ status, requestId: run.request?.requestId ?? null, elapsedMs: elapsed(run), message: MESSAGES[status] });
    run.caller.signal.removeEventListener("abort", run.onAbort);
    run.signal?.removeEventListener("abort", run.onAbort);
    if (run.timeout !== null) clearTimeout(run.timeout);
    if (run.progressTimer !== null) clearInterval(run.progressTimer);
    run.timeout = null;
    run.progressTimer = null;
    stopWorker(run);
    run.caller.abort();
    if (run.request) store.finishHumanFit(run.request.requestId);
    run.resolve(outcome);
    notify({ ...outcome, budgetMs: BUDGET_MS });
  }

  function cancellationOrDeadline(run: Run): boolean {
    if (!current(run)) return true;
    if (run.caller.signal.aborted || run.signal?.aborted) { finish(run, "CANCELLED"); return true; }
    if (expired(run)) { finish(run, "RESOURCE_LIMIT"); return true; }
    return false;
  }

  function failedCommand(run: Run, code: CommandFailureCode): void {
    if (cancellationOrDeadline(run)) return;
    finish(run, code === "INVALID_INPUT" ? "INVALID_REQUEST"
      : code === "PENDING_REVIEW" || code === "IDEMPOTENCY_CONFLICT" || code === "REVISION_CONFLICT" || code === "STATE_UNAVAILABLE" ? "CANCELLED"
        : "INTERNAL_ERROR");
  }

  async function receive(run: Run, value: unknown): Promise<void> {
    if (cancellationOrDeadline(run) || run.processing || !run.request) return;
    run.processing = true;
    try {
      const response = decodeResponse(value, run.request);
      if (!response || response.kind === "protocol-error") { finish(run, "INTERNAL_ERROR"); return; }
      if (response.status !== "FOUND") {
        if (cancellationOrDeadline(run)) return;
        finish(run, response.status);
        return;
      }
      const assessment = assessFitTarget(run.request, response.target);
      if (cancellationOrDeadline(run)) return;
      if (!assessment.hardValid || !assessment.requiredSatisfied) { finish(run, "INTERNAL_ERROR"); return; }
      stopWorker(run);
      const target = structuredClone(response.target);
      if (cancellationOrDeadline(run) || run.deadlineAt === null) return;
      const result = await store.stageHumanFit(run.request, target, run.deadlineAt);
      if (!current(run)) return;
      if (run.caller.signal.aborted || run.signal?.aborted) { finish(run, "CANCELLED"); return; }
      if (!result.ok) { failedCommand(run, result.error.code); return; }
      // A successful store CAS has itself checked the parent deadline after every
      // await and immediately before commit. Never undo/reclassify that committed
      // preview because the success continuation runs a little later.
      finish(run, "FOUND");
    } catch {
      if (!cancellationOrDeadline(run)) finish(run, "INTERNAL_ERROR");
    }
  }

  async function prepare(run: Run, input: FitInput): Promise<void> {
    try {
      let clonedInput: FitInput;
      try { clonedInput = structuredClone(input); } catch {
        if (!cancellationOrDeadline(run)) finish(run, "INVALID_REQUEST");
        return;
      }
      const prepared = await store.prepareHumanFit(clonedInput, run.caller.signal);
      if (!current(run)) {
        if (prepared.ok) store.finishHumanFit(prepared.data.request.requestId);
        return;
      }
      if (!prepared.ok) { failedCommand(run, prepared.error.code); return; }
      const request: FitRequest = prepared.data.request;
      const signal: AbortSignal = prepared.data.signal;
      run.request = request;
      run.signal = signal;
      signal.addEventListener("abort", run.onAbort, { once: true });
      if (cancellationOrDeadline(run)) return;
      if (request.additions.length === 0 && request.targetRoom.widthMm === request.baseline.room.widthMm && request.targetRoom.depthMm === request.baseline.room.depthMm) {
        const assessment = assessFitTarget(request, request.baseline);
        if (cancellationOrDeadline(run)) return;
        if (assessment.hardValid && assessment.requiredSatisfied) { finish(run, "ALREADY_FITS"); return; }
      }
      const message: FitWorkerRequest = { kind: "solve", request: structuredClone(request) };
      if (cancellationOrDeadline(run)) return;
      run.workerStartedAt = performance.now();
      run.deadlineAt = run.workerStartedAt + BUDGET_MS;
      run.worker = new Worker(new URL("./fit-worker.ts", import.meta.url), { type: "module" });
      run.worker.addEventListener("message", run.onMessage);
      run.worker.addEventListener("error", run.onError);
      run.worker.addEventListener("messageerror", run.onError);
      const checkDeadline = (): void => {
        if (cancellationOrDeadline(run)) return;
        run.timeout = setTimeout(checkDeadline, Math.max(1, run.deadlineAt! - performance.now()));
      };
      run.timeout = setTimeout(checkDeadline, Math.max(1, run.deadlineAt - performance.now()));
      run.progressTimer = setInterval(() => {
        if (cancellationOrDeadline(run)) return;
        notify({ status: "RUNNING", requestId: request.requestId, elapsedMs: elapsed(run), budgetMs: BUDGET_MS, message: "Searching every allowed integer-millimetre placement. You can cancel at any time." });
      }, 100);
      if (cancellationOrDeadline(run)) return;
      run.worker.postMessage(message);
    } catch {
      if (!cancellationOrDeadline(run)) finish(run, "INTERNAL_ERROR");
    }
  }

  const controller = Object.freeze({
    start(input: FitInput): Promise<FitOutcome> {
      if (disposed) return Promise.resolve(Object.freeze({ status: "CANCELLED", requestId: null, elapsedMs: 0, message: MESSAGES.CANCELLED }));
      hasStarted = true;
      const startedInvocation = ++invocation;
      if (active) finish(active, "CANCELLED");
      // Progress subscribers may synchronously start a newer run or dispose.
      if (disposed || invocation !== startedInvocation) return Promise.resolve(Object.freeze({ status: "CANCELLED", requestId: null, elapsedMs: 0, message: MESSAGES.CANCELLED }));
      let resolve!: (outcome: FitOutcome) => void;
      const result = new Promise<FitOutcome>((complete) => { resolve = complete; });
      const run: Run = {
        caller: new AbortController(), signal: null, request: null, worker: null, workerStartedAt: null, deadlineAt: null,
        timeout: null, progressTimer: null, done: false, processing: false, resolve,
        onAbort: () => { finish(run, "CANCELLED"); },
        onMessage: (event) => { void receive(run, event.data); },
        onError: (event) => { event.preventDefault(); if (!cancellationOrDeadline(run)) finish(run, "INTERNAL_ERROR"); },
      };
      active = run;
      run.caller.signal.addEventListener("abort", run.onAbort, { once: true });
      notify({ status: "RUNNING", requestId: null, elapsedMs: 0, budgetMs: BUDGET_MS, message: "Preparing the fit request. You can cancel at any time." });
      if (current(run)) void prepare(run, input);
      return result;
    },
    cancel(): void { invocation += 1; if (active) finish(active, "CANCELLED"); },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (active) finish(active, "CANCELLED");
      store.invalidateHumanFit();
    },
  });
  queueMicrotask(() => { if (!disposed && !active && !hasStarted) notify({ status: "IDLE", requestId: null, elapsedMs: 0, budgetMs: BUDGET_MS, message: "Request furniture or a target room, then choose Make it Fit." }); });
  return controller;
}
