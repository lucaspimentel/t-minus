// Browser tests (npm run test:browser). MBTA calls go to a fake API (test/browser/fake-mbta.js).
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'test/browser',
  testMatch: '*.spec.js',
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  workers: 1, // one static server with a global mode switch (service-worker spec)
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://localhost:8765',
    viewport: { width: 390, height: 844 },
    timezoneId: 'America/New_York',
    serviceWorkers: 'block', // the service-worker spec opts back in
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // Cloud sandbox: a preinstalled Chromium instead of `playwright install`.
    launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    command: 'node test/browser/server.mjs',
    url: 'http://localhost:8765/index.html',
    reuseExistingServer: !process.env.CI,
  },
});
