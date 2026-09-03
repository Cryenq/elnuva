import { INSPECT_SPATIAL_LAYOUT_INPUT_SCHEMA } from "./schemas";
import type { InspectSpatialLayoutHandler, ModelContextTool } from "./types";

export type WebMcpRegistration = Readonly<{
  status: "registered" | "unavailable";
  teardown: () => void;
}>;

type RegisterWebMcpToolsOptions = Readonly<{
  document: Document;
  inspect: InspectSpatialLayoutHandler;
}>;

const registrationByDocument = new WeakMap<Document, Promise<WebMcpRegistration>>();

const UNAVAILABLE_REGISTRATION: WebMcpRegistration = Object.freeze({
  status: "unavailable" as const,
  teardown: () => undefined,
});

export function registerWebMcpTools({
  document,
  inspect,
}: RegisterWebMcpToolsOptions): Promise<WebMcpRegistration> {
  const existingRegistration = registrationByDocument.get(document);
  if (existingRegistration !== undefined) {
    return existingRegistration;
  }

  let registrationAttempt: Promise<WebMcpRegistration>;
  registrationAttempt = (async () => {
    if (typeof document.modelContext?.registerTool !== "function") {
      return UNAVAILABLE_REGISTRATION;
    }

    const lifetime = new AbortController();
    let tornDown = false;
    const teardown = (): void => {
      if (tornDown) {
        return;
      }
      tornDown = true;
      lifetime.abort();
    };

    document.defaultView?.addEventListener(
      "pagehide",
      (event) => {
        if (!event.persisted) {
          teardown();
        }
      },
      { signal: lifetime.signal },
    );

    const inspectTool: ModelContextTool = {
      name: "inspect_spatial_layout",
      title: "Inspect spatial layout",
      description:
        "Read the active Elnuva room, furniture, constraints, revision, and bounded catalogs.",
      inputSchema: INSPECT_SPATIAL_LAYOUT_INPUT_SCHEMA,
      annotations: {
        readOnlyHint: true,
        untrustedContentHint: true,
      },
      execute: (input, options) => inspect(input, options),
    };

    try {
      await document.modelContext.registerTool(inspectTool, { signal: lifetime.signal });
    } catch {
      teardown();
      throw new Error("WebMCP registration failed.");
    }

    return Object.freeze({
      status: "registered" as const,
      teardown,
    });
  })();

  registrationByDocument.set(document, registrationAttempt);
  void registrationAttempt.catch(() => {
    if (registrationByDocument.get(document) === registrationAttempt) {
      registrationByDocument.delete(document);
    }
  });

  return registrationAttempt;
}
