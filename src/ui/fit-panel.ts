import { FURNITURE_CATALOG, LIMITS, furnitureCatalogById } from "../domain/catalog";
import { createFitController } from "../domain/fit-controller";
import type { FitAddition, FitProgress } from "../domain/fit-contract";
import type { DomainStore, StoreSnapshot } from "../domain/store";
import type { FurnitureCatalogId, Room } from "../domain/types";

const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "") => {
  const node = document.createElement(tag); node.textContent = text; return node;
};

/** Ephemeral human request controls. No requested item is placed by this panel. */
export function createFitPanel(store: DomainStore, beforeStart: () => void) {
  let snapshot: StoreSnapshot | undefined;
  let additions: FitAddition[] = [];
  let disposed = false;
  let progress: FitProgress = { status: "IDLE", requestId: null, elapsedMs: 0, budgetMs: 15000, message: "Request a room and furniture, then check whether they fit." };
  const section = element("section"); section.dataset.fitPanel = ""; section.className = "fit-panel";
  const details = element("details");
  const summary = element("summary", "Fit a new arrangement"); summary.dataset.focusKey = "section:fit";
  const content = element("div"); content.className = "disclosure-content";
  content.append(element("h2", "Make it Fit"), element("p", "Keep every existing item at its full size. Request additional furniture or a different room, then review a complete arrangement before applying it."));
  const form = element("form"); form.className = "fit-form";
  const dimension = (labelText: string, key: string) => {
    const label = element("label", labelText), input = element("input");
    input.type = "number"; input.min = String(LIMITS.roomMinMm); input.max = String(LIMITS.roomMaxMm); input.step = "1"; input.required = true;
    input.dataset.focusKey = key; input.addEventListener("input", () => controller.cancel());
    label.append(input); form.append(label); return input;
  };
  const width = dimension("Fit room width (mm)", "fit:width");
  const depth = dimension("Fit room depth (mm)", "fit:depth");
  const catalogLabel = element("label", "Furniture to request"), catalog = element("select");
  catalog.dataset.focusKey = "fit:catalog"; catalog.setAttribute("aria-label", "Furniture to request");
  for (const entry of FURNITURE_CATALOG) { const option = element("option", `${entry.label} · ${entry.widthMm} × ${entry.depthMm} mm`); option.value = entry.id; catalog.append(option); }
  catalog.addEventListener("change", () => controller.cancel()); catalogLabel.append(catalog);
  const requestButton = element("button", "Request furniture"); requestButton.type = "button"; requestButton.dataset.focusKey = "fit:request";
  requestButton.addEventListener("click", () => request(catalog.value as FurnitureCatalogId));
  const list = element("ul"); list.dataset.fitRequestList = ""; list.className = "fit-request-list";
  const note = element("p"); note.className = "fit-request-note"; note.setAttribute("role", "status");
  const start = element("button", "Make it Fit"); start.type = "submit"; start.className = "primary-action"; start.dataset.focusKey = "fit:start";
  const cancel = element("button", "Cancel fit"); cancel.type = "button"; cancel.dataset.focusKey = "fit:cancel"; cancel.addEventListener("click", () => controller.cancel());
  const actions = element("div"); actions.className = "fit-actions"; actions.append(start, cancel);
  const status = element("p"); status.dataset.fitStatus = ""; status.className = "fit-status"; status.setAttribute("aria-live", "polite"); status.setAttribute("aria-atomic", "true");
  form.append(catalogLabel, requestButton, list, note, actions); content.append(form, status); details.append(summary, content); section.append(details);

  function controls(): void {
    const pending = !!snapshot?.preview;
    width.disabled = depth.disabled = pending || !snapshot;
    catalog.disabled = pending || !snapshot || snapshot.workingState.furniture.length + additions.length >= LIMITS.maxFurniture;
    requestButton.disabled = catalog.disabled;
    start.disabled = pending || !snapshot || progress.status === "RUNNING";
    cancel.disabled = progress.status !== "RUNNING";
    for (const button of Array.from(list.querySelectorAll<HTMLButtonElement>("button"))) button.disabled = pending;
  }
  function renderRequests(): void {
    list.replaceChildren();
    if (!additions.length) list.append(element("li", "No furniture requested. Existing furniture is always included."));
    for (const addition of additions) {
      const entry = furnitureCatalogById(addition.catalogId)!;
      const row = element("li"); row.dataset.fitRequestId = addition.id;
      row.append(element("strong", `${entry.label} · ${entry.widthMm} × ${entry.depthMm} mm`), element("span", `${addition.id} · Requested — not placed`));
      const remove = element("button", `Remove request ${addition.id}`); remove.type = "button"; remove.dataset.focusKey = `fit:remove:${addition.id}`;
      remove.addEventListener("click", () => { if (disposed || snapshot?.preview) return; controller.cancel(); additions = additions.filter(item => item.id !== addition.id); renderRequests(); requestButton.focus(); });
      row.append(remove); list.append(row);
    }
    controls();
  }
  function request(catalogId: FurnitureCatalogId): void {
    if (disposed || !snapshot || snapshot.preview) return;
    controller.cancel();
    if (snapshot.workingState.furniture.length + additions.length >= LIMITS.maxFurniture) { note.textContent = `At most ${LIMITS.maxFurniture} existing and requested items can be fitted together.`; return; }
    const result = store.createFitAddition(catalogId);
    if (!result.ok) { note.textContent = result.error.message; return; }
    additions = [...additions, result.data]; note.textContent = "Requested only. Your working room and saved layout are unchanged.";
    details.open = true; renderRequests();
  }
  function renderStatus(): void {
    const preview = snapshot?.preview;
    const reviewingResult = preview?.status === "pending-human-fit" && preview.request.requestId === progress.requestId;
    const message = progress.status === "FOUND" && !reviewingResult
      ? "Last completed fit search found an arrangement."
      : progress.message;
    status.dataset.fitState = progress.status;
    const text = `${message} Elapsed ${Math.round(progress.elapsedMs)} / ${progress.budgetMs} ms.`;
    if (status.textContent !== text) status.textContent = text;
  }
  const controller = createFitController(store, value => {
    if (disposed) return;
    progress = value; renderStatus();
    controls();
  });
  form.addEventListener("submit", event => {
    event.preventDefault(); if (disposed || !snapshot || snapshot.preview || progress.status === "RUNNING") return;
    note.textContent = "";
    beforeStart();
    void controller.start({ targetRoom: { widthMm: Number(width.value), depthMm: Number(depth.value) }, additions: [...additions] });
  });
  controls();
  return Object.freeze({
    element: section,
    request,
    update(next: StoreSnapshot) {
      if (disposed) return;
      const reset = !snapshot || snapshot.activeTemplateId !== next.activeTemplateId;
      snapshot = next;
      if (reset) { controller.cancel(); additions = []; width.value = String(next.workingState.room.widthMm); depth.value = String(next.workingState.room.depthMm); note.textContent = ""; renderRequests(); }
      renderStatus(); controls();
    },
    applied(room: Room) {
      if (disposed) return;
      additions = []; note.textContent = "Fit result was applied. Saving is a separate action.";
      width.value = String(room.widthMm); depth.value = String(room.depthMm);
      renderRequests();
    },
    dispose() { if (disposed) return; disposed = true; controller.dispose(); },
  });
}
