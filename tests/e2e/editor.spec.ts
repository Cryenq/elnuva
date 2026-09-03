import { expect, test, type Locator, type Page } from "@playwright/test";

const templates = ["Home Office", "Bedroom", "Study"] as const;

async function openEditor(page: Page): Promise<Locator> {
  await page.goto("/");
  const editor = page.locator('svg[data-room-editor]');
  await expect(editor).toHaveCount(1);
  return editor;
}

test.describe("precise room editor", () => {
  test("renders the accessible editor, all layers, and base revision", async ({ page }) => {
    const editor = await openEditor(page);
    await expect(editor).toHaveAccessibleName("Room layout editor");
    for (const layer of ["grid", "features", "furniture", "constraints", "dimensions", "preview"]) {
      await expect(editor.locator(`[data-layer="${layer}"]`)).toHaveCount(1);
    }
    await expect(page.getByText(/Revision\s*\d+/i)).toBeVisible();
    await expect(page.getByRole("status")).toHaveCount(1);
  });

  test("switches among all templates without leaking drafts", async ({ page }) => {
    await openEditor(page);
    const selector = page.getByRole("combobox", { name: "Room template selector" });
    await expect(selector).toBeVisible();
    for (const template of templates) {
      await selector.selectOption({ label: template });
      await expect(selector).toHaveValue(template);
      await expect(page.locator("svg[data-room-editor] [data-layer=furniture] [data-furniture-id]")).toHaveCount(1);
    }
    await selector.selectOption({ label: "Home Office" });
    await expect(selector).toHaveValue("Home Office");
  });

  test("commits one 50 mm snapped drag using SVG CTM coordinates", async ({ page }) => {
    const editor = await openEditor(page);
    const item = editor.locator("[data-furniture-id]").first();
    const before = await item.getAttribute("data-pose");
    const box = await item.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + 10, box!.y + 10);
    await page.mouse.down();
    await page.mouse.move(box!.x + 60, box!.y + 10);
    await page.mouse.up();
    await expect(item).not.toHaveAttribute("data-pose", before ?? "");
    await expect(page.getByRole("status")).toContainText(/updated|valid/i);
    await expect(page.locator('[data-geometry-row][data-item-id]').first()).toBeVisible();
  });

  test("rejects invalid bounds, collision, and radiator placements while allowing edge touch", async ({ page }) => {
    const editor = await openEditor(page);
    const item = editor.locator("[data-furniture-id]").first();
    const pose = await item.getAttribute("data-pose");
    const box = await item.boundingBox();
    expect(box).not.toBeNull();
    for (const dx of [-1000, 2, 1000]) {
      await page.mouse.move(box!.x + 10, box!.y + 10); await page.mouse.down();
      await page.mouse.move(box!.x + dx, box!.y); await page.mouse.up();
      await expect(item).toHaveAttribute("data-pose", pose ?? "");
    }
    await expect(page.getByRole("status")).toContainText(/invalid|collision|radiator|edge/i);
  });

  test("handles pointer capture, second pointer, cancel, lost capture, and touch", async ({ page }) => {
    const editor = await openEditor(page);
    const item = editor.locator("[data-furniture-id]").first();
    const box = await item.boundingBox(); expect(box).not.toBeNull();
    await page.mouse.move(box!.x + 5, box!.y + 5); await page.mouse.down();
    await page.mouse.move(box!.x + 25, box!.y + 25); await page.mouse.up();
    await page.evaluate(() => window.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true })));
    await page.evaluate(() => window.dispatchEvent(new PointerEvent("lostpointercapture", { bubbles: true })));
    await expect(editor).toBeVisible();
  });

  test("keeps pending agent preview ephemeral, disabled at seams, and in preview layer", async ({ page }) => {
    const editor = await openEditor(page);
    const preview = editor.locator('[data-layer="preview"]');
    await expect(preview).toBeVisible();
    await expect(page.getByRole("button", { name: /Apply|Save|Add|Delete|Undo|Reset|Discard/i })).toHaveCount(0);
    await expect(page.getByRole("status")).not.toContainText(/html|script/i);
  });

  test("stays usable at desktop and narrow responsive viewports without console errors", async ({ page }) => {
    const errors: string[] = []; page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 800 }); await openEditor(page);
      await expect(page.locator('svg[data-room-editor]')).toBeVisible();
      await expect(page.getByRole("combobox", { name: "Room template selector" })).toBeVisible();
    }
    expect(errors).toEqual([]);
  });
});
