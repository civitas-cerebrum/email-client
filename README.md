# @civitas-cerebrum/email-client

[![NPM Version](https://img.shields.io/npm/v/@civitas-cerebrum/email-client?color=rgb(88%2C%20171%2C%2070))](https://www.npmjs.com/package/@civitas-cerebrum/email-client)

A generic SMTP/IMAP email client for test automation. Send, receive, search, and clean emails with composable filters.

- **Zero Playwright runtime dependency** — works with any test runner
- **Composable filters** — combine subject, sender, content, date, and more with AND logic
- **Two-phase matching** — exact match first, partial case-insensitive fallback
- **Full inbox management** — send, receive, receive all, and clean

## Installation

```bash
npm i @civitas-cerebrum/email-client
```

## Quick Start

```ts
import { EmailClient, EmailFilterType } from '@civitas-cerebrum/email-client';

const client = new EmailClient({
    senderEmail: 'sender@example.com',
    senderPassword: 'app-password',
    senderSmtpHost: 'smtp.example.com',
    receiverEmail: 'receiver@example.com',
    receiverPassword: 'app-password',
});

// Send an email
await client.send({
    to: 'user@example.com',
    subject: 'Your OTP Code',
    text: 'Your code is 123456',
});

// Receive the latest matching email
const email = await client.receive({
    filters: [{ type: EmailFilterType.SUBJECT, value: 'Your OTP Code' }],
});
console.log(email.subject, email.text);
```

## API

### Constructor

```ts
const client = new EmailClient(credentials: EmailCredentials);
```

| Field | Type | Default | Description |
|---|---|---|---|
| `senderEmail` | `string` | — | SMTP sender email address |
| `senderPassword` | `string` | — | SMTP sender password or app password |
| `senderSmtpHost` | `string` | — | SMTP host (e.g. `'smtp.gmail.com'`) |
| `senderSmtpPort` | `number` | `587` | SMTP port |
| `receiverEmail` | `string` | — | IMAP receiver email address |
| `receiverPassword` | `string` | — | IMAP receiver password or app password |
| `receiverImapHost` | `string` | `'imap.gmail.com'` | IMAP host |
| `receiverImapPort` | `number` | `993` | IMAP port |

### Sending Emails

```ts
// Plain text
await client.send({ to: 'user@example.com', subject: 'Test', text: 'Hello' });

// Inline HTML
await client.send({ to: 'user@example.com', subject: 'Report', html: '<h1>Results</h1>' });

// HTML file template
await client.send({ to: 'user@example.com', subject: 'Report', htmlFile: 'emails/report.html' });
```

### Receiving Emails

Use composable filters to search for emails. Combine as many filters as needed — all filters are applied with AND logic. Filtering tries exact match first, then falls back to partial case-insensitive match (with a warning log).

```ts
// Single filter — get the latest matching email
const email = await client.receive({
    filters: [{ type: EmailFilterType.SUBJECT, value: 'Your OTP' }],
});

// Multiple filters — combine subject, sender, and content
const email2 = await client.receive({
    filters: [
        { type: EmailFilterType.SUBJECT, value: 'Verification' },
        { type: EmailFilterType.FROM, value: 'noreply@example.com' },
        { type: EmailFilterType.CONTENT, value: 'verification code' },
    ],
});

// Get ALL matching emails
const allEmails = await client.receiveAll({
    filters: [
        { type: EmailFilterType.FROM, value: 'alerts@example.com' },
        { type: EmailFilterType.SINCE, value: new Date('2025-01-01') },
    ],
});
```

### Receive Options

| Option | Type | Default | Description |
|---|---|---|---|
| `filters` | `EmailFilter[]` | — | **Required.** Array of filters (AND logic) |
| `folder` | `string` | `'INBOX'` | IMAP folder to search |
| `waitTimeout` | `number` | `30000` | Max ms to poll for the email |
| `pollInterval` | `number` | `3000` | Ms between poll attempts |
| `downloadDir` | `string` | `os.tmpdir()/pw-emails` | Where to save downloaded HTML |

### Filter Types

| Type | Value | Description |
|---|---|---|
| `EmailFilterType.SUBJECT` | `string` | Filter by email subject |
| `EmailFilterType.FROM` | `string` | Filter by sender address |
| `EmailFilterType.TO` | `string` | Filter by recipient address |
| `EmailFilterType.CONTENT` | `string` | Filter by email body (HTML or plain text) |
| `EmailFilterType.SINCE` | `Date` | Only include emails after this date |

### Cleaning the Inbox

```ts
// Delete emails matching filters
await client.clean({
    filters: [{ type: EmailFilterType.FROM, value: 'noreply@example.com' }],
});

// Delete all emails in the inbox
await client.clean();
```

### Client-Side Filtering

`applyFilters` is public — use it to filter already-fetched emails:

```ts
const filtered = client.applyFilters(emails, [
    { type: EmailFilterType.SUBJECT, value: 'OTP' },
]);
```

## ReceivedEmail

Each received email is downloaded as an HTML file and returned as:

| Field | Type | Description |
|---|---|---|
| `filePath` | `string` | Local path to the downloaded HTML file |
| `subject` | `string` | Email subject |
| `from` | `string` | Sender address |
| `date` | `Date` | Date the email was sent |
| `html` | `string` | Raw HTML content (empty string if plain-text only) |
| `text` | `string` | Plain-text content |

## Contributing

```bash
git clone https://github.com/Umutayb/email-client.git
cd email-client
npm install
npm test
```

## License

MIT
