import { test, expect } from '@playwright/test';
import { EmailClient } from '../src/EmailClient';
import { EmailFilterType, EmailCredentials } from '../src/types';

const hasSecrets = !!(process.env.SENDER_EMAIL && process.env.SENDER_PASSWORD && process.env.SENDER_SMTP_HOST && process.env.RECEIVER_EMAIL && process.env.RECEIVER_PASSWORD);

const credentials: EmailCredentials = {
    senderEmail: process.env.SENDER_EMAIL ?? '',
    senderPassword: process.env.SENDER_PASSWORD ?? '',
    senderSmtpHost: process.env.SENDER_SMTP_HOST ?? '',
    receiverEmail: process.env.RECEIVER_EMAIL ?? '',
    receiverPassword: process.env.RECEIVER_PASSWORD ?? '',
};

test.describe('Integration — real SMTP/IMAP', () => {
    test.skip(!hasSecrets, 'Skipping integration tests — email secrets not configured');

    let client: EmailClient;
    const uniqueSubject = `Integration Test ${Date.now()}`;

    test.beforeAll(() => {
        client = new EmailClient(credentials);
    });

    test('send and receive an email', async () => {
        await client.send({
            to: credentials.receiverEmail,
            subject: uniqueSubject,
            text: 'Integration test body',
        });

        const email = await client.receive({
            filters: [{ type: EmailFilterType.SUBJECT, value: uniqueSubject }],
            waitTimeout: 60000,
            pollInterval: 5000,
        });

        expect(email.subject).toBe(uniqueSubject);
        expect(email.filePath).toBeTruthy();
    });

    test('receiveAll returns the sent email', async () => {
        const emails = await client.receiveAll({
            filters: [{ type: EmailFilterType.SUBJECT, value: uniqueSubject }],
            waitTimeout: 30000,
            pollInterval: 5000,
        });

        expect(emails.length).toBeGreaterThanOrEqual(1);
        expect(emails.some(e => e.subject === uniqueSubject)).toBe(true);
    });

    test('clean deletes the test email', async () => {
        const deleted = await client.clean({
            filters: [{ type: EmailFilterType.SUBJECT, value: uniqueSubject }],
        });

        expect(deleted).toBeGreaterThanOrEqual(1);
    });
});
