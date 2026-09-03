import { defineConfig } from "@playwright/test";

type RuntimeWithEnvironment = typeof globalThis & {
  process?: {
    env?: Readonly<Record<string, string | undefined>>;
  };
};

const runtime = globalThis as RuntimeWithEnvironment;
const externalBaseUrl = runtime.process?.env?.ELNUVA_TEST_BASE_URL;
const localBaseUrl = "http://127.0.0.1:4173";

export default defineConfig({
  testDir: "./tests/e2e",
  use: {
    baseURL: externalBaseUrl ?? localBaseUrl,
  },
  ...(externalBaseUrl
    ? {}
    : {
        webServer: {
          command:
            "npm run build && npm run preview -- --host 127.0.0.1 --port 4173 --strictPort",
          reuseExistingServer: false,
          url: localBaseUrl,
        },
      }),
});
