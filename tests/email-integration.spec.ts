import { test, expect } from './fixtures';
import { EmailFilterType } from '../src';

test.describe('EmailClient Integration Workflows', () => {

    test('should send, receive, and clean a plain text email (Exact Match)', async ({ emailClient }) => {
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

    test('should successfully send and verify an HTML formatted email', async ({ emailClient }) => {
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

    test('should fetch multiple emails using receiveAll', async ({ emailClient }) => {
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

    test('should match emails using the CONTENT filter', async ({ emailClient }) => {
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

    test('should throw a timeout error if no email matches the criteria', async ({ emailClient }) => {
        const impossibleSubject = `This email will never exist ${Date.now()}`;

        await expect(
            emailClient.receive({
                filters: [{ type: EmailFilterType.SUBJECT, value: impossibleSubject }],
                waitTimeout: 5000,
                pollInterval: 1000,
            })
        ).rejects.toThrow(/No email matching criteria found within 5000ms/);
    });
});
