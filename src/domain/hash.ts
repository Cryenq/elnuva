import { canonicalProposal, canonicalWorkingState } from "./canonical";
import type { Constraint, SubmittedMove, WorkingState } from "./types";
const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
export async function sha256(value: string): Promise<string> { const bytes = new TextEncoder().encode(value); const digest = await crypto.subtle.digest("SHA-256", bytes); return hex(digest); }
export const hashWorkingState = (state: WorkingState): Promise<string> => sha256(canonicalWorkingState(state));
export function proposalCanonicalJson(baseRevision: number, baseHash: string, constraints: readonly Constraint[], optionId: string, moves: readonly SubmittedMove[]): string { return canonicalProposal({ contractVersion: "1.0.0", baseRevision, baseHash, constraints, optionId, moves }); }
export const hashProposal = (baseRevision: number, baseHash: string, constraints: readonly Constraint[], optionId: string, moves: readonly SubmittedMove[]): Promise<string> => sha256(proposalCanonicalJson(baseRevision, baseHash, constraints, optionId, moves));
export const sha256Hex = sha256;
export const proposalDigest = hashProposal;
