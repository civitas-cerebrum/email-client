import { describe, test, expect, beforeEach } from 'vitest';
import { EmailClient } from '../src/EmailClient';
import { EmailCredentials } from '../src/types';

const dummyCredentials: EmailCredentials = {
    senderEmail: 'sender@test.com',
    senderPassword: 'pass',
    senderSmtpHost: 'smtp.test.com',
    receiverEmail: 'receiver@test.com',
    receiverPassword: 'pass',
};

describe('MIME Parsing', () => {
    let client: EmailClient;

    beforeEach(() => {
        client = new EmailClient(dummyCredentials);
    });

    test('extracts HTML from simple MIME source', () => {
        const source = [
            'Content-Type: text/html; charset=utf-8',
            '',
            '<h1>Hello World</h1>',
        ].join('\r\n');

        expect(client.extractHtmlFromSource(source)).toBe('<h1>Hello World</h1>');
    });

    test('extracts plain text from MIME source', () => {
        const source = [
            'Content-Type: text/plain; charset=utf-8',
            '',
            'Hello World',
        ].join('\r\n');

        expect(client.extractTextFromSource(source)).toBe('Hello World');
    });

    test('returns empty string when no HTML content type', () => {
        const source = [
            'Content-Type: text/plain; charset=utf-8',
            '',
            'Just plain text',
        ].join('\r\n');

        expect(client.extractHtmlFromSource(source)).toBe('');
    });

    test('returns empty string when no plain text content type', () => {
        const source = [
            'Content-Type: text/html; charset=utf-8',
            '',
            '<p>HTML only</p>',
        ].join('\r\n');

        expect(client.extractTextFromSource(source)).toBe('');
    });

    test('handles multipart MIME with boundary — extracts HTML part', () => {
        const source = [
            'Content-Type: multipart/alternative; boundary="boundary123"',
            '',
            '--boundary123',
            'Content-Type: text/plain; charset=utf-8',
            '',
            'Plain text version',
            '--boundary123',
            'Content-Type: text/html; charset=utf-8',
            '',
            '<h1>HTML version</h1>',
            '--boundary123--',
        ].join('\r\n');

        expect(client.extractHtmlFromSource(source)).toBe('<h1>HTML version</h1>');
        expect(client.extractTextFromSource(source)).toBe('Plain text version');
    });

    test('decodes quoted-printable content', () => {
        const source = [
            'Content-Type: text/html; charset=utf-8',
            'Content-Transfer-Encoding: quoted-printable',
            '',
            'Hello=20World=21',
        ].join('\r\n');

        expect(client.extractHtmlFromSource(source)).toBe('Hello World!');
    });

    test('decodes base64 HTML content', () => {
        const htmlContent = '<h1>Base64 Encoded</h1>';
        const base64Content = Buffer.from(htmlContent).toString('base64');
        const source = [
            'Content-Type: text/html; charset=utf-8',
            'Content-Transfer-Encoding: base64',
            '',
            base64Content,
        ].join('\r\n');

        expect(client.extractHtmlFromSource(source)).toBe(htmlContent);
    });

    test('handles empty MIME source gracefully', () => {
        expect(client.extractHtmlFromSource('')).toBe('');
        expect(client.extractTextFromSource('')).toBe('');
    });
});
