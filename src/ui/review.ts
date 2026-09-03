import { furnitureCatalogById } from "../domain/catalog";
import type { PreviewState } from "../domain/types";

export type ReviewCallbacks = Readonly<{ apply: () => void; discard: () => void }>;

export function reviewPanel(preview: PreviewState | null, callbacks: ReviewCallbacks): HTMLElement {
  const section = document.createElement("section");
  section.className = "preview-review";
  const heading = document.createElement("h2"); heading.textContent = "Agent preview review"; section.append(heading);
  if (!preview) { const empty = document.createElement("p"); empty.dataset.previewEmpty = ""; empty.textContent = "No preview pending. Changes are controlled by you."; section.append(empty); return section; }
  section.dataset.previewReview = "";
  const status = document.createElement("p"); status.className = "preview-trust-status"; status.dataset.previewStatus = "pending-review"; status.dataset.notApplied = "true"; status.dataset.notSaved = "true"; status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite"); status.setAttribute("aria-atomic", "true");
  const state = document.createElement("strong"); state.textContent = "Pending review · Not applied · Not saved"; status.append(state); section.append(status);
  const instruction = document.createElement("p"); instruction.className = "preview-instruction"; instruction.textContent = "Review the staged ghost, then choose Apply or Discard. Only these buttons can resolve this preview."; section.append(instruction);
  const validation = preview.validation; section.dataset.optionId = validation.optionId; const metrics = document.createElement("dl"); metrics.className = "preview-metrics";
  const addMetric = (term: string, value: string, dataset?: string) => { const dt = document.createElement("dt"); dt.textContent = term; const dd = document.createElement("dd"); dd.textContent = value; if (dataset) dd.dataset[dataset] = dataset === "optionId" ? value : ""; const item = document.createElement("div"); item.append(dt, dd); metrics.append(item); };
  addMetric("Option", validation.optionId, "optionId"); addMetric("Moved", String(validation.movedCount)); addMetric("Rotated", String(validation.rotatedCount)); addMetric("Movement", `${validation.totalMovementMm} mm`); addMetric("Clearance", `${validation.minimumClearanceMm} mm`); addMetric("Required constraints", `${validation.required.satisfied}/${validation.required.total}`, "previewRequired"); addMetric("Preferred constraints", `${validation.preferred.satisfied}/${validation.preferred.total}`, "previewPreferred"); addMetric("Validation", validation.hardValid && validation.stageable ? "Valid · stageable" : "Needs attention"); section.append(metrics);
  const constraints = document.createElement("ul"); constraints.className = "preview-constraints"; constraints.dataset.previewConstraints = ""; constraints.dataset.previewConstraintResults = "";
  const constraintLabel = (strength: string) => strength === "required" ? "Required constraints" : "Preferred constraints";
  for (const result of validation.constraintResults) {
    const row = document.createElement("li"); row.dataset.constraintResult = ""; row.dataset.constraintId = result.constraintId;
    const label = document.createElement("strong"); label.textContent = `${result.constraintId} · ${constraintLabel(result.strength)} · ${result.type}`;
    const detail = document.createElement("span"); detail.textContent = ` · ${result.satisfied ? "satisfied" : "not satisfied"} · ${result.operator} · actual ${result.actualMm === null ? "n/a" : `${result.actualMm} mm`} · target ${result.targetMm} mm`;
    row.append(label, detail); constraints.append(row);
  }
  section.append(constraints);
  const moved = document.createElement("ul"); moved.className = "preview-moves"; moved.dataset.previewMoves = "";
  for (const move of preview.moves) { const item = preview.projectedFurniture.find(candidate => candidate.id === move.itemId); const label = item ? furnitureCatalogById(item.catalogId)?.label ?? move.itemId : move.itemId; const li = document.createElement("li"); li.textContent = `${label} → ${move.pose.xMm}, ${move.pose.yMm} mm · ${move.pose.rotationDeg}°`; moved.append(li); } section.append(moved);
  const issues = document.createElement("p"); issues.className = "preview-issues"; issues.dataset.previewIssues = ""; const issueMessages = validation.issues as readonly { message: string }[]; issues.textContent = issueMessages.length === 0 ? "Issues: none" : `Issues: ${issueMessages.map(issue => issue.message).join("; ")}`; section.append(issues);
  const actions = document.createElement("div"); actions.className = "preview-actions";
  const apply = document.createElement("button"); apply.type = "button"; apply.textContent = "Apply preview"; apply.dataset.previewApply = ""; apply.dataset.focusKey = "preview:apply"; apply.className = "primary-action"; apply.addEventListener("click", callbacks.apply);
  const discard = document.createElement("button"); discard.type = "button"; discard.textContent = "Discard preview"; discard.dataset.previewDiscard = ""; discard.dataset.focusKey = "preview:discard"; discard.addEventListener("click", callbacks.discard); actions.append(apply, discard); section.append(actions);
  return section;
}
