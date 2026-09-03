import { FEATURE_CATALOG, FURNITURE_CATALOG, LIMITS } from "./catalog";
import { hashWorkingState } from "./hash";
import { readSnapshot, saveSnapshot, type StorageLike } from "./persistence";
import { createTemplateState } from "./templates";
import { previewSummary } from "./preview";
import type { Furniture, InspectSpatialLayoutData, PreviewState, TemplateId, ToolResult, WorkingState } from "./types";
type Draft = { state: WorkingState; revision: number; undo: readonly Furniture[] | null; preview: PreviewState | null };
export type StoreSnapshot = Readonly<{ activeTemplateId: TemplateId; state: WorkingState; revision: number; baseHash: string; preview: PreviewState | null; error: string | null }>;
export type SuccessfulRecord<T> = Readonly<{ idempotencyKey: string; proposalDigest: string; baseRevision: number; baseHash: string; response: ToolResult<T> }>;
export class DomainStore {
  private readonly drafts = new Map<TemplateId, Draft>(); private readonly records = new Map<string, SuccessfulRecord<unknown>>(); private active: TemplateId = "home-office"; private listeners = new Set<(snapshot: StoreSnapshot) => void>(); private error: string | null = null;
  constructor(private readonly storage: StorageLike | null = typeof localStorage === "undefined" ? null : localStorage) { this.initialize(this.active); }
  private initialize(id: TemplateId): Draft { let draft = this.drafts.get(id); if (!draft) { draft = { state: readSnapshot(this.storage, id), revision: 1, undo: null, preview: null }; this.drafts.set(id, draft); } return draft; }
  private current(): Draft { return this.initialize(this.active); }
  private emit(): void { void this.snapshot().then((value) => this.listeners.forEach((listener) => listener(value))); }
  subscribe(listener: (snapshot: StoreSnapshot) => void): () => void { this.listeners.add(listener); void this.snapshot().then(listener); return () => this.listeners.delete(listener); }
  async snapshot(): Promise<StoreSnapshot> { const draft = this.current(); return { activeTemplateId: this.active, state: structuredClone(draft.state), revision: draft.revision, baseHash: await hashWorkingState(draft.state), preview: draft.preview === null ? null : structuredClone(draft.preview), error: this.error }; }
  async inspect(): Promise<InspectSpatialLayoutData> { const s = await this.snapshot(); return { contractVersion: "1.0.0", baseRevision: s.revision, baseHash: s.baseHash, workingState: s.state, catalog: { furniture: FURNITURE_CATALOG, features: FEATURE_CATALOG }, coordinateSystem: { origin: "north-west", xAxis: "east", yAxis: "south", unit: "mm", integersOnly: true }, limits: LIMITS, preview: previewSummary(s.preview) }; }
  activate(templateId: TemplateId): boolean { if (this.current().preview) return false; this.active = templateId; this.initialize(templateId); this.emit(); return true; }
  activateTemplate(templateId: TemplateId): boolean { return this.activate(templateId); }
  reset(): boolean { const draft = this.current(); if (draft.preview) return false; draft.state = createTemplateState(this.active); draft.undo = null; draft.revision += 1; this.emit(); return true; }
  save(): boolean { const draft = this.current(); if (draft.preview) return false; const ok = saveSnapshot(this.storage, draft.state); this.error = ok ? null : "Unable to save this template locally."; this.emit(); return ok; }
  mutate(state: WorkingState): boolean { const draft = this.current(); if (draft.preview || state.templateId !== this.active) return false; draft.undo = structuredClone(draft.state.furniture); draft.state = structuredClone(state); draft.revision += 1; this.emit(); return true; }
  updateFurniturePose(itemId: string, pose: Pick<Furniture, "xMm" | "yMm" | "rotationDeg">): boolean { const draft = this.current(); const item = draft.state.furniture.find((candidate) => candidate.id === itemId); if (draft.preview || !item || item.locked) return false; return this.mutate({ ...draft.state, furniture: draft.state.furniture.map((candidate) => candidate.id === itemId ? { ...candidate, ...pose } : candidate) }); }
  undo(): boolean { const draft = this.current(); if (draft.preview || !draft.undo) return false; draft.state = { ...draft.state, furniture: structuredClone(draft.undo) }; draft.undo = null; draft.revision += 1; this.emit(); return true; }
  discard(): boolean { const draft = this.current(); if (!draft.preview) return false; draft.preview = null; this.emit(); return true; }
  apply(): boolean { const draft = this.current(); const preview = draft.preview; if (!preview) return false; draft.undo = structuredClone(draft.state.furniture); draft.state = { ...draft.state, furniture: structuredClone(preview.projectedFurniture) }; draft.preview = null; draft.revision += 1; this.emit(); return true; }
  stage(preview: PreviewState): boolean { const draft = this.current(); if (draft.preview) return false; draft.preview = structuredClone(preview); this.emit(); return true; }
  getRecord<T>(key: string, digest: string): ToolResult<T> | "conflict" | undefined { const found = this.records.get(key) as SuccessfulRecord<T> | undefined; if (!found) return undefined; return found.proposalDigest === digest ? structuredClone(found.response) : "conflict"; }
  putRecord<T>(record: SuccessfulRecord<T>): boolean { if (this.records.has(record.idempotencyKey) || this.records.size >= 16) return false; this.records.set(record.idempotencyKey, structuredClone(record) as SuccessfulRecord<unknown>); return true; }
  get recordCount(): number { return this.records.size; }
}
export const createDocumentStore = (options: { storage?: StorageLike | null } = {}) => new DomainStore(options.storage);
