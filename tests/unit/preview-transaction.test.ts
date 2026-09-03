import { describe, expect, it } from "vitest";
import { createStageTransactionBook } from "../../src/domain/preview";

const digest = "a".repeat(64);
const response = { previewId: digest, optionId: "valid", proposalDigest: digest, validation: { optionId: "valid", hardValid: true, stageable: true, issues: [] }, notApplied: true, notSaved: true, requiresHumanAction: true, allowedHumanActions: ["apply", "discard"] };

describe("Document-scoped Stage transaction safety", () => {
  it("replays completed keys ahead of preview/base drift, conflicts on a changed digest, and retains tombstones", async () => {
    const book = createStageTransactionBook();
    await book.commit({ idempotencyKey: "fixture-key-00001", proposalDigest: digest, baseRevision: 1, baseHash: digest, response });
    expect(await book.begin({ idempotencyKey: "fixture-key-00001", proposalDigest: digest })).toStrictEqual({ kind: "replay", response });
    expect(await book.begin({ idempotencyKey: "fixture-key-00001", proposalDigest: "b".repeat(64) })).toStrictEqual({ kind: "failure", code: "IDEMPOTENCY_CONFLICT" });
    expect(book.completedCount()).toBe(1);
  });

  it("enforces the exact active-reservation and 16-key precedence without eviction", async () => {
    const book = createStageTransactionBook();
    const reserved = await book.begin({ idempotencyKey: "reservation-key-01", proposalDigest: digest });
    expect(reserved.kind).toBe("reserved");
    expect(await book.begin({ idempotencyKey: "reservation-key-01", proposalDigest: digest })).toMatchObject({ kind: "join" });
    expect(await book.begin({ idempotencyKey: "reservation-key-01", proposalDigest: "b".repeat(64) })).toStrictEqual({ kind: "failure", code: "IDEMPOTENCY_CONFLICT" });
    expect(await book.begin({ idempotencyKey: "different-key-0001", proposalDigest: digest })).toStrictEqual({ kind: "failure", code: "STATE_UNAVAILABLE" });
    await book.release(reserved);
    for (let index = 0; index < 16; index += 1) await book.commit({ idempotencyKey: `completed-key-${String(index).padStart(2, "0")}`, proposalDigest: `${index}`.padStart(64, "0"), baseRevision: 1, baseHash: digest, response: { ...response, proposalDigest: `${index}`.padStart(64, "0") } });
    expect(book.completedCount()).toBe(16);
    expect(await book.begin({ idempotencyKey: "seventeenth-key-01", proposalDigest: digest })).toStrictEqual({ kind: "failure", code: "STATE_UNAVAILABLE" });
    expect(await book.begin({ idempotencyKey: "completed-key-00", proposalDigest: "0".repeat(64) })).toMatchObject({ kind: "replay" });
  });

  it("never permits a partial record/preview CAS and releases reservations after cancellation", async () => {
    const book = createStageTransactionBook();
    const reservation = await book.begin({ idempotencyKey: "atomic-key-000001", proposalDigest: digest });
    expect(reservation.kind).toBe("reserved");
    expect(() => book.commitAtomically(reservation, { preview: { status: "pending-review" }, response }, { current: false })).toThrow();
    expect(book.completedCount()).toBe(0);
    expect(book.hasPreview()).toBe(false);
    await book.cancel(reservation);
    expect(await book.begin({ idempotencyKey: "next-key-00000001", proposalDigest: digest })).toMatchObject({ kind: "reserved" });
  });
});
