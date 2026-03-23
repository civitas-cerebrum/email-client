import * as nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createLogger } from './logger';
import { EmailSendOptions, EmailReceiveOptions, EmailCredentials, ReceivedEmail, EmailFilterType, EmailFilter } from './types';

const log = createLogger('imap');
const smtpLog = createLogger('smtp');

export class EmailClient {

    private smtpTransport: nodemailer.Transporter | null = null;

    constructor(private credentials: EmailCredentials) {}

    // ─── SMTP ────────────────────────────────────────────────────────────

    async send(options: EmailSendOptions): Promise<void> {
        const transport = this.getSmtpTransport();
        const { to, subject, text, html, htmlFile } = options;

        let htmlContent = html;
        if (htmlFile) {
            const resolvedPath = path.resolve(htmlFile);
            if (!fs.existsSync(resolvedPath)) {
                throw new Error(`HTML file not found: ${resolvedPath}`);
            }
            htmlContent = fs.readFileSync(resolvedPath, 'utf-8');
            smtpLog('Loaded HTML email body from %s (%d bytes)', resolvedPath, htmlContent.length);
        }

        const mailOptions: nodemailer.SendMailOptions = {
            from: this.credentials.senderEmail,
            to,
            subject,
            ...(htmlContent ? { html: htmlContent } : { text: text ?? '' })
        };

        const info = await transport.sendMail(mailOptions);
        smtpLog('Email sent to %s — messageId: %s', to, info.messageId);
    }

    // ─── IMAP ────────────────────────────────────────────────────────────

    async receive(options: EmailReceiveOptions): Promise<ReceivedEmail> {
        const { filters, folder, waitTimeout, pollInterval, downloadDir } = options;
        this.validateFilters(filters);

        const timeout = waitTimeout ?? 30000;
        const interval = pollInterval ?? 3000;
        const mailbox = folder ?? 'INBOX';
        const deadline = Date.now() + timeout;

        const client = this.createImapClient();

        try {
            await client.connect();
            this.logImapConnection();

            while (Date.now() < deadline) {
                await client.mailboxOpen(mailbox);
                const candidates = await this.fetchCandidates(client, filters, downloadDir);

                const result = this.applyFilters(candidates, filters);
                if (result.length > 0) {
                    return result[result.length - 1];
                }

                log('No matching email found yet, retrying in %dms...', interval);
                await new Promise(resolve => setTimeout(resolve, interval));
            }

            throw new Error(`No email matching criteria found within ${timeout}ms. Searched in "${mailbox}" for: ${this.formatFilterSummary(filters)}`);
        } finally {
            try { await client.logout(); } catch { /* already disconnected */ }
        }
    }

    async receiveAll(options: EmailReceiveOptions): Promise<ReceivedEmail[]> {
        const { filters, folder, waitTimeout, pollInterval, downloadDir } = options;
        this.validateFilters(filters);

        const timeout = waitTimeout ?? 30000;
        const interval = pollInterval ?? 3000;
        const mailbox = folder ?? 'INBOX';
        const deadline = Date.now() + timeout;

        const client = this.createImapClient();

        try {
            await client.connect();
            this.logImapConnection();

            while (Date.now() < deadline) {
                await client.mailboxOpen(mailbox);
                const candidates = await this.fetchCandidates(client, filters, downloadDir);

                const results = this.applyFilters(candidates, filters);
                if (results.length > 0) {
                    log('Found %d matching email(s)', results.length);
                    return results;
                }

                log('No matching emails found yet, retrying in %dms...', interval);
                await new Promise(resolve => setTimeout(resolve, interval));
            }

            throw new Error(`No emails matching criteria found within ${timeout}ms. Searched in "${mailbox}" for: ${this.formatFilterSummary(filters)}`);
        } finally {
            try { await client.logout(); } catch { /* already disconnected */ }
        }
    }

    async clean(options?: { filters?: EmailFilter[]; folder?: string }): Promise<number> {
        const filters = options?.filters;
        const mailbox = options?.folder ?? 'INBOX';

        const client = this.createImapClient();

        try {
            await client.connect();
            this.logImapConnection();
            await client.mailboxOpen(mailbox);

            const searchCriteria = filters && filters.length > 0
                ? this.buildSearchCriteria(filters)
                : { all: true };

            const uids: number[] = [];
            for await (const msg of client.fetch({ ...searchCriteria }, { uid: true })) {
                uids.push(msg.uid);
            }

            if (uids.length > 0) {
                await client.messageDelete(uids, { uid: true });
                log('Deleted %d email(s) from "%s"', uids.length, mailbox);
            } else {
                log('No emails to delete in "%s"', mailbox);
            }

            await client.logout();
            return uids.length;
        } catch (error) {
            try { await client.logout(); } catch { /* already disconnected */ }
            throw error;
        }
    }

    // ─── Public filtering API ────────────────────────────────────────

    applyFilters(candidates: ReceivedEmail[], filters: EmailFilter[]): ReceivedEmail[] {
        const stringFilters = filters.filter(f => f.type !== EmailFilterType.SINCE && f.type !== EmailFilterType.TO);
        if (stringFilters.length === 0) return candidates;

        const exactMatches = candidates.filter(email => this.matchesAllFilters(email, stringFilters, true));
        if (exactMatches.length > 0) return exactMatches;

        const partialMatches = candidates.filter(email => this.matchesAllFilters(email, stringFilters, false));
        if (partialMatches.length > 0) {
            log('No exact match found — falling back to partial case-insensitive match for: %s', this.formatFilterSummary(stringFilters));
        }
        return partialMatches;
    }

    // ─── Private helpers ─────────────────────────────────────────────

    private validateFilters(filters: EmailFilter[]): void {
        if (!filters || filters.length === 0) {
            throw new Error('At least one email filter is required. Use EmailFilterType to specify filter criteria.');
        }
    }

    private createImapClient(): ImapFlow {
        return new ImapFlow({
            host: this.credentials.receiverImapHost ?? 'imap.gmail.com',
            port: this.credentials.receiverImapPort ?? 993,
            secure: true,
            auth: {
                user: this.credentials.receiverEmail,
                pass: this.credentials.receiverPassword
            },
            logger: false
        });
    }

    private logImapConnection(): void {
        log('IMAP connected to %s as %s', this.credentials.receiverImapHost ?? 'imap.gmail.com', this.credentials.receiverEmail);
    }

    private buildSearchCriteria(filters: EmailFilter[]): Record<string, any> {
        const criteria: Record<string, any> = {};
        for (const filter of filters) {
            switch (filter.type) {
                case EmailFilterType.SUBJECT: criteria.subject = filter.value; break;
                case EmailFilterType.FROM: criteria.from = filter.value; break;
                case EmailFilterType.TO: criteria.to = filter.value; break;
                case EmailFilterType.CONTENT: criteria.body = filter.value; break;
                case EmailFilterType.SINCE: criteria.since = filter.value; break;
                default: throw new Error(`Unknown email filter type: ${(filter as any).type}`);
            }
        }
        return criteria;
    }

    private async fetchCandidates(client: ImapFlow, filters: EmailFilter[], downloadDir?: string): Promise<ReceivedEmail[]> {
        const searchCriteria = this.buildSearchCriteria(filters);
        const candidates: ReceivedEmail[] = [];
        for await (const msg of client.fetch({ ...searchCriteria }, { source: true, envelope: true })) {
            candidates.push(this.parseMessage(msg, downloadDir));
        }
        return candidates;
    }

    private matchesAllFilters(email: ReceivedEmail, filters: EmailFilter[], exact: boolean): boolean {
        return filters.every(filter => {
            const filterValue = filter.value as string;
            const fieldValue = this.getEmailField(email, filter.type);
            if (exact) return fieldValue === filterValue;
            return fieldValue.toLowerCase().includes(filterValue.toLowerCase());
        });
    }

    private getEmailField(email: ReceivedEmail, filterType: EmailFilterType): string {
        switch (filterType) {
            case EmailFilterType.SUBJECT: return email.subject;
            case EmailFilterType.FROM: return email.from;
            case EmailFilterType.TO: return '';
            case EmailFilterType.CONTENT: return email.html || email.text;
            default: return '';
        }
    }

    private formatFilterSummary(filters: EmailFilter[]): string {
        return filters.map(f => `${f.type}: ${f.value instanceof Date ? f.value.toISOString() : f.value}`).join(', ');
    }

    private parseMessage(msg: any, downloadDir?: string): ReceivedEmail {
        const source = msg.source?.toString('utf-8') ?? '';
        const envelope = msg.envelope;

        const htmlBody = this.extractHtmlFromSource(source);
        const textBody = this.extractTextFromSource(source);

        const outputDir = downloadDir ?? path.join(os.tmpdir(), 'pw-emails');
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        const sanitizedSubject = (envelope?.subject ?? 'email')
            .replace(/[^a-zA-Z0-9-_]/g, '_')
            .substring(0, 50);
        const fileName = `${sanitizedSubject}-${Date.now()}.html`;
        const filePath = path.join(outputDir, fileName);

        const content = htmlBody || `<pre>${textBody}</pre>`;
        fs.writeFileSync(filePath, content, 'utf-8');
        log('Email downloaded to %s', filePath);

        return {
            filePath,
            subject: envelope?.subject ?? '',
            from: envelope?.from?.[0]?.address ?? '',
            date: envelope?.date ?? new Date(),
            html: htmlBody,
            text: textBody
        };
    }

    private getSmtpTransport(): nodemailer.Transporter {
        if (!this.smtpTransport) {
            this.smtpTransport = nodemailer.createTransport({
                host: this.credentials.senderSmtpHost,
                port: this.credentials.senderSmtpPort ?? 587,
                secure: this.credentials.senderSmtpPort === 465,
                auth: {
                    user: this.credentials.senderEmail,
                    pass: this.credentials.senderPassword
                }
            });
        }
        return this.smtpTransport;
    }

    extractHtmlFromSource(source: string): string {
        const sectionMatch = source.match(
            /(Content-Type:\s*text\/html[^\r\n]*(?:\r?\n(?![\r\n])[^\r\n]*)*)\r?\n\r?\n([\s\S]*?)(?:\r?\n--|\r?\n\.\r?\n|$)/i
        );
        if (sectionMatch) {
            const headers = sectionMatch[1];
            let content = sectionMatch[2];
            if (/Content-Transfer-Encoding:\s*base64/i.test(headers)) {
                try { content = Buffer.from(content.replace(/\s/g, ''), 'base64').toString('utf-8'); } catch { /* not base64 */ }
            }
            if (/Content-Transfer-Encoding:\s*quoted-printable/i.test(headers)) {
                content = content
                    .replace(/=\r?\n/g, '')
                    .replace(/=([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
            }
            return content;
        }
        return '';
    }

    extractTextFromSource(source: string): string {
        const sectionMatch = source.match(
            /(Content-Type:\s*text\/plain[^\r\n]*(?:\r?\n(?![\r\n])[^\r\n]*)*)\r?\n\r?\n([\s\S]*?)(?:\r?\n--|\r?\n\.\r?\n|$)/i
        );
        if (sectionMatch) {
            const headers = sectionMatch[1];
            let content = sectionMatch[2];
            if (/Content-Transfer-Encoding:\s*base64/i.test(headers)) {
                try { content = Buffer.from(content.replace(/\s/g, ''), 'base64').toString('utf-8'); } catch { /* not base64 */ }
            }
            if (/Content-Transfer-Encoding:\s*quoted-printable/i.test(headers)) {
                content = content
                    .replace(/=\r?\n/g, '')
                    .replace(/=([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
            }
            return content;
        }
        return '';
    }
}
