import type { InspectSpatialLayoutData } from "./domain/types";

type CapabilityState = "checking" | "registered" | "unavailable" | "failed";

export type AppView = Readonly<{
  setCapabilityStatus: (state: CapabilityState, message: string) => void;
}>;

function appendTextElement<K extends keyof HTMLElementTagNameMap>(
  parent: HTMLElement,
  tagName: K,
  text: string,
  className?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tagName);
  element.textContent = text;
  if (className !== undefined) {
    element.className = className;
  }
  parent.append(element);
  return element;
}

function addDefinition(list: HTMLDListElement, term: string, value: string): void {
  appendTextElement(list, "dt", term);
  appendTextElement(list, "dd", value);
}

export function hydrateApp(root: HTMLElement, layout: InspectSpatialLayoutData): AppView {
  root.replaceChildren();

  const shell = document.createElement("div");
  shell.className = "app-shell";

  const header = document.createElement("header");
  header.className = "site-header";
  appendTextElement(header, "p", "Spatial workspace", "eyebrow");
  appendTextElement(header, "h1", "Elnuva");
  appendTextElement(
    header,
    "p",
    "Constraint-aware room planning, with you in control.",
    "tagline",
  );
  shell.append(header);

  const content = document.createElement("main");
  content.className = "workspace";

  const layoutCard = document.createElement("section");
  layoutCard.className = "card layout-card";
  layoutCard.setAttribute("aria-labelledby", "layout-heading");
  const layoutHeading = appendTextElement(layoutCard, "h2", "Active layout");
  layoutHeading.id = "layout-heading";
  appendTextElement(
    layoutCard,
    "p",
    "The local Home Office fixture is ready for inspection.",
    "section-intro",
  );

  const summary = document.createElement("dl");
  summary.className = "layout-summary";
  addDefinition(summary, "Template", "Home Office");
  addDefinition(
    summary,
    "Room",
    `${layout.workingState.room.widthMm} × ${layout.workingState.room.depthMm} mm`,
  );
  addDefinition(summary, "Revision", String(layout.baseRevision));
  addDefinition(summary, "Furniture", String(layout.workingState.furniture.length));
  addDefinition(summary, "Features", String(layout.workingState.features.length));
  addDefinition(summary, "Constraints", String(layout.workingState.constraints.length));
  layoutCard.append(summary);

  const inventoryHeading = appendTextElement(layoutCard, "h3", "Furniture inventory");
  inventoryHeading.id = "inventory-heading";
  const tableWrap = document.createElement("div");
  tableWrap.className = "table-wrap";
  const table = document.createElement("table");
  table.setAttribute("aria-labelledby", inventoryHeading.id);
  const tableHead = document.createElement("thead");
  const headingRow = document.createElement("tr");
  for (const heading of ["Item", "Position", "Rotation", "Lock"]) {
    appendTextElement(headingRow, "th", heading).scope = "col";
  }
  tableHead.append(headingRow);
  table.append(tableHead);

  const catalogLabels = new Map(
    layout.catalog.furniture.map((entry) => [entry.id, entry.label] as const),
  );
  const tableBody = document.createElement("tbody");
  for (const item of layout.workingState.furniture) {
    const row = document.createElement("tr");
    appendTextElement(row, "th", catalogLabels.get(item.catalogId) ?? item.id).scope = "row";
    appendTextElement(row, "td", `${item.xMm}, ${item.yMm} mm`);
    appendTextElement(row, "td", `${item.rotationDeg}°`);
    appendTextElement(row, "td", item.locked ? "Locked" : "Unlocked");
    tableBody.append(row);
  }
  table.append(tableBody);
  tableWrap.append(table);
  layoutCard.append(tableWrap);

  const capabilityCard = document.createElement("aside");
  capabilityCard.className = "card capability-card";
  capabilityCard.setAttribute("aria-labelledby", "capability-heading");
  const capabilityHeading = appendTextElement(capabilityCard, "h2", "Agent capability");
  capabilityHeading.id = "capability-heading";
  appendTextElement(
    capabilityCard,
    "p",
    "The room remains visible when WebMCP is absent. When supported, an agent can inspect this same bounded state.",
    "section-intro",
  );
  const capabilityStatus = appendTextElement(
    capabilityCard,
    "p",
    "Checking WebMCP availability…",
    "capability-status",
  );
  capabilityStatus.setAttribute("role", "status");
  capabilityStatus.setAttribute("aria-live", "polite");
  capabilityStatus.dataset.state = "checking";

  const disclosure = document.createElement("dl");
  disclosure.className = "capability-details";
  addDefinition(disclosure, "Inspect tool", "inspect_spatial_layout");
  addDefinition(disclosure, "Access", "Read-only");
  addDefinition(disclosure, "Preview", "None");
  addDefinition(disclosure, "Working state", "Unchanged by inspection");
  capabilityCard.append(disclosure);

  content.append(layoutCard, capabilityCard);
  shell.append(content);

  const footer = document.createElement("footer");
  footer.className = "site-footer";
  appendTextElement(
    footer,
    "p",
    `Layout ${layout.baseHash.slice(0, 12)} · north-west origin · millimetres`,
  );
  shell.append(footer);
  root.append(shell);

  return Object.freeze({
    setCapabilityStatus(state: CapabilityState, message: string): void {
      capabilityStatus.dataset.state = state;
      capabilityStatus.textContent = message;
    },
  });
}
