import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
    exclude: ['node_modules', 'dist'],
    reporters: ['verbose'],
    testTimeout: 60000, // 10 seconds for email operations
    hookTimeout: 10000,
  },
});