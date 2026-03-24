import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
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

// Test context that can be used by test files
export function createEmailClientFixture() {
    const emailClient = new EmailClient({
        senderEmail: 'sender@test.com',
        senderPassword: 'pass',
        senderSmtpHost: 'smtp.test.com',
        receiverEmail: 'receiver@test.com',
        receiverPassword: 'pass',
    });
    return emailClient;
}

// Export test utilities that match Playwright's API
export const test = {
    describe,
    it: test,
    expect,
};

// Export test info for skipping logic
export function testInfo(skip: boolean, reason: string): void {
    if (skip) {
        throw new Error(`Test skipped: ${reason}`);
    }
}