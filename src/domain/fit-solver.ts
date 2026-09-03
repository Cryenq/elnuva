import Logic, { type Bits, type Solver, type Term } from "logic-solver";
import { featureCatalogById, furnitureCatalogById } from "./catalog";
import { featureKeepOutAabb } from "./geometry";
import { assessFitRequest, assessFitTarget } from "./layout-assessment";
import type { FitRequest, FitWorkerResponse } from "./fit-contract";
import type { Aabb, Feature, Furniture, RotationDeg, WorkingState } from "./types";

type RectangleBits = Readonly<{ left: Bits; right: Bits; top: Bits; bottom: Bits }>;
type ItemBits = RectangleBits & Readonly<{ item: Furniture; x: Bits; y: Bits; rotation: Bits }>;

const MAX_INTEGER = 2 ** 31 - 1;
const MAX_GAP = 24000;

function constant(value: number): Bits {
  if (!Number.isSafeInteger(value) || Object.is(value, -0) || value < 0 || value > MAX_INTEGER) throw new RangeError("Unsupported solver integer.");
  return Logic.constantBits(value);
}

function variable(solver: Solver, name: string, max: number): Bits {
  const bits = Logic.variableBits(name, Math.max(1, Math.ceil(Math.log2(max + 1))));
  solver.require(Logic.lessThanOrEqual(bits, constant(max)));
  return bits;
}

function selectedDimension(swap: Term, normal: number, rotated: number): Bits {
  const count = Math.ceil(Math.log2(Math.max(normal, rotated) + 1));
  return new Logic.Bits(Array.from({ length: count }, (_, index) => Logic.or(
    Logic.and(Logic.not(swap), Math.floor(normal / 2 ** index) % 2 === 1 ? Logic.TRUE : Logic.FALSE),
    Logic.and(swap, Math.floor(rotated / 2 ** index) % 2 === 1 ? Logic.TRUE : Logic.FALSE),
  )));
}

/**
 * Original unsigned partial-product circuit. Ordered pairs include both cross
 * terms, and the adder retains every carry. Even two unrestricted 15-bit squares
 * total at most 2*(32767^2)=2147352578 < 2^31; model gaps are tighter (<=24000).
 */
export function encodeSquaredGapSum(x: Bits, y: Bits): Bits {
  if (x.bits.length > 15 || y.bits.length > 15) throw new RangeError("Gap operands must have at most 15 bits.");
  const terms: Term[] = [], weights: number[] = [];
  for (const operand of [x, y]) {
    for (let i = 0; i < operand.bits.length; i += 1) {
      for (let j = 0; j < operand.bits.length; j += 1) {
        terms.push(Logic.and(operand.bits[i], operand.bits[j]));
        weights.push(2 ** (i + j));
      }
    }
  }
  const result = Logic.weightedSum(terms, weights);
  if (result.bits.length > 31) throw new RangeError("Unexpected squared-gap carry width.");
  return result;
}

function fixedRectangle(rectangle: Aabb): RectangleBits {
  return { left: constant(rectangle.left2), right: constant(rectangle.right2), top: constant(rectangle.top2), bottom: constant(rectangle.bottom2) };
}

function separated(a: RectangleBits, b: RectangleBits): Term {
  return Logic.or(Logic.lessThanOrEqual(a.right, b.left), Logic.lessThanOrEqual(b.right, a.left), Logic.lessThanOrEqual(a.bottom, b.top), Logic.lessThanOrEqual(b.bottom, a.top));
}

/** Complete ordering partition: gaps are exact equalities, never slack variables. */
function gap(solver: Solver, name: string, aMin: Bits, aMax: Bits, bMin: Bits, bMax: Bits): Bits {
  const result = variable(solver, name, MAX_GAP);
  solver.require(Logic.or(
    Logic.and(Logic.lessThanOrEqual(aMax, bMin), Logic.equalBits(Logic.sum(aMax, result), bMin)),
    Logic.and(Logic.lessThanOrEqual(bMax, aMin), Logic.equalBits(Logic.sum(bMax, result), aMin)),
    Logic.and(Logic.lessThanOrEqual(aMin, bMax), Logic.lessThanOrEqual(bMin, aMax), Logic.equalBits(result, constant(0))),
  ));
  return result;
}

function physicalFeature(feature: Feature, target: WorkingState): Aabb {
  const catalog = featureCatalogById(feature.catalogId);
  if (!catalog) throw new Error("Unknown feature.");
  const start = feature.offsetMm * 2, end = start + catalog.spanMm * 2, depth = catalog.depthMm * 2;
  if (feature.wall === "north") return { left2: start, right2: end, top2: 0, bottom2: depth };
  if (feature.wall === "south") return { left2: start, right2: end, top2: target.room.depthMm * 2 - depth, bottom2: target.room.depthMm * 2 };
  if (feature.wall === "west") return { left2: 0, right2: depth, top2: start, bottom2: end };
  return { left2: target.room.widthMm * 2 - depth, right2: target.room.widthMm * 2, top2: start, bottom2: end };
}

function corridor(feature: Feature, widthMm: number, target: WorkingState): Aabb {
  const catalog = featureCatalogById(feature.catalogId);
  if (!catalog || catalog.type !== "door") throw new Error("Invalid corridor feature.");
  const center = feature.offsetMm * 2 + catalog.spanMm;
  const start = center - widthMm, end = center + widthMm;
  const horizontal = feature.wall === "north" || feature.wall === "south";
  if (start < 0 || end > (horizontal ? target.room.widthMm : target.room.depthMm) * 2) throw new Error("Invalid corridor extent.");
  if (feature.wall === "north") return { left2: start, right2: end, top2: 0, bottom2: target.room.depthMm };
  if (feature.wall === "south") return { left2: start, right2: end, top2: target.room.depthMm, bottom2: target.room.depthMm * 2 };
  if (feature.wall === "west") return { left2: 0, right2: target.room.widthMm, top2: start, bottom2: end };
  return { left2: target.room.widthMm, right2: target.room.widthMm * 2, top2: start, bottom2: end };
}

function identity(value: unknown): Readonly<{ requestId: string; generation: number }> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const requestId = Object.getOwnPropertyDescriptor(value, "requestId")?.value as unknown;
  const generation = Object.getOwnPropertyDescriptor(value, "generation")?.value as unknown;
  if (typeof requestId !== "string" || !/^[A-Za-z0-9_-]{16,80}$/.test(requestId) || typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 1) return null;
  return { requestId, generation };
}

function frozen<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}

/** Worker-only complete finite model. Null from the completed SAT solve is its sole UNSAT route. */
export function solveFitRequest(value: unknown): FitWorkerResponse {
  let responseIdentity: ReturnType<typeof identity> = null;
  try {
    responseIdentity = identity(value);
    const decoded = assessFitRequest(value);
    if (!decoded.ok) return frozen(responseIdentity ? { kind: "result", ...responseIdentity, status: "INVALID_REQUEST" } : { kind: "protocol-error", status: "INTERNAL_ERROR" });
    const request: FitRequest = decoded.data;
    responseIdentity = { requestId: request.requestId, generation: request.generation };
    const target: WorkingState = structuredClone({ ...request.baseline, room: request.targetRoom, furniture: [
      ...request.baseline.furniture,
      ...request.additions.map((addition): Furniture => ({ ...addition, xMm: 0, yMm: 0, rotationDeg: 0 })),
    ] });
    const solver = new Logic.Solver();
    const items: ItemBits[] = target.furniture.map((item, index) => {
      const catalog = furnitureCatalogById(item.catalogId);
      if (!catalog) throw new Error("Unknown furniture.");
      const x = variable(solver, `item${index}x`, target.room.widthMm);
      const y = variable(solver, `item${index}y`, target.room.depthMm);
      const rotation = variable(solver, `item${index}r`, 3);
      const width = selectedDimension(rotation.bits[0], catalog.widthMm, catalog.depthMm);
      const depth = selectedDimension(rotation.bits[0], catalog.depthMm, catalog.widthMm);
      const left = variable(solver, `item${index}left`, target.room.widthMm * 2);
      const top = variable(solver, `item${index}top`, target.room.depthMm * 2);
      // Unsigned equalities enforce nonnegative edges without modular subtraction.
      const right = Logic.sum(left, width, width), bottom = Logic.sum(top, depth, depth);
      solver.require(Logic.equalBits(Logic.sum(left, width), Logic.sum(x, x)), Logic.equalBits(Logic.sum(top, depth), Logic.sum(y, y)), Logic.lessThanOrEqual(right, constant(target.room.widthMm * 2)), Logic.lessThanOrEqual(bottom, constant(target.room.depthMm * 2)));
      if (item.locked) solver.require(Logic.equalBits(x, constant(item.xMm)), Logic.equalBits(y, constant(item.yMm)), Logic.equalBits(rotation, constant(item.rotationDeg / 90)));
      return { item, x, y, rotation, left, top, right, bottom };
    });
    for (let i = 0; i < items.length; i += 1) {
      for (let j = i + 1; j < items.length; j += 1) solver.require(separated(items[i], items[j]));
      for (const feature of target.features) {
        const keepOut = featureKeepOutAabb(feature, target.room);
        if (keepOut) solver.require(separated(items[i], fixedRectangle(keepOut)));
      }
    }
    const byId = new Map(items.map((item) => [item.item.id, item]));
    const features = new Map(target.features.map((feature) => [feature.id, feature]));
    target.constraints.forEach((constraint, index) => {
      if (constraint.strength !== "required") return;
      if (constraint.type === "door_path_clear") {
        const feature = features.get(constraint.featureId);
        if (!feature) throw new Error("Unknown corridor.");
        const rectangle = fixedRectangle(corridor(feature, constraint.widthMm, target));
        items.forEach((item) => solver.require(separated(item, rectangle)));
        return;
      }
      const first = byId.get(constraint.type === "feature_distance" ? constraint.itemId : constraint.itemAId);
      const feature = constraint.type === "feature_distance" ? features.get(constraint.featureId) : null;
      const second = constraint.type === "feature_distance" ? feature && fixedRectangle(physicalFeature(feature, target)) : byId.get(constraint.itemBId);
      if (!first || !second) throw new Error("Unknown distance referent.");
      const x = gap(solver, `constraint${index}gapX`, first.left, first.right, second.left, second.right);
      const y = gap(solver, `constraint${index}gapY`, first.top, first.bottom, second.top, second.bottom);
      const squared = encodeSquaredGapSum(x, y);
      solver.require(Logic.lessThanOrEqual(squared, constant(1_152_000_000)));
      solver.require(constraint.relation === "near"
        ? Logic.lessThan(squared, constant(4 * (constraint.thresholdMm + 1) ** 2))
        : Logic.greaterThanOrEqual(squared, constant(4 * constraint.thresholdMm ** 2)));
    });
    const solution = solver.solve();
    if (solution === null) return frozen({ kind: "result", ...responseIdentity, status: "PROVEN_IMPOSSIBLE" });
    const solved: WorkingState = { ...target, furniture: items.map((item) => ({ ...item.item, xMm: solution.evaluate(item.x), yMm: solution.evaluate(item.y), rotationDeg: solution.evaluate(item.rotation) * 90 as RotationDeg })) };
    const assessment = assessFitTarget(request, solved);
    if (!assessment.hardValid || !assessment.requiredSatisfied) return frozen({ kind: "result", ...responseIdentity, status: "INTERNAL_ERROR" });
    return frozen({ kind: "result", ...responseIdentity, status: "FOUND", target: solved });
  } catch {
    return frozen(responseIdentity ? { kind: "result", ...responseIdentity, status: "INTERNAL_ERROR" } : { kind: "protocol-error", status: "INTERNAL_ERROR" });
  }
}
