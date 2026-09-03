import type {
  ConstraintResult,
  FurnitureCatalogId,
  Room,
  TemplateId,
  WorkingState,
} from "./types";

/** Human-requested inventory is ephemeral until a separately reviewed Apply. */
export type FitAddition = Readonly<{
  id: string;
  catalogId: FurnitureCatalogId;
  locked: false;
}>;

export type FitInput = Readonly<{
  targetRoom: Room;
  additions: readonly FitAddition[];
}>;

export type FitRequest = Readonly<{
  contractVersion: "human-fit/1";
  requestId: string;
  generation: number;
  templateId: TemplateId;
  baseRevision: number;
  baseHash: string;
  baseline: WorkingState;
  targetRoom: Room;
  additions: readonly FitAddition[];
}>;

export type FitIssueCode =
  | "INVALID_REQUEST"
  | "MEMBERSHIP_MISMATCH"
  | "LOCKED_ITEM_CHANGED"
  | "ITEM_OUT_OF_BOUNDS"
  | "ITEM_OVERLAP"
  | "FEATURE_KEEP_OUT_INTERSECTION"
  | "REQUIRED_CONSTRAINT_UNSATISFIED";

export type FitIssue = Readonly<{
  code: FitIssueCode;
  itemIds: readonly string[];
  featureId?: string;
  constraintId?: string;
  message: string;
}>;

export type LayoutAssessment = Readonly<{
  hardValid: boolean;
  requiredSatisfied: boolean;
  issues: readonly FitIssue[];
  constraintResults: readonly ConstraintResult[];
  required: Readonly<{ satisfied: number; total: number }>;
  preferred: Readonly<{ satisfied: number; total: number }>;
}>;

export type CandidatePoseAssessment = Readonly<{
  hardValid: boolean;
  issues: readonly FitIssue[];
  constraintResults: readonly ConstraintResult[];
}>;

/** Distinct from the unchanged native pose-only PreviewState. */
export type HumanFitPreview = Readonly<{
  status: "pending-human-fit";
  request: FitRequest;
  projectedState: WorkingState;
  assessment: LayoutAssessment;
  notApplied: true;
  notSaved: true;
  requiresHumanAction: true;
}>;

export type FitTerminalStatus =
  | "FOUND"
  | "ALREADY_FITS"
  | "PROVEN_IMPOSSIBLE"
  | "CANCELLED"
  | "RESOURCE_LIMIT"
  | "INVALID_REQUEST"
  | "INTERNAL_ERROR";

export type FitOutcome = Readonly<{
  status: FitTerminalStatus;
  requestId: string | null;
  elapsedMs: number;
  message: string;
}>;

export type FitProgress = Readonly<{
  status: "IDLE" | "RUNNING" | FitTerminalStatus;
  requestId: string | null;
  elapsedMs: number;
  budgetMs: 15000;
  message: string;
}>;

/** Signals and the parent's monotonic deadline never cross this boundary. */
export type FitWorkerRequest = Readonly<{
  kind: "solve";
  request: FitRequest;
}>;

/** Untrusted worker data requires strict validation; no free-text error channel. */
export type FitWorkerResponse =
  | Readonly<{ kind: "protocol-error"; status: "INTERNAL_ERROR" }>
  | Readonly<
      { kind: "result"; requestId: string; generation: number } &
        (
          | { status: "FOUND"; target: WorkingState }
          | { status: "PROVEN_IMPOSSIBLE" }
          | { status: "INVALID_REQUEST" | "INTERNAL_ERROR" }
        )
    >;
