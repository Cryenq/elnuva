import { hydrateApp } from "./app";
import { createDocumentStore } from "./domain/store";
import { verifyStageRequest } from "./domain/validator";
import { createWebMcpHandlers } from "./webmcp/handlers";
import { registerWebMcpTools, type WebMcpRegistration } from "./webmcp/register";

const root = document.querySelector<HTMLElement>("#app");
if (root === null) throw new Error("Elnuva application root is unavailable.");

const store = createDocumentStore({ stageVerifier: verifyStageRequest });
const app = hydrateApp(root, undefined, store);
const handlers = createWebMcpHandlers(store);
let registration: WebMcpRegistration | null = null;
let documentEnded = false;

void registerWebMcpTools({ document, ...handlers }).then((result) => {
  registration = result;
  if (documentEnded) { result.teardown(); return; }
  if (result.status === "registered") app.setCapabilityStatus("registered", "WebMCP tools are available.");
  else app.setCapabilityStatus("unavailable", "WebMCP unavailable in this client. The room layout remains available.");
}).catch(() => {
  if (!documentEnded) app.setCapabilityStatus("failed", "WebMCP registration failed. The room layout remains available.");
});

window.addEventListener("pagehide", (event) => {
  if (event.persisted) return;
  documentEnded = true;
  registration?.teardown();
  app.teardown();
});
