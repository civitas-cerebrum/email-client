import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    silent: false,
    reporters: ['verbose'],
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
    exclude: ['node_modules', 'dist'],

    // ── Timeout invariant ────────────────────────────────────────────────
    // `testTimeout` must ALWAYS exceed the largest internal client wait a
    // test can spend (`waitTimeout` on receive/receiveAll), with real margin.
    // `_pollMailbox` polls until `Date.now() + waitTimeout` and only THEN
    // throws its diagnostic "Found 0/N emails within Nms ..." error, so a
    // test whose vitest budget equals its waitTimeout is killed at the exact
    // instant the useful error would have been produced — it can only pass
    // by luck, and it never reports why it failed.
    //
    // 180000 = WAIT_TIMEOUT (120000, the integration suite's standard wait)
    //          + 60000 margin for SMTP send, IMAP mark/clean round-trips and
    //          connection setup. Tests that spend more than one full wait
    //          declare their own budget via the `budget()` helper in
    //          tests/email-integration.spec.ts.
    testTimeout: 180000,

    // beforeAll builds the live client (env validation + construction) and
    // is the shared gate for all 34 integration tests — if it blows, every
    // one of them fails together. 10s left no room for a slow install/import
    // or for any future hook that opens a real SMTP/IMAP handshake.
    hookTimeout: 60000,
  },
});
