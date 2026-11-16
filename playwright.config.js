// Browser tests. MBTA calls go to a fake API (test/browser/fake-mbta.js).
// - chromium (npm run test:browser): every spec except the WebKit layout spec.
// - webkit-iphone-se, webkit-iphone-17-pro-max (npm run test:webkit): only
//   test/browser/webkit-layout.spec.js, in Playwright's WebKit on two emulated iPhones.
import { defineConfig, devices } from '@playwright/test';

const WEBKIT_SPEC = /webkit-layout\.spec\.js$/;

export default defineConfig({
  testDir: 'test/browser',
  testMatch: '*.spec.js',
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  workers: 1, // one static server with a global mode switch (service-worker spec)
  reporter: process.env.CI ? [['list'], ['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://localhost:8765',
    timezoneId: 'America/New_York',
    serviceWorkers: 'block', // the service-worker spec opts back in
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      testIgnore: WEBKIT_SPEC,
      use: {
        browserName: 'chromium',
        viewport: { width: 390, height: 844 },
        // Cloud sandbox: a preinstalled Chromium instead of `playwright install`.
        launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
      },
    },
    { name: 'webkit-iphone-se', testMatch: WEBKIT_SPEC, use: { ...devices['iPhone SE'], browserName: 'webkit' } },
    { name: 'webkit-iphone-17-pro-max', testMatch: WEBKIT_SPEC, use: { ...devices['iPhone 17 Pro Max'], browserName: 'webkit' } },
  ],
  webServer: {
    command: 'node test/browser/server.mjs',
    url: 'http://localhost:8765/index.html',
    reuseExistingServer: !process.env.CI,
  },
});
