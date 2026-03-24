import { describe, test, expect, beforeEach } from 'vitest';
import { EmailFilterType, EmailFilter, EmailCredentials, ReceivedEmail } from '../src/types';
import { EmailClient } from '../src/EmailClient';
import { generateApiCoverage } from '../src/index'

const dummyCredentials: EmailCredentials = {
    senderEmail: 'sender@test.com',
    senderPassword: 'pass',
    senderSmtpHost: 'smtp.test.com',
    receiverEmail: 'receiver@test.com',
    receiverPassword: 'pass',
};

function makeEmail(overrides: Partial<ReceivedEmail> = {}): ReceivedEmail {
    return {
        filePath: '/tmp/test.html',
        subject: 'Your OTP Code',
        from: 'noreply@example.com',
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
    });

    // ─── NEW UNIT TESTS: send & clean ────────────────────────────────

    describe('send() logic', () => {

        test('should throw an error if recipient "to" is missing', async () => {
            await expect(
                emailClient.send({ subject: 'Test', text: 'Hello' } as any)
            ).rejects.toThrow();
        });

        test('should throw an error if "subject" is missing', async () => {
            await expect(
                emailClient.send({ to: 'test@example.com', text: 'Hello' } as any)
            ).rejects.toThrow();
        });

        test('should successfully resolve when valid parameters are provided', async () => {
            const testClient = await import('../src/fixtures').then(m => m.createTestClientWithCredentials());

            await expect(
                testClient.send({ to: 'test@example.com', subject: 'Test', text: 'Hello' })
            ).resolves.not.toThrow();
        });
    });

    describe('clean() logic', () => {
        test('should successfully resolve when called with no filters (clean all)', async () => {
            const testClient = await import('../src/fixtures').then(m => m.createTestClientWithCredentials());

            // Mock internal IMAP client to avoid real operations
            (testClient as any).imapClient = { deleteMessages: async () => true, connect: async () => { }, logout: async () => { } };

            await expect(testClient.clean()).resolves.not.toThrow();
        });

        test('should successfully resolve when called with specific filters', async () => {
            const testClient = await import('../src/fixtures').then(m => m.createTestClientWithCredentials());

            // Mock internal IMAP client to avoid real operations
            (testClient as any).imapClient = { deleteMessages: async () => true, connect: async () => { }, logout: async () => { } };

            await expect(
                testClient.clean({
                    filters: [{ type: EmailFilterType.SUBJECT, value: 'Old Test' }]
                })
            ).resolves.not.toThrow();
        });
    });

    // ─── EXISTING UNIT TESTS: Filter Logic ───────────────────────────

    describe('applyFilters() logic', () => {
        test('SUBJECT filter — exact match', () => {
            const candidates = [
                makeEmail({ subject: 'Your OTP Code' }),
                makeEmail({ subject: 'Welcome aboard' }),
            ];
            const filters: EmailFilter[] = [{ type: EmailFilterType.SUBJECT, value: 'Your OTP Code' }];
            const result = emailClient.applyFilters(candidates, filters);
            expect(result).toHaveLength(1);
            expect(result[0].subject).toBe('Your OTP Code');
        });

        test('FROM filter — exact match', () => {
            const candidates = [
                makeEmail({ from: 'noreply@example.com' }),
                makeEmail({ from: 'support@example.com' }),
            ];
            const filters: EmailFilter[] = [{ type: EmailFilterType.FROM, value: 'noreply@example.com' }];
            const result = emailClient.applyFilters(candidates, filters);
            expect(result).toHaveLength(1);
            expect(result[0].from).toBe('noreply@example.com');
        });

        test('CONTENT filter — exact match on HTML body', () => {
            const candidates = [
                makeEmail({ html: '<p>Your verification code is 999</p>' }),
                makeEmail({ html: '<p>Welcome to our service</p>' }),
            ];
            const filters: EmailFilter[] = [{ type: EmailFilterType.CONTENT, value: '<p>Your verification code is 999</p>' }];
            const result = emailClient.applyFilters(candidates, filters);
            expect(result).toHaveLength(1);
            expect(result[0].html).toContain('999');
        });

        test('CONTENT filter — falls back to plain text when no HTML', () => {
            const candidates = [
                makeEmail({ html: '', text: 'Plain text OTP: 5678' }),
                makeEmail({ html: '', text: 'Welcome email' }),
            ];
            const filters: EmailFilter[] = [{ type: EmailFilterType.CONTENT, value: 'Plain text OTP: 5678' }];
            const result = emailClient.applyFilters(candidates, filters);
            expect(result).toHaveLength(1);
            expect(result[0].text).toContain('5678');
        });

        test('Multiple filters — SUBJECT + FROM exact match (AND logic)', () => {
            const candidates = [
                makeEmail({ subject: 'OTP', from: 'noreply@example.com' }),
                makeEmail({ subject: 'OTP', from: 'support@example.com' }),
                makeEmail({ subject: 'Welcome', from: 'noreply@example.com' }),
            ];
            const filters: EmailFilter[] = [
                { type: EmailFilterType.SUBJECT, value: 'OTP' },
                { type: EmailFilterType.FROM, value: 'noreply@example.com' },
            ];
            const result = emailClient.applyFilters(candidates, filters);
            expect(result).toHaveLength(1);
            expect(result[0].subject).toBe('OTP');
            expect(result[0].from).toBe('noreply@example.com');
        });

        test('Three filters — SUBJECT + FROM + CONTENT exact match', () => {
            const candidates = [
                makeEmail({ subject: 'OTP', from: 'noreply@example.com', html: '<p>Code: 123</p>' }),
                makeEmail({ subject: 'OTP', from: 'noreply@example.com', html: '<p>Code: 456</p>' }),
            ];
            const filters: EmailFilter[] = [
                { type: EmailFilterType.SUBJECT, value: 'OTP' },
                { type: EmailFilterType.FROM, value: 'noreply@example.com' },
                { type: EmailFilterType.CONTENT, value: '<p>Code: 456</p>' },
            ];
            const result = emailClient.applyFilters(candidates, filters);
            expect(result).toHaveLength(1);
            expect(result[0].html).toContain('456');
        });

        test('SUBJECT filter — falls back to partial case-insensitive match', () => {
            const candidates = [
                makeEmail({ subject: 'Your OTP Code - Action Required' }),
                makeEmail({ subject: 'Welcome aboard' }),
            ];
            const filters: EmailFilter[] = [{ type: EmailFilterType.SUBJECT, value: 'otp code' }];
            const result = emailClient.applyFilters(candidates, filters);
            expect(result).toHaveLength(1);
            expect(result[0].subject).toBe('Your OTP Code - Action Required');
        });

        test('FROM filter — falls back to partial case-insensitive match', () => {
            const candidates = [
                makeEmail({ from: 'NoReply@Example.COM' }),
                makeEmail({ from: 'support@other.com' }),
            ];
            const filters: EmailFilter[] = [{ type: EmailFilterType.FROM, value: 'noreply@example.com' }];
            const result = emailClient.applyFilters(candidates, filters);
            expect(result).toHaveLength(1);
            expect(result[0].from).toBe('NoReply@Example.COM');
        });

        test('CONTENT filter — falls back to partial case-insensitive match', () => {
            const candidates = [
                makeEmail({ html: '<h1>Your Verification Code is ABC123</h1>' }),
                makeEmail({ html: '<p>Newsletter</p>' }),
            ];
            const filters: EmailFilter[] = [{ type: EmailFilterType.CONTENT, value: 'verification code' }];
            const result = emailClient.applyFilters(candidates, filters);
            expect(result).toHaveLength(1);
            expect(result[0].html).toContain('ABC123');
        });

        test('Combined filters — partial fallback applies to all filters together', () => {
            const candidates = [
                makeEmail({ subject: 'Your OTP Code', from: 'NoReply@Example.COM' }),
            ];
            const filters: EmailFilter[] = [
                { type: EmailFilterType.SUBJECT, value: 'otp' },
                { type: EmailFilterType.FROM, value: 'noreply' },
            ];
            const result = emailClient.applyFilters(candidates, filters);
            expect(result).toHaveLength(1);
        });

        test('Exact match is preferred over partial match', () => {
            const candidates = [
                makeEmail({ subject: 'OTP Code' }),
                makeEmail({ subject: 'OTP' }),
                makeEmail({ subject: 'Your OTP is ready' }),
            ];
            const filters: EmailFilter[] = [{ type: EmailFilterType.SUBJECT, value: 'OTP' }];
            const result = emailClient.applyFilters(candidates, filters);
            expect(result).toHaveLength(1);
            expect(result[0].subject).toBe('OTP');
        });

        test('SINCE filter is excluded from client-side matching', () => {
            const candidates = [makeEmail({ subject: 'Test Email' })];
            const filters: EmailFilter[] = [
                { type: EmailFilterType.SINCE, value: new Date('2025-01-01') },
            ];
            const result = emailClient.applyFilters(candidates, filters);
            expect(result).toHaveLength(1);
        });

        test('SINCE combined with string filters works correctly', () => {
            const candidates = [
                makeEmail({ subject: 'Match' }),
                makeEmail({ subject: 'No Match' }),
            ];
            const filters: EmailFilter[] = [
                { type: EmailFilterType.SINCE, value: new Date('2025-01-01') },
                { type: EmailFilterType.SUBJECT, value: 'Match' },
            ];
            const result = emailClient.applyFilters(candidates, filters);
            expect(result).toHaveLength(1);
            expect(result[0].subject).toBe('Match');
        });

        test('No candidates — returns empty array', () => {
            const filters: EmailFilter[] = [{ type: EmailFilterType.SUBJECT, value: 'Anything' }];
            const result = emailClient.applyFilters([], filters);
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
            const filters: EmailFilter[] = [{ type: EmailFilterType.SUBJECT, value: 'OTP Code' }];
            const result = emailClient.applyFilters(candidates, filters);
            expect(result).toHaveLength(0);
        });

        test('Combined filters — one filter matches but the other does not — returns empty', () => {
            const candidates = [
                makeEmail({ subject: 'OTP', from: 'support@other.com' }),
            ];
            const filters: EmailFilter[] = [
                { type: EmailFilterType.SUBJECT, value: 'OTP' },
                { type: EmailFilterType.FROM, value: 'noreply@example.com' },
            ];
            const result = emailClient.applyFilters(candidates, filters);
            expect(result).toHaveLength(0);
        });

        test('CONTENT filter — no match in HTML or text — returns empty', () => {
            const candidates = [
                makeEmail({ html: '<p>Hello world</p>', text: 'Hello world' }),
            ];
            const filters: EmailFilter[] = [{ type: EmailFilterType.CONTENT, value: 'verification code' }];
            const result = emailClient.applyFilters(candidates, filters);
            expect(result).toHaveLength(0);
        });

        test('Partial match on one filter but not the other — returns empty', () => {
            const candidates = [
                makeEmail({ subject: 'Your OTP Code', from: 'totally-different@xyz.com' }),
            ];
            const filters: EmailFilter[] = [
                { type: EmailFilterType.SUBJECT, value: 'otp' },
                { type: EmailFilterType.FROM, value: 'noreply@example.com' },
            ];
            const result = emailClient.applyFilters(candidates, filters);
            expect(result).toHaveLength(0);
        });

        test('Multiple candidates match — all are returned', () => {
            const candidates = [
                makeEmail({ subject: 'OTP Code', from: 'noreply@example.com' }),
                makeEmail({ subject: 'OTP Code', from: 'noreply@example.com' }),
                makeEmail({ subject: 'Welcome', from: 'support@example.com' }),
            ];
            const filters: EmailFilter[] = [{ type: EmailFilterType.SUBJECT, value: 'OTP Code' }];
            const result = emailClient.applyFilters(candidates, filters);
            expect(result).toHaveLength(2);
        });
    });

    // ─── EXISTING UNIT TESTS: Validation ─────────────────────────────

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
});