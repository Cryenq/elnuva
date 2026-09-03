import type { InspectSpatialLayoutData } from "../domain/types";
import { isInspectSpatialLayoutInput } from "./schemas";
import type {
  InspectSpatialLayoutHandler,
  ToolFailure,
  ToolFailureCode,
} from "./types";

type InspectHandlerDependencies = Readonly<{
  readCurrentLayout: () => InspectSpatialLayoutData | null;
}>;

const FAILURE_MESSAGES: Readonly<Record<ToolFailureCode, string>> = {
  INVALID_INPUT: "Inspect input must be an empty object.",
  UNSUPPORTED_CONSTRAINT: "The requested constraint is unsupported.",
  STATE_UNAVAILABLE: "Layout state is unavailable.",
  REVISION_CONFLICT: "The layout revision has changed.",
  OPTION_INVALID: "The selected layout option is invalid.",
  DIGEST_MISMATCH: "The layout proposal digest does not match.",
  PENDING_REVIEW: "A layout preview is already pending review.",
  IDEMPOTENCY_CONFLICT: "The idempotency key conflicts with an earlier request.",
  CANCELLED: "Inspect was cancelled.",
  INTERNAL_ERROR: "Inspect could not be completed.",
};

function failure(code: ToolFailureCode): ToolFailure {
  return {
    ok: false,
    error: {
      code,
      message: FAILURE_MESSAGES[code],
    },
  };
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

export function createInspectSpatialLayoutHandler({
  readCurrentLayout,
}: InspectHandlerDependencies): InspectSpatialLayoutHandler {
  return async (input, options) => {
    if (isAborted(options?.signal)) {
      return failure("CANCELLED");
    }

    if (!isInspectSpatialLayoutInput(input)) {
      return failure("INVALID_INPUT");
    }

    try {
      const currentLayout = readCurrentLayout();

      if (isAborted(options?.signal)) {
        return failure("CANCELLED");
      }

      if (currentLayout === null) {
        return failure("STATE_UNAVAILABLE");
      }

      const isolatedLayout = structuredClone(currentLayout);

      if (isAborted(options?.signal)) {
        return failure("CANCELLED");
      }

      return { ok: true, data: isolatedLayout };
    } catch {
      return failure("INTERNAL_ERROR");
    }
  };
}
