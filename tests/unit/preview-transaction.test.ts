import { describe, expect, it } from "vitest";
import { createStageTransactionBook, createValidateTransactionBook, type StageReservation } from "../../src/domain/preview";
import { createFactoryState } from "../../src/domain/templates";
import type { PreviewState, StageBinding } from "../../src/domain/types";

type Outcome = { ok: true; value: string } | { ok: false; code: string };
const baseHash = "b".repeat(64);
const digest = "a".repeat(64);
const failed: Outcome = { ok: false, code: "REVISION_CONFLICT" };
const cancelled: Outcome = { ok: false, code: "CANCELLED" };

const binding = (idempotencyKey = "fixture-key-00001", proposalDigest = digest): StageBinding => ({
  idempotencyKey,
  proposalDigest,
  baseRevision: 1,
  baseHash,
});

function preview(idempotencyKey = "fixture-key-00001", proposalDigest = digest): PreviewState {
  const state = createFactoryState("home-office");
  const moves = [{ itemId: "desk-main", pose: { xMm: 1900, yMm: 500, rotationDeg: 0 as const } }];
  return {
    status: "pending-review",
    baseRevision: 1,
    baseHash,
    optionId: "valid",
    moves,
    constraints: state.constraints,
    proposalDigest,
    idempotencyKey,
    validation: {
      optionId: "valid",
      hardValid: true,
      stageable: true,
      issues: [],
      constraintResults: [],
      required: { satisfied: 0, total: 0 },
      preferred: { satisfied: 0, total: 0 },
      movedCount: 1,
      rotatedCount: 0,
      totalMovementMm: 600,
      minimumClearanceMm: 100,
      proposalDigest,
    },
    projectedFurniture: state.furniture.map((item) => item.id === "desk-main" ? { ...item, xMm: 1900 } : item),
    notApplied: true,
    notSaved: true,
    requiresHumanAction: true,
  };
}

function reserve(book: ReturnType<typeof createStageTransactionBook<Outcome>>, request: StageBinding): StageReservation<Outcome> {
  const result = book.begin(request);
  expect(result.kind).toBe("reserved");
  return result as StageReservation<Outcome>;
}

describe("Document-scoped Stage transaction safety", () => {
  it("replays completed keys ahead of preview/base drift, conflicts on a changed digest, and retains tombstones", () => {
    const book = createStageTransactionBook<Outcome>();
    const reservation = reserve(book, binding());
    const response: Outcome = { ok: true, value: "original" };
    expect(book.commitAtomically(reservation, { preview: preview(), response }, { baseRevision: 1, baseHash, previewAbsent: true, aborted: false }, { rejected: failed, cancelled })).toBe("committed");
    book.clearPreview();
    expect(book.begin({ ...binding(), baseRevision: 99, baseHash: "c".repeat(64) })).toStrictEqual({ kind: "replay", response });
    expect(book.begin(binding("fixture-key-00001", "d".repeat(64)))).toStrictEqual({ kind: "failure", code: "IDEMPOTENCY_CONFLICT" });
    expect(book.completedCount()).toBe(1);
  });

  it("enforces reservation join/conflict/busy and the 16-key never-evicted capacity", async () => {
    const book = createStageTransactionBook<Outcome>();
    const first = reserve(book, binding("reservation-key-01"));
    const joined = book.begin(binding("reservation-key-01"));
    expect(joined.kind).toBe("join");
    expect(book.begin(binding("reservation-key-01", "d".repeat(64)))).toStrictEqual({ kind: "failure", code: "IDEMPOTENCY_CONFLICT" });
    expect(book.begin(binding("different-key-0001"))).toStrictEqual({ kind: "failure", code: "STATE_UNAVAILABLE" });
    book.cancel(first, failed);
    if (joined.kind === "join") await expect(joined.promise).resolves.toStrictEqual(failed);

    for (let index = 0; index < 16; index += 1) {
      const key = `completed-key-${String(index).padStart(2, "0")}`;
      const proposalDigest = index.toString(16).padStart(64, "0");
      const reservation = reserve(book, binding(key, proposalDigest));
      expect(book.commitAtomically(reservation, { preview: preview(key, proposalDigest), response: { ok: true, value: key } }, { baseRevision: 1, baseHash, previewAbsent: true, aborted: false }, { rejected: failed, cancelled })).toBe("committed");
      book.clearPreview();
    }
    expect(book.completedCount()).toBe(16);
    expect(book.begin(binding("seventeenth-key-01"))).toStrictEqual({ kind: "failure", code: "STATE_UNAVAILABLE" });
    expect(book.begin(binding("completed-key-00", "0".repeat(64)))).toMatchObject({ kind: "replay" });
  });

  it("never permits partial preview/record CAS and separately bounds Validate", () => {
    const book = createStageTransactionBook<Outcome>();
    const reservation = reserve(book, binding("atomic-key-000001"));
    expect(book.commitAtomically(reservation, { preview: preview("atomic-key-000001"), response: { ok: true, value: "no" } }, { baseRevision: 2, baseHash, previewAbsent: true, aborted: false }, { rejected: failed, cancelled })).toBe("rejected");
    expect(book.completedCount()).toBe(0);
    expect(book.hasPreview()).toBe(false);
    expect(book.begin(binding("next-key-00000001"))).toMatchObject({ kind: "reserved" });

    const validate = createValidateTransactionBook();
    const first = validate.begin();
    expect("token" in first).toBe(true);
    expect(validate.begin()).toStrictEqual({ kind: "failure", code: "STATE_UNAVAILABLE" });
    if ("token" in first) expect(validate.release(first)).toBe(true);
    expect(validate.begin()).toHaveProperty("token");
  });

  it("applies exact abort precedence after completed records and active reservations but before capacity and preview", async () => {
    const replayBook = createStageTransactionBook<Outcome>();
    const completed = reserve(replayBook, binding("abort-replay-key-01"));
    const response: Outcome = { ok: true, value: "recorded" };
    expect(replayBook.commitAtomically(completed, { preview: preview("abort-replay-key-01"), response }, { baseRevision: 1, baseHash, previewAbsent: true, aborted: false }, { rejected: failed, cancelled })).toBe("committed");
    const abortedReplay = new AbortController();
    abortedReplay.abort();
    expect(replayBook.begin(binding("abort-replay-key-01"), abortedReplay.signal)).toStrictEqual({ kind: "replay", response });
    expect(replayBook.begin(binding("abort-replay-key-01", "d".repeat(64)), abortedReplay.signal)).toStrictEqual({ kind: "failure", code: "IDEMPOTENCY_CONFLICT" });

    const activeBook = createStageTransactionBook<Outcome>();
    const owner = reserve(activeBook, binding("abort-active-key-01"));
    const joined = activeBook.begin(binding("abort-active-key-01"), abortedReplay.signal);
    expect(joined.kind).toBe("join");
    expect(activeBook.begin(binding("abort-active-key-01", "d".repeat(64)), abortedReplay.signal)).toStrictEqual({ kind: "failure", code: "IDEMPOTENCY_CONFLICT" });
    expect(activeBook.begin(binding("abort-other-key-001"), abortedReplay.signal)).toStrictEqual({ kind: "failure", code: "STATE_UNAVAILABLE" });
    activeBook.cancel(owner, cancelled);
    if (joined.kind === "join") await expect(joined.promise).resolves.toStrictEqual(cancelled);

    replayBook.clearPreview();
    for (let index = 1; index < 16; index += 1) {
      const key = `abort-capacity-${String(index).padStart(2, "0")}`;
      const proposalDigest = index.toString(16).padStart(64, "0");
      const reservation = reserve(replayBook, binding(key, proposalDigest));
      expect(replayBook.commitAtomically(reservation, { preview: preview(key, proposalDigest), response: { ok: true, value: key } }, { baseRevision: 1, baseHash, previewAbsent: true, aborted: false }, { rejected: failed, cancelled })).toBe("committed");
      replayBook.clearPreview();
    }
    expect(replayBook.begin(binding("abort-before-cap-01"), abortedReplay.signal)).toStrictEqual({ kind: "failure", code: "CANCELLED" });

    const previewBook = createStageTransactionBook<Outcome>();
    const previewOwner = reserve(previewBook, binding("abort-preview-key-1"));
    expect(previewBook.commitAtomically(previewOwner, { preview: preview("abort-preview-key-1"), response }, { baseRevision: 1, baseHash, previewAbsent: true, aborted: false }, { rejected: failed, cancelled })).toBe("committed");
    expect(previewBook.begin(binding("abort-before-prev-01"), abortedReplay.signal)).toStrictEqual({ kind: "failure", code: "CANCELLED" });
    expect(previewBook.begin(binding("new-pending-key-001"))).toStrictEqual({ kind: "failure", code: "PENDING_REVIEW" });
  });

  it("cancels synchronously immediately before CAS and releases the reservation without preview or record", async () => {
    const book = createStageTransactionBook<Outcome>();
    const controller = new AbortController();
    const reservation = reserve(book, binding("abort-final-cas-001"));
    const joined = book.begin(binding("abort-final-cas-001"));
    controller.abort();
    expect(book.commitAtomically(
      reservation,
      { preview: preview("abort-final-cas-001"), response: { ok: true, value: "must-not-commit" } },
      { baseRevision: 1, baseHash, previewAbsent: true, aborted: controller.signal.aborted },
      { rejected: failed, cancelled },
    )).toBe("cancelled");
    if (joined.kind === "join") await expect(joined.promise).resolves.toStrictEqual(cancelled);
    expect(book.hasPreview()).toBe(false);
    expect(book.completedCount()).toBe(0);
    expect(book.begin(binding("after-cancel-key-01"))).toMatchObject({ kind: "reserved" });
  });
});
