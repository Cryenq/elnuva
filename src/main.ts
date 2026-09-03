import { hydrateApp } from "./app";
import { createHomeOfficeInspectData } from "./domain/fixture";
import { createInspectSpatialLayoutHandler } from "./webmcp/handlers";
import { registerWebMcpTools, type WebMcpRegistration } from "./webmcp/register";

const root = document.querySelector<HTMLElement>("#app");
if (root === null) {
  throw new Error("Elnuva application root is unavailable.");
}

const currentLayout = createHomeOfficeInspectData();
const app = hydrateApp(root, currentLayout);
const inspect = createInspectSpatialLayoutHandler({
  readCurrentLayout: () => currentLayout,
});

let registration: WebMcpRegistration | null = null;
let documentEnded = false;

void registerWebMcpTools({ document, inspect })
  .then((result) => {
    registration = result;

    if (documentEnded) {
      result.teardown();
      return;
    }

    if (result.status === "registered") {
      app.setCapabilityStatus("registered", "WebMCP Inspect is available.");
      return;
    }

    app.setCapabilityStatus("unavailable", "WebMCP unavailable in this client.");
  })
  .catch(() => {
    if (!documentEnded) {
      app.setCapabilityStatus(
        "failed",
        "WebMCP registration failed. The room layout remains available.",
      );
    }
  });

window.addEventListener(
  "pagehide",
  (event) => {
    if (event.persisted) {
      return;
    }

    documentEnded = true;
    registration?.teardown();
  },
);
