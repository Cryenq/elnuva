import { solveFitRequest } from "./fit-solver";
import type { FitWorkerResponse } from "./fit-contract";

// This static module is the only browser entry importing the solver backend.
let consumed = false;
self.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (consumed) return;
  consumed = true;
  let response: FitWorkerResponse = { kind: "protocol-error", status: "INTERNAL_ERROR" };
  try {
    const value = event.data;
    if (value !== null && typeof value === "object" && !Array.isArray(value)
      && Reflect.ownKeys(value).length === 2
      && Object.prototype.hasOwnProperty.call(value, "kind") && Object.prototype.hasOwnProperty.call(value, "request")
      && (value as Record<string, unknown>).kind === "solve") {
      response = solveFitRequest((value as Record<string, unknown>).request);
    }
  } catch { /* Protocol errors never forward exception text. */ }
  self.postMessage(response);
});

self.addEventListener("messageerror", () => {
  if (consumed) return;
  consumed = true;
  self.postMessage({ kind: "protocol-error", status: "INTERNAL_ERROR" } satisfies FitWorkerResponse);
});
