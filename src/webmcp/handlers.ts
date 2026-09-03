import type { DomainStore } from "../domain/store";
import type { InspectSpatialLayoutData, StageRequest, ToolFailureCode, ToolResult } from "../domain/types";
import { validateLayoutOptions } from "../domain/validator";
import { isInspectSpatialLayoutInput, isStageLayoutPreviewInput, isValidateLayoutOptionsInput } from "./schemas";
import type { InspectSpatialLayoutHandler, StageLayoutPreviewHandler, ValidateLayoutOptionsHandler, WebMcpHandlers } from "./types";

const messages: Record<ToolFailureCode, string> = { INVALID_INPUT: "The request is invalid.", UNSUPPORTED_CONSTRAINT: "The request contains an unsupported constraint.", STATE_UNAVAILABLE: "Layout state is unavailable.", REVISION_CONFLICT: "The layout revision or hash has changed.", OPTION_INVALID: "The option is not valid for staging.", DIGEST_MISMATCH: "The proposal digest does not match.", PENDING_REVIEW: "A layout preview is already pending review.", IDEMPOTENCY_CONFLICT: "The idempotency key conflicts with an earlier request.", CANCELLED: "The operation was cancelled.", INTERNAL_ERROR: "The operation could not be completed." };
const failure = <T>(code: ToolFailureCode): ToolResult<T> => ({ ok: false, error: { code, message: messages[code] } });
const aborted = (options?: { signal: AbortSignal }) => options?.signal?.aborted === true;

type InspectHandlerDependencies = Readonly<{ readCurrentLayout: () => InspectSpatialLayoutData | null | Promise<InspectSpatialLayoutData | null> }>;
export function createInspectSpatialLayoutHandler({ readCurrentLayout }: InspectHandlerDependencies): InspectSpatialLayoutHandler {
  return async (input, options) => {
    if (aborted(options)) return failure("CANCELLED");
    if (!isInspectSpatialLayoutInput(input)) return { ok: false, error: { code: "INVALID_INPUT", message: "Inspect input must be an empty object." } };
    try { const value = await readCurrentLayout(); if (aborted(options)) return failure("CANCELLED"); return value === null ? failure("STATE_UNAVAILABLE") : { ok: true, data: structuredClone(value) }; } catch { return failure(aborted(options) ? "CANCELLED" : "INTERNAL_ERROR"); }
  };
}

export function createValidateLayoutOptionsHandler(store: Pick<DomainStore, "beginValidate" | "releaseValidate" | "snapshot">): ValidateLayoutOptionsHandler {
  return async (input, options) => {
    if (aborted(options)) return failure("CANCELLED");
    if (!isValidateLayoutOptionsInput(input)) return failure("INVALID_INPUT");
    const reservation = store.beginValidate(); if ("ok" in reservation) return failure("STATE_UNAVAILABLE");
    try { const snapshot = await store.snapshot(); if (aborted(options)) return failure("CANCELLED"); const result = await validateLayoutOptions(snapshot, input); if (aborted(options)) return failure("CANCELLED"); return result; }
    catch { return failure(aborted(options) ? "CANCELLED" : "INTERNAL_ERROR"); }
    finally { store.releaseValidate(reservation); }
  };
}

export function createStageLayoutPreviewHandler(store: Pick<DomainStore, "stage">): StageLayoutPreviewHandler {
  return async (input, options) => { if (!isStageLayoutPreviewInput(input)) return failure("INVALID_INPUT"); try { return await store.stage(input as StageRequest, options?.signal); } catch { return failure(aborted(options) ? "CANCELLED" : "INTERNAL_ERROR"); } };
}

export function createWebMcpHandlers(store: DomainStore): WebMcpHandlers { return { inspect: createInspectSpatialLayoutHandler({ readCurrentLayout: () => store.inspect() }), validate: createValidateLayoutOptionsHandler(store), stage: createStageLayoutPreviewHandler(store) }; }
