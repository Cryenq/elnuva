import type { PreviewState, PreviewSummary, StageBinding, StageValidationSummary } from "./types";

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{16,80}$/;
const HASH = /^[a-f0-9]{64}$/;

export const noPreview = (): PreviewSummary => ({ status: "none" });

export function previewSummary(preview: PreviewState | null): PreviewSummary {
  return preview === null
    ? noPreview()
    : { status: "pending-review", optionId: preview.optionId, proposalDigest: preview.proposalDigest, notApplied: true, notSaved: true };
}

export function createPreview(input: Omit<PreviewState, "status" | "notApplied" | "notSaved" | "requiresHumanAction">): PreviewState {
  return structuredClone({ ...input, status: "pending-review", notApplied: true, notSaved: true, requiresHumanAction: true });
}

export function stageValidationSummary(summary: StageValidationSummary): StageValidationSummary {
  return structuredClone(summary);
}

export type StageTransactionFailureCode = "INVALID_INPUT" | "STATE_UNAVAILABLE" | "PENDING_REVIEW" | "IDEMPOTENCY_CONFLICT" | "CANCELLED";

export type StageReservation<T> = Readonly<{
  kind: "reserved";
  binding: StageBinding;
  promise: Promise<T>;
  token: symbol;
}>;

export type StageBeginResult<T> =
  | StageReservation<T>
  | Readonly<{ kind: "replay"; response: T }>
  | Readonly<{ kind: "join"; promise: Promise<T> }>
  | Readonly<{ kind: "failure"; code: StageTransactionFailureCode }>;

export type StageCommitResult = "committed" | "cancelled" | "rejected";

type SuccessfulRecord<T> = Readonly<StageBinding & { response: T }>;

function validBinding(binding: StageBinding): boolean {
  return IDEMPOTENCY_KEY.test(binding.idempotencyKey)
    && HASH.test(binding.proposalDigest)
    && HASH.test(binding.baseHash)
    && Number.isSafeInteger(binding.baseRevision)
    && !Object.is(binding.baseRevision, -0)
    && binding.baseRevision >= 1;
}

export class StageTransactionBook<T> {
  private readonly completed = new Map<string, SuccessfulRecord<T>>();
  private active: {
    reservation: StageReservation<T>;
    resolve: (response: T) => void;
  } | null = null;
  private preview: PreviewState | null = null;

  begin(binding: StageBinding, signal?: Pick<AbortSignal, "aborted">): StageBeginResult<T> {
    if (!validBinding(binding)) return { kind: "failure", code: "INVALID_INPUT" };

    const completed = this.completed.get(binding.idempotencyKey);
    if (completed) {
      return completed.proposalDigest === binding.proposalDigest
        ? { kind: "replay", response: structuredClone(completed.response) }
        : { kind: "failure", code: "IDEMPOTENCY_CONFLICT" };
    }

    if (this.active) {
      const activeBinding = this.active.reservation.binding;
      if (activeBinding.idempotencyKey !== binding.idempotencyKey) return { kind: "failure", code: "STATE_UNAVAILABLE" };
      if (activeBinding.proposalDigest !== binding.proposalDigest) return { kind: "failure", code: "IDEMPOTENCY_CONFLICT" };
      return { kind: "join", promise: this.active.reservation.promise };
    }

    if (signal?.aborted === true) return { kind: "failure", code: "CANCELLED" };
    if (this.completed.size >= 16) return { kind: "failure", code: "STATE_UNAVAILABLE" };
    if (this.preview !== null) return { kind: "failure", code: "PENDING_REVIEW" };

    let resolve!: (response: T) => void;
    const promise = new Promise<T>((complete) => { resolve = complete; });
    const reservation: StageReservation<T> = {
      kind: "reserved",
      binding: structuredClone(binding),
      promise,
      token: Symbol("stage-reservation"),
    };
    this.active = { reservation, resolve };
    return reservation;
  }

  owns(reservation: StageReservation<T>): boolean {
    return this.active?.reservation.token === reservation.token;
  }

  commitAtomically(
    reservation: StageReservation<T>,
    payload: Readonly<{ preview: PreviewState; response: T }>,
    current: Readonly<{ baseRevision: number; baseHash: string; previewAbsent: boolean; aborted: boolean }>,
    responses: Readonly<{ rejected: T; cancelled: T }>,
  ): StageCommitResult {
    if (this.owns(reservation) && current.aborted) {
      this.cancel(reservation, responses.cancelled);
      return "cancelled";
    }

    const binding = reservation.binding;
    const canCommit = this.owns(reservation)
      && this.completed.size < 16
      && this.preview === null
      && current.previewAbsent
      && current.baseRevision === binding.baseRevision
      && current.baseHash === binding.baseHash
      && payload.preview.baseRevision === binding.baseRevision
      && payload.preview.baseHash === binding.baseHash
      && payload.preview.idempotencyKey === binding.idempotencyKey
      && payload.preview.proposalDigest === binding.proposalDigest;

    if (!canCommit) {
      this.cancel(reservation, responses.rejected);
      return "rejected";
    }

    const record: SuccessfulRecord<T> = structuredClone({ ...binding, response: payload.response });
    const preview = structuredClone(payload.preview);
    this.completed.set(binding.idempotencyKey, record);
    this.preview = preview;
    const active = this.active!;
    this.active = null;
    active.resolve(structuredClone(payload.response));
    return "committed";
  }

  cancel(reservation: StageReservation<T>, response: T): boolean {
    if (!this.owns(reservation)) return false;
    const active = this.active!;
    this.active = null;
    active.resolve(structuredClone(response));
    return true;
  }

  release(reservation: StageReservation<T>, response: T): boolean {
    return this.cancel(reservation, response);
  }

  getPreview(): PreviewState | null {
    return this.preview === null ? null : structuredClone(this.preview);
  }

  clearPreview(): boolean {
    if (this.preview === null) return false;
    this.preview = null;
    return true;
  }

  completedCount(): number {
    return this.completed.size;
  }

  hasPreview(): boolean {
    return this.preview !== null;
  }
}

export function createStageTransactionBook<T = unknown>(): StageTransactionBook<T> {
  return new StageTransactionBook<T>();
}

export type ValidateReservation = Readonly<{ token: symbol }>;

export class ValidateTransactionBook {
  private active: symbol | null = null;

  begin(): ValidateReservation | Readonly<{ kind: "failure"; code: "STATE_UNAVAILABLE" }> {
    if (this.active !== null) return { kind: "failure", code: "STATE_UNAVAILABLE" };
    const token = Symbol("validate-reservation");
    this.active = token;
    return { token };
  }

  release(reservation: ValidateReservation): boolean {
    if (this.active !== reservation.token) return false;
    this.active = null;
    return true;
  }
}

export const createValidateTransactionBook = (): ValidateTransactionBook => new ValidateTransactionBook();
