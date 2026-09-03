import type { InspectSpatialLayoutData } from "../domain/types";

export type ToolFailureCode =
  | "INVALID_INPUT"
  | "UNSUPPORTED_CONSTRAINT"
  | "STATE_UNAVAILABLE"
  | "REVISION_CONFLICT"
  | "OPTION_INVALID"
  | "DIGEST_MISMATCH"
  | "PENDING_REVIEW"
  | "IDEMPOTENCY_CONFLICT"
  | "CANCELLED"
  | "INTERNAL_ERROR";

export type ToolSuccess<T> = Readonly<{
  ok: true;
  data: T;
}>;

export type ToolFailure = Readonly<{
  ok: false;
  error: Readonly<{
    code: ToolFailureCode;
    message: string;
  }>;
}>;

export type ToolResult<T> = ToolSuccess<T> | ToolFailure;

export type ToolExecutionOptions = Readonly<{
  signal: AbortSignal;
}>;

export type InspectSpatialLayoutHandler = (
  input: unknown,
  options: ToolExecutionOptions,
) => Promise<ToolResult<InspectSpatialLayoutData>>;

export type ModelContextTool = Readonly<{
  name: string;
  title?: string;
  description: string;
  inputSchema: unknown;
  annotations: Readonly<Record<string, unknown>>;
  execute: (input: unknown, options: ToolExecutionOptions) => unknown;
}>;

export type ModelContextRegistrationOptions = Readonly<{
  signal: AbortSignal;
}>;

export interface ElnuvaModelContext {
  registerTool(
    tool: ModelContextTool,
    options: ModelContextRegistrationOptions,
  ): void | Promise<void>;
}

declare global {
  interface Document {
    readonly modelContext?: ElnuvaModelContext;
  }
}
