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
    // WHY THESE NUMBERS ARE LARGE — READ BEFORE TIGHTENING THEM.
    // The integration suite runs against a free-tier hosted mail provider.
    // The dominant cost is that provider's delivery latency, not this
    // library's speed — on a slow day an email takes minutes to become
    // visible over IMAP. These budgets are sized for the provider. Cutting
    // them back does not speed up a good run (a passing test returns as soon
    // as the mail lands); it only makes a slow day fail, which is the
    // release-blocking failure they were raised to stop.
    //
    // 420000 = the suite's standard wait (300000, `TIMEOUT` in
    //          tests/email-integration.spec.ts) + 120000 margin for SMTP
    //          send, IMAP mark/clean round-trips and connection setup —
    //          i.e. exactly `budget(1)`, so a test that declares no budget
    //          of its own still gets one full wait plus that margin. Keep
    //          this in step with TIMEOUT: if the wait moves, this moves.
    //          Tests that spend more than one full wait, or that perform an
    //          unbounded server mutation on the critical path, declare their
    //          own budget via the `budget()` helper in that spec.
    testTimeout: 420000,

    // beforeAll builds the live client (env validation + construction) and
    // is the shared gate for all 34 integration tests — if it blows, every
    // one of them fails together. 10s left no room for a slow install/import
    // or for any future hook that opens a real SMTP/IMAP handshake. The hook
    // does no network I/O today, so this does not need to scale with the
    // provider-driven test budgets.
    hookTimeout: 60000,
  },
});
