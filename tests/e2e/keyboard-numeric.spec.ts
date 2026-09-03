import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";

async function installToolCapture(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type CapturedTool = { name: string; execute: (input: unknown, options: { signal: AbortSignal }) => unknown };
    const captured = new Map<string, CapturedTool>();
    Object.defineProperty(document, "modelContext", {
      configurable: true,
      value: { registerTool: async (tool: CapturedTool) => { captured.set(tool.name, tool); } },
    });
    (window as unknown as { __elnuvaCapturedTools: Map<string, CapturedTool> }).__elnuvaCapturedTools = captured;
  });
}

async function openEditor(page: Page): Promise<Locator> {
  await page.goto("/");
  const editor = page.locator('svg[data-room-editor]');
  await expect(editor).toBeVisible();
  return editor;
}

function row(page: Page, itemId: string): Locator {
  return page.locator(`[data-geometry-row][data-item-id="${itemId}"]`);
}

async function revision(page: Page): Promise<number> {
  const term = page.locator("dt").filter({ hasText: /^Revision$/ }).first();
  await expect(term).toBeVisible();
  return Number((await term.locator("xpath=following-sibling::dd[1]").textContent())?.trim());
}

async function updateNumeric(page: Page, itemId: string, x: string, y: string, rotation: string): Promise<void> {
  const target = row(page, itemId);
  await target.getByRole("spinbutton", { name: "X position (mm)" }).fill(x);
  await target.getByRole("spinbutton", { name: "Y position (mm)" }).fill(y);
  await target.getByRole("spinbutton", { name: "Rotation" }).fill(rotation);
  await target.getByRole("button", { name: "Update furniture" }).click();
}

async function roomPointToClient(editor: Locator, xMm: number, yMm: number): Promise<{ x: number; y: number }> {
  return editor.evaluate((node, point) => {
    const matrix = (node as SVGGraphicsElement).getScreenCTM();
    if (!matrix) throw new Error("SVG screen CTM is unavailable.");
    const transformed = new DOMPoint(point.xMm, point.yMm).matrixTransform(matrix);
    return { x: transformed.x, y: transformed.y };
  }, { xMm, yMm });
}

async function inspect(page: Page): Promise<unknown> {
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { __elnuvaCapturedTools: Map<string, unknown> }).__elnuvaCapturedTools.has("inspect_spatial_layout"),
  )).toBe(true);
  return page.evaluate(async () => {
    type CapturedTool = { execute: (input: unknown, options: { signal: AbortSignal }) => unknown };
    const tool = (window as unknown as { __elnuvaCapturedTools: Map<string, CapturedTool> }).__elnuvaCapturedTools.get("inspect_spatial_layout")!;
    return tool.execute({}, { signal: new AbortController().signal });
  });
}

async function freshCapturedPage(browser: Browser): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await installToolCapture(page);
  await openEditor(page);
  return { page, close: () => context.close() };
}

test.describe("numeric and keyboard editing", () => {
  test.beforeEach(async ({ page }) => { await openEditor(page); });

  test("commits the exact integer chair pose 1901,1301,90 once", async ({ page }) => {
    await updateNumeric(page, "chair-main", "1901", "1301", "90");
    const chair = page.locator('[data-furniture-id="chair-main"]');
    await expect(chair).toHaveAttribute("data-x-mm", "1901");
    await expect(chair).toHaveAttribute("data-y-mm", "1301");
    await expect(chair).toHaveAttribute("data-rotation-deg", "90");
    expect(await revision(page)).toBe(2);
    await expect(row(page, "chair-main").getByRole("spinbutton", { name: "Rotation" })).toHaveValue("90");
  });

  test("keeps locked Storage pose controls disabled until the human unlocks it", async ({ page }) => {
    const storage = row(page, "storage-main");
    const lock = storage.getByRole("checkbox", { name: "Locked" });
    await expect(lock).toBeChecked();
    await expect(lock).toBeEnabled();
    await expect(storage.getByRole("spinbutton", { name: "X position (mm)" })).toBeDisabled();
    await expect(storage.getByRole("spinbutton", { name: "Y position (mm)" })).toBeDisabled();
    await expect(storage.getByRole("spinbutton", { name: "Rotation" })).toBeDisabled();
    await expect(storage.getByRole("button", { name: "Update furniture" })).toBeDisabled();

    await lock.uncheck();
    await expect(lock).not.toBeChecked();
    await expect(storage.getByRole("spinbutton", { name: "X position (mm)" })).toBeEnabled();
    await expect(storage.getByRole("button", { name: "Update furniture" })).toBeEnabled();
    await expect(page.locator('[data-furniture-id="storage-main"]')).toHaveAttribute("data-locked", "false");
    expect(await revision(page)).toBe(2);
  });

  test("pointer and numeric paths yield the identical domain state in fresh Documents", async ({ browser, page }) => {
    void page;
    const pointer = await freshCapturedPage(browser);
    const numeric = await freshCapturedPage(browser);
    try {
      const pointerEditor = pointer.page.locator('svg[data-room-editor]');
      const start = await roomPointToClient(pointerEditor, 2500, 1300);
      const target = await roomPointToClient(pointerEditor, 2550, 1300);
      await pointer.page.mouse.move(start.x, start.y);
      await pointer.page.mouse.down();
      await pointer.page.mouse.move(target.x, target.y, { steps: 3 });
      await pointer.page.mouse.up();
      await updateNumeric(numeric.page, "chair-main", "2550", "1300", "0");

      const pointerState = await inspect(pointer.page);
      const numericState = await inspect(numeric.page);
      expect(pointerState).toEqual(numericState);
      expect(await revision(pointer.page)).toBe(2);
      expect(await revision(numeric.page)).toBe(2);
    } finally {
      await pointer.close();
      await numeric.close();
    }
  });

  for (const vector of [
    { name: "fractional millimetres", x: "1900.5", y: "1300", rotation: "0", status: /integer|whole/i },
    { name: "an empty coordinate", x: "", y: "1300", rotation: "0", status: /required|invalid/i },
    { name: "a non-quarter rotation", x: "1901", y: "1301", rotation: "37.5", status: /rotation|quarter|90/i },
    { name: "an out-of-bounds pose", x: "200", y: "1500", rotation: "0", status: /outside|bounds/i },
    { name: "a colliding pose", x: "2500", y: "500", rotation: "0", status: /overlap|collision|Desk/i },
  ] as const) {
    test(`rejects ${vector.name} without a command`, async ({ page }) => {
      const beforeRevision = await revision(page);
      await updateNumeric(page, "chair-main", vector.x, vector.y, vector.rotation);
      const chair = page.locator('[data-furniture-id="chair-main"]');
      await expect(chair).toHaveAttribute("data-x-mm", "2500");
      await expect(chair).toHaveAttribute("data-y-mm", "1300");
      await expect(chair).toHaveAttribute("data-rotation-deg", "0");
      expect(await revision(page)).toBe(beforeRevision);
      await expect(page.locator('[data-editor-status][role="status"]')).toContainText(vector.status);
    });
  }

  test("uses Enter and Space for selection while focus remains visibly distinct", async ({ page }) => {
    const chair = page.locator('[data-furniture-id="chair-main"]');
    const desk = page.locator('[data-furniture-id="desk-main"]');
    await expect(chair).toHaveAttribute("role", "button");
    await expect(chair).toHaveAttribute("tabindex", "0");
    await expect(chair).toHaveAttribute("aria-pressed", "false");
    await chair.focus();
    await page.keyboard.press("Enter");
    await expect(chair).toHaveAttribute("aria-pressed", "true");

    await desk.focus();
    await expect(desk).toBeFocused();
    await expect(desk).toHaveAttribute("aria-pressed", "false");
    await expect(chair).toHaveAttribute("aria-pressed", "true");
    expect(await desk.evaluate(node => {
      const style = getComputedStyle(node);
      return style.outlineStyle !== "none" || style.outlineWidth !== "0px" || style.boxShadow !== "none";
    })).toBe(true);

    await page.keyboard.press("Space");
    await expect(desk).toHaveAttribute("aria-pressed", "true");
    await expect(chair).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByRole("combobox", { name: "Room template" })).toHaveJSProperty("tagName", "SELECT");
    await expect(row(page, "desk-main").getByRole("checkbox", { name: "Locked" })).toHaveAttribute("type", "checkbox");
    await expect(row(page, "desk-main").getByRole("spinbutton", { name: "X position (mm)" })).toHaveAttribute("type", "number");
  });
});
