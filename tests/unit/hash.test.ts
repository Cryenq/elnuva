import { describe, expect, it } from "vitest";
import { hashWorkingState, proposalDigest, sha256Hex } from "../../src/domain/hash";
import { createFactoryState } from "../../src/domain/templates";

describe("SHA-256 golden hashes", () => {
  it("matches all factory base hashes with lower-case 64-hex output", async () => {
    await expect(hashWorkingState(createFactoryState("home-office"))).resolves.toBe("54314a64f990ba98d9244a679e81d4037fc97c6275936c12e38ec243ca6aeb2e");
    await expect(hashWorkingState(createFactoryState("bedroom"))).resolves.toBe("bf71347d179de915dfb3976edd97e39da3673b35a94547dd51ed8ce3721a081b");
    await expect(hashWorkingState(createFactoryState("study"))).resolves.toBe("b2ba6f48701ab423805262c9136c6052ae3a5052da50448290124d087f764274");
    await expect(sha256Hex("abc")).resolves.toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("matches proposal digest goldens and binds revision/hash/constraint order", async () => {
    const state = createFactoryState("home-office");
    const input = { contractVersion: "1.0.0", baseRevision: 1, baseHash: "54314a64f990ba98d9244a679e81d4037fc97c6275936c12e38ec243ca6aeb2e", constraints: state.constraints, optionId: "home-valid", moves: [{ itemId: "desk-main", pose: { xMm: 1900, yMm: 500, rotationDeg: 0 } }] };
    await expect(proposalDigest(input)).resolves.toBe("0a1cb9ff5ba7bd65c1bdcb478bf53c55dc8c01a1605fe02fc2147151fe0db68f");
    await expect(proposalDigest({ ...input, baseRevision: 2 })).resolves.not.toBe("0a1cb9ff5ba7bd65c1bdcb478bf53c55dc8c01a1605fe02fc2147151fe0db68f");
  });
});
