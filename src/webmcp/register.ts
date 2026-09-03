import { INSPECT_SPATIAL_LAYOUT_INPUT_SCHEMA, STAGE_LAYOUT_PREVIEW_INPUT_SCHEMA, VALIDATE_LAYOUT_OPTIONS_INPUT_SCHEMA } from "./schemas";
import type { InspectSpatialLayoutHandler, ModelContextTool, StageLayoutPreviewHandler, ValidateLayoutOptionsHandler } from "./types";
export type WebMcpRegistration = Readonly<{ status: "registered" | "unavailable"; teardown: () => void }>;
type Options = Readonly<{ document: Document; inspect: InspectSpatialLayoutHandler; validate?: ValidateLayoutOptionsHandler; stage?: StageLayoutPreviewHandler }>;
const registrations = new WeakMap<Document, Promise<WebMcpRegistration>>();
const unavailable: WebMcpRegistration = Object.freeze({ status: "unavailable", teardown: () => undefined });
export function registerWebMcpTools({ document, inspect, validate, stage }: Options): Promise<WebMcpRegistration> {
  const existing = registrations.get(document); if (existing) return existing;
  const attempt = (async (): Promise<WebMcpRegistration> => {
    if (typeof document.modelContext?.registerTool !== "function") return unavailable;
    const lifetime = new AbortController(); let tornDown = false; const teardown = () => { if (!tornDown) { tornDown = true; lifetime.abort(); } };
    document.defaultView?.addEventListener("pagehide", (event) => { if (!(event as PageTransitionEvent).persisted) teardown(); }, { signal: lifetime.signal });
    const tools: ModelContextTool[] = [{ name: "inspect_spatial_layout", title: "Inspect spatial layout", description: "Read the active Elnuva room, furniture, constraints, revision, and bounded catalogs.", inputSchema: INSPECT_SPATIAL_LAYOUT_INPUT_SCHEMA, annotations: { readOnlyHint: true, untrustedContentHint: true }, execute: (input, options) => inspect(input, options) }];
    if (validate) tools.push({ name: "validate_layout_options", title: "Validate layout options", description: "Validate and rank one to three concrete furniture move options against the active Elnuva layout without changing state.", inputSchema: VALIDATE_LAYOUT_OPTIONS_INPUT_SCHEMA, annotations: { readOnlyHint: true, untrustedContentHint: true }, execute: (input, options) => validate(input, options) });
    if (stage) tools.push({ name: "stage_layout_preview", title: "Stage layout preview", description: "Stage one validated furniture move option as an ephemeral preview for human Apply or Discard; never apply or save it.", inputSchema: STAGE_LAYOUT_PREVIEW_INPUT_SCHEMA, annotations: { readOnlyHint: false, untrustedContentHint: true }, execute: (input, options) => stage(input, options) });
    try { for (const tool of tools) await document.modelContext.registerTool(tool, { signal: lifetime.signal }); } catch { teardown(); throw new Error("WebMCP registration failed."); }
    return Object.freeze({ status: "registered" as const, teardown });
  })();
  registrations.set(document, attempt); void attempt.catch(() => { if (registrations.get(document) === attempt) registrations.delete(document); }); return attempt;
}
