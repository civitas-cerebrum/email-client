import { test as base } from '@playwright/test';
import { EmailClient } from './EmailClient';
import { EmailCredentials } from './types';
import * as dotenv from 'dotenv';

// Load .env for local testing; in CI the vars come from GitHub Actions secrets
dotenv.config();

function isEmailConfigured(): boolean {
    return !!(
        process.env.SENDER_EMAIL &&
        process.env.SENDER_PASSWORD &&
        process.env.SENDER_SMTP_HOST &&
        process.env.RECEIVER_EMAIL &&
        process.env.RECEIVER_PASSWORD
    );
}

type EmailFixtures = {
    emailClient: EmailClient;
};

export const test = base.extend<EmailFixtures>({
    emailClient: async ({}, use, testInfo) => {
        if (!isEmailConfigured()) {
            testInfo.skip(true, 'Email environment variables are not configured');
        }
        const credentials: EmailCredentials = {
            senderEmail: process.env.SENDER_EMAIL!,
            senderPassword: process.env.SENDER_PASSWORD!,
            senderSmtpHost: process.env.SENDER_SMTP_HOST!,
            receiverEmail: process.env.RECEIVER_EMAIL!,
            receiverPassword: process.env.RECEIVER_PASSWORD!,
        };
        const client = new EmailClient(credentials);
        await use(client);
    },
});

export { expect } from '@playwright/test';
