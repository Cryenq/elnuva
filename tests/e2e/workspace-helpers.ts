import { expect, type Locator, type Page } from "@playwright/test";

export type WorkspaceSection = "room" | "features" | "constraints" | "layout-data";
export type WorkspaceMode = "precision-2d" | "top" | "isometric";
export type WorkspacePanel = "properties" | "add" | "fit";

export async function openPanel(page: Page, panel: WorkspacePanel): Promise<Locator> {
  const trigger = page.locator(`[data-panel-toggle="${panel}"]`);
  const target = page.locator(`[data-workspace-panel="${panel}"]`);
  await expect(trigger).toHaveCount(1);
  await expect(target).toHaveCount(1);
  await expect(trigger).toHaveAccessibleName({ properties: "Properties", add: "Add furniture", fit: "Make it Fit" }[panel]);
  const id = await target.getAttribute("id");
  expect(id).toBeTruthy();
  await expect(trigger).toHaveAttribute("aria-controls", id!);
  if (await trigger.getAttribute("aria-expanded") !== "true") await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(target).toBeVisible();
  for (const other of ["properties", "add", "fit"] as const) {
    if (other === panel) continue;
    await expect(page.locator(`[data-panel-toggle="${other}"]`)).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator(`[data-workspace-panel="${other}"]`)).not.toBeVisible();
  }
  return target;
}

export async function openReviewDetails(page: Page): Promise<Locator> {
  const details = page.locator("details[data-review-details]");
  await expect(details).toHaveCount(1);
  const summary = details.locator(":scope > summary");
  await expect(summary).toHaveAccessibleName("Preview details");
  if (!(await details.evaluate(node => (node as HTMLDetailsElement).open))) await summary.click();
  await expect(details).toHaveJSProperty("open", true);
  await expect(details).toBeVisible();
  return details;
}

/** Full ordinary-control sequence, not a subset or a minimum-length assertion. */
export async function expectCompactFocusOrder(page: Page, panel: WorkspacePanel, selected = false, roomOpen: boolean | "all" = false): Promise<void> {
  const expected = [
    "template:active", "layout:save", "layout:undo", "layout:reset",
    "view:isometric", "view:top", "view:precision-2d", "view:reset",
    "panel:properties", "panel:add", "panel:fit",
    "plan:furniture:chair-main", "plan:furniture:desk-main", "plan:furniture:storage-main",
    `panel:${panel}:close`,
    ...(panel === "properties" ? [
      "scene:chair-main", "scene:desk-main", "scene:storage-main",
      ...(selected ? ["furniture:chair-main:xMm", "furniture:chair-main:yMm", "furniture:chair-main:rotationDeg",
        "furniture:chair-main:lock", "furniture:chair-main:rotate", "furniture:chair-main:update", "furniture:chair-main:delete"] : []),
      "section:room", ...(roomOpen ? ["room:width", "room:depth", "room:update"] : []),
      "section:features", ...(roomOpen === "all" ? [
        ...["door-main", "radiator-east", "window-north"].flatMap(id => ["wall", "offset", "update", "delete"].map(action => `feature:${id}:${action}`)),
        "feature:new:catalog", "feature:new:wall", "feature:new:offset", "feature:add",
      ] : []),
      "section:constraints", ...(roomOpen === "all" ? [
        "constraint:c-door:strength", "constraint:c-door:feature", "constraint:c-door:amount", "constraint:c-door:update", "constraint:c-door:delete",
        ...["c-radiator", "c-window"].flatMap(id => ["strength", "item", "feature", "amount", "relation", "update", "delete"].map(action => `constraint:${id}:${action}`)),
        ...["strength", "item-a", "item-b", "amount", "relation", "update", "delete"].map(action => `constraint:c-chair:${action}`),
        "constraint:new:type", "constraint:new:item", "constraint:new:feature", "constraint:add",
      ] : []), "section:layout-data",
    ] : panel === "add" ? ["furniture:catalog", "furniture:add"] : [
      "section:fit", "fit:width", "fit:depth", "fit:catalog", "fit:request", "fit:start",
    ]),
  ];
  await expect(page.locator('[tabindex]:not([tabindex="0"]):not([tabindex="-1"])')).toHaveCount(0);
  const actual = await page.locator("button, input, select, textarea, a[href], summary, [tabindex]").evaluateAll(nodes =>
    nodes.filter(node => (node as HTMLElement).tabIndex >= 0 && !node.matches(":disabled") && node.checkVisibility()
      && !Array.from(node.closest("[data-workspace-panel]")?.querySelectorAll("details") ?? []).some(details =>
        !details.open && details.contains(node) && details.querySelector(":scope > summary") !== node))
      .map(node => node.getAttribute("data-focus-key")));
  expect(actual, "Every visible enabled focusable control must have the complete agreed DOM sequence").toEqual(expected);
  const first = page.locator(`[data-focus-key="${expected[0]}"]`);
  await first.focus();
  await expect(first).toBeFocused();
  for (const key of expected.slice(1)) {
    const target = page.locator(`[data-focus-key="${key}"]`);
    await expect(target).toHaveCount(1);
    await page.keyboard.press("Tab");
    await expect(target, `Tab must reach ${key}, without hidden-panel stops or a focus trap`).toBeFocused();
    await expect(target).toBeVisible();
    const visible = await target.evaluate(node => {
      const box = node.getBoundingClientRect();
      const x = Math.max(0, Math.min(innerWidth - 1, box.left + box.width / 2));
      const y = Math.max(0, Math.min(innerHeight - 1, box.top + box.height / 2));
      const top = document.elementFromPoint(x, y);
      return box.top >= -1 && box.bottom <= innerHeight + 1 && box.left >= -1 && box.right <= innerWidth + 1
        && !!top && (node === top || node.contains(top));
    });
    expect(visible, `${key} must be revealed and unobscured when keyboard-focused`).toBe(true);
  }
}

export async function openSection(page: Page, section: WorkspaceSection): Promise<void> {
  await openPanel(page, "properties");
  const details = page.locator(`details[data-workspace-section="${section}"]`);
  await expect(details).toHaveCount(1);
  if (!(await details.evaluate(node => (node as HTMLDetailsElement).open))) {
    await details.locator(":scope > summary").click();
  }
  await expect(details).toHaveJSProperty("open", true);
}

export async function selectFurniture(page: Page, itemId: string): Promise<Locator> {
  await openPanel(page, "properties");
  const item = page.locator(`[data-scene-item-list] [data-spatial-item-id="${itemId}"]`);
  await expect(item).toHaveCount(1);
  const select = item.getByRole("button");
  await expect(select).toHaveCount(1);
  await expect(select).toHaveAccessibleName(new RegExp(`^Select .+ \\(${itemId}\\)$`));
  await select.click();
  await expect(select).toHaveAttribute("aria-pressed", "true");
  const form = page.locator(`form[data-geometry-row][data-item-id="${itemId}"]`);
  await expect(page.locator("form[data-geometry-row]")).toHaveCount(1);
  await expect(form).toBeVisible();
  return form;
}

export async function enterWorkspace(page: Page): Promise<void> {
  const start = page.getByRole("button", { name: "Start designing", exact: true });
  await expect(start).toHaveCount(1);
  await expect(start).toBeVisible();
  await start.click();
  await expect(page.locator("[data-workspace]")).toBeVisible();
  await expect(page.locator("[data-workspace-entry]")).not.toBeVisible();
}

export async function setView(page: Page, mode: WorkspaceMode): Promise<void> {
  const name = { "precision-2d": "Precision 2D", top: "Top", isometric: "Isometric" }[mode];
  const button = page.getByRole("button", { name, exact: true });
  await expect(button).toHaveCount(1);
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
  if (mode === "precision-2d") await expect(page.locator("svg[data-room-editor]")).toBeVisible();
}

export async function preparePrecisionWorkspace(page: Page): Promise<void> {
  await enterWorkspace(page);
  await setView(page, "precision-2d");
  for (const section of ["room", "features", "constraints", "layout-data"] as const) await openSection(page, section);
  await selectFurniture(page, "chair-main");
}

export async function openWorkspace(page: Page): Promise<void> {
  await page.goto("/");
  await preparePrecisionWorkspace(page);
}

export async function expectPendingMutationControls(page: Page): Promise<void> {
  for (const section of ["room", "features", "constraints", "layout-data"] as const) await openSection(page, section);
  for (const name of ["Room template"]) {
    const control = page.getByRole("combobox", { name, exact: true });
    await expect(control).toHaveCount(1);
    await expect(control).toBeDisabled();
  }
  for (const name of ["Save", "Undo", "Reset", "Update room", "Add feature", "Add constraint"]) {
    const control = page.getByRole("button", { name, exact: true });
    await expect(control).toHaveCount(1);
    await expect(control).toBeDisabled();
  }
  await expect(page.locator('[data-scene-item-list] [data-spatial-item-id]')).toHaveCount(3);
  for (const id of ["chair-main", "desk-main", "storage-main"]) {
    const form = await selectFurniture(page, id);
    await expect(form.getByRole("spinbutton")).toHaveCount(3);
    for (const input of await form.getByRole("spinbutton").all()) await expect(input).toBeDisabled();
    await expect(form.getByRole("checkbox", { name: "Locked", exact: true })).toBeDisabled();
    for (const name of ["Update furniture", "Delete furniture", "Rotate 90°"]) await expect(form.getByRole("button", { name, exact: true })).toBeDisabled();
  }
  for (const [selector, count] of [["form[data-feature-id]", 3], ["form[data-constraint-row]", 4]] as const) {
    const forms = page.locator(selector);
    await expect(forms).toHaveCount(count);
    for (const form of await forms.all()) {
      const controls = form.locator("input, select, button");
      expect(await controls.count()).toBeGreaterThanOrEqual(4);
      for (const control of await controls.all()) await expect(control).toBeDisabled();
    }
  }
  for (const section of ["room", "features", "constraints"] as const) {
    const inputs = page.locator(`details[data-workspace-section="${section}"] input, details[data-workspace-section="${section}"] select`);
    expect(await inputs.count()).toBeGreaterThan(0);
    for (const input of await inputs.all()) await expect(input).toBeDisabled();
  }
  await openPanel(page, "add");
  await expect(page.getByRole("combobox", { name: "Add furniture", exact: true })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Add selected furniture", exact: true })).toHaveCount(1);
  await expect(page.getByRole("combobox", { name: "Add furniture", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Add selected furniture", exact: true })).toBeDisabled();
  await openPanel(page, "properties");
  for (const name of ["Apply preview", "Discard preview"]) await expect(page.getByRole("button", { name, exact: true })).toBeEnabled();
}
