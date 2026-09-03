import type { WorkingState } from "./types";
const plain = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
function canonical(value: unknown): unknown { if (Array.isArray(value)) return value.map(canonical); if (plain(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])); return value; }
export function canonicalJson(value: unknown): string { return JSON.stringify(canonical(value)); }
export function canonicalWorkingState(state: WorkingState): string { return canonicalJson({ schemaVersion: state.schemaVersion, templateId: state.templateId, room: state.room, features: [...state.features].sort((a,b) => a.id.localeCompare(b.id)), furniture: [...state.furniture].sort((a,b) => a.id.localeCompare(b.id)), constraints: state.constraints }); }
export const canonicalizeWorkingState = canonicalWorkingState;
export const canonicalizeProposal = canonicalJson;
