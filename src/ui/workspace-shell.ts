import type { SpatialViewMode } from "./spatial-view-contract";

const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "") => {
  const node = document.createElement(tag);
  node.textContent = text;
  return node;
};
type WorkspacePanel = "properties" | "add" | "fit";

/** Persistent application furniture; the spatial renderer owns only spatialHost. */
export function createWorkspaceShell(root: HTMLElement) {
  const shell = element("div");
  shell.className = "app-shell";
  const header = element("header");
  header.className = "site-header";
  const brand = element("div");
  brand.className = "brand";
  brand.append(element("h1", "Elnuva"), element("p", "ROOM STUDIO"));
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
  const toolbar = element("div");
  toolbar.className = "workspace-toolbar";
  const title = element("h2", "Your room");
  title.id = "workspace-title";
  title.tabIndex = -1;
  const views = element("div");
  views.className = "view-toolbar";
  views.setAttribute("aria-label", "Room view");
  const modeButtons = {} as Record<SpatialViewMode, HTMLButtonElement>;
  for (const [mode, label] of [["isometric", "Isometric"], ["top", "Top"], ["precision-2d", "Precision 2D"]] as const) {
    const button = element("button", label);
    button.type = "button";
    button.dataset.focusKey = `view:${mode}`;
    button.setAttribute("aria-pressed", String(mode === "isometric"));
    modeButtons[mode] = button;
    views.append(button);
  }
  const resetViewButton = element("button", "Reset view");
  resetViewButton.type = "button";
  resetViewButton.dataset.focusKey = "view:reset";
  resetViewButton.className = "reset-view";
  views.append(resetViewButton);
  const navigation = element("div");
  navigation.className = "panel-navigation";
  navigation.setAttribute("aria-label", "Editor panels");
  toolbar.append(title, views, navigation);

  const centre = element("section");
  centre.className = "layout-card";
  centre.setAttribute("aria-labelledby", "workspace-title");
  const spatialHost = element("div");
  spatialHost.dataset.spatialHost = "";
  spatialHost.className = "spatial-host";
  const precisionHost = element("div");
  precisionHost.className = "precision-host";
  centre.append(spatialHost, precisionHost);

  const dock = element("aside");
  dock.className = "workspace-dock";
  dock.setAttribute("aria-label", "Editor properties and tools");
  const panelToggles = {} as Record<WorkspacePanel, HTMLButtonElement>;
  const panels = {} as Record<WorkspacePanel, HTMLElement>;
  let openPanelName: WorkspacePanel | null = "properties";
  const showPanel = (name: WorkspacePanel | null) => {
    openPanelName = name;
    shell.dataset.panel = name ?? "none";
    dock.hidden = name === null;
    for (const key of ["properties", "add", "fit"] as const) {
      panels[key].hidden = key !== name;
      panelToggles[key].setAttribute("aria-expanded", String(key === name));
    }
  };
  for (const [key, label] of [["properties", "Properties"], ["add", "Add furniture"], ["fit", "Make it Fit"]] as const) {
    const toggle = element("button", label);
    toggle.type = "button";
    toggle.dataset.panelToggle = key;
    toggle.dataset.focusKey = `panel:${key}`;
    toggle.setAttribute("aria-controls", `workspace-panel-${key}`);
    toggle.addEventListener("click", () => showPanel(openPanelName === key ? null : key));
    panelToggles[key] = toggle;
    navigation.append(toggle);
    const panel = element("section");
    panel.id = `workspace-panel-${key}`;
    panel.dataset.workspacePanel = key;
    panel.setAttribute("aria-label", label);
    const panelHeading = element("div");
    panelHeading.className = "dock-heading";
    const close = element("button", "×");
    close.type = "button";
    close.setAttribute("aria-label", `Close ${label}`);
    close.dataset.focusKey = `panel:${key}:close`;
    const closePanel = () => { showPanel(null); toggle.focus(); };
    close.addEventListener("click", closePanel);
    panel.addEventListener("keydown", event => {
      if (event.key === "Escape") { event.preventDefault(); closePanel(); }
    });
    panelHeading.append(element("h2", label), close);
    panel.append(panelHeading);
    panels[key] = panel;
    dock.append(panel);
  }
  const catalogSlot = element("div");
  panels.add.append(catalogSlot);
  const sceneListSlot = element("div");
  const inspectorSlot = element("div");
  panels.properties.append(sceneListSlot, inspectorSlot);
  const disclosure = (key: string, label: string) => {
    const details = element("details");
    details.dataset.workspaceSection = key;
    const summary = element("summary", label);
    summary.dataset.focusKey = `section:${key}`;
    const content = element("div");
    content.className = "disclosure-content";
    details.append(summary, content);
    panels.properties.append(details);
    return content;
  };
  const roomSlot = disclosure("room", "Room");
  const featuresSlot = disclosure("features", "Features");
  const constraintsSlot = disclosure("constraints", "Constraints");
  const layoutDataSlot = disclosure("layout-data", "Layout data");
  const summarySlot = element("div");
  panels.properties.append(summarySlot);
  const fitSlot = element("div");
  panels.fit.append(fitSlot);
  showPanel("properties");

  const reviewSlot = element("div");
  reviewSlot.dataset.reviewDock = "";
  reviewSlot.className = "review-dock";
  const editorStatus = element("p", "Ready to edit the room.");
  editorStatus.dataset.editorStatus = "";
  editorStatus.dataset.focusKey = "status:editor";
  editorStatus.tabIndex = -1;
  editorStatus.setAttribute("role", "status");
  editorStatus.setAttribute("aria-live", "polite");
  editorStatus.setAttribute("aria-atomic", "true");
  const spatialStatus = element("p", "Preparing the spatial view…");
  spatialStatus.dataset.spatialStatus = "";
  spatialStatus.dataset.state = "initializing";
  spatialStatus.className = "spatial-status";
  spatialStatus.setAttribute("role", "status");
  const guidance = element("p", "Drag to move · 50 mm snap · Heights are illustrative.");
  guidance.className = "viewport-guidance";
  const workspaceStatus = element("div");
  workspaceStatus.className = "workspace-status";
  workspaceStatus.append(editorStatus, spatialStatus, guidance);
  workspace.append(toolbar, centre, dock, reviewSlot, workspaceStatus);

  const agent = element("section");
  agent.className = "capability-panel";
  agent.setAttribute("aria-label", "Agent capability");
  const capabilityStatus = element("p", "Checking WebMCP availability…");
  capabilityStatus.className = "capability-status";
  capabilityStatus.dataset.state = "checking";
  capabilityStatus.setAttribute("role", "status");
  agent.append(capabilityStatus, element("p", "Your agent can inspect, validate and stage. You apply, discard, save or undo."));
  const footer = element("footer", "Local-first planning aid · Not architectural, accessibility, or safety certification.");
  footer.className = "site-footer";
  shell.append(header, entry, workspace, agent, footer);
  root.replaceChildren(shell);
  return Object.freeze({ shell, workspace, entry, startButton, title, templateSlot, actionsSlot, summarySlot, catalogSlot, sceneListSlot, inspectorSlot, roomSlot, featuresSlot, constraintsSlot, layoutDataSlot, fitSlot, reviewSlot, precisionHost, spatialHost, spatialStatus, capabilityStatus, editorStatus, modeButtons, resetViewButton, panelToggles, showPanel });
}
