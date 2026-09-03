import { furnitureCatalogById } from "../domain/catalog";
import type { StoreSnapshot } from "../domain/store";
import type { HumanFitPreview } from "../domain/fit-contract";

export type ReviewCallbacks = Readonly<{ apply: () => void; discard: () => void }>;

function humanFitReview(preview: HumanFitPreview, callbacks: ReviewCallbacks): HTMLElement {
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "") => { const el = document.createElement(tag); el.textContent = text; return el; };
  const section = make("section"); section.className = "preview-review human-fit-review"; section.dataset.humanFitPreview = "";
  section.dataset.notApplied = "true"; section.dataset.notSaved = "true";
  section.append(make("h2", "Make it Fit preview — Not applied — Not saved"));
  const old = preview.request.baseline.room, target = preview.projectedState.room;
  const room = make("p", `Original room ${old.widthMm} × ${old.depthMm} mm → Target room ${target.widthMm} × ${target.depthMm} mm.`);
  section.append(room, make("p", "The solid room is your unchanged working reference. Dashed and translucent shapes show the complete target. Apply once to replace the room and inventory; Save remains a separate action."));
  section.append(make("h3", `${preview.request.additions.length} requested additions`));
  const additions = make("ul");
  for (const item of preview.request.additions) { const entry = furnitureCatalogById(item.catalogId)!; additions.append(make("li", `${entry.label} · ${item.id} · ${entry.widthMm} × ${entry.depthMm} mm · Requested — not placed`)); }
  if (!preview.request.additions.length) additions.append(make("li", "No additions. All existing furniture is retained at its full size."));
  section.append(additions);
  const counts = preview.assessment;
  section.append(make("p", `Required constraints: ${counts.required.satisfied}/${counts.required.total}. Preferred constraints: ${counts.preferred.satisfied}/${counts.preferred.total}.`));
  const constraints = make("ul"); constraints.className = "preview-constraints";
  for (const result of counts.constraintResults) {
    const row = make("li", `${result.strength === "required" ? "Required" : "Preferred"} · ${result.constraintId} · ${result.type} · ${result.satisfied ? "satisfied" : "not satisfied"} · ${result.operator} · actual ${result.actualMm === null ? "n/a" : `${result.actualMm} mm`} · target ${result.targetMm} mm`);
    row.dataset.constraintId = result.constraintId; constraints.append(row);
  }
  section.append(constraints, make("h3", "Complete target furniture"));
  const poses = make("ul"); poses.className = "preview-moves";
  for (const item of preview.projectedState.furniture) {
    const entry = furnitureCatalogById(item.catalogId)!;
    poses.append(make("li", `${entry.label} · ${item.id} · ${entry.widthMm} × ${entry.depthMm} mm → ${item.xMm}, ${item.yMm} mm · ${item.rotationDeg}° · ${item.locked ? "Locked, unchanged" : "Editable after Apply"}`));
  }
  section.append(poses);
  const actions = make("div"); actions.className = "preview-actions";
  const apply = make("button", "Apply preview"); apply.type = "button"; apply.dataset.previewApply = ""; apply.dataset.focusKey = "preview:apply"; apply.className = "primary-action"; apply.addEventListener("click", callbacks.apply);
  const discard = make("button", "Discard preview"); discard.type = "button"; discard.dataset.previewDiscard = ""; discard.dataset.focusKey = "preview:discard"; discard.addEventListener("click", callbacks.discard);
  actions.append(apply, discard); section.append(actions); return section;
}

export function reviewPanel(preview: StoreSnapshot["preview"], callbacks: ReviewCallbacks): HTMLElement {
  if (preview?.status === "pending-human-fit") return humanFitReview(preview, callbacks);
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
