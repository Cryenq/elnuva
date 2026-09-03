import type { SpatialViewMode } from "./spatial-view-contract";

const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "") => {
  const node = document.createElement(tag);
  node.textContent = text;
  return node;
};

/** Persistent application furniture; the spatial renderer owns only spatialHost. */
export function createWorkspaceShell(root: HTMLElement) {
  const shell = element("div");
  shell.className = "app-shell";
  const header = element("header");
  header.className = "site-header";
  const brand = element("div");
  brand.className = "brand";
  brand.append(element("h1", "Elnuva"), element("p", "A little space. A better fit."));
  const templateSlot = element("div");
  templateSlot.className = "template-slot";
  const actionsSlot = element("div");
  actionsSlot.className = "editor-actions";
  header.append(brand, templateSlot, actionsSlot);

  const entry = element("section");
  entry.dataset.workspaceEntry = "";
  entry.className = "workspace-entry";
  entry.setAttribute("aria-labelledby", "welcome-heading");
  const welcome = element("div");
  const eyebrow = element("p", "YOUR SPACE, YOUR CALL");
  eyebrow.className = "eyebrow";
  const welcomeTitle = element("h2", "Make room for what matters.");
  welcomeTitle.id = "welcome-heading";
  welcome.append(eyebrow, welcomeTitle, element("p", "Choose a room, move things around, and see what fits. Your agent can suggest. You stay in control."));
  const entryActions = element("div");
  entryActions.className = "entry-actions";
  const startButton = element("button", "Start designing");
  startButton.type = "button";
  startButton.className = "primary-action";
  startButton.dataset.focusKey = "workspace:start";
  entryActions.append(startButton, element("span", "Three editable rooms · Precise millimetres"));
  entry.append(welcome, entryActions);

  const workspace = element("main");
  workspace.dataset.workspace = "";
  workspace.className = "workspace";
  const centre = element("section");
  centre.className = "card layout-card";
  centre.setAttribute("aria-labelledby", "workspace-title");
  const viewportHeading = element("div");
  viewportHeading.className = "viewport-heading";
  const title = element("h2", "Your room");
  title.id = "workspace-title";
  title.tabIndex = -1;
  viewportHeading.append(title, element("span", "INTERACTIVE WORKSPACE"));
  const toolbar = element("div");
  toolbar.className = "view-toolbar";
  toolbar.setAttribute("aria-label", "Room view");
  const modeButtons = {} as Record<SpatialViewMode, HTMLButtonElement>;
  for (const [mode, label] of [["isometric", "Isometric"], ["top", "Top"], ["precision-2d", "Precision 2D"]] as const) {
    const button = element("button", label);
    button.type = "button";
    button.dataset.focusKey = `view:${mode}`;
    button.setAttribute("aria-pressed", String(mode === "isometric"));
    modeButtons[mode] = button;
    toolbar.append(button);
  }
  const resetViewButton = element("button", "Reset view");
  resetViewButton.type = "button";
  resetViewButton.dataset.focusKey = "view:reset";
  resetViewButton.className = "reset-view";
  toolbar.append(resetViewButton);
  const spatialStatus = element("p", "Preparing the spatial view…");
  spatialStatus.dataset.spatialStatus = "";
  spatialStatus.dataset.state = "initializing";
  spatialStatus.className = "spatial-status";
  spatialStatus.setAttribute("role", "status");
  const spatialHost = element("div");
  spatialHost.dataset.spatialHost = "";
  spatialHost.className = "spatial-host";
  const precisionHost = element("div");
  precisionHost.className = "precision-host";
  const guidance = element("p", "Select furniture to edit it. Drag to move · 50 mm snap · Heights are illustrative.");
  guidance.className = "viewport-guidance";
  const summarySlot = element("div");
  const reviewSlot = element("div");
  reviewSlot.dataset.reviewDock = "";
  const editorStatus = element("p", "Ready to edit the room.");
  editorStatus.dataset.editorStatus = "";
  editorStatus.dataset.focusKey = "status:editor";
  editorStatus.tabIndex = -1;
  editorStatus.setAttribute("role", "status");
  editorStatus.setAttribute("aria-live", "polite");
  editorStatus.setAttribute("aria-atomic", "true");
  centre.append(viewportHeading, toolbar, spatialStatus, spatialHost, precisionHost, guidance, summarySlot, reviewSlot, editorStatus);

  const rail = element("aside");
  rail.className = "card controls-card";
  rail.setAttribute("aria-label", "Furniture library and room items");
  const catalogSlot = element("div");
  const sceneListSlot = element("div");
  rail.append(catalogSlot, sceneListSlot);
  const right = element("aside");
  right.className = "card details-card";
  right.setAttribute("aria-label", "Selected furniture and room settings");
  const inspectorSlot = element("div");
  right.append(inspectorSlot);
  const disclosure = (key: string, label: string) => {
    const details = element("details");
    details.dataset.workspaceSection = key;
    const summary = element("summary", label);
    summary.dataset.focusKey = `section:${key}`;
    const content = element("div");
    content.className = "disclosure-content";
    details.append(summary, content);
    right.append(details);
    return content;
  };
  const roomSlot = disclosure("room", "Room");
  const featuresSlot = disclosure("features", "Features");
  const constraintsSlot = disclosure("constraints", "Constraints");
  const layoutDataSlot = disclosure("layout-data", "Layout data");
  workspace.append(centre, rail, right);

  const agent = element("section");
  agent.className = "capability-panel";
  agent.setAttribute("aria-label", "Agent capability");
  const capabilityStatus = element("p", "Checking WebMCP availability…");
  capabilityStatus.className = "capability-status";
  capabilityStatus.dataset.state = "checking";
  capabilityStatus.setAttribute("role", "status");
  agent.append(capabilityStatus, element("p", "Your agent can inspect, validate and stage a preview. Only you can apply, discard, save or undo."));
  const footer = element("footer", "Local-first planning aid · Not architectural, accessibility, or safety certification.");
  footer.className = "site-footer";
  shell.append(header, entry, workspace, agent, footer);
  root.replaceChildren(shell);
  return Object.freeze({ shell, workspace, entry, startButton, title, templateSlot, actionsSlot, summarySlot, catalogSlot, sceneListSlot, inspectorSlot, roomSlot, featuresSlot, constraintsSlot, layoutDataSlot, reviewSlot, precisionHost, spatialHost, spatialStatus, capabilityStatus, editorStatus, modeButtons, resetViewButton });
}
