import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  reporter: 'html',
  projects: [
    {
      name: 'unit',
      testMatch: /\/(filter-logic|mime-parsing)\.spec\.ts$/,
    },
    {
      name: 'e2e',
      testMatch: /email-integration\.spec\.ts$/,
    },
    {
      name: 'coverage',
      testMatch: /api-coverage\.spec\.ts$/,
    },
  ],
});
