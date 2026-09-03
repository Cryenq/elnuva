/** Selected public API of the exact logic-solver 2.0.1 registry artifact. */
declare module "logic-solver" {
  const formulaBrand: unique symbol;

  /** Opaque library formula; callers construct formulas through public operators. */
  export interface Formula {
    readonly [formulaBrand]: true;
  }

  export type Term = string | number | Formula;
  type TermInput = Term | readonly TermInput[];
  type SumInput = Term | Bits | readonly SumInput[];

  /** Least-significant bit first; numeric results are limited to bits 0 through 30. */
  export class Bits {
    constructor(terms: readonly Term[]);
    readonly bits: readonly Term[];
  }

  export interface Solution {
    evaluate(value: Bits): number;
    evaluate(value: Term): boolean;
  }

  export class Solver {
    constructor();
    require(...terms: readonly TermInput[]): void;
    solve(): Solution | null;
  }

  /** Default CommonJS interop value; runtime imports belong only to the worker. */
  const Logic: Readonly<{
    Solver: typeof Solver;
    Bits: typeof Bits;
    TRUE: "$T";
    FALSE: "$F";
    variableBits(name: string, count: number): Bits;
    /** Values and weights must be integers within 0..2^31-1. */
    constantBits(value: number): Bits;
    and(...terms: readonly TermInput[]): Term;
    or(...terms: readonly TermInput[]): Term;
    not(term: Term): Term;
    implies(left: Term, right: Term): Term;
    equiv(left: Term, right: Term): Term;
    exactlyOne(...terms: readonly TermInput[]): Term;
    sum(...terms: readonly SumInput[]): Bits;
    weightedSum(terms: readonly Term[], weights: number | readonly number[]): Bits;
    equalBits(left: Bits, right: Bits): Term;
    lessThan(left: Bits, right: Bits): Term;
    lessThanOrEqual(left: Bits, right: Bits): Term;
    greaterThan(left: Bits, right: Bits): Term;
    greaterThanOrEqual(left: Bits, right: Bits): Term;
  }>;

  export default Logic;
}
