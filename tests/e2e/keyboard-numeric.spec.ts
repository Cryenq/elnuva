import { expect, test } from "@playwright/test";

test.describe("numeric and keyboard editing", () => {
  test.beforeEach(async ({ page }) => { await page.goto("/"); await expect(page.locator('svg[data-room-editor]')).toBeVisible(); });

  test("numeric x/y/rotation and lock controls commit arbitrary mm and match pointer pose", async ({ page }) => {
    const row = page.locator('[data-geometry-row][data-item-id]').first();
    await expect(row).toBeVisible();
    const x = row.getByRole("spinbutton", { name: "X position (mm)" });
    const y = row.getByRole("spinbutton", { name: "Y position (mm)" });
    const rotation = row.getByRole("spinbutton", { name: "Rotation" });
    await x.fill("417"); await y.fill("263"); await rotation.fill("37.5");
    await row.getByRole("checkbox", { name: "Locked" }).check();
    await row.getByRole("button", { name: "Update furniture" }).click();
    await expect(page.locator(`[data-furniture-id="${await row.getAttribute("data-item-id")}"]`)).toHaveAttribute("data-pose", /417.*263.*37\.5/i);
    await expect(x).toHaveValue("417"); await expect(y).toHaveValue("263");
  });

  test("invalid numeric inputs never dispatch a command", async ({ page }) => {
    const row = page.locator('[data-geometry-row][data-item-id]').first();
    const x = row.getByRole("spinbutton", { name: "X position (mm)" });
    const before = await page.locator("[data-furniture-id]").first().getAttribute("data-pose");
    for (const value of ["", "-1", "NaN", "999999999999"]) {
      await x.fill(value); await row.getByRole("button", { name: "Update furniture" }).click();
      await expect(page.getByRole("status")).toContainText(/invalid|required|range/i);
      await expect(page.locator("[data-furniture-id]").first()).toHaveAttribute("data-pose", before ?? "");
    }
  });

  test("keyboard focus is distinct from selection and controls remain native", async ({ page }) => {
    const editor = page.locator('svg[data-room-editor]');
    await editor.focus(); await page.keyboard.press("Tab");
    await expect(page.locator(":focus")).toBeVisible();
    await expect(page.locator("[data-furniture-id][aria-selected=true]")).toHaveCount(0);
    await expect(page.getByRole("checkbox", { name: "Locked" }).first()).toHaveAttribute("type", "checkbox");
  });
});
