import { expect, type Locator, type Page } from "@playwright/test";

export type WorkspaceSection = "room" | "features" | "constraints" | "layout-data";
export type WorkspaceMode = "precision-2d" | "top" | "isometric";

export async function openSection(page: Page, section: WorkspaceSection): Promise<void> {
  const details = page.locator(`details[data-workspace-section="${section}"]`);
  await expect(details).toHaveCount(1);
  if (!(await details.evaluate(node => (node as HTMLDetailsElement).open))) {
    await details.locator(":scope > summary").click();
  }
  await expect(details).toHaveJSProperty("open", true);
}

export async function selectFurniture(page: Page, itemId: string): Promise<Locator> {
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
  for (const name of ["Room template", "Add furniture"]) {
    const control = page.getByRole("combobox", { name, exact: true });
    await expect(control).toHaveCount(1);
    await expect(control).toBeDisabled();
  }
  for (const name of ["Add selected furniture", "Save", "Undo", "Reset", "Update room", "Add feature", "Add constraint"]) {
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
  for (const name of ["Apply preview", "Discard preview"]) await expect(page.getByRole("button", { name, exact: true })).toBeEnabled();
}
