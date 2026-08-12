import { defineConfig, devices } from "@playwright/test";

// Two engines on purpose. The redaction engine has already been bitten once by a
// WebKit-only canvas difference (ctx.filter='blur()' is a silent no-op there —
// see src/lib/regions.ts), and the whole product claim is about what ends up in
// the exported pixels. A pass in Chromium alone proves very little.
//
// Firefox is deliberately absent: its browser binary isn't installed here, and
// nothing in the pipeline is Gecko-specific. Add it with `npx playwright install
// firefox` if that ever changes.
export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [["list"]],
  // Rendering 150 pages of PDF is legitimately slow, and WebKit is slower again.
  timeout: 120_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: "http://localhost:4321",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  // Test the built site, not the dev server: the lazy chunking, the `?url` asset
  // hashes and the public/ copy all differ between them, and it is the built
  // output that ships.
  //
  // `reuseExistingServer` stays OFF even locally. `npm run preview` serves a
  // static ./dist, so a leftover server from an earlier run happily answers
  // with a stale build and every assertion becomes a lie about code that is no
  // longer on disk. Paying for a rebuild each run is the cheaper mistake.
  webServer: {
    command: "npm run build && npm run preview",
    url: "http://localhost:4321",
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
