import { expect, test, type Locator, type Page } from "@playwright/test";

const factories = {
  "home-office": {
    label: "Home Office", room: "3600 × 3000 mm",
    furniture: [
      ["chair-main", "2500", "1300", "0", "false"],
      ["desk-main", "2500", "500", "0", "false"],
      ["storage-main", "700", "600", "0", "true"],
    ],
    features: ["door-main: Door west 1950 mm", "radiator-east: Radiator east 850 mm", "window-north: Window north 1100 mm"],
    constraints: ["c-door: required door path clear 900 mm", "c-radiator: required feature distance away 800 mm", "c-window: preferred feature distance near 700 mm", "c-chair: preferred item distance near 500 mm"],
  },
  bedroom: {
    label: "Bedroom", room: "4200 × 3600 mm",
    furniture: [
      ["bed-main", "2300", "2400", "0", "false"],
      ["nightstand-main", "3550", "2500", "0", "false"],
      ["wardrobe-main", "700", "700", "0", "true"],
    ],
    features: ["door-south: Door south 300 mm", "radiator-north: Radiator north 2600 mm", "window-east: Window east 500 mm"],
    constraints: ["c-door: required door path clear 900 mm", "c-radiator: required feature distance away 800 mm", "c-window: preferred feature distance near 700 mm", "c-nightstand: preferred item distance near 300 mm"],
  },
  study: {
    label: "Study", room: "3200 × 2800 mm",
    furniture: [
      ["bookcase-main", "2700", "2300", "0", "true"],
      ["chair-main", "2000", "1600", "0", "false"],
      ["table-main", "2000", "900", "0", "false"],
    ],
    features: ["door-north: Door north 100 mm", "radiator-west: Radiator west 1500 mm", "window-south: Window south 900 mm"],
    constraints: ["c-door: required door path clear 800 mm", "c-radiator: required feature distance away 700 mm", "c-window: preferred feature distance near 700 mm", "c-chair: preferred item distance near 400 mm"],
  },
} as const;

const row = (page: Page, id: string): Locator => page.locator(`[data-geometry-row][data-item-id="${id}"]`);
const summary = (page: Page, term: string): Locator => page.locator("dt").filter({ hasText: new RegExp(`^${term}$`) }).locator("xpath=following-sibling::dd[1]");

async function selectTemplate(page: Page, id: keyof typeof factories): Promise<void> {
  await page.getByRole("combobox", { name: "Room template" }).selectOption(id);
  await expect(summary(page, "Template")).toHaveText(factories[id].label);
}

async function expectFactory(page: Page, id: keyof typeof factories): Promise<void> {
  const expected = factories[id];
  await expect(summary(page, "Room")).toHaveText(expected.room);
  const svgFurniture = page.locator('[data-layer="furniture"] [data-furniture-id]');
  await expect(svgFurniture).toHaveCount(3);
  expect(await svgFurniture.evaluateAll(nodes => nodes.map(node => [
    (node as HTMLElement).dataset.furnitureId,
    (node as HTMLElement).dataset.xMm,
    (node as HTMLElement).dataset.yMm,
    (node as HTMLElement).dataset.rotationDeg,
    (node as HTMLElement).dataset.locked,
  ]))).toEqual(expected.furniture);
  const semanticFeatures = page.locator("[data-semantic-layout] [data-feature-id]");
  expect(await semanticFeatures.evaluateAll(nodes => nodes.map(node => (node.textContent ?? "").trim()))).toEqual(expected.features);
  expect(await semanticFeatures.evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.featureId))).toEqual(expected.features.map(value => value.split(":")[0]));
  const semanticConstraints = page.locator("[data-semantic-layout] [data-constraint-id]");
  expect(await semanticConstraints.evaluateAll(nodes => nodes.map(node => (node.textContent ?? "").trim()))).toEqual(expected.constraints);
  expect(await semanticConstraints.evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.constraintId))).toEqual(expected.constraints.map(value => value.split(":")[0]));
  expect(await page.locator("[data-geometry-row]").evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.itemId))).toEqual(expected.furniture.map(item => item[0]));
}

test.describe("T08 templates and persistence", () => {
  test.beforeEach(async ({ page }) => { await page.goto("/"); });

  for (const id of Object.keys(factories) as (keyof typeof factories)[]) {
    test(`${id} exposes the exact factory in SVG and semantic controls`, async ({ page }) => {
      await selectTemplate(page, id);
      await expectFactory(page, id);
    });
  }

  test("keeps template drafts independent and restores each draft when switching", async ({ page }) => {
    const chair = row(page, "chair-main");
    await chair.getByRole("spinbutton", { name: "X position (mm)" }).fill("1900");
    await chair.getByRole("spinbutton", { name: "Y position (mm)" }).fill("1300");
    await chair.getByRole("button", { name: "Update furniture" }).click();
    await selectTemplate(page, "bedroom");
    await expect(page.locator('[data-furniture-id="bed-main"]')).toHaveAttribute("data-x-mm", "2300");
    await selectTemplate(page, "home-office");
    await expect(page.locator('[data-furniture-id="chair-main"]')).toHaveAttribute("data-x-mm", "1900");
  });

  test("keeps saved and unsaved drafts independent across templates and reload", async ({ page }) => {
    await selectTemplate(page, "bedroom");
    const nightstand = row(page, "nightstand-main");
    const bedroomRevision = Number(await summary(page, "Revision").textContent());
    await nightstand.getByRole("spinbutton", { name: "X position (mm)" }).fill("3950");
    await nightstand.getByRole("spinbutton", { name: "Y position (mm)" }).fill("2500");
    await nightstand.getByRole("button", { name: "Update furniture" }).click();
    await expect(summary(page, "Revision")).toHaveText(String(bedroomRevision + 1));
    await page.getByRole("button", { name: "Save" }).click();
    await selectTemplate(page, "study");
    const chair = row(page, "chair-main");
    await chair.getByRole("spinbutton", { name: "X position (mm)" }).fill("2300");
    await chair.getByRole("spinbutton", { name: "Y position (mm)" }).fill("1400");
    await chair.getByRole("button", { name: "Update furniture" }).click();
    await page.reload();
    await expect(page.getByRole("combobox", { name: "Room template" })).toHaveValue("home-office");
    await selectTemplate(page, "bedroom");
    await expect(page.locator('[data-furniture-id="nightstand-main"]')).toHaveAttribute("data-x-mm", "3950");
    await expect(page.locator('[data-furniture-id="nightstand-main"]')).toHaveAttribute("data-y-mm", "2500");
    await selectTemplate(page, "study");
    await expect(page.locator('[data-furniture-id="chair-main"]')).toHaveAttribute("data-x-mm", "2000");
  });

  test("Save persists only the active draft; Reset is an explicit later mutation", async ({ page }) => {
    const chair = row(page, "chair-main");
    await chair.getByRole("spinbutton", { name: "X position (mm)" }).fill("1900");
    await chair.getByRole("spinbutton", { name: "Y position (mm)" }).fill("1300");
    await chair.getByRole("button", { name: "Update furniture" }).click();
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.locator('[data-editor-status][role="status"]')).toContainText(/save.*complete/i);
    await page.reload();
    await expect(page.locator('[data-furniture-id="chair-main"]')).toHaveAttribute("data-x-mm", "1900");
    const beforeReset = Number(await summary(page, "Revision").textContent());
    await page.getByRole("button", { name: "Reset" }).click();
    await expect(page.locator('[data-furniture-id="chair-main"]')).toHaveAttribute("data-x-mm", "2500");
    await expect(summary(page, "Revision")).toHaveText(String(beforeReset + 1));
    await page.reload();
    await expect(page.locator('[data-furniture-id="chair-main"]')).toHaveAttribute("data-x-mm", "1900");
  });

  test("adds, locks, edits, unlocks, and deletes furniture through bounded human controls", async ({ page }) => {
    const locked = row(page, "storage-main");
    await expect(locked.getByRole("checkbox", { name: "Locked" })).toBeChecked();
    await expect(locked.getByRole("button", { name: "Update furniture" })).toBeDisabled();
    await expect(locked.getByRole("button", { name: "Delete furniture" })).toBeDisabled();
    let revision = Number(await summary(page, "Revision").textContent());
    await locked.getByRole("checkbox", { name: "Locked" }).uncheck();
    await expect(summary(page, "Revision")).toHaveText(String(++revision));
    await expect(locked.getByRole("button", { name: "Delete furniture" })).toBeEnabled();
    await locked.getByRole("spinbutton", { name: "X position (mm)" }).fill("750");
    await locked.getByRole("button", { name: "Update furniture" }).click();
    await expect(summary(page, "Revision")).toHaveText(String(++revision));
    await expect(page.locator('[data-furniture-id="storage-main"]')).toHaveAttribute("data-x-mm", "750");
    await locked.getByRole("button", { name: "Delete furniture" }).click();
    await expect(summary(page, "Revision")).toHaveText(String(++revision));
    await expect(row(page, "storage-main")).toHaveCount(0);
    const add = page.getByRole("combobox", { name: "Add furniture" });
    await add.selectOption("storage-800x400");
    await page.getByRole("button", { name: "Add selected furniture" }).click();
    await expect(summary(page, "Revision")).toHaveText(String(++revision));
    await expect(page.locator("[data-geometry-row]")).toHaveCount(3);
  });

  test("adds, edits, and deletes a constraint and rejects both eight-item caps without mutation", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(`page: ${error.message}`));
    page.on("console", message => { if (message.type() === "error") errors.push(`console: ${message.text()}`); });
    let revision = Number(await summary(page, "Revision").textContent());
    await page.getByRole("button", { name: "Add constraint" }).click();
    await expect(summary(page, "Revision")).toHaveText(String(++revision));
    const created = page.locator("[data-constraint-row]").last();
    await created.getByRole("combobox", { name: "Strength" }).selectOption("preferred");
    await created.getByRole("spinbutton", { name: "Distance threshold (mm)" }).fill("650");
    await created.getByRole("button", { name: "Update constraint" }).click();
    await expect(summary(page, "Revision")).toHaveText(String(++revision));
    await expect(created).toContainText(/preferred.*650/i);
    await created.getByRole("button", { name: "Delete constraint" }).click();
    await expect(summary(page, "Revision")).toHaveText(String(++revision));
    await expect(page.locator("[data-constraint-row]")).toHaveCount(4);

    const addFurniture = page.getByRole("combobox", { name: "Add furniture" });
    for (const catalogId of ["bed-2000x1600", "nightstand-500x400", "wardrobe-1200x600", "table-1200x800", "bookcase-800x350"]) {
      await addFurniture.selectOption(catalogId);
      await page.getByRole("button", { name: "Add selected furniture" }).click();
    }
    await expect(page.locator("[data-geometry-row]")).toHaveCount(8);
    const furnitureCapRevision = await summary(page, "Revision").textContent();
    const furnitureAdd = page.getByRole("button", { name: "Add selected furniture" });
    await expect(furnitureAdd).toBeDisabled();
    await furnitureAdd.evaluate((button: HTMLButtonElement) => button.click());
    await expect(page.locator("[data-geometry-row]")).toHaveCount(8);
    await expect(summary(page, "Revision")).toHaveText(furnitureCapRevision!);
    await expect(page.locator('[data-editor-status][role="status"]')).toContainText(/maximum.*8/i);
    for (let index = 4; index < 8; index += 1) await page.getByRole("button", { name: "Add constraint" }).click();
    await expect(page.locator("[data-constraint-row]")).toHaveCount(8);
    const constraintCapRevision = await summary(page, "Revision").textContent();
    const constraintAdd = page.getByRole("button", { name: "Add constraint" });
    await expect(constraintAdd).toBeDisabled();
    await constraintAdd.evaluate((button: HTMLButtonElement) => button.click());
    await expect(page.locator("[data-constraint-row]")).toHaveCount(8);
    await expect(summary(page, "Revision")).toHaveText(constraintCapRevision!);
    await expect(page.getByText(/maximum.*8|up to 8/i)).toBeVisible();
    expect(errors).toEqual([]);
  });
});
