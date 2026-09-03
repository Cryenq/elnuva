import type { InspectSpatialLayoutData, StageRequest, StageSuccessData, ToolResult } from "../domain/types";
import type { ValidateLayoutOptionsData, ValidateLayoutOptionsRequest } from "../domain/validator";
export type { ToolFailureCode, ToolResult } from "../domain/types";
export type ToolFailure = Extract<ToolResult<never>, { ok: false }>;
export type ToolExecutionOptions = Readonly<{ signal: AbortSignal }>;
export type InspectSpatialLayoutHandler = (input: unknown, options: ToolExecutionOptions) => Promise<ToolResult<InspectSpatialLayoutData>>;
export type ValidateLayoutOptionsHandler = (input: unknown, options: ToolExecutionOptions) => Promise<ToolResult<ValidateLayoutOptionsData>>;
export type StageLayoutPreviewHandler = (input: unknown, options: ToolExecutionOptions) => Promise<ToolResult<StageSuccessData>>;
export type WebMcpHandlers = Readonly<{ inspect: InspectSpatialLayoutHandler; validate: ValidateLayoutOptionsHandler; stage: StageLayoutPreviewHandler }>;
export type ModelContextTool = Readonly<{ name: "inspect_spatial_layout" | "validate_layout_options" | "stage_layout_preview"; title: string; description: string; inputSchema: unknown; annotations: Readonly<{ readOnlyHint: boolean; untrustedContentHint: true }>; execute: (input: unknown, options: ToolExecutionOptions) => unknown }>;
export type ModelContextRegistrationOptions = Readonly<{ signal: AbortSignal }>;
export interface ElnuvaModelContext { registerTool(tool: ModelContextTool, options: ModelContextRegistrationOptions): void | Promise<void> }
export type ValidateRequest = ValidateLayoutOptionsRequest;
export type StageInput = StageRequest;
declare global { interface Document { readonly modelContext?: ElnuvaModelContext } }
