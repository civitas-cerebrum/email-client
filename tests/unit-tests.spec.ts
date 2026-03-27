import { describe, test, expect, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { EmailFilterType, EmailFilter, EmailCredentials, EmailClientConfig, ReceivedEmail } from '../src/types';
import { EmailClient } from '../src/EmailClient';
import { EmailMarkAction } from '../src';

// ─── 1. MOCK THE NETWORK LIBRARIES COMPLETELY ────────────────────────

vi.mock('nodemailer', () => {
    return {
        createTransport: vi.fn().mockReturnValue({
            sendMail: vi.fn().mockImplementation(async (mailOptions) => {
                if (!mailOptions.to) throw new Error('No recipients defined');
                if (!mailOptions.subject) throw new Error('No subject defined');
                return { messageId: 'mock-id' };
            }),
            verify: vi.fn().mockResolvedValue(true),
        }),
    };
});

const mockMessageFlagsAdd = vi.fn().mockResolvedValue(true);
const mockMessageFlagsRemove = vi.fn().mockResolvedValue(true);
const mockMessageMove = vi.fn().mockResolvedValue(true);
const mockMessageDelete = vi.fn().mockResolvedValue(true);
const mockSearch = vi.fn().mockResolvedValue([1]);
const mockMailboxOpen = vi.fn().mockResolvedValue(undefined);
const mockFetch = vi.fn();

vi.mock('imapflow', () => {
    return {
        ImapFlow: vi.fn().mockImplementation(() => ({
            connect: vi.fn().mockResolvedValue(undefined),
            logout: vi.fn().mockResolvedValue(undefined),
            mailboxOpen: mockMailboxOpen,
            messageDelete: mockMessageDelete,
            messageFlagsAdd: mockMessageFlagsAdd,
            messageFlagsRemove: mockMessageFlagsRemove,
            messageMove: mockMessageMove,
            search: mockSearch,
            fetch: mockFetch,
            getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
        })),
    };
});
// ─────────────────────────────────────────────────────────────────────

const dummyCredentials: EmailCredentials = {
    senderEmail: 'fake-sender@test.com',
    senderPassword: 'fake-password',
    senderSmtpHost: 'fake-smtp.test.com',
    receiverEmail: 'fake-receiver@test.com',
    receiverPassword: 'fake-password',
};

function makeEmail(overrides: Partial<ReceivedEmail> = {}): ReceivedEmail {
    return {
        filePath: '/tmp/test.html',
        subject: 'Your OTP Code',
        from: 'noreply@example.com',
        to: 'fake-receiver@test.com',
        date: new Date('2025-06-01'),
        html: '<h1>Your code is 123456</h1>',
        text: 'Your code is 123456',
        ...overrides,
    };
}

describe('EmailClient Unit Tests', () => {
    let emailClient: EmailClient;

    beforeEach(() => {
        emailClient = new EmailClient(dummyCredentials);
        vi.clearAllMocks();
        // Default: search returns one UID so action methods have something to act on
        mockSearch.mockResolvedValue([1]);
    });

    // ─── SEND() ──────────────────────────────────────────────────────

    describe('send() logic', () => {
        test('should throw when recipient "to" is missing', async () => {
            // @ts-expect-error intentionally testing missing param
            await expect(emailClient.send({ subject: 'Test', text: 'Hello' })).rejects.toThrow();
        });

        test('should throw when "subject" is missing', async () => {
            // @ts-expect-error intentionally testing missing param
            await expect(emailClient.send({ to: 'test@example.com', text: 'Hello' })).rejects.toThrow();
        });

        test('should resolve when valid text params are provided', async () => {
            await expect(
                emailClient.send({ to: 'test@example.com', subject: 'Test', text: 'Hello' })
            ).resolves.not.toThrow();
        });

        test('should resolve when valid html param is provided', async () => {
            await expect(
                emailClient.send({ to: 'test@example.com', subject: 'Test', html: '<p>Hello</p>' })
            ).resolves.not.toThrow();
        });

        test('should load and send HTML from a file when htmlFile is provided', async () => {
            const tmpFile = path.join(os.tmpdir(), `unit-test-email-${Date.now()}.html`);
            fs.writeFileSync(tmpFile, '<h1>From file</h1>', 'utf-8');

            try {
                await expect(
                    emailClient.send({ to: 'test@example.com', subject: 'Test', htmlFile: tmpFile })
                ).resolves.not.toThrow();
            } finally {
                fs.unlinkSync(tmpFile);
            }
        });

        test('should throw when htmlFile path does not exist', async () => {
            await expect(
                emailClient.send({
                    to: 'test@example.com',
                    subject: 'Test',
                    htmlFile: '/tmp/does-not-exist-at-all.html',
                })
            ).rejects.toThrow(/HTML file not found/);
        });
    });

    // ─── CLEAN() ─────────────────────────────────────────────────────

    describe('clean() logic', () => {
        test('should resolve when called with no options (clean all)', async () => {
            await expect(emailClient.clean()).resolves.not.toThrow();
        });

        test('should resolve when called with specific filters', async () => {
            await expect(
                emailClient.clean({ filters: [{ type: EmailFilterType.SUBJECT, value: 'Old Test' }] })
            ).resolves.not.toThrow();
        });

        test('should return 0 when search finds no matching UIDs', async () => {
            mockSearch.mockResolvedValueOnce([]);
            const count = await emailClient.clean({
                filters: [{ type: EmailFilterType.SUBJECT, value: 'no-match' }],
            });
            expect(count).toBe(0);
            expect(mockMessageDelete).not.toHaveBeenCalled();
        });

        test('should return the number of deleted emails', async () => {
            mockSearch.mockResolvedValueOnce([1, 2, 3]);
            const count = await emailClient.clean({
                filters: [{ type: EmailFilterType.SUBJECT, value: 'batch' }],
            });
            expect(count).toBe(3);
            expect(mockMessageDelete).toHaveBeenCalledWith([1, 2, 3], { uid: true });
        });

        test('should open the specified folder', async () => {
            mockSearch.mockResolvedValueOnce([]);
            await emailClient.clean({ folder: 'Sent' });
            expect(mockMailboxOpen).toHaveBeenCalledWith('Sent');
        });
    });

    // ─── MARK() ──────────────────────────────────────────────────────

    describe('mark() logic', () => {
        test('should add \\Seen flag for READ action', async () => {
            const count = await emailClient.mark({
                action: EmailMarkAction.READ,
                filters: [{ type: EmailFilterType.SUBJECT, value: 'test' }],
            });
            expect(count).toBe(1);
            expect(mockMessageFlagsAdd).toHaveBeenCalledWith([1], ['\\Seen'], { uid: true });
        });

        test('should remove \\Seen flag for UNREAD action', async () => {
            const count = await emailClient.mark({
                action: EmailMarkAction.UNREAD,
                filters: [{ type: EmailFilterType.SUBJECT, value: 'test' }],
            });
            expect(count).toBe(1);
            expect(mockMessageFlagsRemove).toHaveBeenCalledWith([1], ['\\Seen'], { uid: true });
        });

        test('should add \\Flagged for FLAGGED action', async () => {
            const count = await emailClient.mark({
                action: EmailMarkAction.FLAGGED,
                filters: [{ type: EmailFilterType.SUBJECT, value: 'test' }],
            });
            expect(count).toBe(1);
            expect(mockMessageFlagsAdd).toHaveBeenCalledWith([1], ['\\Flagged'], { uid: true });
        });

        test('should remove \\Flagged for UNFLAGGED action', async () => {
            const count = await emailClient.mark({
                action: EmailMarkAction.UNFLAGGED,
                filters: [{ type: EmailFilterType.SUBJECT, value: 'test' }],
            });
            expect(count).toBe(1);
            expect(mockMessageFlagsRemove).toHaveBeenCalledWith([1], ['\\Flagged'], { uid: true });
        });

        test('should call messageMove for ARCHIVED action', async () => {
            const count = await emailClient.mark({
                action: EmailMarkAction.ARCHIVED,
                filters: [{ type: EmailFilterType.SUBJECT, value: 'test' }],
                archiveFolder: 'Archive',
            });
            expect(count).toBe(1);
            expect(mockMessageMove).toHaveBeenCalledWith([1], 'Archive', { uid: true });
        });

        test('should add custom flag array when action is a string[]', async () => {
            const count = await emailClient.mark({
                action: ['\\Draft', '\\Answered'],
                filters: [{ type: EmailFilterType.SUBJECT, value: 'test' }],
            });
            expect(count).toBe(1);
            expect(mockMessageFlagsAdd).toHaveBeenCalledWith([1], ['\\Draft', '\\Answered'], { uid: true });
        });

        test('should return 0 and not call any flag method when no UIDs match', async () => {
            mockSearch.mockResolvedValueOnce([]);
            const count = await emailClient.mark({
                action: EmailMarkAction.READ,
                filters: [{ type: EmailFilterType.SUBJECT, value: 'no-match' }],
            });
            expect(count).toBe(0);
            expect(mockMessageFlagsAdd).not.toHaveBeenCalled();
        });

        test('should throw for an unsupported action string', async () => {
            await expect(
                emailClient.mark({
                    action: 'NONEXISTENT_ACTION' as unknown as EmailMarkAction,
                    filters: [{ type: EmailFilterType.SUBJECT, value: 'test' }],
                })
            ).rejects.toThrow(/Unsupported mark action/);
        });
    });

    // ─── APPLYFILTERS() ──────────────────────────────────────────────

    describe('applyFilters() logic', () => {
        test('SUBJECT filter — exact match', () => {
            const candidates = [
                makeEmail({ subject: 'Your OTP Code' }),
                makeEmail({ subject: 'Welcome aboard' }),
            ];
            const result = emailClient.applyFilters(candidates, [
                { type: EmailFilterType.SUBJECT, value: 'Your OTP Code' },
            ]);
            expect(result).toHaveLength(1);
            expect(result[0].subject).toBe('Your OTP Code');
        });

        test('FROM filter — exact match', () => {
            const candidates = [
                makeEmail({ from: 'noreply@example.com' }),
                makeEmail({ from: 'support@example.com' }),
            ];
            const result = emailClient.applyFilters(candidates, [
                { type: EmailFilterType.FROM, value: 'noreply@example.com' },
            ]);
            expect(result).toHaveLength(1);
            expect(result[0].from).toBe('noreply@example.com');
        });

        test('CONTENT filter — exact match on HTML body', () => {
            const candidates = [
                makeEmail({ html: '<p>Your verification code is 999</p>' }),
                makeEmail({ html: '<p>Welcome to our service</p>' }),
            ];
            const result = emailClient.applyFilters(candidates, [
                { type: EmailFilterType.CONTENT, value: '<p>Your verification code is 999</p>' },
            ]);
            expect(result).toHaveLength(1);
            expect(result[0].html).toContain('999');
        });

        test('CONTENT filter — falls back to plain text when no HTML', () => {
            const candidates = [
                makeEmail({ html: '', text: 'Plain text OTP: 5678' }),
                makeEmail({ html: '', text: 'Welcome email' }),
            ];
            const result = emailClient.applyFilters(candidates, [
                { type: EmailFilterType.CONTENT, value: 'Plain text OTP: 5678' },
            ]);
            expect(result).toHaveLength(1);
            expect(result[0].text).toContain('5678');
        });

        test('Multiple filters — SUBJECT + FROM exact match (AND logic)', () => {
            const candidates = [
                makeEmail({ subject: 'OTP', from: 'noreply@example.com' }),
                makeEmail({ subject: 'OTP', from: 'support@example.com' }),
                makeEmail({ subject: 'Welcome', from: 'noreply@example.com' }),
            ];
            const result = emailClient.applyFilters(candidates, [
                { type: EmailFilterType.SUBJECT, value: 'OTP' },
                { type: EmailFilterType.FROM, value: 'noreply@example.com' },
            ]);
            expect(result).toHaveLength(1);
            expect(result[0].subject).toBe('OTP');
            expect(result[0].from).toBe('noreply@example.com');
        });

        test('Three filters — SUBJECT + FROM + CONTENT exact match', () => {
            const candidates = [
                makeEmail({ subject: 'OTP', from: 'noreply@example.com', html: '<p>Code: 123</p>' }),
                makeEmail({ subject: 'OTP', from: 'noreply@example.com', html: '<p>Code: 456</p>' }),
            ];
            const result = emailClient.applyFilters(candidates, [
                { type: EmailFilterType.SUBJECT, value: 'OTP' },
                { type: EmailFilterType.FROM, value: 'noreply@example.com' },
                { type: EmailFilterType.CONTENT, value: '<p>Code: 456</p>' },
            ]);
            expect(result).toHaveLength(1);
            expect(result[0].html).toContain('456');
        });

        test('SUBJECT filter — falls back to partial case-insensitive match', () => {
            const candidates = [
                makeEmail({ subject: 'Your OTP Code - Action Required' }),
                makeEmail({ subject: 'Welcome aboard' }),
            ];
            const result = emailClient.applyFilters(candidates, [
                { type: EmailFilterType.SUBJECT, value: 'otp code' },
            ]);
            expect(result).toHaveLength(1);
            expect(result[0].subject).toBe('Your OTP Code - Action Required');
        });

        test('FROM filter — falls back to partial case-insensitive match', () => {
            const candidates = [
                makeEmail({ from: 'NoReply@Example.COM' }),
                makeEmail({ from: 'support@other.com' }),
            ];
            const result = emailClient.applyFilters(candidates, [
                { type: EmailFilterType.FROM, value: 'noreply@example.com' },
            ]);
            expect(result).toHaveLength(1);
            expect(result[0].from).toBe('NoReply@Example.COM');
        });

        test('CONTENT filter — falls back to partial case-insensitive match', () => {
            const candidates = [
                makeEmail({ html: '<h1>Your Verification Code is ABC123</h1>' }),
                makeEmail({ html: '<p>Newsletter</p>' }),
            ];
            const result = emailClient.applyFilters(candidates, [
                { type: EmailFilterType.CONTENT, value: 'verification code' },
            ]);
            expect(result).toHaveLength(1);
            expect(result[0].html).toContain('ABC123');
        });

        test('Combined filters — partial fallback applies to all filters together', () => {
            const candidates = [makeEmail({ subject: 'Your OTP Code', from: 'NoReply@Example.COM' })];
            const result = emailClient.applyFilters(candidates, [
                { type: EmailFilterType.SUBJECT, value: 'otp' },
                { type: EmailFilterType.FROM, value: 'noreply' },
            ]);
            expect(result).toHaveLength(1);
        });

        test('Exact match is preferred over partial match', () => {
            const candidates = [
                makeEmail({ subject: 'OTP Code' }),
                makeEmail({ subject: 'OTP' }),
                makeEmail({ subject: 'Your OTP is ready' }),
            ];
            const result = emailClient.applyFilters(candidates, [
                { type: EmailFilterType.SUBJECT, value: 'OTP' },
            ]);
            expect(result).toHaveLength(1);
            expect(result[0].subject).toBe('OTP');
        });

        test('SINCE filter is excluded from client-side matching', () => {
            const candidates = [makeEmail({ subject: 'Test Email' })];
            const result = emailClient.applyFilters(candidates, [
                { type: EmailFilterType.SINCE, value: new Date('2025-01-01') },
            ]);
            expect(result).toHaveLength(1);
        });

        test('SINCE combined with string filters works correctly', () => {
            const candidates = [
                makeEmail({ subject: 'Match' }),
                makeEmail({ subject: 'No Match' }),
            ];
            const result = emailClient.applyFilters(candidates, [
                { type: EmailFilterType.SINCE, value: new Date('2025-01-01') },
                { type: EmailFilterType.SUBJECT, value: 'Match' },
            ]);
            expect(result).toHaveLength(1);
            expect(result[0].subject).toBe('Match');
        });

        test('No candidates — returns empty array', () => {
            const result = emailClient.applyFilters([], [
                { type: EmailFilterType.SUBJECT, value: 'Anything' },
            ]);
            expect(result).toHaveLength(0);
        });

        test('No filters (empty array) — returns all candidates unchanged', () => {
            const candidates = [makeEmail(), makeEmail({ subject: 'Other' })];
            const result = emailClient.applyFilters(candidates, []);
            expect(result).toHaveLength(2);
        });

        test('No exact or partial match — returns empty array', () => {
            const candidates = [
                makeEmail({ subject: 'Completely unrelated' }),
                makeEmail({ subject: 'Also unrelated' }),
            ];
            const result = emailClient.applyFilters(candidates, [
                { type: EmailFilterType.SUBJECT, value: 'OTP Code' },
            ]);
            expect(result).toHaveLength(0);
        });

        test('Combined filters — one matches but the other does not — returns empty', () => {
            const candidates = [makeEmail({ subject: 'OTP', from: 'support@other.com' })];
            const result = emailClient.applyFilters(candidates, [
                { type: EmailFilterType.SUBJECT, value: 'OTP' },
                { type: EmailFilterType.FROM, value: 'noreply@example.com' },
            ]);
            expect(result).toHaveLength(0);
        });

        test('CONTENT filter — no match in HTML or text — returns empty', () => {
            const candidates = [makeEmail({ html: '<p>Hello world</p>', text: 'Hello world' })];
            const result = emailClient.applyFilters(candidates, [
                { type: EmailFilterType.CONTENT, value: 'verification code' },
            ]);
            expect(result).toHaveLength(0);
        });

        test('Partial match on one filter but not the other — returns empty', () => {
            const candidates = [
                makeEmail({ subject: 'Your OTP Code', from: 'totally-different@xyz.com' }),
            ];
            const result = emailClient.applyFilters(candidates, [
                { type: EmailFilterType.SUBJECT, value: 'otp' },
                { type: EmailFilterType.FROM, value: 'noreply@example.com' },
            ]);
            expect(result).toHaveLength(0);
        });

        test('Multiple candidates match — all are returned', () => {
            const candidates = [
                makeEmail({ subject: 'OTP Code', from: 'noreply@example.com' }),
                makeEmail({ subject: 'OTP Code', from: 'noreply@example.com' }),
                makeEmail({ subject: 'Welcome', from: 'support@example.com' }),
            ];
            const result = emailClient.applyFilters(candidates, [
                { type: EmailFilterType.SUBJECT, value: 'OTP Code' },
            ]);
            expect(result).toHaveLength(2);
        });
    });

    // ─── BUILDSEARCHCRITERIA() ────────────────────────────────────────

    describe('buildSearchCriteria() logic', () => {
        test('maps SUBJECT filter to IMAP subject criterion', () => {
            const criteria = (emailClient as any).buildSearchCriteria([
                { type: EmailFilterType.SUBJECT, value: 'Hello' },
            ]);
            expect(criteria).toMatchObject({ subject: 'Hello' });
        });

        test('maps FROM filter to IMAP from criterion', () => {
            const criteria = (emailClient as any).buildSearchCriteria([
                { type: EmailFilterType.FROM, value: 'sender@example.com' },
            ]);
            expect(criteria).toMatchObject({ from: 'sender@example.com' });
        });

        test('maps TO filter to IMAP to criterion', () => {
            const criteria = (emailClient as any).buildSearchCriteria([
                { type: EmailFilterType.TO, value: 'receiver@example.com' },
            ]);
            expect(criteria).toMatchObject({ to: 'receiver@example.com' });
        });

        test('maps CONTENT filter to IMAP body criterion', () => {
            const criteria = (emailClient as any).buildSearchCriteria([
                { type: EmailFilterType.CONTENT, value: 'secret code' },
            ]);
            expect(criteria).toMatchObject({ body: 'secret code' });
        });

        test('maps SINCE filter to IMAP since criterion', () => {
            const since = new Date('2025-01-01');
            const criteria = (emailClient as any).buildSearchCriteria([
                { type: EmailFilterType.SINCE, value: since },
            ]);
            expect(criteria).toMatchObject({ since });
        });

        test('combines multiple filters into one criteria object (AND logic)', () => {
            const since = new Date('2025-01-01');
            const criteria = (emailClient as any).buildSearchCriteria([
                { type: EmailFilterType.SUBJECT, value: 'OTP' },
                { type: EmailFilterType.FROM, value: 'noreply@example.com' },
                { type: EmailFilterType.SINCE, value: since },
            ]);
            expect(criteria).toMatchObject({
                subject: 'OTP',
                from: 'noreply@example.com',
                since,
            });
        });

        test('ignores duplicate filter types at the IMAP level (relies on client-side filtering)', () => {
            const criteria = (emailClient as any).buildSearchCriteria([
                { type: EmailFilterType.SUBJECT, value: 'First' },
                { type: EmailFilterType.SUBJECT, value: 'Second' },
            ]);
            expect(criteria.subject).toBe('First');
        });

        test('throws for an unknown filter type', () => {
            expect(() =>
                (emailClient as any).buildSearchCriteria([
                    { type: 'UNKNOWN_TYPE', value: 'something' },
                ])
            ).toThrow(/Unknown email filter type/);
        });
    });

    // ─── EXTRACT*FROMSOURCE() ─────────────────────────────────────────

    describe('extractHtmlFromSource() / extractTextFromSource() logic', () => {
        test('returns empty string for an empty source', () => {
            expect((emailClient as any).extractHtmlFromSource('')).toBe('');
            expect((emailClient as any).extractTextFromSource('')).toBe('');
        });

        test('extracts HTML from a multipart/alternative source', () => {
            const source = [
                'Content-Type: multipart/alternative; boundary="bound"',
                '',
                '--bound',
                'Content-Type: text/plain; charset="utf-8"',
                '',
                'Plain fallback',
                '--bound',
                'Content-Type: text/html; charset="utf-8"',
                '',
                '<p>HTML content</p>',
                '--bound--',
            ].join('\r\n');
            expect((emailClient as any).extractHtmlFromSource(source)).toContain('<p>HTML content</p>');
        });

        test('extracts plain text from a multipart/alternative source', () => {
            const source = [
                'Content-Type: multipart/alternative; boundary="bound"',
                '',
                '--bound',
                'Content-Type: text/plain; charset="utf-8"',
                '',
                'Plain fallback',
                '--bound',
                'Content-Type: text/html; charset="utf-8"',
                '',
                '<p>HTML content</p>',
                '--bound--',
            ].join('\r\n');
            expect((emailClient as any).extractTextFromSource(source)).toContain('Plain fallback');
        });

        test('decodes base64-encoded HTML part', () => {
            const encoded = Buffer.from('<p>decoded</p>').toString('base64');
            const source = [
                'Content-Type: multipart/alternative; boundary="b"',
                '',
                '--b',
                'Content-Type: text/html; charset="utf-8"',
                'Content-Transfer-Encoding: base64',
                '',
                encoded,
                '--b--',
            ].join('\r\n');
            expect((emailClient as any).extractHtmlFromSource(source)).toContain('<p>decoded</p>');
        });

        test('decodes quoted-printable using latin-1 safe characters', () => {
            const source = [
                'Content-Type: multipart/alternative; boundary="b"',
                '',
                '--b',
                'Content-Type: text/plain; charset="utf-8"',
                'Content-Transfer-Encoding: quoted-printable',
                '',
                'caf=E9',
                '--b--',
            ].join('\r\n');
            expect((emailClient as any).extractTextFromSource(source)).toContain('caf\u00e9');
        });

        test('returns empty string when the requested content-type is absent', () => {
            const source = [
                'Content-Type: multipart/alternative; boundary="b"',
                '',
                '--b',
                'Content-Type: text/plain; charset="utf-8"',
                '',
                'Only plain text.',
                '--b--',
            ].join('\r\n');
            expect((emailClient as any).extractHtmlFromSource(source)).toBe('');
        });

        test('extracts from a non-multipart single-part source', () => {
            const source = [
                'Content-Type: text/plain; charset="utf-8"',
                'Content-Transfer-Encoding: 7bit',
                '',
                'Single part body.',
            ].join('\r\n');
            expect((emailClient as any).extractTextFromSource(source)).toContain('Single part body.');
        });
    });

    // ─── VALIDATION ──────────────────────────────────────────────────

    describe('Validation', () => {
        test('receive() throws when filters array is empty', async () => {
            await expect(
                emailClient.receive({ filters: [], waitTimeout: 100 })
            ).rejects.toThrow('At least one email filter is required');
        });

        test('receiveAll() throws when filters array is empty', async () => {
            await expect(
                emailClient.receiveAll({ filters: [], waitTimeout: 100 })
            ).rejects.toThrow('At least one email filter is required');
        });
    });

    // ─── RECEIVE() LATEST EMAIL ────────────────────────────────────

    describe('receive() latest email ordering', () => {
        function buildMimeSource(subject: string, date: Date, from: string = 'noreply@example.com'): string {
            return [
                `From: ${from}`,
                `To: fake-receiver@test.com`,
                `Subject: ${subject}`,
                `Date: ${date.toUTCString()}`,
                `Content-Type: text/plain; charset="utf-8"`,
                ``,
                `Body of ${subject}`,
            ].join('\r\n');
        }

        function createAsyncIterable(messages: Array<{ uid: number; source: string }>) {
            return {
                async *[Symbol.asyncIterator]() {
                    for (const msg of messages) {
                        yield { uid: msg.uid, source: Buffer.from(msg.source) };
                    }
                },
            };
        }

        test('receive() returns the most recent email by date when multiple match', async () => {
            const olderDate = new Date('2025-01-10T00:00:00Z');
            const newerDate = new Date('2025-06-15T00:00:00Z');
            const oldestDate = new Date('2024-03-01T00:00:00Z');

            // Search returns 3 UIDs
            mockSearch.mockResolvedValue([1, 2, 3]);

            // Fetch returns 3 emails in non-chronological order (newer, oldest, older)
            mockFetch.mockReturnValue(createAsyncIterable([
                { uid: 1, source: buildMimeSource('OTP Code', newerDate) },
                { uid: 2, source: buildMimeSource('OTP Code', oldestDate) },
                { uid: 3, source: buildMimeSource('OTP Code', olderDate) },
            ]));

            const result = await emailClient.receive({
                filters: [{ type: EmailFilterType.SUBJECT, value: 'OTP Code' }],
                waitTimeout: 5000,
                pollInterval: 100,
            });

            expect(result.subject).toBe('OTP Code');
            expect(result.date.toISOString()).toBe(newerDate.toISOString());
        });

        test('receive() returns correct email when latest is not first in fetch order', async () => {
            const oldDate = new Date('2024-01-01T00:00:00Z');
            const latestDate = new Date('2026-02-20T00:00:00Z');

            mockSearch.mockResolvedValue([10, 20]);

            // Fetch returns older email first, newer email second
            mockFetch.mockReturnValue(createAsyncIterable([
                { uid: 10, source: buildMimeSource('Welcome', oldDate) },
                { uid: 20, source: buildMimeSource('Welcome', latestDate) },
            ]));

            const result = await emailClient.receive({
                filters: [{ type: EmailFilterType.SUBJECT, value: 'Welcome' }],
                waitTimeout: 5000,
                pollInterval: 100,
            });

            expect(result.date.toISOString()).toBe(latestDate.toISOString());
        });

        test('receiveAll() returns all matches without date sorting', async () => {
            const date1 = new Date('2025-06-15T00:00:00Z');
            const date2 = new Date('2024-03-01T00:00:00Z');
            const date3 = new Date('2025-01-10T00:00:00Z');

            mockSearch.mockResolvedValue([1, 2, 3]);

            mockFetch.mockReturnValue(createAsyncIterable([
                { uid: 1, source: buildMimeSource('Alert', date1) },
                { uid: 2, source: buildMimeSource('Alert', date2) },
                { uid: 3, source: buildMimeSource('Alert', date3) },
            ]));

            const results = await emailClient.receiveAll({
                filters: [{ type: EmailFilterType.SUBJECT, value: 'Alert' }],
                waitTimeout: 5000,
                pollInterval: 100,
                expectedCount: 3,
            });

            expect(results).toHaveLength(3);
            // receiveAll preserves fetch order, not sorted by date
            expect(results[0].date.toISOString()).toBe(date1.toISOString());
            expect(results[1].date.toISOString()).toBe(date2.toISOString());
            expect(results[2].date.toISOString()).toBe(date3.toISOString());
        });
    });

    // ─── CREDENTIAL FLEXIBILITY ─────────────────────────────────────

    describe('Credential flexibility', () => {
        test('constructs with smtp-only config', () => {
            const config: EmailClientConfig = {
                smtp: { email: 'sender@test.com', password: 'pass', host: 'smtp.test.com' },
            };
            expect(() => new EmailClient(config)).not.toThrow();
        });

        test('constructs with imap-only config', () => {
            const config: EmailClientConfig = {
                imap: { email: 'receiver@test.com', password: 'pass' },
            };
            expect(() => new EmailClient(config)).not.toThrow();
        });

        test('constructs with both smtp and imap config', () => {
            const config: EmailClientConfig = {
                smtp: { email: 'sender@test.com', password: 'pass', host: 'smtp.test.com' },
                imap: { email: 'receiver@test.com', password: 'pass' },
            };
            expect(() => new EmailClient(config)).not.toThrow();
        });

        test('constructs with legacy flat EmailCredentials', () => {
            expect(() => new EmailClient(dummyCredentials)).not.toThrow();
        });

        test('send() throws "SMTP credentials are required" when smtp is missing', async () => {
            const client = new EmailClient({ imap: { email: 'r@test.com', password: 'p' } });
            await expect(
                client.send({ to: 'someone@test.com', subject: 'Hi', text: 'Hello' })
            ).rejects.toThrow('SMTP credentials are required');
        });

        test('receive() throws "IMAP credentials are required" when imap is missing', async () => {
            const client = new EmailClient({ smtp: { email: 's@test.com', password: 'p', host: 'smtp.test.com' } });
            await expect(
                client.receive({ filters: [{ type: EmailFilterType.SUBJECT, value: 'test' }] })
            ).rejects.toThrow('IMAP credentials are required');
        });

        test('receiveAll() throws "IMAP credentials are required" when imap is missing', async () => {
            const client = new EmailClient({ smtp: { email: 's@test.com', password: 'p', host: 'smtp.test.com' } });
            await expect(
                client.receiveAll({ filters: [{ type: EmailFilterType.SUBJECT, value: 'test' }] })
            ).rejects.toThrow('IMAP credentials are required');
        });

        test('clean() throws "IMAP credentials are required" when imap is missing', async () => {
            const client = new EmailClient({ smtp: { email: 's@test.com', password: 'p', host: 'smtp.test.com' } });
            await expect(client.clean()).rejects.toThrow('IMAP credentials are required');
        });

        test('mark() throws "IMAP credentials are required" when imap is missing', async () => {
            const client = new EmailClient({ smtp: { email: 's@test.com', password: 'p', host: 'smtp.test.com' } });
            await expect(
                client.mark({ action: EmailMarkAction.READ, filters: [{ type: EmailFilterType.SUBJECT, value: 'test' }] })
            ).rejects.toThrow('IMAP credentials are required');
        });
    });
});