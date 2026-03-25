import { describe, test, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { EmailClient } from './EmailClient.js';
import { EmailCredentials } from './types.js';
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

// Helper to validate and retrieve environment variables
function getValidatedCredentials() {
    const requiredVars = [
        'SENDER_EMAIL',
        'SENDER_PASSWORD',
        'SENDER_SMTP_HOST',
        'RECEIVER_EMAIL',
        'RECEIVER_PASSWORD'
    ];

    // Filter out the variables that are missing or empty
    const missingVars = requiredVars.filter(envVar => !process.env[envVar]);

    if (missingVars.length > 0) {
        throw new Error(
            `Email credentials not configured. Missing required environment variables: ${missingVars.join(', ')}`
        );
    }

    return {
        senderEmail: process.env.SENDER_EMAIL as string,
        senderPassword: process.env.SENDER_PASSWORD as string,
        senderSmtpHost: process.env.SENDER_SMTP_HOST as string,
        receiverEmail: process.env.RECEIVER_EMAIL as string,
        receiverPassword: process.env.RECEIVER_PASSWORD as string,
    };
}

// Create a test client with real credentials (for tests that need to actually send/receive)
export function createTestClientWithCredentials() {
    const credentials = getValidatedCredentials();
    return new EmailClient(credentials);
}

// Global fixture setup for emailClient (used by tests that need real email operations)
export let globalEmailClient: EmailClient | null = null;

export async function setupGlobalEmailClient(): Promise<EmailClient> {
    const credentials = getValidatedCredentials();
    globalEmailClient = new EmailClient(credentials);
    return globalEmailClient;
}

export function getGlobalEmailClient(): EmailClient {
    if (!globalEmailClient) {
        throw new Error('Global email client not initialized');
    }
    return globalEmailClient;
}