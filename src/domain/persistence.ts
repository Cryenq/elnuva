import { isValidWorkingState } from "./canonical";
import { createTemplateState } from "./templates";
import type { StoredEnvelope, TemplateId, WorkingState } from "./types";

export const storageKeyForTemplate = (templateId: TemplateId): string => `elnuva:v1:template:${templateId}`;
export const storageKey = storageKeyForTemplate;

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export class MemoryStorage implements StorageLike {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

type PersistenceErrorCode = "INVALID_SNAPSHOT" | "STORAGE_UNAVAILABLE" | "INVALID_STATE";
type PersistenceError = Readonly<{ code: PersistenceErrorCode; message: string }>;

export type LoadSnapshotResult =
  | Readonly<{ ok: true; source: "factory" | "saved"; state: WorkingState }>
  | Readonly<{ ok: false; fallback: true; state: WorkingState; error: PersistenceError }>;

export type SaveSnapshotResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; error: PersistenceError }>;

const fallback = (templateId: TemplateId, error: PersistenceError): LoadSnapshotResult => ({
  ok: false,
  fallback: true,
  state: createTemplateState(templateId),
  error,
});

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function loadTemplateSnapshot(storage: StorageLike | null | undefined, templateId: TemplateId): LoadSnapshotResult {
  if (!storage) return { ok: true, source: "factory", state: createTemplateState(templateId) };
  let raw: string | null;
  try {
    raw = storage.getItem(storageKeyForTemplate(templateId));
  } catch {
    return fallback(templateId, { code: "STORAGE_UNAVAILABLE", message: "Saved template data is unavailable." });
  }
  if (raw === null) return { ok: true, source: "factory", state: createTemplateState(templateId) };

  try {
    const envelope: unknown = JSON.parse(raw);
    if (!hasExactKeys(envelope, ["storageVersion", "templateId", "state"])) {
      return fallback(templateId, { code: "INVALID_SNAPSHOT", message: "Saved template data was invalid; factory data was loaded." });
    }
    if (envelope.storageVersion !== 1 || envelope.templateId !== templateId || !isValidWorkingState(envelope.state, templateId)) {
      return fallback(templateId, { code: "INVALID_SNAPSHOT", message: "Saved template data was invalid; factory data was loaded." });
    }
    return { ok: true, source: "saved", state: structuredClone(envelope.state) };
  } catch {
    return fallback(templateId, { code: "INVALID_SNAPSHOT", message: "Saved template data was invalid; factory data was loaded." });
  }
}

export function saveTemplateSnapshot(storage: StorageLike | null | undefined, state: WorkingState): SaveSnapshotResult {
  const templateId = typeof state === "object" && state !== null && "templateId" in state ? state.templateId : undefined;
  if ((templateId !== "home-office" && templateId !== "bedroom" && templateId !== "study") || !isValidWorkingState(state, templateId)) {
    return { ok: false, error: { code: "INVALID_STATE", message: "The current template state is invalid and was not saved." } };
  }
  if (!storage) {
    return { ok: false, error: { code: "STORAGE_UNAVAILABLE", message: "Local template storage is unavailable." } };
  }
  const envelope: StoredEnvelope = { storageVersion: 1, templateId, state: structuredClone(state) };
  try {
    storage.setItem(storageKeyForTemplate(templateId), JSON.stringify(envelope));
    return { ok: true };
  } catch {
    return { ok: false, error: { code: "STORAGE_UNAVAILABLE", message: "The template could not be saved locally." } };
  }
}

export const readSnapshot = loadTemplateSnapshot;
export const saveSnapshot = saveTemplateSnapshot;
export const isWorkingState = isValidWorkingState;
