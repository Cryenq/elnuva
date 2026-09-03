import { FEATURE_CATALOG, FURNITURE_CATALOG, LIMITS } from "./catalog";
import { assertWorkingState, canonicalJson } from "./canonical";
import { hashWorkingState } from "./hash";
import { loadTemplateSnapshot, saveTemplateSnapshot, type StorageLike } from "./persistence";
import {
  createStageTransactionBook,
  createValidateTransactionBook,
  previewSummary,
  type StageBeginResult,
  type StageReservation,
  type ValidateReservation,
} from "./preview";
import { createTemplateState } from "./templates";
import { assessFitRequest, assessFitTarget } from "./layout-assessment";
import type { FitAddition, FitInput, FitRequest, HumanFitPreview } from "./fit-contract";
import type {
  CommandFailureCode,
  CommandResult,
  Constraint,
  Feature,
  Furniture,
  FurnitureCatalogId,
  InspectSpatialLayoutData,
  PreviewState,
  Room,
  StageBinding,
  StageRequest,
  StageSuccessData,
  StageVerifier,
  TemplateId,
  ToolFailureCode,
  ToolResult,
  WorkingState,
} from "./types";

type Draft = {
  state: WorkingState;
  revision: number;
  undo: Readonly<{ kind: "furniture"; furniture: readonly Furniture[] }> | Readonly<{ kind: "human-fit"; state: WorkingState }> | null;
  hashCache: Readonly<{ revision: number; state: WorkingState; value: string }> | null;
};

export type StoreSnapshot = Readonly<{
  activeTemplateId: TemplateId;
  workingState: WorkingState;
  baseRevision: number;
  baseHash: string;
  preview: PreviewState | HumanFitPreview | null;
  error: string | null;
}>;

type StageToolResult = ToolResult<StageSuccessData>;
type StageVerifierResult = Awaited<ReturnType<StageVerifier>>;
type FitReservation = {
  generation: number;
  draft: Draft;
  state: WorkingState;
  templateId: TemplateId;
  revision: number;
  request: FitRequest | null;
  controller: AbortController;
  callerSignal: AbortSignal;
  onAbort: () => void;
};

const success = <T = undefined>(data: T = undefined as T): CommandResult<T> => ({ ok: true, data });
const failure = (code: CommandFailureCode, message: string): CommandResult<never> => ({ ok: false, error: { code, message } });
const toolFailure = (code: ToolFailureCode, message: string): StageToolResult => ({ ok: false, error: { code, message } });

function immutableClone<T>(value: T): T {
  const clone = structuredClone(value);
  const freeze = (entry: unknown): void => {
    if (entry === null || typeof entry !== "object" || Object.isFrozen(entry)) return;
    Object.freeze(entry);
    for (const child of Object.values(entry as Record<string, unknown>)) freeze(child);
  };
  freeze(clone);
  return clone;
}

function samePose(left: Furniture, right: Furniture): boolean {
  return left.xMm === right.xMm && left.yMm === right.yMm && left.rotationDeg === right.rotationDeg;
}

function isTemplateId(value: unknown): value is TemplateId {
  return value === "home-office" || value === "bedroom" || value === "study";
}

function stageFailure(code: "INVALID_INPUT" | "STATE_UNAVAILABLE" | "PENDING_REVIEW" | "IDEMPOTENCY_CONFLICT" | "CANCELLED"): StageToolResult {
  const messages = {
    INVALID_INPUT: "The Stage transaction input is invalid.",
    STATE_UNAVAILABLE: "The document is not available for this Stage operation.",
    PENDING_REVIEW: "A layout preview is already pending review.",
    IDEMPOTENCY_CONFLICT: "This idempotency key is already bound to another proposal.",
    CANCELLED: "The Stage operation was cancelled before the preview was committed.",
  } as const;
  return toolFailure(code, messages[code]);
}

const STAGE_REQUEST_KEYS = ["baseRevision", "baseHash", "constraints", "optionId", "moves", "proposalDigest", "idempotencyKey"] as const;

function exactStageRequest(value: unknown): value is StageRequest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  return keys.length === STAGE_REQUEST_KEYS.length
    && keys.every((key) => (STAGE_REQUEST_KEYS as readonly string[]).includes(key))
    && Number.isSafeInteger(record.baseRevision)
    && !Object.is(record.baseRevision, -0)
    && (record.baseRevision as number) >= 1
    && typeof record.baseHash === "string"
    && /^[a-f0-9]{64}$/.test(record.baseHash)
    && Array.isArray(record.constraints)
    && typeof record.optionId === "string"
    && Array.isArray(record.moves)
    && typeof record.proposalDigest === "string"
    && /^[a-f0-9]{64}$/.test(record.proposalDigest)
    && typeof record.idempotencyKey === "string"
    && /^[A-Za-z0-9_-]{16,80}$/.test(record.idempotencyKey);
}

function verifierFailure(result: StageVerifierResult): StageToolResult {
  return result.ok ? toolFailure("INTERNAL_ERROR", "The Stage verifier returned an invalid result.") : immutableClone(result);
}

const isAborted = (signal?: AbortSignal): boolean => signal?.aborted === true;

export class DomainStore {
  private readonly drafts = new Map<TemplateId, Draft>();
  private readonly stageTransactions = createStageTransactionBook<StageToolResult>();
  private readonly validateTransactions = createValidateTransactionBook();
  private active: TemplateId = "home-office";
  private readonly listeners = new Set<(snapshot: StoreSnapshot) => void>();
  private error: string | null = null;
  private emission = 0;
  private fitGeneration = 0;
  private fitAdditionSequence = 0;
  private activeFit: FitReservation | null = null;
  private humanFitPreview: HumanFitPreview | null = null;

  constructor(
    private readonly storage: StorageLike | null = typeof localStorage === "undefined" ? null : localStorage,
    private readonly stageVerifier: StageVerifier | null = null,
  ) {
    this.initialize(this.active);
  }

  private initialize(id: TemplateId): Draft {
    const existing = this.drafts.get(id);
    if (existing) return existing;
    const loaded = loadTemplateSnapshot(this.storage, id);
    if (!loaded.ok) this.error = loaded.error.message;
    const draft: Draft = { state: structuredClone(loaded.state), revision: 1, undo: null, hashCache: null };
    this.drafts.set(id, draft);
    return draft;
  }

  private current(): Draft {
    return this.initialize(this.active);
  }

  private emit(): void {
    const emission = ++this.emission;
    void this.snapshot().then((snapshot) => {
      if (emission !== this.emission) return;
      for (const listener of this.listeners) listener(snapshot);
    });
  }

  private pending(): CommandResult<never> | null {
    return this.stageTransactions.hasPreview() || this.humanFitPreview !== null
      ? failure("PENDING_REVIEW", "Review or discard the pending preview before changing the layout.")
      : null;
  }

  private commitState(next: WorkingState, undo: readonly Furniture[] | null): CommandResult {
    const pending = this.pending();
    if (pending) return pending;
    try {
      assertWorkingState(next, this.active);
    } catch {
      return failure("INVALID_INPUT", "The requested layout change violates the document contract.");
    }
    const draft = this.current();
    for (const item of draft.state.furniture) {
      const replacement = next.furniture.find((candidate) => candidate.id === item.id);
      if (replacement && replacement.catalogId !== item.catalogId) {
        return failure("INVALID_INPUT", "Furniture catalog assignments cannot be changed in place.");
      }
      if (item.locked && (!replacement || !samePose(item, replacement))) {
        return failure("OPTION_INVALID", "Locked furniture cannot change pose.");
      }
    }
    draft.undo = undo === null ? null : { kind: "furniture", furniture: structuredClone(undo) };
    draft.state = structuredClone(next);
    draft.revision += 1;
    draft.hashCache = null;
    this.error = null;
    this.cancelActiveFit();
    this.emit();
    return success();
  }

  subscribe(listener: (snapshot: StoreSnapshot) => void): () => void {
    this.listeners.add(listener);
    const emission = this.emission;
    void this.snapshot().then((snapshot) => {
      if (this.listeners.has(listener) && emission === this.emission) listener(snapshot);
    });
    return () => this.listeners.delete(listener);
  }

  async snapshot(): Promise<StoreSnapshot> {
    const activeTemplateId = this.active;
    const draft = this.initialize(activeTemplateId);
    const stateReference = draft.state;
    const baseRevision = draft.revision;
    const workingState = structuredClone(stateReference);
    const preview = this.humanFitPreview ?? this.stageTransactions.getPreview();
    const error = this.error;
    const cached = draft.hashCache;
    const baseHash = cached && cached.revision === baseRevision && cached.state === stateReference
      ? cached.value
      : await hashWorkingState(workingState);
    if (draft.state === stateReference && draft.revision === baseRevision) {
      draft.hashCache = { state: stateReference, revision: baseRevision, value: baseHash };
    }
    return immutableClone({
      activeTemplateId,
      workingState,
      baseRevision,
      baseHash,
      preview,
      error,
    });
  }

  async inspect(): Promise<InspectSpatialLayoutData> {
    const snapshot = await this.snapshot();
    return immutableClone({
      contractVersion: "1.1.0",
      baseRevision: snapshot.baseRevision,
      baseHash: snapshot.baseHash,
      workingState: snapshot.workingState,
      catalog: { furniture: FURNITURE_CATALOG, features: FEATURE_CATALOG },
      coordinateSystem: { origin: "north-west", xAxis: "east", yAxis: "south", unit: "mm", integersOnly: true },
      limits: LIMITS,
      preview: previewSummary(snapshot.preview),
    });
  }

  activateTemplate(templateId: TemplateId): CommandResult {
    const pending = this.pending();
    if (pending) return pending;
    if (!isTemplateId(templateId)) return failure("INVALID_INPUT", "Unknown template.");
    this.error = null;
    this.active = templateId;
    this.initialize(templateId);
    this.cancelActiveFit();
    this.emit();
    return success();
  }

  activate(templateId: TemplateId): CommandResult {
    return this.activateTemplate(templateId);
  }

  private cancelActiveFit(): void {
    const active = this.activeFit;
    this.activeFit = null;
    this.fitGeneration += 1;
    if (!active) return;
    active.callerSignal.removeEventListener("abort", active.onAbort);
    active.controller.abort();
  }

  private ownsFit(active: FitReservation): boolean {
    return this.activeFit === active && this.fitGeneration === active.generation
      && !active.callerSignal.aborted && !active.controller.signal.aborted
      && this.active === active.templateId && this.current() === active.draft
      && active.draft.state === active.state && active.draft.revision === active.revision;
  }

  createFitAddition(catalogId: FurnitureCatalogId): CommandResult<FitAddition> {
    const pending = this.pending();
    if (pending) return pending;
    const catalog = FURNITURE_CATALOG.find(entry => entry.id === catalogId);
    if (!catalog || this.current().state.furniture.length >= LIMITS.maxFurniture) return failure("INVALID_INPUT", "No further furniture can be requested.");
    let id: string;
    do {
      if (this.fitAdditionSequence >= Number.MAX_SAFE_INTEGER) return failure("STATE_UNAVAILABLE", "No request identity is available.");
      id = `fit-${catalog.kind}-${++this.fitAdditionSequence}`;
    } while (this.current().state.furniture.some(item => item.id === id));
    return success(immutableClone({ id, catalogId, locked: false as const }));
  }

  async prepareHumanFit(input: FitInput, callerSignal: AbortSignal): Promise<CommandResult<Readonly<{ request: FitRequest; signal: AbortSignal }>>> {
    if (callerSignal.aborted) return failure("REVISION_CONFLICT", "The fit request was cancelled.");
    const pending = this.pending();
    if (pending) return pending;
    if (this.stageTransactions.hasActiveReservation()) return failure("PENDING_REVIEW", "A native preview is being prepared.");
    if (this.activeFit) return failure("IDEMPOTENCY_CONFLICT", "Another fit request is already active.");
    const draft = this.current();
    const generation = ++this.fitGeneration;
    let candidate: FitRequest;
    try {
      if (input === null || typeof input !== "object" || Array.isArray(input) || (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) || Reflect.ownKeys(input).length !== 2 || !["targetRoom", "additions"].every(key => {
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        return !!descriptor && descriptor.enumerable === true && "value" in descriptor;
      })) return failure("INVALID_INPUT", "The fit request is invalid.");
      // Validate and freeze all input before awaiting its real baseline hash.
      const decoded = assessFitRequest({ contractVersion: "human-fit/1", requestId: crypto.randomUUID(), generation, templateId: this.active, baseRevision: draft.revision, baseHash: "0".repeat(64), baseline: draft.state, targetRoom: input.targetRoom, additions: input.additions });
      if (!decoded.ok) return decoded;
      candidate = decoded.data;
    } catch { return failure("INVALID_INPUT", "The fit request is invalid."); }
    const active: FitReservation = {
      generation, draft, state: draft.state, templateId: this.active, revision: draft.revision,
      request: null, controller: new AbortController(), callerSignal,
      onAbort: () => { if (this.activeFit === active) this.cancelActiveFit(); },
    };
    this.activeFit = active;
    callerSignal.addEventListener("abort", active.onAbort, { once: true });
    if (callerSignal.aborted) { this.cancelActiveFit(); return failure("REVISION_CONFLICT", "The fit request was cancelled."); }
    try {
      const snapshot = await this.snapshot();
      if (!this.ownsFit(active) || snapshot.activeTemplateId !== active.templateId || snapshot.baseRevision !== active.revision || this.humanFitPreview !== null || this.stageTransactions.hasPreview() || this.stageTransactions.hasActiveReservation()) {
        if (this.activeFit === active) this.cancelActiveFit();
        return failure("REVISION_CONFLICT", "The layout changed during fit preparation.");
      }
      const request = immutableClone({ ...candidate, baseHash: snapshot.baseHash });
      active.request = request;
      return success(Object.freeze({ request, signal: active.controller.signal }));
    } catch {
      const cancelled = !this.ownsFit(active);
      if (this.activeFit === active) this.cancelActiveFit();
      if (cancelled) return failure("REVISION_CONFLICT", "The fit request was cancelled.");
      return failure("STATE_UNAVAILABLE", "The fit baseline is unavailable.");
    }
  }

  async stageHumanFit(request: FitRequest, target: unknown, deadlineAt: number): Promise<CommandResult> {
    const active = this.activeFit;
    const expired = () => !Number.isFinite(deadlineAt) || performance.now() >= deadlineAt;
    if (expired()) return failure("OPTION_INVALID", "The fit deadline has expired.");
    if (!active || !this.ownsFit(active) || !active.request) return failure("REVISION_CONFLICT", "The fit request is no longer active.");
    if (this.pending() || this.stageTransactions.hasActiveReservation()) return failure("PENDING_REVIEW", "Another preview owns the document.");
    let projectedState: WorkingState;
    let report: ReturnType<typeof assessFitTarget>;
    try {
      const decoded = assessFitRequest(request);
      if (!decoded.ok || canonicalJson(decoded.data) !== canonicalJson(active.request)) return failure("REVISION_CONFLICT", "The fit request does not match the active run.");
      report = assessFitTarget(active.request, target);
      if (!report.hardValid || !report.requiredSatisfied) return failure("OPTION_INVALID", "The fit target is invalid.");
      projectedState = immutableClone(target as WorkingState);
      assertWorkingState(projectedState, active.templateId);
      const snapshot = await this.snapshot();
      if (expired()) return failure("OPTION_INVALID", "The fit deadline has expired.");
      if (!this.ownsFit(active) || snapshot.baseRevision !== request.baseRevision || snapshot.baseHash !== request.baseHash || snapshot.activeTemplateId !== request.templateId) return failure("REVISION_CONFLICT", "The fit result is stale.");
    } catch {
      if (!this.ownsFit(active)) return failure("REVISION_CONFLICT", "The fit result is stale.");
      return failure("OPTION_INVALID", "The fit target could not be verified.");
    }
    const preview = immutableClone({ status: "pending-human-fit" as const, request: active.request, projectedState, assessment: report, notApplied: true as const, notSaved: true as const, requiresHumanAction: true as const });
    if (expired()) return failure("OPTION_INVALID", "The fit deadline has expired.");
    if (!this.ownsFit(active) || this.humanFitPreview !== null || this.stageTransactions.hasPreview() || this.stageTransactions.hasActiveReservation() || active.draft.hashCache?.state !== active.state || active.draft.hashCache.revision !== request.baseRevision || active.draft.hashCache.value !== request.baseHash) return failure("REVISION_CONFLICT", "The fit result is stale.");
    this.humanFitPreview = preview;
    this.emit();
    return success();
  }

  finishHumanFit(requestId: string): void {
    if (this.activeFit?.request?.requestId === requestId) this.cancelActiveFit();
  }

  invalidateHumanFit(): void {
    const hadPreview = this.humanFitPreview !== null;
    this.humanFitPreview = null;
    this.cancelActiveFit();
    if (hadPreview) this.emit();
  }

  updateRoom(room: Room): CommandResult {
    return this.commitState({ ...this.current().state, room: structuredClone(room) }, null);
  }

  addFeature(feature: Feature): CommandResult {
    const draft = this.current();
    return this.commitState({ ...draft.state, features: [...draft.state.features, structuredClone(feature)] }, null);
  }

  updateFeature(featureId: string, replacement: Feature): CommandResult {
    const draft = this.current();
    if (!draft.state.features.some((feature) => feature.id === featureId) || replacement.id !== featureId) {
      return failure("INVALID_INPUT", "Unknown feature or mismatched feature identifier.");
    }
    return this.commitState({ ...draft.state, features: draft.state.features.map((feature) => feature.id === featureId ? structuredClone(replacement) : feature) }, null);
  }

  deleteFeature(featureId: string): CommandResult {
    const draft = this.current();
    if (!draft.state.features.some((feature) => feature.id === featureId)) return failure("INVALID_INPUT", "Unknown feature.");
    return this.commitState({ ...draft.state, features: draft.state.features.filter((feature) => feature.id !== featureId) }, null);
  }

  addFurniture(item: Furniture): CommandResult {
    const draft = this.current();
    return this.commitState({ ...draft.state, furniture: [...draft.state.furniture, structuredClone(item)] }, draft.state.furniture);
  }

  deleteFurniture(itemId: string): CommandResult {
    const draft = this.current();
    const item = draft.state.furniture.find((candidate) => candidate.id === itemId);
    if (!item) return failure("INVALID_INPUT", "Unknown furniture item.");
    if (item.locked) return failure("OPTION_INVALID", "Unlock furniture before deleting it.");
    return this.commitState({ ...draft.state, furniture: draft.state.furniture.filter((candidate) => candidate.id !== itemId) }, draft.state.furniture);
  }

  updateFurniturePose(itemId: string, pose: Pick<Furniture, "xMm" | "yMm" | "rotationDeg">): CommandResult {
    const draft = this.current();
    const item = draft.state.furniture.find((candidate) => candidate.id === itemId);
    if (!item) return failure("INVALID_INPUT", "Unknown furniture item.");
    if (item.locked) return failure("OPTION_INVALID", "Locked furniture cannot change pose.");
    if (item.xMm === pose.xMm && item.yMm === pose.yMm && item.rotationDeg === pose.rotationDeg) {
      return failure("INVALID_INPUT", "The furniture pose is unchanged.");
    }
    return this.commitState({
      ...draft.state,
      furniture: draft.state.furniture.map((candidate) => candidate.id === itemId ? { ...candidate, ...pose } : candidate),
    }, draft.state.furniture);
  }

  setFurnitureLocked(itemId: string, locked: boolean): CommandResult {
    const draft = this.current();
    const item = draft.state.furniture.find((candidate) => candidate.id === itemId);
    if (!item || typeof locked !== "boolean" || item.locked === locked) return failure("INVALID_INPUT", "Invalid furniture lock change.");
    return this.commitState({
      ...draft.state,
      furniture: draft.state.furniture.map((candidate) => candidate.id === itemId ? { ...candidate, locked } : candidate),
    }, null);
  }

  addConstraint(constraint: Constraint): CommandResult {
    const draft = this.current();
    return this.commitState({ ...draft.state, constraints: [...draft.state.constraints, structuredClone(constraint)] }, null);
  }

  updateConstraint(constraintId: string, replacement: Constraint): CommandResult {
    const draft = this.current();
    if (!draft.state.constraints.some((constraint) => constraint.constraintId === constraintId) || replacement.constraintId !== constraintId) {
      return failure("INVALID_INPUT", "Unknown constraint or mismatched constraint identifier.");
    }
    return this.commitState({
      ...draft.state,
      constraints: draft.state.constraints.map((constraint) => constraint.constraintId === constraintId ? structuredClone(replacement) : constraint),
    }, null);
  }

  deleteConstraint(constraintId: string): CommandResult {
    const draft = this.current();
    if (!draft.state.constraints.some((constraint) => constraint.constraintId === constraintId)) return failure("INVALID_INPUT", "Unknown constraint.");
    return this.commitState({ ...draft.state, constraints: draft.state.constraints.filter((constraint) => constraint.constraintId !== constraintId) }, null);
  }

  replaceConstraints(constraints: readonly Constraint[]): CommandResult {
    return this.commitState({ ...this.current().state, constraints: structuredClone(constraints) }, null);
  }

  mutate(state: WorkingState): CommandResult {
    return this.commitState(state, this.current().state.furniture);
  }

  reset(): CommandResult {
    const pending = this.pending();
    if (pending) return pending;
    const draft = this.current();
    const factory = createTemplateState(this.active);
    assertWorkingState(factory, this.active);
    draft.state = factory;
    draft.undo = null;
    draft.revision += 1;
    draft.hashCache = null;
    this.error = null;
    this.cancelActiveFit();
    this.emit();
    return success();
  }

  save(): CommandResult {
    const pending = this.pending();
    if (pending) return pending;
    const result = saveTemplateSnapshot(this.storage, this.current().state);
    if (!result.ok) {
      this.error = result.error.message;
      this.emit();
      return failure("STORAGE_UNAVAILABLE", result.error.message);
    }
    this.error = null;
    this.cancelActiveFit();
    this.emit();
    return success();
  }

  undo(): CommandResult {
    const pending = this.pending();
    if (pending) return pending;
    const draft = this.current();
    if (!draft.undo) return failure("NOTHING_TO_UNDO", "There is no layout change to undo.");
    const next: WorkingState = draft.undo.kind === "human-fit" ? structuredClone(draft.undo.state) : { ...draft.state, furniture: structuredClone(draft.undo.furniture) };
    try {
      assertWorkingState(next, this.active);
    } catch {
      return failure("STATE_UNAVAILABLE", "The saved undo state is no longer valid.");
    }
    draft.state = next;
    draft.undo = null;
    draft.revision += 1;
    draft.hashCache = null;
    this.error = null;
    this.cancelActiveFit();
    this.emit();
    return success();
  }

  beginValidate(): ValidateReservation | CommandResult<never> {
    const result = this.validateTransactions.begin();
    return "kind" in result ? failure("STATE_UNAVAILABLE", "Another validation is already running.") : result;
  }

  releaseValidate(reservation: ValidateReservation): boolean {
    return this.validateTransactions.release(reservation);
  }

  private beginStage(binding: StageBinding, signal?: AbortSignal): StageBeginResult<StageToolResult> {
    const result = this.stageTransactions.begin(binding, signal, this.humanFitPreview !== null);
    if (result.kind === "reserved") this.cancelActiveFit();
    return result;
  }

  private cancelStage(reservation: StageReservation<StageToolResult>, result: StageToolResult): StageToolResult {
    this.stageTransactions.cancel(reservation, result);
    return result;
  }

  private commitStageAtomically(
    reservation: StageReservation<StageToolResult>,
    request: StageRequest,
    verified: Extract<StageVerifierResult, { ok: true }>["data"],
    activeTemplateId: TemplateId,
    signal?: AbortSignal,
  ): StageToolResult {
    const draft = this.current();
    const binding = reservation.binding;
    const cachedHash = draft.hashCache?.revision === draft.revision && draft.hashCache.state === draft.state
      ? draft.hashCache.value
      : "";
    const failureResult = toolFailure("REVISION_CONFLICT", "The layout changed before the preview could be staged.");
    const cancelledResult = stageFailure("CANCELLED");

    if (isAborted(signal)) return this.cancelStage(reservation, cancelledResult);
    if (this.active !== activeTemplateId
      || draft.revision !== binding.baseRevision
      || cachedHash !== binding.baseHash
      || canonicalJson(draft.state.constraints) !== canonicalJson(request.constraints)) {
      return this.cancelStage(reservation, failureResult);
    }

    try {
      const validation = verified.validation;
      const preview: PreviewState = {
        status: "pending-review",
        baseRevision: binding.baseRevision,
        baseHash: binding.baseHash,
        optionId: verified.optionId,
        moves: structuredClone(verified.moves),
        constraints: structuredClone(request.constraints),
        proposalDigest: verified.proposalDigest,
        idempotencyKey: binding.idempotencyKey,
        validation: structuredClone(validation),
        projectedFurniture: structuredClone(verified.projectedFurniture),
        notApplied: true,
        notSaved: true,
        requiresHumanAction: true,
      };
      const response: StageSuccessData = {
        previewId: verified.proposalDigest,
        optionId: verified.optionId,
        proposalDigest: verified.proposalDigest,
        validation: structuredClone(validation),
        notApplied: true,
        notSaved: true,
        requiresHumanAction: true,
        allowedHumanActions: ["apply", "discard"],
      };
      const projectedState: WorkingState = { ...draft.state, furniture: structuredClone(preview.projectedFurniture) };
      assertWorkingState(projectedState, this.active);
      const uniqueMoveIds = new Set(preview.moves.map((move) => move.itemId));
      if (preview.status !== "pending-review"
        || preview.notApplied !== true
        || preview.notSaved !== true
        || preview.requiresHumanAction !== true
        || preview.optionId !== preview.validation.optionId
        || preview.validation.hardValid !== true
        || preview.validation.stageable !== true
        || preview.validation.issues.length !== 0
        || preview.proposalDigest !== preview.validation.proposalDigest
        || preview.optionId !== request.optionId
        || preview.proposalDigest !== request.proposalDigest
        || canonicalJson(preview.moves) !== canonicalJson(request.moves)
        || response.previewId !== preview.proposalDigest
        || response.optionId !== preview.optionId
        || response.proposalDigest !== preview.proposalDigest
        || response.validation.proposalDigest !== preview.proposalDigest
        || response.notApplied !== true
        || response.notSaved !== true
        || response.requiresHumanAction !== true
        || response.allowedHumanActions.length !== 2
        || response.allowedHumanActions[0] !== "apply"
        || response.allowedHumanActions[1] !== "discard"
        || canonicalJson(response.validation) !== canonicalJson(preview.validation)
        || canonicalJson(preview.constraints) !== canonicalJson(draft.state.constraints)
        || uniqueMoveIds.size !== preview.moves.length
        || preview.projectedFurniture.length !== draft.state.furniture.length) {
        this.stageTransactions.cancel(reservation, toolFailure("OPTION_INVALID", "The validated preview is inconsistent."));
        return toolFailure("OPTION_INVALID", "The validated preview is inconsistent.");
      }

      const moves = new Map(preview.moves.map((move) => [move.itemId, move.pose]));
      for (let index = 0; index < draft.state.furniture.length; index += 1) {
        const current = draft.state.furniture[index];
        const projected = preview.projectedFurniture[index];
        if (!projected || projected.id !== current.id || projected.catalogId !== current.catalogId || projected.locked !== current.locked) throw new TypeError();
        const move = moves.get(current.id);
        if (move) {
          if (current.locked || samePose(current, projected) || projected.xMm !== move.xMm || projected.yMm !== move.yMm || projected.rotationDeg !== move.rotationDeg) throw new TypeError();
        } else if (!samePose(current, projected)) throw new TypeError();
      }

      if (isAborted(signal)
        || this.active !== activeTemplateId
        || draft !== this.current()
        || draft.revision !== binding.baseRevision
        || cachedHash !== binding.baseHash
        || canonicalJson(draft.state.constraints) !== canonicalJson(request.constraints)) {
        if (isAborted(signal)) return this.cancelStage(reservation, cancelledResult);
        return this.cancelStage(reservation, failureResult);
      }

      const committed = this.stageTransactions.commitAtomically(
        reservation,
        { preview, response: { ok: true, data: immutableClone(response) } },
        {
          baseRevision: draft.revision,
          baseHash: cachedHash,
          previewAbsent: !this.stageTransactions.hasPreview() && this.humanFitPreview === null,
          aborted: isAborted(signal),
        },
        { rejected: failureResult, cancelled: cancelledResult },
      );
      if (committed === "cancelled") return cancelledResult;
      if (committed === "rejected") return failureResult;
      this.emit();
      return { ok: true, data: immutableClone(response) };
    } catch {
      const invalid = toolFailure("OPTION_INVALID", "The validated preview is inconsistent.");
      return this.cancelStage(reservation, invalid);
    }
  }

  async stage(requestValue: StageRequest, signal?: AbortSignal): Promise<StageToolResult> {
    if (!exactStageRequest(requestValue)) return stageFailure("INVALID_INPUT");
    const request = immutableClone(requestValue);
    const begin = this.beginStage({
      idempotencyKey: request.idempotencyKey,
      proposalDigest: request.proposalDigest,
      baseRevision: request.baseRevision,
      baseHash: request.baseHash,
    }, signal);
    if (begin.kind === "failure") return stageFailure(begin.code);
    if (begin.kind === "replay") return begin.response;
    if (begin.kind === "join") return begin.promise;

    if (!this.stageVerifier) return this.cancelStage(begin, stageFailure("STATE_UNAVAILABLE"));
    if (isAborted(signal)) return this.cancelStage(begin, stageFailure("CANCELLED"));

    let snapshot: StoreSnapshot;
    try {
      snapshot = await this.snapshot();
    } catch {
      return this.cancelStage(
        begin,
        isAborted(signal)
          ? stageFailure("CANCELLED")
          : toolFailure("INTERNAL_ERROR", "The layout state could not be read for Stage."),
      );
    }
    if (isAborted(signal)) return this.cancelStage(begin, stageFailure("CANCELLED"));
    if (snapshot.baseRevision !== request.baseRevision || snapshot.baseHash !== request.baseHash) {
      return this.cancelStage(begin, toolFailure("REVISION_CONFLICT", "The layout changed before the option could be verified."));
    }
    if (canonicalJson(snapshot.workingState.constraints) !== canonicalJson(request.constraints)) {
      return this.cancelStage(begin, toolFailure("INVALID_INPUT", "Submitted constraints do not match the active layout."));
    }

    let verified: StageVerifierResult;
    try {
      verified = await this.stageVerifier(immutableClone({
        request,
        workingState: snapshot.workingState,
        baseRevision: snapshot.baseRevision,
        baseHash: snapshot.baseHash,
      }));
    } catch {
      return this.cancelStage(
        begin,
        isAborted(signal)
          ? stageFailure("CANCELLED")
          : toolFailure("INTERNAL_ERROR", "The Stage verifier failed safely."),
      );
    }
    if (isAborted(signal)) return this.cancelStage(begin, stageFailure("CANCELLED"));
    if (!verified.ok) return this.cancelStage(begin, verifierFailure(verified));
    return this.commitStageAtomically(begin, request, immutableClone(verified.data), snapshot.activeTemplateId, signal);
  }

  discard(): CommandResult {
    if (this.humanFitPreview !== null) {
      this.humanFitPreview = null;
      this.cancelActiveFit();
      this.emit();
      return success();
    }
    if (!this.stageTransactions.clearPreview()) return failure("NO_PREVIEW", "There is no preview to discard.");
    this.emit();
    return success();
  }

  async apply(): Promise<CommandResult> {
    if (this.humanFitPreview !== null) return this.applyHumanFit(this.humanFitPreview);
    const preview = this.stageTransactions.getPreview();
    if (!preview) return failure("NO_PREVIEW", "There is no preview to apply.");
    if (!this.stageVerifier) return failure("STATE_UNAVAILABLE", "The authoritative layout verifier is unavailable.");
    let snapshot: StoreSnapshot;
    try {
      snapshot = await this.snapshot();
    } catch {
      return failure("STATE_UNAVAILABLE", "The preview could not be verified for Apply.");
    }
    if (snapshot.activeTemplateId !== this.active
      || snapshot.baseRevision !== preview.baseRevision
      || snapshot.baseHash !== preview.baseHash
      || canonicalJson(snapshot.workingState.constraints) !== canonicalJson(preview.constraints)) {
      return failure("REVISION_CONFLICT", "The layout changed before the preview could be applied.");
    }

    const request: StageRequest = immutableClone({
      baseRevision: preview.baseRevision,
      baseHash: preview.baseHash,
      constraints: preview.constraints,
      optionId: preview.optionId,
      moves: preview.moves,
      proposalDigest: preview.proposalDigest,
      idempotencyKey: preview.idempotencyKey,
    });
    let verified: StageVerifierResult;
    try {
      verified = await this.stageVerifier(immutableClone({
        request,
        workingState: snapshot.workingState,
        baseRevision: snapshot.baseRevision,
        baseHash: snapshot.baseHash,
      }));
    } catch {
      return failure("STATE_UNAVAILABLE", "The preview could not be verified for Apply.");
    }
    if (!verified.ok) {
      return verified.error.code === "REVISION_CONFLICT"
        ? failure("REVISION_CONFLICT", "The layout changed before the preview could be applied.")
        : verified.error.code === "STATE_UNAVAILABLE" || verified.error.code === "CANCELLED" || verified.error.code === "INTERNAL_ERROR"
          ? failure("STATE_UNAVAILABLE", "The preview could not be verified for Apply.")
          : failure("OPTION_INVALID", "The preview no longer passes authoritative validation.");
    }

    const authoritative = immutableClone(verified.data);
    const currentPreview = this.stageTransactions.getPreview();
    const draft = this.current();
    const next: WorkingState = { ...draft.state, furniture: structuredClone(authoritative.projectedFurniture) };
    try {
      if (authoritative.optionId !== request.optionId
        || authoritative.proposalDigest !== request.proposalDigest
        || authoritative.validation.optionId !== request.optionId
        || authoritative.validation.proposalDigest !== request.proposalDigest
        || authoritative.validation.hardValid !== true
        || authoritative.validation.stageable !== true
        || authoritative.validation.issues.length !== 0
        || canonicalJson(authoritative.moves) !== canonicalJson(request.moves)
        || canonicalJson(authoritative.validation) !== canonicalJson(preview.validation)
        || canonicalJson(authoritative.projectedFurniture) !== canonicalJson(preview.projectedFurniture)) throw new TypeError();
      assertWorkingState(next, this.active);
      for (const current of draft.state.furniture) {
        const projected = next.furniture.find((item) => item.id === current.id);
        if (!projected || projected.catalogId !== current.catalogId || projected.locked !== current.locked || (current.locked && !samePose(current, projected))) throw new TypeError();
      }
    } catch {
      return failure("OPTION_INVALID", "The preview no longer satisfies layout invariants.");
    }

    if (!currentPreview
      || this.active !== snapshot.activeTemplateId
      || currentPreview.idempotencyKey !== preview.idempotencyKey
      || currentPreview.proposalDigest !== preview.proposalDigest
      || canonicalJson(currentPreview) !== canonicalJson(preview)
      || draft.revision !== preview.baseRevision
      || draft.hashCache?.revision !== draft.revision
      || draft.hashCache.state !== draft.state
      || draft.hashCache.value !== preview.baseHash
      || canonicalJson(draft.state.constraints) !== canonicalJson(preview.constraints)) {
      return failure("REVISION_CONFLICT", "The layout changed before the preview could be applied.");
    }
    draft.undo = { kind: "furniture", furniture: structuredClone(draft.state.furniture) };
    draft.state = structuredClone(next);
    draft.revision += 1;
    draft.hashCache = null;
    this.stageTransactions.clearPreview();
    this.error = null;
    this.cancelActiveFit();
    this.emit();
    return success();
  }

  private async applyHumanFit(preview: HumanFitPreview): Promise<CommandResult> {
    const request = preview.request;
    let snapshot: StoreSnapshot;
    try { snapshot = await this.snapshot(); }
    catch { return failure("STATE_UNAVAILABLE", "The fit preview could not be verified for Apply."); }
    if (this.humanFitPreview !== preview || snapshot.activeTemplateId !== request.templateId || snapshot.baseRevision !== request.baseRevision || snapshot.baseHash !== request.baseHash) return failure("REVISION_CONFLICT", "The fit preview changed before Apply.");
    const report = assessFitTarget(request, preview.projectedState);
    if (!report.hardValid || !report.requiredSatisfied) return failure("OPTION_INVALID", "The fit preview no longer passes validation.");
    let next: WorkingState;
    try {
      next = structuredClone(preview.projectedState);
      assertWorkingState(next, request.templateId);
    } catch { return failure("OPTION_INVALID", "The fit preview violates the document contract."); }
    const draft = this.current();
    if (this.humanFitPreview !== preview || this.stageTransactions.hasPreview() || this.stageTransactions.hasActiveReservation() || this.active !== request.templateId || draft.revision !== request.baseRevision || draft.hashCache?.state !== draft.state || draft.hashCache.revision !== request.baseRevision || draft.hashCache.value !== request.baseHash || canonicalJson(draft.state) !== canonicalJson(request.baseline)) return failure("REVISION_CONFLICT", "The fit preview changed before Apply.");
    // Final identity/base check and commit are synchronous and callback-free.
    draft.undo = { kind: "human-fit", state: structuredClone(draft.state) };
    draft.state = next;
    draft.revision += 1;
    draft.hashCache = null;
    this.humanFitPreview = null;
    this.error = null;
    this.cancelActiveFit();
    this.emit();
    return success();
  }

  get recordCount(): number {
    return this.stageTransactions.completedCount();
  }
}

export const createDocumentStore = (options: { storage?: StorageLike | null; stageVerifier?: StageVerifier | null } = {}): DomainStore =>
  new DomainStore(options.storage, options.stageVerifier);
