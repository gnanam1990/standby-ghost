import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test/browser',
  timeout: 30_000,
  // all specs share one in-memory server; serialize to avoid cross-talk
  workers: 1,
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:8189' },
  webServer: {
    command: 'node dist/index.js',
    url: 'http://127.0.0.1:8189/',
    reuseExistingServer: false,
    timeout: 20_000,
    env: { PORT: '8189', SG_DB: ':memory:', SG_STATIC: 'public' },
  },
});
