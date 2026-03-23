import * as nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';
import { simpleParser, AddressObject } from 'mailparser';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createLogger } from './logger';
import { 
    EmailSendOptions, 
    EmailReceiveOptions, 
    EmailCredentials, 
    ReceivedEmail, 
    EmailFilterType, 
    EmailFilter 
} from './types';

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
        const seenUids = new Set<number>(); // Track downloaded UIDs to prevent redownloading

        try {
            await client.connect();
            this.logImapConnection();

            while (Date.now() < deadline) {
                await client.mailboxOpen(mailbox);
                
                // Only fetch sources for new emails
                const candidates = await this.fetchNewCandidates(client, filters, seenUids, downloadDir);

                const result = this.applyFilters(candidates, filters);
                if (result.length > 0) {
                    return result[result.length - 1];
                }

                log('No matching email found yet, retrying in %dms...', interval);
                await new Promise(resolve => setTimeout(resolve, interval));
            }

            throw new Error(`No email matching criteria found within ${timeout}ms. Searched in "${mailbox}" for: ${this.formatFilterSummary(filters)}`);
        } finally {
            try { await client.logout(); } catch { /* ignore */ }
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
        const seenUids = new Set<number>();
        const allMatches: ReceivedEmail[] = [];

        try {
            await client.connect();
            this.logImapConnection();

            while (Date.now() < deadline) {
                await client.mailboxOpen(mailbox);
                
                const candidates = await this.fetchNewCandidates(client, filters, seenUids, downloadDir);
                const matches = this.applyFilters(candidates, filters);
                
                if (matches.length > 0) {
                    allMatches.push(...matches);
                    log('Found %d matching email(s)', allMatches.length);
                    return allMatches;
                }

                log('No matching emails found yet, retrying in %dms...', interval);
                await new Promise(resolve => setTimeout(resolve, interval));
            }

            throw new Error(`No emails matching criteria found within ${timeout}ms. Searched in "${mailbox}" for: ${this.formatFilterSummary(filters)}`);
        } finally {
            try { await client.logout(); } catch { /* ignore */ }
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

            // Find UIDs first!
            const uids = await client.search(searchCriteria);

            if (!uids || uids.length === 0) {
                log('No emails to delete in "%s"', mailbox);
                return 0;
            }

            // Delete passing the UIDs array
            await client.messageDelete(uids, { uid: true });
            log('Deleted %d email(s) from "%s"', uids.length, mailbox);
            
            return uids.length;
        } finally {
            // Cleanly handles disconnects regardless of success/fail
            try { await client.logout(); } catch { /* ignore */ }
        }
    }

    // ─── Public filtering API ────────────────────────────────────────

    applyFilters(candidates: ReceivedEmail[], filters: EmailFilter[]): ReceivedEmail[] {
        // Exclude 'SINCE' from string matching, but include 'TO' this time.
        const stringFilters = filters.filter(f => f.type !== EmailFilterType.SINCE);
        if (stringFilters.length === 0) return candidates;

        const exactMatches = candidates.filter(email => this.matchesAllFilters(email, stringFilters, true));
        if (exactMatches.length > 0) return exactMatches;

        const partialMatches = candidates.filter(email => this.matchesAllFilters(email, stringFilters, false));
        if (partialMatches.length > 0) {
            log('No exact match found — falling back to partial case-insensitive match for: %s', this.formatFilterSummary(stringFilters));
        }
        return partialMatches;
    }

    // ─── MIME extraction ────────────────────────────────────────────

    extractHtmlFromSource(source: string): string {
        return this.extractContentFromSource(source, 'text/html');
    }

    extractTextFromSource(source: string): string {
        return this.extractContentFromSource(source, 'text/plain');
    }

    private extractContentFromSource(source: string, contentType: string): string {
        if (!source) return '';

        const boundaryMatch = source.match(/boundary="?([^"\r\n]+)"?/);
        if (boundaryMatch) {
            return this.extractFromMultipart(source, boundaryMatch[1], contentType);
        }

        // Single-part message
        const ctMatch = source.match(/Content-Type:\s*([^\s;]+)/i);
        if (!ctMatch || !ctMatch[1].toLowerCase().startsWith(contentType)) return '';

        const encoding = this.getTransferEncoding(source);
        const body = this.getBodyAfterHeaders(source);
        return this.decodeContent(body, encoding);
    }

    private extractFromMultipart(source: string, boundary: string, contentType: string): string {
        const parts = source.split(`--${boundary}`);
        for (const part of parts) {
            const ctMatch = part.match(/Content-Type:\s*([^\s;]+)/i);
            if (ctMatch && ctMatch[1].toLowerCase().startsWith(contentType)) {
                const encoding = this.getTransferEncoding(part);
                const body = this.getBodyAfterHeaders(part);
                return this.decodeContent(body, encoding);
            }
        }
        return '';
    }

    private getTransferEncoding(part: string): string {
        const match = part.match(/Content-Transfer-Encoding:\s*(\S+)/i);
        return match ? match[1].toLowerCase() : '7bit';
    }

    private getBodyAfterHeaders(part: string): string {
        const separatorIndex = part.indexOf('\r\n\r\n');
        if (separatorIndex === -1) {
            const lfIndex = part.indexOf('\n\n');
            return lfIndex === -1 ? '' : part.substring(lfIndex + 2).trim();
        }
        return part.substring(separatorIndex + 4).trim();
    }

    private decodeContent(body: string, encoding: string): string {
        if (encoding === 'base64') {
            return Buffer.from(body, 'base64').toString('utf-8');
        }
        if (encoding === 'quoted-printable') {
            return body
                .replace(/=\r?\n/g, '')
                .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
        }
        return body;
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
            // If multiple filters of the same type exist, the first is used for IMAP broad search.
            // Our local applyFilters() strictly handles duplicate logic afterwards.
            switch (filter.type) {
                case EmailFilterType.SUBJECT: 
                    if (!criteria.subject) criteria.subject = filter.value; 
                    break;
                case EmailFilterType.FROM: 
                    if (!criteria.from) criteria.from = filter.value; 
                    break;
                case EmailFilterType.TO: 
                    if (!criteria.to) criteria.to = filter.value; 
                    break;
                case EmailFilterType.CONTENT: 
                    if (!criteria.body) criteria.body = filter.value; 
                    break;
                case EmailFilterType.SINCE: 
                    if (!criteria.since) criteria.since = filter.value; 
                    break;
                default: 
                    throw new Error(`Unknown email filter type: ${(filter as any).type}`);
            }
        }
        return criteria;
    }

    private async fetchNewCandidates(
        client: ImapFlow, 
        filters: EmailFilter[], 
        seenUids: Set<number>,
        downloadDir?: string
    ): Promise<ReceivedEmail[]> {
        const searchCriteria = this.buildSearchCriteria(filters);
        
        // 1. Search for matching UIDs
        const uids = await client.search(searchCriteria);
        if (!uids || uids.length === 0) return [];

        // 2. Filter out UIDs we've already parsed to optimize polling
        const newUids = uids.filter(uid => !seenUids.has(uid));
        if (newUids.length === 0) return [];

        const candidates: ReceivedEmail[] = [];
        
        // 3. Fetch ONLY the unread message sources
        for await (const msg of client.fetch(newUids, { source: true, uid: true })) {
            seenUids.add(msg.uid);
            candidates.push(await this.parseMessage(msg, downloadDir));
        }
        return candidates;
    }

    private matchesAllFilters(email: any, filters: EmailFilter[], exact: boolean): boolean {
        return filters.every(filter => {
            const filterValue = String(filter.value);
            const fieldValue = this.getEmailField(email, filter.type);
            
            if (exact) return fieldValue === filterValue;
            return fieldValue.toLowerCase().includes(filterValue.toLowerCase());
        });
    }

    private getEmailField(email: any, filterType: EmailFilterType): string {
        switch (filterType) {
            case EmailFilterType.SUBJECT: return email.subject || '';
            case EmailFilterType.FROM: return email.from || '';
            case EmailFilterType.TO: return email.to || ''; 
            case EmailFilterType.CONTENT: return (email.html || '') + '\n' + (email.text || '');
            default: return '';
        }
    }

    private formatFilterSummary(filters: EmailFilter[]): string {
        return filters.map(f => `${f.type}: ${f.value instanceof Date ? f.value.toISOString() : f.value}`).join(', ');
    }

    private async parseMessage(msg: any, downloadDir?: string): Promise<ReceivedEmail> {
        const parsed = await simpleParser(msg.source);

        // Helper to safely extract email addresses regardless of whether 
        // mailparser returns a single AddressObject or an array of them.
        const extractEmails = (field: AddressObject | AddressObject[] | undefined): string => {
            if (!field) return '';
            const items = Array.isArray(field) ? field : [field];
            return items
                .flatMap(item => item.value || []) // Combine all value arrays
                .map(addr => addr.address)         // Extract the raw email address strings
                .filter((addr): addr is string => !!addr) // Filter out undefined/null
                .join(', ');                       // Join multiple addresses with a comma
        };

        const htmlBody = parsed.html || '';
        const textBody = parsed.text || '';
        const subject = parsed.subject || '';
        const date = parsed.date || new Date();
        
        // Use the helper to satisfy TypeScript
        const from = extractEmails(parsed.from);
        const to = extractEmails(parsed.to);

        const outputDir = downloadDir ?? path.join(os.tmpdir(), 'pw-emails');
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        const sanitizedSubject = (subject || 'email')
            .replace(/[^a-zA-Z0-9-_]/g, '_')
            .substring(0, 50);
        const fileName = `${sanitizedSubject}-${Date.now()}.html`;
        const filePath = path.join(outputDir, fileName);

        const content = htmlBody || `<pre>${textBody}</pre>`;
        fs.writeFileSync(filePath, content, 'utf-8');
        log('Email downloaded to %s', filePath);

        return {
            filePath,
            subject,
            from,
            to,       
            date,
            html: htmlBody,
            text: textBody
        } as ReceivedEmail; 
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
}