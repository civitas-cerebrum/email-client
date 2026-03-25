import { describe, test, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { EmailClient, EmailFilterType, EmailMarkAction } from '../src';

describe('EmailClient Integration Workflows', () => {
    let emailClient: EmailClient;
    const TIMEOUT = 60000
    const POLLING = 5000

    beforeAll(async () => {
        emailClient = await import('../src/fixtures').then(m => m.setupGlobalEmailClient());
    });

    test('should send, receive, and clean a plain text email (Exact Match)', async () => {
        const uniqueSubject = `Test OTP Code ${Date.now()}`;
        const recipient = process.env.RECEIVER_EMAIL!;

        await emailClient.send({
            to: recipient,
            subject: uniqueSubject,
            text: 'Your verification code is 847291.',
        });

        const email = await emailClient.receive({
            filters: [
                { type: EmailFilterType.SUBJECT, value: uniqueSubject },
                { type: EmailFilterType.TO, value: recipient }
            ],
            waitTimeout: TIMEOUT,
            pollInterval: POLLING,
        });

        expect(email.subject).toBe(uniqueSubject);
        expect(email.text).toContain('847291');

        await emailClient.clean({
            filters: [{ type: EmailFilterType.SUBJECT, value: uniqueSubject }]
        });
    });

    test('should successfully send and verify an HTML formatted email', async () => {
        const uniqueSubject = `HTML Content Test ${Date.now()}`;
        const recipient = process.env.RECEIVER_EMAIL!;
        const expectedHtml = '<h1 style="color: blue;">Welcome to Civitas!</h1><p>Your journey begins here.</p>';

        await emailClient.send({
            to: recipient,
            subject: uniqueSubject,
            html: expectedHtml,
        });

        const email = await emailClient.receive({
            filters: [{ type: EmailFilterType.SUBJECT, value: uniqueSubject }],
            waitTimeout: TIMEOUT,
        });

        expect(email.subject).toBe(uniqueSubject);
        expect(email.html).toContain('<h1 style="color: blue;">Welcome to Civitas!</h1>');
        expect(email.text).toMatch(/Welcome to Civitas!/i);

        await emailClient.clean({
            filters: [{ type: EmailFilterType.SUBJECT, value: uniqueSubject }]
        });
    });

    test('should fetch multiple emails using receiveAll', async () => {
        const batchId = `BatchTest-${Date.now()}`;
        const recipient = process.env.RECEIVER_EMAIL!;

        await Promise.all([
            emailClient.send({ to: recipient, subject: `${batchId} - Invoice 1`, text: 'Amount: $10' }),
            emailClient.send({ to: recipient, subject: `${batchId} - Invoice 2`, text: 'Amount: $20' }),
            emailClient.send({ to: recipient, subject: `${batchId} - Invoice 3`, text: 'Amount: $30' })
        ]);

        let emails: any[] = [];
        const startTime = Date.now();

        // Wait up to 45 seconds for all 3 emails to arrive
        while (Date.now() - startTime < (TIMEOUT * 3)) {
            emails = await emailClient.receiveAll({
                filters: [{ type: EmailFilterType.SUBJECT, value: batchId }],
                waitTimeout: TIMEOUT,
                pollInterval: POLLING,
            }).catch(() => []); // Ignore timeouts during the intermediate polling

            if (emails.length >= 3) break;

            // Back off slightly before checking again
            await new Promise(resolve => setTimeout(resolve, 2000));
        }

        expect(emails.length).toBe(3);

        for (const email of emails) {
            expect(email.subject).toContain(batchId);
            expect(email.text).toMatch(/Amount:\s*\$/);
        }

        await emailClient.clean({
            filters: [{ type: EmailFilterType.SUBJECT, value: batchId }]
        });
    });

    test('should match emails using the CONTENT filter', async () => {
        const uniqueSubject = `Content Filter Test ${Date.now()}`;
        const uniqueSecret = `SECRET_KEY_${Date.now()}`;
        const recipient = process.env.RECEIVER_EMAIL!;

        await emailClient.send({
            to: recipient,
            subject: uniqueSubject,
            text: `Please store this key securely: ${uniqueSecret}`,
        });

        const email = await emailClient.receive({
            filters: [
                { type: EmailFilterType.SUBJECT, value: uniqueSubject },
                { type: EmailFilterType.CONTENT, value: uniqueSecret }
            ],
            waitTimeout: TIMEOUT,
        });

        expect(email.text).toContain(uniqueSecret);

        await emailClient.clean({
            filters: [{ type: EmailFilterType.SUBJECT, value: uniqueSubject }]
        });
    });

    test('should throw a timeout error if no email matches the criteria', async () => {
        const impossibleSubject = `This email will never exist ${Date.now()}`;

        await expect(
            emailClient.receive({
                filters: [{ type: EmailFilterType.SUBJECT, value: impossibleSubject }],
                waitTimeout: TIMEOUT,
                pollInterval: POLLING,
            })
        ).rejects.toThrow(new RegExp(`No email matching criteria found within ${TIMEOUT}ms`));
    });

    test('should apply filters client-side to a batch of fetched emails (applyFilters E2E)', async () => {
        const batchId = `ClientFilterTest-${Date.now()}`;
        const recipient = process.env.RECEIVER_EMAIL!;

        await Promise.all([
            emailClient.send({ to: recipient, subject: `${batchId} - Target`, text: 'Apple' }),
            emailClient.send({ to: recipient, subject: `${batchId} - Ignore`, text: 'Banana' }),
        ]);

        const allEmails = await emailClient.receiveAll({
            filters: [{ type: EmailFilterType.SUBJECT, value: batchId }],
            waitTimeout: 45000,
        });

        expect(allEmails.length).toBeGreaterThanOrEqual(2);

        const filtered = emailClient.applyFilters(allEmails, [
            { type: EmailFilterType.CONTENT, value: 'Apple' }
        ]);

        expect(filtered).toHaveLength(1);
        expect(filtered[0].subject).toContain('Target');

        await emailClient.clean({
            filters: [{ type: EmailFilterType.SUBJECT, value: batchId }]
        });
    });

    test('should accurately extract HTML and Text from raw source (extractHtmlFromSource / extractTextFromSource)', async () => {
        const rawEmailSource = [
            'Content-Type: multipart/alternative; boundary="test-boundary-123"',
            '',
            '--test-boundary-123',
            'Content-Type: text/plain; charset="utf-8"',
            '',
            'Fallback text content',
            '--test-boundary-123',
            'Content-Type: text/html; charset="utf-8"',
            '',
            '<div><h1>Title</h1><p>Paragraph</p></div>',
            '--test-boundary-123--'
        ].join('\r\n');

        const extractedHtml = (emailClient as any).extractHtmlFromSource(rawEmailSource);
        expect(extractedHtml).toContain('<h1>Title</h1>');

        const extractedText = (emailClient as any).extractTextFromSource(rawEmailSource);
        expect(extractedText).toContain('Fallback text content');
    });

    test('should successfully apply standard IMAP flags (READ, UNREAD, FLAGGED) using mark()', async () => {
        const uniqueSubject = `Mark Standard Flags Test ${Date.now()}`;
        const recipient = process.env.RECEIVER_EMAIL!;

        await emailClient.send({
            to: recipient,
            subject: uniqueSubject,
            text: 'Testing the standard mark() enumerations.',
        });

        await emailClient.receive({
            filters: [{ type: EmailFilterType.SUBJECT, value: uniqueSubject }],
            waitTimeout: TIMEOUT,
        });

        const filterCriteria = [{ type: EmailFilterType.SUBJECT, value: uniqueSubject }];

        const readCount = await emailClient.mark({
            action: EmailMarkAction.READ,
            filters: filterCriteria
        });
        expect(readCount).toBe(1);

        const unreadCount = await emailClient.mark({
            action: EmailMarkAction.UNREAD,
            filters: filterCriteria
        });
        expect(unreadCount).toBe(1);

        const flaggedCount = await emailClient.mark({
            action: EmailMarkAction.FLAGGED,
            filters: filterCriteria
        });
        expect(flaggedCount).toBe(1);

        await emailClient.clean({ filters: filterCriteria });
    });

    test('should apply custom IMAP string flags using mark()', async () => {
        const uniqueSubject = `Mark Custom Flags Test ${Date.now()}`;
        const recipient = process.env.RECEIVER_EMAIL!;

        await emailClient.send({
            to: recipient,
            subject: uniqueSubject,
            text: 'Testing custom string arrays in the mark method.',
        });

        await emailClient.receive({
            filters: [{ type: EmailFilterType.SUBJECT, value: uniqueSubject }],
            waitTimeout: TIMEOUT,
        });

        const customFlagCount = await emailClient.mark({
            action: ['\\Draft', '\\Answered'],
            filters: [{ type: EmailFilterType.SUBJECT, value: uniqueSubject }]
        });

        expect(customFlagCount).toBe(1);

        await emailClient.clean({
            filters: [{ type: EmailFilterType.SUBJECT, value: uniqueSubject }]
        });
    });

    // ─── SEND() ────────────────────────────────────────────────────────────

    describe('send()', () => {
        test('should load and send HTML content from a local file (htmlFile option)', async () => {
            const uniqueSubject = `HtmlFile Send Test ${Date.now()}`;
            const recipient = process.env.RECEIVER_EMAIL!;

            const tmpFile = path.join(os.tmpdir(), `test-email-${Date.now()}.html`);
            fs.writeFileSync(tmpFile, '<h2>From file</h2><p>Loaded from disk.</p>', 'utf-8');

            try {
                await emailClient.send({
                    to: recipient,
                    subject: uniqueSubject,
                    htmlFile: tmpFile,
                });

                const email = await emailClient.receive({
                    filters: [{ type: EmailFilterType.SUBJECT, value: uniqueSubject }],
                    waitTimeout: TIMEOUT,
                });

                expect(email.html).toContain('From file');
                expect(email.html).toContain('Loaded from disk');
            } finally {
                fs.unlinkSync(tmpFile);
                await emailClient.clean({
                    filters: [{ type: EmailFilterType.SUBJECT, value: uniqueSubject }],
                });
            }
        });

        test('should throw if the htmlFile path does not exist', async () => {
            await expect(
                emailClient.send({
                    to: process.env.RECEIVER_EMAIL!,
                    subject: 'Should not send',
                    htmlFile: '/tmp/this-file-does-not-exist-at-all.html',
                })
            ).rejects.toThrow(/HTML file not found/);
        });
    });

    // ─── RECEIVEALL() TIMEOUT ──────────────────────────────────────────────

    describe('receiveAll()', () => {
        test('should throw a timeout error when no emails match within the deadline', async () => {
            const impossibleSubject = `receiveAll-never-exists-${Date.now()}`;

            await expect(
                emailClient.receiveAll({
                    filters: [{ type: EmailFilterType.SUBJECT, value: impossibleSubject }],
                    waitTimeout: TIMEOUT,
                    pollInterval: POLLING,
                })
            ).rejects.toThrow(new RegExp(`No email matching criteria found within ${TIMEOUT}ms`));
        });
    });

    // ─── FILTER VALIDATION ─────────────────────────────────────────────────

    describe('receive() / receiveAll() — filter validation', () => {
        test('should throw when no filters are supplied to receive()', async () => {
            await expect(
                emailClient.receive({
                    filters: [],
                    waitTimeout: 3000,
                })
            ).rejects.toThrow(/At least one email filter is required/);
        });

        test('should throw when no filters are supplied to receiveAll()', async () => {
            await expect(
                emailClient.receiveAll({
                    filters: [],
                    waitTimeout: 3000,
                })
            ).rejects.toThrow(/At least one email filter is required/);
        });
    });

    // ─── CLEAN() ───────────────────────────────────────────────────────────

    describe('clean()', () => {
        test('should return 0 when no emails match the filter criteria', async () => {
            const deletedCount = await emailClient.clean({
                filters: [{ type: EmailFilterType.SUBJECT, value: `no-such-email-${Date.now()}` }],
            });

            expect(deletedCount).toBe(0);
        });

        test('should throw when the specified folder does not exist on the server', async () => {
            await expect(
                emailClient.clean({
                    filters: [{ type: EmailFilterType.SUBJECT, value: `folder-test-${Date.now()}` }],
                    folder: 'Trash',
                })
            ).rejects.toThrow(/Failed to open folder "Trash"/i); // FIX 1: Updated regex to match the new robust error wrapper
        });

        test('should delete ALL emails in INBOX when called with no options', async () => {
            const batchId = `CleanAll-${Date.now()}`;
            const recipient = process.env.RECEIVER_EMAIL!;

            await Promise.all([
                emailClient.send({ to: recipient, subject: `${batchId} - A`, text: 'a' }),
                emailClient.send({ to: recipient, subject: `${batchId} - B`, text: 'b' }),
            ]);

            await emailClient.receiveAll({
                filters: [{ type: EmailFilterType.SUBJECT, value: batchId }],
                waitTimeout: 45000,
            });

            const deletedCount = await emailClient.clean();
            expect(deletedCount).toBeGreaterThanOrEqual(2);
        });
    });

    // ─── MARK() ────────────────────────────────────────────────────────────

    describe('mark() — UNFLAGGED, ARCHIVED, and error cases', () => {
        test('should mark an email as UNFLAGGED', async () => {
            const uniqueSubject = `Mark UNFLAGGED Test ${Date.now()}`;
            const recipient = process.env.RECEIVER_EMAIL!;

            await emailClient.send({ to: recipient, subject: uniqueSubject, text: 'unflagged test' });
            await emailClient.receive({
                filters: [{ type: EmailFilterType.SUBJECT, value: uniqueSubject }],
                waitTimeout: TIMEOUT,
            });

            const filterCriteria = [{ type: EmailFilterType.SUBJECT, value: uniqueSubject }];

            await emailClient.mark({ action: EmailMarkAction.FLAGGED, filters: filterCriteria });

            const count = await emailClient.mark({
                action: EmailMarkAction.UNFLAGGED,
                filters: filterCriteria,
            });

            expect(count).toBe(1);

            await emailClient.clean({ filters: filterCriteria });
        });

        test('should archive an email by moving it to the archive folder', async () => {
            const uniqueSubject = `Mark ARCHIVED Test ${Date.now()}`;
            const recipient = process.env.RECEIVER_EMAIL!;

            // FIX 2: Using a known localized Gmail folder string
            const testArchiveFolder = '[Gmail]/Taslaklar';

            await emailClient.send({ to: recipient, subject: uniqueSubject, text: 'archive test' });
            await emailClient.receive({
                filters: [{ type: EmailFilterType.SUBJECT, value: uniqueSubject }],
                waitTimeout: TIMEOUT,
            });

            const count = await emailClient.mark({
                action: EmailMarkAction.ARCHIVED,
                filters: [{ type: EmailFilterType.SUBJECT, value: uniqueSubject }],
                archiveFolder: testArchiveFolder,
            });

            expect(count).toBe(1);

            await emailClient.clean({
                filters: [{ type: EmailFilterType.SUBJECT, value: uniqueSubject }],
                folder: testArchiveFolder, // Make sure we clean up the right folder!
            });
        });

        test('should throw for an unsupported mark action string', async () => {
            const uniqueSubject = `Mark Bad Action Test ${Date.now()}`;
            const recipient = process.env.RECEIVER_EMAIL!;

            await emailClient.send({ to: recipient, subject: uniqueSubject, text: 'bad action' });

            // FIX 3: Added try/finally block so clean() always fires even if the assertion fails
            try {
                await emailClient.receive({
                    filters: [{ type: EmailFilterType.SUBJECT, value: uniqueSubject }],
                    waitTimeout: TIMEOUT,
                });

                await expect(
                    emailClient.mark({
                        action: 'NONEXISTENT_ACTION' as unknown as EmailMarkAction,
                        filters: [{ type: EmailFilterType.SUBJECT, value: uniqueSubject }],
                    })
                ).rejects.toThrow(/Unsupported mark action/);
            } finally {
                await emailClient.clean({
                    filters: [{ type: EmailFilterType.SUBJECT, value: uniqueSubject }],
                });
            }
        });

        test('should return 0 when mark() finds no matching emails', async () => {
            const count = await emailClient.mark({
                action: EmailMarkAction.READ,
                filters: [{ type: EmailFilterType.SUBJECT, value: `no-such-email-${Date.now()}` }],
            });

            expect(count).toBe(0);
        });
    });

    // ─── APPLYFILTERS() ────────────────────────────────────────────────────

    describe('applyFilters()', () => {
        test('should return all candidates when the filters array is empty', () => {
            const candidates = [
                { subject: 'a', from: '', to: '', html: '', text: 'alpha', date: new Date(), filePath: '' },
                { subject: 'b', from: '', to: '', html: '', text: 'beta', date: new Date(), filePath: '' },
            ];

            const result = (emailClient as any).applyFilters(candidates, []);
            expect(result).toHaveLength(2);
        });

        test('should return an empty array when no candidates match', () => {
            const candidates = [
                { subject: 'hello', from: '', to: '', html: '', text: 'world', date: new Date(), filePath: '' },
            ];

            const result = (emailClient as any).applyFilters(candidates, [
                { type: EmailFilterType.CONTENT, value: 'will-never-match-xyz' },
            ]);

            expect(result).toHaveLength(0);
        });

        test('should ignore SINCE filters during client-side applyFilters', () => {
            const candidates = [
                { subject: 'test', from: '', to: '', html: '', text: 'some content', date: new Date(), filePath: '' },
            ];

            const result = (emailClient as any).applyFilters(candidates, [
                { type: EmailFilterType.SINCE, value: new Date('2099-01-01') },
            ]);

            expect(result).toHaveLength(1);
        });

        test('should fall back to partial case-insensitive match when no exact match exists', () => {
            const candidates = [
                { subject: 'Hello World', from: '', to: '', html: '', text: '', date: new Date(), filePath: '' },
                { subject: 'Goodbye', from: '', to: '', html: '', text: '', date: new Date(), filePath: '' },
            ];

            const result = (emailClient as any).applyFilters(candidates, [
                { type: EmailFilterType.SUBJECT, value: 'hello world' },
            ]);

            expect(result).toHaveLength(1);
            expect(result[0].subject).toBe('Hello World');
        });
    });

    // ─── EXTRACT*FROMSOURCE() ──────────────────────────────────────────────

    describe('extractHtmlFromSource() / extractTextFromSource() — edge cases', () => {
        test('should return empty string for an empty source', () => {
            expect((emailClient as any).extractHtmlFromSource('')).toBe('');
            expect((emailClient as any).extractTextFromSource('')).toBe('');
        });

        test('should decode base64-encoded MIME part content', () => {
            const htmlContent = '<p>base64 decoded content</p>';
            const encoded = Buffer.from(htmlContent).toString('base64');

            const rawEmailSource = [
                'Content-Type: multipart/alternative; boundary="b64-boundary"',
                '',
                '--b64-boundary',
                'Content-Type: text/html; charset="utf-8"',
                'Content-Transfer-Encoding: base64',
                '',
                encoded,
                '--b64-boundary--',
            ].join('\r\n');

            const result = (emailClient as any).extractHtmlFromSource(rawEmailSource);
            expect(result).toContain('base64 decoded content');
        });

        test('should decode quoted-printable encoded MIME part content', () => {
            const qpEncoded = 'caf=E9 from quoted-printable';

            const rawEmailSource = [
                'Content-Type: multipart/alternative; boundary="qp-boundary"',
                '',
                '--qp-boundary',
                'Content-Type: text/plain; charset="utf-8"',
                'Content-Transfer-Encoding: quoted-printable',
                '',
                qpEncoded,
                '--qp-boundary--',
            ].join('\r\n');

            const result = (emailClient as any).extractTextFromSource(rawEmailSource);
            expect(result).toContain('caf\u00e9 from quoted-printable');
        });

        test('should return empty string when the requested content-type is absent', () => {
            const rawEmailSource = [
                'Content-Type: multipart/alternative; boundary="plain-only-boundary"',
                '',
                '--plain-only-boundary',
                'Content-Type: text/plain; charset="utf-8"',
                '',
                'Only plain text here.',
                '--plain-only-boundary--',
            ].join('\r\n');

            const result = (emailClient as any).extractHtmlFromSource(rawEmailSource);
            expect(result).toBe('');
        });

        test('should extract content from a non-multipart single-part MIME source', () => {
            const rawSinglePart = [
                'Content-Type: text/plain; charset="utf-8"',
                'Content-Transfer-Encoding: 7bit',
                '',
                'Single part plain text.',
            ].join('\r\n');

            const result = (emailClient as any).extractTextFromSource(rawSinglePart);
            expect(result).toContain('Single part plain text.');
        });
    });

    // ─── BUILDSEARCHCRITERIA() ─────────────────────────────────────────────

    describe('buildSearchCriteria() — unknown filter type', () => {
        test('should throw for an unrecognised EmailFilterType', () => {
            expect(() =>
                (emailClient as any).buildSearchCriteria([
                    { type: 'UNKNOWN_TYPE', value: 'something' },
                ])
            ).toThrow(/Unknown email filter type/);
        });
    });
});