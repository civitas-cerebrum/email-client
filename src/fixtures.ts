import { describe, test, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { EmailClient } from './EmailClient';
import { EmailCredentials } from './types';
import * as dotenv from 'dotenv';

// Load .env for local testing; in CI the vars come from GitHub Actions secrets
dotenv.config();

type EmailFixtures = {
    emailClient: EmailClient;
};

// Export test info for skipping logic
export function testInfo(skip: boolean, reason: string): void {
    if (skip) {
        throw new Error(`Test skipped: ${reason}`);
    }
}

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

// Create a test client with real credentials (for tests that need to actually send/receive)
export function createTestClientWithCredentials() {
    const senderEmail = process.env.SENDER_EMAIL;
    const senderPassword = process.env.SENDER_PASSWORD;
    const senderSmtpHost = process.env.SENDER_SMTP_HOST;
    const receiverEmail = process.env.RECEIVER_EMAIL;
    const receiverPassword = process.env.RECEIVER_PASSWORD;

    // Validate credentials
    if (!senderEmail || !senderPassword || !senderSmtpHost || !receiverEmail || !receiverPassword) {
        throw new Error(
            'Email credentials not configured. Required environment variables: ' +
            'SENDER_EMAIL, SENDER_PASSWORD, SENDER_SMTP_HOST, RECEIVER_EMAIL, RECEIVER_PASSWORD'
        );
    }

    return new EmailClient({
        senderEmail,
        senderPassword,
        senderSmtpHost,
        receiverEmail,
        receiverPassword,
    });
}

// Global fixture setup for emailClient (used by tests that need real email operations)
export let globalEmailClient: EmailClient | null = null;

export async function setupGlobalEmailClient(): Promise<EmailClient> {
    const senderEmail = process.env.SENDER_EMAIL;
    const senderPassword = process.env.SENDER_PASSWORD;
    const senderSmtpHost = process.env.SENDER_SMTP_HOST;
    const receiverEmail = process.env.RECEIVER_EMAIL;
    const receiverPassword = process.env.RECEIVER_PASSWORD;

    // Validate that all required credentials are configured
    if (!senderEmail || !senderPassword || !senderSmtpHost || !receiverEmail || !receiverPassword) {
        throw new Error(
            'Email credentials not configured. Required environment variables: ' +
            'SENDER_EMAIL, SENDER_PASSWORD, SENDER_SMTP_HOST, RECEIVER_EMAIL, RECEIVER_PASSWORD'
        );
    }

    globalEmailClient = new EmailClient({
        senderEmail,
        senderPassword,
        senderSmtpHost,
        receiverEmail,
        receiverPassword,
    });
    return globalEmailClient;
}

export function getGlobalEmailClient(): EmailClient {
    if (!globalEmailClient) {
        throw new Error('Global email client not initialized');
    }
    return globalEmailClient;
}