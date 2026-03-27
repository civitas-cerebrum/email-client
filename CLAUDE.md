# @civitas-cerebrum/email-client — Development Instructions

A standalone SMTP/IMAP email client for test automation. Send, receive, search, and clean emails with composable filters.

## Build & Test

```bash
npm run build        # Clean build (rm -rf dist && tsc)
npm test             # Run all tests via Vitest
npx tsc --noEmit     # Type check only
```

## Architecture

- `src/EmailClient.ts` — Core class: send (SMTP), receive/receiveAll (IMAP), clean, applyFilters
- `src/types.ts` — All public type definitions (EmailFilterType, EmailFilter, EmailCredentials, SmtpCredentials, ImapCredentials, EmailClientConfig, etc.)
- `src/logger.ts` — debug-based logger (`DEBUG=email-client:*`)
- `src/index.ts` — Public exports

## Testing

- `tests/filter-logic.spec.ts` — Unit tests for two-phase filter matching (exact → partial fallback)
- `tests/mime-parsing.spec.ts` — Unit tests for HTML/text extraction from MIME sources
- `tests/integration.spec.ts` — Real SMTP/IMAP tests (require env vars, skipped otherwise)

### Required secrets for integration tests

`SENDER_EMAIL`, `SENDER_PASSWORD`, `SENDER_SMTP_HOST`, `RECEIVER_EMAIL`, `RECEIVER_PASSWORD`

## Key Design Decisions

- **Two-phase filtering** — exact match first, partial case-insensitive fallback with warning log
- **`applyFilters` is public** — consumers can use it for client-side filtering of already-fetched emails
- **Logger** uses `debug` with `email-client:*` namespace (not `TESTER_DEBUG`)
- **Default SMTP port** is 587 (no env var needed)
- **Split credentials** — SMTP and IMAP credentials are independent; constructor accepts { smtp?, imap? } or legacy flat EmailCredentials for backward compat
