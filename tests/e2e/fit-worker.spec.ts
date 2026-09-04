import { expect, test, type Page } from "@playwright/test";
import { enterWorkspace, openPanel } from "./workspace-helpers";
import type { WorkingState } from "../../src/domain/types";

const empty: WorkingState = { schemaVersion: 1, templateId: "home-office", room: { widthMm: 2000, depthMm: 2000 }, furniture: [], features: [], constraints: [] };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function open(page: Page, state = empty) {
  await page.addInitScript(value => {
    localStorage.setItem("elnuva:v1:template:home-office", JSON.stringify({ storageVersion: 1, templateId: "home-office", state: value }));
    Object.assign(window, { __fitCspViolations: [] as string[] });
    document.addEventListener("securitypolicyviolation", event => {
      (window as unknown as { __fitCspViolations: string[] }).__fitCspViolations.push(`${event.violatedDirective}:${event.blockedURI}`);
    });
  }, state);
  await page.goto("/"); await enterWorkspace(page); await openPanel(page, "fit");
  const closed = page.locator("[data-fit-panel] details:not([open]) > summary"); if (await closed.count()) await closed.click();
}
async function queue(page: Page, catalogId: string) {
  await page.getByLabel("Furniture to request", { exact: true }).selectOption(catalogId);
  await page.getByRole("button", { name: "Request furniture", exact: true }).click();
}

test.describe("real bundled Worker execution (no Worker stub)", () => {
  test("runs the production SAT module worker under self-only scripts/workers without unsafe-eval", async ({ page }) => {
    const workerUrls: string[] = [], pageErrors: string[] = [];
    page.on("worker", worker => { workerUrls.push(worker.url()); }); page.on("pageerror", error => { pageErrors.push(error.message); });
    // Test-only response headers tighten the real built app. Assets and worker
    // bytes are fetched unchanged; no solver substitute or production hook.
    const policy = "default-src 'self'; script-src 'self'; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'none'";
    await page.route("**/*", async route => {
      const response = await route.fetch(); await route.fulfill({ response, headers: { ...response.headers(), "content-security-policy": policy } });
    });
    await open(page); const saved = await page.evaluate(() => Object.entries(localStorage)); await queue(page, "chair-600x600");
    await page.locator("[data-fit-panel]").getByRole("button", { name: "Make it Fit", exact: true }).click();
    await expect(page.locator("[data-fit-status]")).toHaveAttribute("data-fit-state", "FOUND", { timeout: 17000 });
    expect(workerUrls).toHaveLength(1); expect(workerUrls[0]).toMatch(/\/assets\/fit-worker-[^/]+\.js$/);
    expect(new URL(workerUrls[0]).origin).toBe(new URL(page.url()).origin);
    expect(await page.evaluate(() => (window as unknown as { __fitCspViolations: string[] }).__fitCspViolations)).toEqual([]);
    expect(pageErrors).toEqual([]); expect(await page.evaluate(() => Object.entries(localStorage))).toEqual(saved);
    await expect(page.locator("[data-human-fit-preview]")).toBeVisible();
  });

  test("reports real finite UNSAT for two full-size beds in the legal minimum room", async ({ page }) => {
    const workers: string[] = []; page.on("worker", worker => { workers.push(worker.url()); }); await open(page);
    await queue(page, "bed-2000x1600"); await queue(page, "bed-2000x1600"); const saved = await page.evaluate(() => Object.entries(localStorage));
    await page.locator("[data-fit-panel]").getByRole("button", { name: "Make it Fit", exact: true }).click();
    const status = page.locator("[data-fit-status]"); await expect(status).toHaveAttribute("data-fit-state", "PROVEN_IMPOSSIBLE", { timeout: 17000 });
    await expect(status).toContainText("No arrangement exists within this 2D model and its required constraints.");
    expect(workers).toHaveLength(1); await expect(page.locator("[data-human-fit-preview]")).toHaveCount(0);
    expect(await page.evaluate(() => Object.entries(localStorage))).toEqual(saved);
  });

  test("cancels a native Worker while its real asset is held, ignoring late asset delivery without a preview", async ({ page }) => {
    const entered = deferred<void>(), release = deferred<void>(), delivered = deferred<void>();
    await page.route(/\/assets\/fit-worker-[^/]+\.js$/, async route => {
      const response = await route.fetch(); entered.resolve(); await release.promise;
      // Browser termination can cancel this request. That is an expected network
      // lifecycle outcome, not a caught test assertion or accepted product error.
      try { await route.fulfill({ response }); } catch (error) {
        if (!(error instanceof Error) || !/closed|cancel|aborted|invalid interception/i.test(error.message)) throw error;
      } finally { delivered.resolve(); }
    });
    await open(page); await queue(page, "chair-600x600"); const saved = await page.evaluate(() => Object.entries(localStorage));
    await page.locator("[data-fit-panel]").getByRole("button", { name: "Make it Fit", exact: true }).click(); await entered.promise;
    const cancel = page.getByRole("button", { name: "Cancel fit", exact: true }); await expect(cancel).toBeEnabled();
    await cancel.focus(); await page.keyboard.press("Enter"); await expect(page.locator("[data-fit-status]")).toHaveAttribute("data-fit-state", "CANCELLED");
    release.resolve(); await delivered.promise;
    await expect(page.locator("[data-fit-status]")).toHaveAttribute("data-fit-state", "CANCELLED");
    await expect(page.locator("[data-human-fit-preview]")).toHaveCount(0); expect(await page.evaluate(() => Object.entries(localStorage))).toEqual(saved);
  });
});
