# @civitas-cerebrum/email-client

[](https://www.npmjs.com/package/@civitas-cerebrum/email-client)

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

```ts
import { EmailClient, EmailFilterType, EmailMarkAction } from '@civitas-cerebrum/email-client';

const client = new EmailClient({
    senderEmail: 'sender@example.com',
    senderPassword: 'app-password',
    senderSmtpHost: 'smtp.example.com',
    receiverEmail: 'receiver@example.com',
    receiverPassword: 'app-password',
});

// 1. Send an email
await client.send({
    to: 'user@example.com',
    subject: 'Your OTP Code',
    text: 'Your code is 123456',
});

// 2. Poll the inbox until the email arrives
const email = await client.receive({
    filters: [{ type: EmailFilterType.SUBJECT, value: 'Your OTP Code' }],
    waitTimeout: 30000 // Waits up to 30 seconds
});
console.log(email.text); // "Your code is 123456"

// 3. Mark as Read, or clean up the test
await client.mark({
    action: EmailMarkAction.READ,
    filters: [{ type: EmailFilterType.SUBJECT, value: 'Your OTP Code' }]
});

await client.clean({
    filters: [{ type: EmailFilterType.SUBJECT, value: 'Your OTP Code' }]
});
```

-----

## API Reference

### Initialization

```ts
const client = new EmailClient(credentials: EmailCredentials);
```

| Field | Type | Default | Description |
|---|---|---|---|
| `senderEmail` | `string` | — | SMTP sender email address |
| `senderPassword` | `string` | — | SMTP sender password or app password |
| `senderSmtpHost` | `string` | — | SMTP host (e.g., `'smtp.gmail.com'`) |
| `senderSmtpPort` | `number` | `587` | SMTP port |
| `receiverEmail` | `string` | — | IMAP receiver email address |
| `receiverPassword` | `string` | — | IMAP receiver password or app password |
| `receiverImapHost` | `string` | `'imap.gmail.com'` | IMAP host |
| `receiverImapPort` | `number` | `993` | IMAP port |

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

The client uses a robust polling mechanism. It will continuously query the IMAP server until the `waitTimeout` is reached or the filters are satisfied. Combine multiple filters to create strict `AND` logic constraints.

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

## Contributing

```bash
git clone https://github.com/Umutayb/email-client.git
cd email-client
npm install
npm run test
```

## License

MIT