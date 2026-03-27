# @civitas-cerebrum/email-client

[![NPM Version](https://img.shields.io/npm/v/@civitas-cerebrum/email-client?color=rgb(88%2C%20171%2C%2070))](https://www.npmjs.com/package/@civitas-cerebrum/email-client)

A highly robust, zero-dependency SMTP/IMAP email client built specifically for E2E test automation. Send, receive, search, manage, and clean emails using composable, deterministic filters.

## Why this client?

  * **Zero Playwright runtime dependency** — Works seamlessly with Playwright, Cypress, Vitest, Jest, or any Node.js test runner.
  * **Smart Polling Engine** — Built-in retry logic prevents flaky tests caused by slow email delivery.
  * **Memory Protected** — Automatically caps raw MIME fetches to prevent Node.js memory crashes when hitting large, unmanaged test inboxes.
  * **Two-Phase Matching** — Evaluates exact IMAP criteria first, then falls back to a smart, case-insensitive client-side match to catch poorly formatted automated emails.
  * **Full Mailbox Management** — Send, receive, flag, archive, and aggressively clean your test environment.

-----

## Installation

```bash
npm install @civitas-cerebrum/email-client
```

-----

## Quick Start

### Send-Only (SMTP)

```ts
import { EmailClient } from '@civitas-cerebrum/email-client';

const client = new EmailClient({
    smtp: {
        email: 'sender@example.com',
        password: 'app-password',
        host: 'smtp.example.com',
    },
});

await client.send({
    to: 'user@example.com',
    subject: 'Your OTP Code',
    text: 'Your code is 123456',
});
```

### Receive-Only (IMAP)

```ts
import { EmailClient, EmailFilterType } from '@civitas-cerebrum/email-client';

const client = new EmailClient({
    imap: {
        email: 'receiver@example.com',
        password: 'app-password',
    },
});

const email = await client.receive({
    filters: [{ type: EmailFilterType.SUBJECT, value: 'Your OTP Code' }],
});
console.log(email.text);
```

### Full Client (Send + Receive)

```ts
import { EmailClient, EmailFilterType, EmailMarkAction } from '@civitas-cerebrum/email-client';

const client = new EmailClient({
    smtp: {
        email: 'sender@example.com',
        password: 'app-password',
        host: 'smtp.example.com',
    },
    imap: {
        email: 'receiver@example.com',
        password: 'app-password',
    },
});

await client.send({ to: 'user@example.com', subject: 'OTP', text: '123456' });

const email = await client.receive({
    filters: [{ type: EmailFilterType.SUBJECT, value: 'OTP' }],
});

await client.mark({
    action: EmailMarkAction.READ,
    filters: [{ type: EmailFilterType.SUBJECT, value: 'OTP' }],
});

await client.clean({
    filters: [{ type: EmailFilterType.SUBJECT, value: 'OTP' }],
});
```

-----

## API Reference

### Initialization

**Constructor:** `new EmailClient({ smtp?, imap? })` or `new EmailClient(legacyCredentials)`

**SmtpCredentials** (required for `send()`):

| Field | Type | Default | Description |
|---|---|---|---|
| `email` | `string` | — | SMTP sender email address |
| `password` | `string` | — | SMTP sender password or app password |
| `host` | `string` | — | SMTP host (e.g., `'smtp.gmail.com'`) |
| `port` | `number` | `587` | SMTP port |

**ImapCredentials** (required for `receive()`, `receiveAll()`, `clean()`, `mark()`):

| Field | Type | Default | Description |
|---|---|---|---|
| `email` | `string` | — | IMAP email address |
| `password` | `string` | — | IMAP password or app password |
| `host` | `string` | `'imap.gmail.com'` | IMAP host |
| `port` | `number` | `993` | IMAP port |

### Legacy Format

The old flat `EmailCredentials` interface is still supported for backward compatibility. Migration to the new split format is encouraged.

```ts
// Legacy format (still supported)
const client = new EmailClient({
    senderEmail: 'sender@example.com',
    senderPassword: 'app-password',
    senderSmtpHost: 'smtp.example.com',
    receiverEmail: 'receiver@example.com',
    receiverPassword: 'app-password',
});
```

-----

### Sending Emails (`send`)

Supports plain text, inline HTML, and loading HTML files directly from disk.

```ts
// Plain text
await client.send({ to: 'user@example.com', subject: 'Test', text: 'Hello' });

// Inline HTML
await client.send({ to: 'user@example.com', subject: 'Report', html: '<h1>Results</h1>' });

// HTML template from disk
await client.send({ to: 'user@example.com', subject: 'Report', htmlFile: 'emails/template.html' });
```

-----

### Receiving Emails (`receive` / `receiveAll`)

The client uses a robust polling mechanism. It will continuously query the IMAP server until the `waitTimeout` is reached or the filters are satisfied. Combine multiple filters to create strict `AND` logic constraints. When multiple emails match, `receive()` returns the most recent one by date.

```ts
// Get the single most recent matching email
const email = await client.receive({
    filters: [{ type: EmailFilterType.SUBJECT, value: 'Your OTP' }],
    waitTimeout: 15000 // Optional: fail if not found in 15s
});

// Get ALL matching emails in the inbox (useful for batch processing)
const allEmails = await client.receiveAll({
    filters: [
        { type: EmailFilterType.FROM, value: 'alerts@example.com' },
        { type: EmailFilterType.SINCE, value: new Date('2025-01-01') },
    ],
});
```

#### Receive Options

| Option | Type | Default | Description |
|---|---|---|---|
| `filters` | `EmailFilter[]` | — | **Required.** Array of filters (AND logic) |
| `folder` | `string` | `'INBOX'` | IMAP folder to search |
| `waitTimeout` | `number` | `30000` | Max milliseconds to poll before throwing an error |
| `pollInterval` | `number` | `3000` | Milliseconds to wait between IMAP fetch attempts |
| `downloadDir` | `string` | `os.tmpdir()` | Directory to save downloaded `.html` copies |

#### Available Filters (`EmailFilterType`)

| Type | Value Type | Description |
|---|---|---|
| `SUBJECT` | `string` | Exact or partial match of the email subject |
| `FROM` | `string` | Sender email address |
| `TO` | `string` | Recipient email address |
| `CONTENT` | `string` | Matches anywhere in the HTML body or plain text fallback |
| `SINCE` | `Date` | Only fetch emails received after this timestamp |

-----

### Managing the Inbox (`mark` / `clean`)

Keep your automated test inboxes clean and organized to prevent IMAP throttling and memory issues.

#### Mark (Flagging and Moving)

Modify the state of emails matching specific criteria. Returns the number of emails affected.

```ts
// Apply standard flags
await client.mark({
    action: EmailMarkAction.READ, // READ, UNREAD, FLAGGED, UNFLAGGED
    filters: [{ type: EmailFilterType.SUBJECT, value: 'Welcome' }]
});

// Move emails to an archive folder
await client.mark({
    action: EmailMarkAction.ARCHIVED,
    filters: [{ type: EmailFilterType.FROM, value: 'spam@example.com' }],
    archiveFolder: 'Archive' // Note: This must match the server's localized folder name
});

// Apply custom IMAP flags
await client.mark({
    action: ['\\Draft', '\\Answered'],
    filters: [{ type: EmailFilterType.SUBJECT, value: 'Custom State' }]
});
```

#### Clean (Deleting)

Permanently delete emails from the server.

```ts
// Delete specific emails
await client.clean({
    filters: [{ type: EmailFilterType.FROM, value: 'noreply@example.com' }],
});

// Nuke the entire inbox (Use with caution!)
await client.clean();
```

-----

### The `ReceivedEmail` Object

When you receive an email, the client parses the raw MIME source and returns a clean, strongly-typed object:

| Property | Type | Description |
|---|---|---|
| `subject` | `string` | Email subject line |
| `from` | `string` | Sender address |
| `to` | `string` | Recipient address |
| `date` | `Date` | Date the email was sent |
| `html` | `string` | Parsed HTML body (empty string if plain-text only) |
| `text` | `string` | Parsed plain-text content |
| `filePath` | `string` | Local path to the downloaded `.html` copy |

-----

## Error Handling

The client provides clear error messages when credentials are missing for a specific operation:

| Operation | Missing Credentials | Error Message |
|---|---|---|
| `send()` | SMTP | `SMTP credentials are required to send emails. Provide { smtp: { email, password, host } } when constructing EmailClient.` |
| `receive()` / `receiveAll()` | IMAP | `IMAP credentials are required to receive/manage emails. Provide { imap: { email, password } } when constructing EmailClient.` |
| `clean()` / `mark()` | IMAP | `IMAP credentials are required to receive/manage emails. Provide { imap: { email, password } } when constructing EmailClient.` |

-----

## Contributing

```bash
git clone https://github.com/Umutayb/email-client.git
cd email-client
npm install
npm run test
```

## License

MIT
