import { describe, test, expect, beforeAll } from 'vitest';
import { EmailClient, EmailFilterType } from '../src';

describe('EmailClient Integration Workflows', () => {
    let emailClient: EmailClient;

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
            waitTimeout: 30000,
            pollInterval: 500,
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
            waitTimeout: 30000,
        });

        expect(email.subject).toBe(uniqueSubject);
        expect(email.html).toContain('<h1 style="color: blue;">Welcome to Civitas!</h1>');
        expect(email.text).toMatch(/Welcome to Civitas!/i);

        await emailClient.clean({
            filters: [{ type: EmailFilterType.SUBJECT, value: uniqueSubject }]
        });
    });

    test.skip('should fetch multiple emails using receiveAll', async () => {
        // Skipping - receives multiple emails takes >10s, runs as integration test on publish pipeline
        const batchId = `BatchTest-${Date.now()}`;
        const recipient = process.env.RECEIVER_EMAIL!;

        await Promise.all([
            emailClient.send({ to: recipient, subject: `${batchId} - Invoice 1`, text: 'Amount: $10' }),
            emailClient.send({ to: recipient, subject: `${batchId} - Invoice 2`, text: 'Amount: $20' }),
            emailClient.send({ to: recipient, subject: `${batchId} - Invoice 3`, text: 'Amount: $30' })
        ]);

        const emails = await emailClient.receiveAll({
            filters: [{ type: EmailFilterType.SUBJECT, value: batchId }],
            waitTimeout: 45000,
            pollInterval: 5000,
        });

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
            waitTimeout: 30000,
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
                waitTimeout: 5000,
                pollInterval: 1000,
            })
        ).rejects.toThrow(/No email matching criteria found within 5000ms/);
    });

    // ─── NEW E2E TESTS ───────────────────────────────────────────────

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
        // Craft a raw multipart MIME string to simulate what the IMAP client actually fetches.
        // This ensures we hit the boundary matching and content extraction logic.
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

        // Pass the raw string instead of the parsed email object
        const extractedHtml = (emailClient as any).extractHtmlFromSource(rawEmailSource);
        expect(extractedHtml).toContain('<h1>Title</h1>');

        const extractedText = (emailClient as any).extractTextFromSource(rawEmailSource);
        expect(extractedText).toContain('Fallback text content');
    });
});