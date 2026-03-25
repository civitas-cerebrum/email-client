import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    silent: false,
    reporters: ['verbose'],
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
    exclude: ['node_modules', 'dist'],
    testTimeout: 120000, 
    hookTimeout: 10000,
  },
});