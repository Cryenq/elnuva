import { expect, test, type Locator, type Page } from "@playwright/test";
import { openWorkspace, preparePrecisionWorkspace, selectFurniture, openSection, setView } from "./workspace-helpers";

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
    constraintReferents: [["door-main"], ["desk-main", "radiator-east"], ["desk-main", "window-north"], ["chair-main", "desk-main"]],
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
    constraintReferents: [["door-south"], ["bed-main", "radiator-north"], ["bed-main", "window-east"], ["nightstand-main", "bed-main"]],
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
    constraintReferents: [["door-north"], ["table-main", "radiator-west"], ["table-main", "window-south"], ["chair-main", "table-main"]],
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
  await expect(semanticConstraints).toHaveCount(expected.constraints.length);
  const semanticConstraintText = await semanticConstraints.evaluateAll(nodes => nodes.map(node => (node.textContent ?? "").trim()));
  for (const [index, text] of semanticConstraintText.entries()) {
    expect(text).toContain(expected.constraints[index]);
    for (const referent of expected.constraintReferents[index]) expect(text).toContain(referent);
  }
  expect(await semanticConstraints.evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.constraintId))).toEqual(expected.constraints.map(value => value.split(":")[0]));
  const cues = page.locator('[data-layer="constraints"] [data-constraint-cue]');
  await expect(cues).toHaveCount(expected.constraints.length);
  expect(await cues.evaluateAll(nodes => nodes.map(node => (node as SVGElement).dataset.constraintId))).toEqual(expected.constraints.map(value => value.split(":")[0]));
  for (let index = 0; index < expected.constraints.length; index += 1) {
    const cue = cues.nth(index);
    await expect(cue.locator("text")).not.toHaveText("");
    const cueText = (await cue.textContent()) ?? "";
    expect(cueText).toContain(expected.constraints[index].split(":")[0]);
    for (const referent of expected.constraintReferents[index]) expect(cueText).toContain(referent);
  }
  expect(await page.locator("[data-scene-item-list] [data-spatial-item-id]").evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.spatialItemId))).toEqual(expected.furniture.map(item => item[0]));
  for (const [itemId, xMm, yMm, rotation, locked] of expected.furniture) {
    const form = await selectFurniture(page, itemId);
    await expect(form.getByRole("spinbutton", { name: "X position (mm)" })).toHaveValue(xMm);
    await expect(form.getByRole("spinbutton", { name: "Y position (mm)" })).toHaveValue(yMm);
    await expect(form.getByRole("spinbutton", { name: "Rotation" })).toHaveValue(rotation);
    await expect(form.getByRole("checkbox", { name: "Locked" })).toBeChecked({ checked: locked === "true" });
  }
}

async function optionValues(locator: Locator): Promise<string[]> {
  return locator.locator("option").evaluateAll(options => options.map(option => (option as HTMLOptionElement).value));
}

async function savedTemplateKey(page: Page): Promise<string> {
  const key = await page.evaluate(() => {
    for (let index = 0; index < localStorage.length; index += 1) {
      const candidate = localStorage.key(index);
      if (!candidate) continue;
      const value = localStorage.getItem(candidate);
      try {
        const parsed = JSON.parse(value ?? "null") as { templateId?: unknown } | null;
        if (parsed?.templateId === "home-office") return candidate;
      } catch { /* the test discovers only the valid save it just created */ }
    }
    return null;
  });
  expect(key).not.toBeNull();
  return key!;
}

test.describe("T08 templates and persistence", () => {
  test.beforeEach(async ({ page }) => { await openWorkspace(page); });

  for (const id of Object.keys(factories) as (keyof typeof factories)[]) {
    test(`${id} exposes the exact factory in SVG and semantic controls`, async ({ page }) => {
      await selectTemplate(page, id);
      await expectFactory(page, id);
    });
  }

  test("keeps template drafts independent and restores each draft when switching", async ({ page }) => {
    const chair = await selectFurniture(page, "chair-main");
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
    const nightstand = await selectFurniture(page, "nightstand-main");
    const bedroomRevision = Number(await summary(page, "Revision").textContent());
    await nightstand.getByRole("spinbutton", { name: "X position (mm)" }).fill("3950");
    await nightstand.getByRole("spinbutton", { name: "Y position (mm)" }).fill("2500");
    await nightstand.getByRole("button", { name: "Update furniture" }).click();
    await expect(summary(page, "Revision")).toHaveText(String(bedroomRevision + 1));
    await page.getByRole("button", { name: "Save" }).click();
    await selectTemplate(page, "study");
    const chair = await selectFurniture(page, "chair-main");
    await chair.getByRole("spinbutton", { name: "X position (mm)" }).fill("2300");
    await chair.getByRole("spinbutton", { name: "Y position (mm)" }).fill("1400");
    await chair.getByRole("button", { name: "Update furniture" }).click();
    await page.reload(); await preparePrecisionWorkspace(page);
    await expect(page.getByRole("combobox", { name: "Room template" })).toHaveValue("home-office");
    await selectTemplate(page, "bedroom");
    await expect(page.locator('[data-furniture-id="nightstand-main"]')).toHaveAttribute("data-x-mm", "3950");
    await expect(page.locator('[data-furniture-id="nightstand-main"]')).toHaveAttribute("data-y-mm", "2500");
    await selectTemplate(page, "study");
    await expect(page.locator('[data-furniture-id="chair-main"]')).toHaveAttribute("data-x-mm", "2000");
  });

  test("Save persists only the active draft; Reset is an explicit later mutation", async ({ page }) => {
    const chair = await selectFurniture(page, "chair-main");
    await chair.getByRole("spinbutton", { name: "X position (mm)" }).fill("1900");
    await chair.getByRole("spinbutton", { name: "Y position (mm)" }).fill("1300");
    await chair.getByRole("button", { name: "Update furniture" }).click();
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.locator('[data-editor-status][role="status"]')).toContainText(/save.*complete/i);
    await page.reload(); await preparePrecisionWorkspace(page);
    await expect(page.locator('[data-furniture-id="chair-main"]')).toHaveAttribute("data-x-mm", "1900");
    const beforeReset = Number(await summary(page, "Revision").textContent());
    await page.getByRole("button", { name: "Reset" }).click();
    await expect(page.locator('[data-furniture-id="chair-main"]')).toHaveAttribute("data-x-mm", "2500");
    await expect(summary(page, "Revision")).toHaveText(String(beforeReset + 1));
    await page.reload(); await preparePrecisionWorkspace(page);
    await expect(page.locator('[data-furniture-id="chair-main"]')).toHaveAttribute("data-x-mm", "1900");
  });

  test("adds, locks, edits, unlocks, and deletes furniture through bounded human controls", async ({ page }) => {
    const locked = await selectFurniture(page, "storage-main");
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
    await expect(page.locator('[data-scene-item-list] [data-spatial-item-id="storage-main"]')).toHaveCount(0);
    await expect(page.locator('[data-scene-item-list] [data-spatial-item-id]')).toHaveCount(2);
    const add = page.getByRole("combobox", { name: "Add furniture" });
    await add.selectOption("storage-800x400");
    await page.getByRole("button", { name: "Add selected furniture" }).click();
    await expect(summary(page, "Revision")).toHaveText(String(++revision));
    await expect(page.locator("[data-scene-item-list] [data-spatial-item-id]")).toHaveCount(3);
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
    await expect(page.locator("[data-scene-item-list] [data-spatial-item-id]")).toHaveCount(8);
    const furnitureCapRevision = await summary(page, "Revision").textContent();
    const furnitureAdd = page.getByRole("button", { name: "Add selected furniture" });
    await expect(furnitureAdd).toBeDisabled();
    await furnitureAdd.evaluate((button: HTMLButtonElement) => button.click());
    await expect(page.locator("[data-scene-item-list] [data-spatial-item-id]")).toHaveCount(8);
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

  test("binds every constraint type through explicit type-correct referents after feature array changes", async ({ page }) => {
    const featureAdd = page.getByRole("button", { name: "Add feature" }).locator("xpath=ancestor::form[1]");
    await featureAdd.getByRole("combobox", { name: "Feature type" }).selectOption("door-900");
    await featureAdd.getByRole("combobox", { name: "Wall", exact: true }).selectOption("west");
    await featureAdd.getByRole("spinbutton", { name: "Offset (mm)" }).fill("500");
    await featureAdd.getByRole("button", { name: "Add feature" }).click();
    const addedDoorId = await page.locator("form[data-feature-id]").evaluateAll(forms => {
      const ids = forms.map(form => (form as HTMLElement).dataset.featureId!).filter(Boolean);
      return ids.find(id => id !== "door-main" && id.startsWith("door-")) ?? null;
    });
    expect(addedDoorId).not.toBeNull();

    const doorConstraint = page.locator('[data-constraint-row][data-constraint-id="c-door"]');
    const editableDoorReference = doorConstraint.getByRole("combobox", { name: "Wall feature" });
    expect(await optionValues(editableDoorReference)).toEqual(["door-main", addedDoorId!]);
    await editableDoorReference.selectOption(addedDoorId!);
    await doorConstraint.getByRole("button", { name: "Update constraint" }).click();
    await expect(page.locator('[data-semantic-layout] [data-constraint-id="c-door"]')).toContainText(addedDoorId!);
    await page.locator('[data-constraint-row][data-constraint-id="c-door"]').getByRole("button", { name: "Delete constraint" }).click();
    await page.locator('form[data-feature-id="door-main"]').getByRole("button", { name: "Delete" }).click();

    const addConstraint = page.getByRole("button", { name: "Add constraint" }).locator("xpath=ancestor::form[1]");
    await addConstraint.getByRole("combobox", { name: "Constraint type" }).selectOption("door_path_clear");
    const newDoorReference = addConstraint.getByRole("combobox", { name: "Wall feature" });
    expect(await optionValues(newDoorReference)).toEqual([addedDoorId!]);
    await newDoorReference.selectOption(addedDoorId!);
    await addConstraint.getByRole("button", { name: "Add constraint" }).click();
    const recreatedDoor = page.locator('[data-semantic-layout] [data-constraint-id]').filter({ hasText: /door path clear/i }).filter({ hasText: addedDoorId! });
    await expect(recreatedDoor).toHaveCount(1);

    const featureDistance = page.locator('[data-constraint-row][data-constraint-id="c-window"]');
    const furnitureReference = featureDistance.getByRole("combobox", { name: "Furniture item" });
    const featureReference = featureDistance.getByRole("combobox", { name: "Wall feature" });
    expect(await optionValues(furnitureReference)).toEqual(["chair-main", "desk-main", "storage-main"]);
    expect(await optionValues(featureReference)).toEqual(["radiator-east", "window-north", addedDoorId!]);
    await furnitureReference.selectOption("chair-main");
    await featureReference.selectOption("radiator-east");
    await featureDistance.getByRole("button", { name: "Update constraint" }).click();
    const updatedFeatureDistance = page.locator('[data-semantic-layout] [data-constraint-id="c-window"]');
    await expect(updatedFeatureDistance).toContainText("chair-main");
    await expect(updatedFeatureDistance).toContainText("radiator-east");

    const itemDistance = page.locator('[data-constraint-row][data-constraint-id="c-chair"]');
    const firstFurniture = itemDistance.getByRole("combobox", { name: "First furniture item" });
    const secondFurniture = itemDistance.getByRole("combobox", { name: "Second furniture item" });
    expect(await optionValues(firstFurniture)).toEqual(["chair-main", "desk-main", "storage-main"]);
    expect(await optionValues(secondFurniture)).toEqual(["desk-main", "storage-main"]);
    await firstFurniture.selectOption("desk-main");
    const duplicateSecond = secondFurniture.locator('option[value="desk-main"]');
    expect(await duplicateSecond.count() === 0 || await duplicateSecond.isDisabled()).toBe(true);
    await secondFurniture.selectOption("storage-main");
    await itemDistance.getByRole("button", { name: "Update constraint" }).click();
    const updatedItemDistance = page.locator('[data-semantic-layout] [data-constraint-id="c-chair"]');
    await expect(updatedItemDistance).toContainText("desk-main");
    await expect(updatedItemDistance).toContainText("storage-main");

    const featureAddConstraint = page.getByRole("button", { name: "Add constraint" }).locator("xpath=ancestor::form[1]");
    await featureAddConstraint.getByRole("combobox", { name: "Constraint type" }).selectOption("feature_distance");
    expect(await optionValues(featureAddConstraint.getByRole("combobox", { name: "Furniture item" }))).toEqual(["chair-main", "desk-main", "storage-main"]);
    expect(await optionValues(featureAddConstraint.getByRole("combobox", { name: "Wall feature" }))).toEqual(["radiator-east", "window-north", addedDoorId!]);
    await featureAddConstraint.getByRole("combobox", { name: "Furniture item" }).selectOption("storage-main");
    await featureAddConstraint.getByRole("combobox", { name: "Wall feature" }).selectOption("window-north");
    await featureAddConstraint.getByRole("button", { name: "Add constraint" }).click();
    await expect(page.locator('[data-semantic-layout] [data-constraint-id]').filter({ hasText: /feature distance/i }).filter({ hasText: "storage-main" }).filter({ hasText: "window-north" })).toHaveCount(1);

    const itemAddConstraint = page.getByRole("button", { name: "Add constraint" }).locator("xpath=ancestor::form[1]");
    await itemAddConstraint.getByRole("combobox", { name: "Constraint type" }).selectOption("item_distance");
    expect(await optionValues(itemAddConstraint.getByRole("combobox", { name: "First furniture item" }))).toEqual(["chair-main", "desk-main", "storage-main"]);
    await itemAddConstraint.getByRole("combobox", { name: "First furniture item" }).selectOption("chair-main");
    await itemAddConstraint.getByRole("combobox", { name: "Second furniture item" }).selectOption("storage-main");
    await itemAddConstraint.getByRole("button", { name: "Add constraint" }).click();
    await expect(page.locator('[data-semantic-layout] [data-constraint-id]').filter({ hasText: /item distance/i }).filter({ hasText: "chair-main" }).filter({ hasText: "storage-main" })).toHaveCount(1);

    const semanticIds = await page.locator("[data-semantic-layout] [data-constraint-id]").evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.constraintId));
    const cueText = await page.locator('[data-layer="constraints"] [data-constraint-cue]').evaluateAll(nodes => nodes.map(node => ({
      id: (node as SVGElement).dataset.constraintId,
      text: node.textContent ?? "",
    })));
    expect(cueText.map(cue => cue.id)).toEqual(semanticIds);
    for (const referents of [[addedDoorId!], ["chair-main", "radiator-east"], ["desk-main", "storage-main"], ["storage-main", "window-north"], ["chair-main", "storage-main"]]) {
      expect(cueText.some(cue => referents.every(referent => cue.text.includes(referent)))).toBe(true);
    }
  });

  for (const scenario of ["malformed saved data", "version-mismatched saved data"] as const) {
    test(`${scenario} falls back to the factory and reports a sanitized visible error`, async ({ page }) => {
      const chair = await selectFurniture(page, "chair-main");
      await chair.getByRole("spinbutton", { name: "X position (mm)" }).fill("1900");
      await chair.getByRole("button", { name: "Update furniture" }).click();
      await page.getByRole("button", { name: "Save" }).click();
      await expect(page.locator('[data-editor-status][role="status"]')).toContainText(/save.*complete/i);
      const key = await savedTemplateKey(page);
      await page.evaluate(({ key, scenario }) => {
        if (scenario === "malformed saved data") {
          localStorage.setItem(key, '{"hostile-marker":"<img data-hostile src=x onerror=alert(1)>"}');
          return;
        }
        const envelope = JSON.parse(localStorage.getItem(key)!) as { storageVersion: number };
        envelope.storageVersion = 999;
        localStorage.setItem(key, JSON.stringify(envelope));
      }, { key, scenario });
      await page.reload(); await preparePrecisionWorkspace(page);
      await expect(page.locator('[data-furniture-id="chair-main"]')).toHaveAttribute("data-x-mm", "2500");
      const status = page.locator('[data-editor-status][role="status"]');
      await expect(status).toContainText(/saved template data.*invalid.*factory data.*loaded/i);
      await expect(status).not.toContainText(/hostile-marker|<img|onerror/i);
      await expect(page.locator("[data-hostile]")).toHaveCount(0);
    });
  }
});
