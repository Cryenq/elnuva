import { createTemplateState } from "./templates";
import type { StoredEnvelope, TemplateId, WorkingState } from "./types";
export const storageKey = (templateId: TemplateId): string => `elnuva:v1:template:${templateId}`;
export const storageKeyForTemplate = storageKey;
export interface StorageLike { getItem(key: string): string | null; setItem(key: string, value: string): void; }
export class MemoryStorage implements StorageLike { private readonly values = new Map<string, string>(); constructor(private readonly options: { setItemError?: boolean } = {}) {} getItem(key: string): string | null { return this.values.get(key) ?? null; } setItem(key: string, value: string): void { if (this.options.setItemError) throw new Error("storage unavailable"); this.values.set(key, value); } }
export function isWorkingState(value: unknown, templateId?: TemplateId): value is WorkingState { if (typeof value !== "object" || value === null) return false; const s = value as Record<string, unknown>; return s.schemaVersion === 1 && (templateId === undefined || s.templateId === templateId) && typeof s.templateId === "string" && typeof s.room === "object" && Array.isArray(s.features) && Array.isArray(s.furniture) && Array.isArray(s.constraints); }
export function readSnapshot(storage: StorageLike | null | undefined, templateId: TemplateId): WorkingState { try { const raw = storage?.getItem(storageKey(templateId)); if (!raw) return createTemplateState(templateId); const item = JSON.parse(raw) as StoredEnvelope; return item.storageVersion === 1 && item.templateId === templateId && isWorkingState(item.state, templateId) ? structuredClone(item.state) : createTemplateState(templateId); } catch { return createTemplateState(templateId); } }
export function saveSnapshot(storage: StorageLike | null | undefined, state: WorkingState): boolean { try { if (!storage) return false; storage.setItem(storageKey(state.templateId), JSON.stringify({ storageVersion: 1, templateId: state.templateId, state } satisfies StoredEnvelope)); return true; } catch { return false; } }
export const loadTemplateSnapshot = readSnapshot;
export const saveTemplateSnapshot = saveSnapshot;
