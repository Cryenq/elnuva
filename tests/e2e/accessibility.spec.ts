import { expect, test, type Page } from "@playwright/test";

async function installCapture(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type Tool = { name: string; execute: (input: unknown, options: { signal: AbortSignal }) => Promise<any> };
    const tools = new Map<string, Tool>();
    Object.defineProperty(document, "modelContext", { configurable: true, value: { registerTool: async (tool: Tool) => { tools.set(tool.name, tool); } } });
    (window as any).__elnuvaTools = tools;
  });
}

async function stageHome(page: Page, idempotencyKey = "fixture-home-0001"): Promise<void> {
  const inspect = await page.evaluate(async () => (window as any).__elnuvaTools.get("inspect_spatial_layout").execute({}, { signal: new AbortController().signal }));
  const moves = [{ itemId: "desk-main", pose: { xMm: 1900, yMm: 500, rotationDeg: 0 } }];
  const validation = await page.evaluate(async ({ inspect, moves }) => (window as any).__elnuvaTools.get("validate_layout_options").execute({ baseRevision: inspect.data.baseRevision, baseHash: inspect.data.baseHash, constraints: inspect.data.workingState.constraints, options: [{ optionId: "home-valid", moves }] }, { signal: new AbortController().signal }), { inspect, moves });
  const staged = await page.evaluate(async ({ inspect, moves, result, idempotencyKey }) => (window as any).__elnuvaTools.get("stage_layout_preview").execute({ baseRevision: inspect.data.baseRevision, baseHash: inspect.data.baseHash, constraints: inspect.data.workingState.constraints, optionId: "home-valid", moves, proposalDigest: result.proposalDigest, idempotencyKey }, { signal: new AbortController().signal }), { inspect, moves, result: validation.data.results[0], idempotencyKey });
  expect(staged).toMatchObject({ ok: true, data: { notApplied: true, notSaved: true } });
}

async function expectMeaningfulFocus(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => {
    const active = document.activeElement;
    if (!active || active === document.body || !(active instanceof HTMLElement)) return false;
    if (active.matches("[data-editor-status]")) return true;
    return Boolean(active.closest("[data-geometry-row], form[data-feature-id], [data-constraint-row]"));
  })).toBe(true);
  await expect(page.locator(":focus")).toBeVisible();
}

function contrastRatio(foreground: string, background: string): number {
  const parse = (value: string): [number, number, number] => {
    const channels = value.match(/[\d.]+/g)?.slice(0, 3).map(Number);
    if (!channels || channels.length !== 3) throw new Error(`Unable to parse color: ${value}`);
    return channels as [number, number, number];
  };
  const luminance = (rgb: [number, number, number]) => {
    const linear = rgb.map(channel => {
      const normalized = channel / 255;
      return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  };
  const first = luminance(parse(foreground));
  const second = luminance(parse(background));
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

test.describe("T08 accessibility and truthful state", () => {
  test("has native names, logical keyboard focus, and a same-snapshot text alternative", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: "Elnuva" })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Room template" })).toBeVisible();
    const editor = page.locator('svg[data-room-editor]');
    await expect(editor).toHaveAttribute("aria-label", "Room layout editor");
    await expect(editor).toHaveAttribute("aria-describedby", /\S+/);
    const descriptionId = await editor.getAttribute("aria-describedby");
    await expect(page.locator(`#${descriptionId}`)).toContainText(/home office.*3600\s*(?:×|by)\s*3000\s*(?:mm|millimetres?)/i);
    const textState = page.locator("[data-semantic-layout]");
    await expect(textState).toContainText(/chair-main/i);
    await expect(textState).toContainText(/2500.*1300.*0/i);
    await expect(textState).toContainText(/storage-main.*locked/i);
    await page.keyboard.press("Tab");
    const focused = page.locator(":focus");
    await expect(focused).toBeVisible();
    expect(await focused.evaluate(node => {
      const style = getComputedStyle(node);
      return style.outlineStyle !== "none" || style.outlineWidth !== "0px" || style.boxShadow !== "none";
    })).toBe(true);
  });

  test("gives the Add Feature catalog and wall selectors visible accessible labels", async ({ page }) => {
    await page.goto("/");
    const featureAdd = page.getByRole("button", { name: "Add feature" }).locator("xpath=ancestor::form[1]");
    const featureType = featureAdd.getByRole("combobox", { name: "Feature type" });
    const wall = featureAdd.getByRole("combobox", { name: "Wall", exact: true });
    const offset = featureAdd.getByRole("spinbutton", { name: "Offset (mm)" });
    await expect(featureType).toBeVisible();
    await expect(wall).toBeVisible();
    await expect(offset).toBeVisible();
    await expect(featureType.locator("xpath=ancestor::label[1]")).toContainText("Feature type");
    await expect(wall.locator("xpath=ancestor::label[1]")).toContainText("Wall");
    await expect(offset.locator("xpath=ancestor::label[1]")).toContainText("Offset (mm)");
  });

  test("keeps keyboard focus distinct from selection and restores focus after a row mutation", async ({ page }) => {
    await page.goto("/");
    const chairGraphic = page.locator('[data-furniture-id="chair-main"]');
    const deskGraphic = page.locator('[data-furniture-id="desk-main"]');
    await chairGraphic.focus();
    await page.keyboard.press("Enter");
    await expect(chairGraphic).toHaveAttribute("aria-pressed", "true");
    await deskGraphic.focus();
    await expect(deskGraphic).toBeFocused();
    await expect(chairGraphic).toHaveAttribute("aria-pressed", "true");
    await expect(deskGraphic).toHaveAttribute("aria-pressed", "false");

    const chairRow = page.locator('[data-geometry-row][data-item-id="chair-main"]');
    await chairRow.getByRole("spinbutton", { name: "X position (mm)" }).fill("1900");
    const update = chairRow.getByRole("button", { name: "Update furniture" });
    await update.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator('[data-furniture-id="chair-main"]')).toHaveAttribute("data-x-mm", "1900");
    await expect(page.locator('[data-editor-status][role="status"]')).toContainText(/chair-main.*updated/i);
    await expect(update).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(chairRow.getByRole("button", { name: "Delete furniture" })).toBeFocused();
  });

  test("reports errors and success with text, role status, and no color-only meaning", async ({ page }) => {
    await page.goto("/");
    const chair = page.locator('[data-geometry-row][data-item-id="chair-main"]');
    await chair.getByRole("spinbutton", { name: "X position (mm)" }).fill("200");
    await chair.getByRole("button", { name: "Update furniture" }).click();
    const status = page.locator('[data-editor-status][role="status"]');
    await expect(status).toContainText(/rejected|outside|bounds/i);
    await expect(status).toHaveAttribute("aria-live", "polite");
    await expect(status).not.toHaveText("");
    await expect(page.getByText(/planning aid.*not.*certif|not.*building code|not.*egress/i)).toBeVisible();
    const required = page.locator('[data-semantic-layout] [data-constraint-id="c-door"]');
    await expect(required).toContainText(/required/i);
    await expect(required).toContainText(/door path clear/i);
  });

  test("preview is explicitly not applied/not saved and leaves only Apply/Discard enabled", async ({ page }) => {
    await installCapture(page);
    await page.goto("/");
    await expect.poll(() => page.evaluate(() => (window as any).__elnuvaTools?.size)).toBe(3);
    await stageHome(page);
    const review = page.locator("[data-preview-review]");
    const pendingStatus = review.getByRole("status");
    await expect(pendingStatus).toHaveAttribute("aria-live", "polite");
    await expect(pendingStatus).toHaveAttribute("aria-atomic", "true");
    await expect(pendingStatus).toContainText(/pending review/i);
    await expect(pendingStatus).toContainText(/not applied/i);
    await expect(pendingStatus).toContainText(/not saved/i);
    await expect(page.getByRole("combobox", { name: "Room template" })).toBeDisabled();
    await expect(page.getByRole("combobox", { name: "Add furniture" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Add selected furniture" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Add constraint" })).toBeDisabled();
    for (const name of ["Save", "Undo", "Reset"]) await expect(page.getByRole("button", { name })).toBeDisabled();
    for (const control of await page.getByRole("button", { name: "Update furniture" }).all()) await expect(control).toBeDisabled();
    for (const control of await page.getByRole("button", { name: "Delete furniture" }).all()) await expect(control).toBeDisabled();
    for (const control of await page.getByRole("button", { name: /update constraint/i }).all()) await expect(control).toBeDisabled();
    for (const control of await page.getByRole("button", { name: /delete constraint/i }).all()) await expect(control).toBeDisabled();
    for (const control of await page.getByRole("checkbox", { name: "Locked" }).all()) await expect(control).toBeDisabled();
    await expect(page.getByRole("button", { name: "Apply preview" })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Discard preview" })).toBeEnabled();
    await expect(page.locator('[data-layer="preview"] .preview-ghost')).toHaveAttribute("aria-label", /preview ghost.*not applied/i);
    await expect(page.locator("[data-preview-review]")).toContainText(/required constraints.*2\/2/i);
    await page.getByRole("button", { name: "Discard preview" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.locator('[data-layer="preview"] .preview-ghost')).toHaveCount(0);
  });

  test("returns keyboard focus to a meaningful target after preview Discard and Apply", async ({ page }) => {
    await installCapture(page);
    await page.goto("/");
    await stageHome(page, "fixture-home-0003");
    await page.getByRole("button", { name: "Discard preview" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.locator('[data-layer="preview"] .preview-ghost')).toHaveCount(0);
    await expectMeaningfulFocus(page);
    await expect(page.locator('[data-editor-status][role="status"]')).toContainText(/discard|preview/i);

    await stageHome(page, "fixture-home-0002");
    await page.getByRole("button", { name: "Apply preview" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.locator('[data-layer="preview"] .preview-ghost')).toHaveCount(0);
    await expectMeaningfulFocus(page);
    await expect(page.locator('[data-editor-status][role="status"]')).toContainText(/appl|desk-main|preview/i);
  });

  test("returns keyboard focus to a meaningful remaining target after deleting furniture, feature, and constraint", async ({ page }) => {
    await page.goto("/");

    const furnitureDelete = page.locator('[data-geometry-row][data-item-id="storage-main"]');
    await furnitureDelete.getByRole("checkbox", { name: "Locked" }).uncheck();
    const deleteFurniture = furnitureDelete.getByRole("button", { name: "Delete furniture" });
    await deleteFurniture.focus();
    await page.keyboard.press("Enter");
    await expect(furnitureDelete).toHaveCount(0);
    await expectMeaningfulFocus(page);
    await expect(page.locator('[data-editor-status][role="status"]')).toContainText(/storage-main|delet/i);

    const featureAdd = page.getByRole("button", { name: "Add feature" }).locator("xpath=ancestor::form[1]");
    await featureAdd.getByRole("combobox", { name: "Feature type" }).selectOption("window-1400");
    await featureAdd.getByRole("combobox", { name: "Wall", exact: true }).selectOption("south");
    await featureAdd.getByRole("spinbutton", { name: "Offset (mm)" }).fill("400");
    await expect(page.locator("form[data-feature-id]")).toHaveCount(3);
    await featureAdd.getByRole("button", { name: "Add feature" }).click();
    await expect(page.locator("form[data-feature-id]")).toHaveCount(4);
    const featureDelete = page.locator('form[data-feature-id="window-1"]');
    await expect(featureDelete).toHaveCount(1);
    const deleteFeature = featureDelete.getByRole("button", { name: "Delete" });
    await deleteFeature.focus();
    await page.keyboard.press("Enter");
    await expect(featureDelete).toHaveCount(0);
    await expect(page.locator("form[data-feature-id]")).toHaveCount(3);
    await expectMeaningfulFocus(page);
    await expect(page.locator('[data-editor-status][role="status"]')).toContainText(/delet|feature/i);

    const constraintDelete = page.locator('[data-constraint-row][data-constraint-id="c-window"]');
    const deleteConstraint = constraintDelete.getByRole("button", { name: "Delete constraint" });
    await deleteConstraint.focus();
    await page.keyboard.press("Enter");
    await expect(constraintDelete).toHaveCount(0);
    await expectMeaningfulFocus(page);
    await expect(page.locator('[data-editor-status][role="status"]')).toContainText(/c-window|delet/i);
  });

  test("does not render internal storage, replay, prompt, or inactive-template metadata", async ({ page }) => {
    await page.goto("/");
    const body = page.locator("body");
    await expect(body).not.toContainText(/elnuva:v1:template|idempotency|reservation|proposalDigest|localStorage|prompt transcript/i);
    await expect(body).not.toContainText(/bed-main|table-main/);
    await expect(page.locator('script[src^="http"], link[href^="http"], img[src^="http"]')).toHaveCount(0);
  });

  test("keeps small footer text at or above 4.5 to 1 contrast", async ({ page }) => {
    await page.goto("/");
    const colors = await page.locator(".site-footer").evaluate(node => ({
      foreground: getComputedStyle(node).color,
      background: getComputedStyle(document.body).backgroundColor,
    }));
    expect(contrastRatio(colors.foreground, colors.background)).toBeGreaterThanOrEqual(4.5);
  });
});
