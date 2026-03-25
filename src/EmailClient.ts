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
    EmailFilter,
    EmailMarkOptions,
    EmailMarkAction
} from './types';

const log = createLogger('imap');
const smtpLog = createLogger('smtp');

/**
 * A comprehensive client for handling SMTP sending and IMAP polling/management.
 * Provides unified APIs for interacting with mail servers using robust polling mechanisms.
 */
export class EmailClient {
    private smtpTransport: nodemailer.Transporter | null = null;

    /**
     * Initializes the EmailClient.
     * @param credentials Configuration for connecting to the SMTP and IMAP servers.
     */
    constructor(private credentials: EmailCredentials) { }

    // ════════════════════════════════════════════════════════════════════════
    // 1. SMTP API
    // ════════════════════════════════════════════════════════════════════════

    /**
     * Sends an email via SMTP.
     * Supports plain text, direct HTML strings, or loading HTML from a local file.
     * @param options The email addressing and content options.
     * @throws Error if `htmlFile` is provided but the file does not exist.
     */
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

    // ════════════════════════════════════════════════════════════════════════
    // 2. IMAP POLLING API
    // ════════════════════════════════════════════════════════════════════════

    /**
     * Polls the mailbox until a single email matching the provided filters is found.
     * If multiple emails match, returns the most recent one.
     * @param options The polling configuration and filter criteria.
     * @returns A promise resolving to the matched `ReceivedEmail`.
     * @throws Error if the `waitTimeout` is reached before an email is found.
     */
    async receive(options: EmailReceiveOptions): Promise<ReceivedEmail> {
        const result = await this._pollMailbox(options, false);
        return result as ReceivedEmail;
    }

    /**
     * Polls the mailbox until at least one email matching the provided filters is found,
     * returning all matching emails discovered during that polling cycle.
     * @param options The polling configuration and filter criteria.
     * @returns A promise resolving to an array of matched `ReceivedEmail` objects.
     * @throws Error if the `waitTimeout` is reached before any emails are found.
     */
    async receiveAll(options: EmailReceiveOptions): Promise<ReceivedEmail[]> {
        const result = await this._pollMailbox(options, true);
        return result as ReceivedEmail[];
    }

    // ════════════════════════════════════════════════════════════════════════
    // 3. IMAP MANAGEMENT API
    // ════════════════════════════════════════════════════════════════════════

    /**
     * Deletes emails from the mailbox based on the provided filters.
     * If no filters are provided, it deletes ALL emails in the specified folder.
     * @param options Filtering criteria and the target folder.
     * @returns The number of emails successfully deleted.
     */
    async clean(options?: { filters?: EmailFilter[]; folder?: string }): Promise<number> {
        const folder = options?.folder ?? 'INBOX';

        return this._executeImapAction(folder, options?.filters, 'delete', async (client, uids) => {
            await client.messageDelete(uids, { uid: true });
            log('Deleted %d email(s) from "%s"', uids.length, folder);
        });
    }

    /**
     * Modifies the state or flags of emails in the mailbox (e.g., Read, Unread, Flagged, Archived).
     * @param options Action details, filtering criteria, and target folder configuration.
     * @returns The number of emails successfully modified.
     */
    /**
     * Modifies the state or flags of emails in the mailbox (e.g., Read, Unread, Flagged, Archived).
     * @param options Action details, filtering criteria, and target folder configuration.
     * @returns The number of emails successfully modified.
     */
    async mark(options: EmailMarkOptions): Promise<number> {
        const { action, filters, folder = 'INBOX', archiveFolder = 'Archive' } = options;

        const isValidAction = Array.isArray(action) || Object.values(EmailMarkAction).includes(action as any);
        if (!isValidAction) {
            throw new Error(`Unsupported mark action: ${action}`);
        }

        return this._executeImapAction(folder, filters, 'mark', async (client, uids) => {
            if (uids.length === 0) return;

            // Handle Custom Flags
            if (Array.isArray(action)) {
                await client.messageFlagsAdd(uids, action, { uid: true });
                log('Added custom flags %j to %d email(s) in "%s"', action, uids.length, folder);
                return;
            }

            // Handle Standard Actions
            switch (action) {
                case EmailMarkAction.READ:
                    await client.messageFlagsAdd(uids, ['\\Seen'], { uid: true });
                    log('Action READ applied to %d email(s) in "%s"', uids.length, folder);
                    break;
                case EmailMarkAction.UNREAD:
                    await client.messageFlagsRemove(uids, ['\\Seen'], { uid: true });
                    log('Action UNREAD applied to %d email(s) in "%s"', uids.length, folder);
                    break;
                case EmailMarkAction.FLAGGED:
                    await client.messageFlagsAdd(uids, ['\\Flagged'], { uid: true });
                    log('Action FLAGGED applied to %d email(s) in "%s"', uids.length, folder);
                    break;
                case EmailMarkAction.UNFLAGGED:
                    await client.messageFlagsRemove(uids, ['\\Flagged'], { uid: true });
                    log('Action UNFLAGGED applied to %d email(s) in "%s"', uids.length, folder);
                    break;
                case EmailMarkAction.ARCHIVED:
                    await client.messageMove(uids, archiveFolder, { uid: true });
                    log('Archived %d email(s) from "%s" to "%s"', uids.length, folder, archiveFolder);
                    break;
            }
        });
    }

    // ════════════════════════════════════════════════════════════════════════
    // 4. FILTERING & EXTRACTION UTILITIES
    // ════════════════════════════════════════════════════════════════════════

    /**
     * Filters a list of fetched emails against the defined criteria.
     * Prioritizes exact matches, falling back to case-insensitive partial matches if necessary.
     * @param candidates The list of parsed emails to evaluate.
     * @param filters The criteria required to pass the filter.
     * @returns An array of emails that successfully pass all string filter criteria.
     */
    applyFilters(candidates: ReceivedEmail[], filters: EmailFilter[]): ReceivedEmail[] {
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

    /**
     * Extracts raw HTML content from an email's unparsed MIME source.
     * @param source The raw MIME source string.
     * @returns The decoded HTML content, or an empty string if not found.
     */
    extractHtmlFromSource(source: string): string {
        return this.extractContentFromSource(source, 'text/html');
    }

    /**
     * Extracts plain text content from an email's unparsed MIME source.
     * @param source The raw MIME source string.
     * @returns The decoded plain text content, or an empty string if not found.
     */
    extractTextFromSource(source: string): string {
        return this.extractContentFromSource(source, 'text/plain');
    }

    // ════════════════════════════════════════════════════════════════════════
    // 5. PRIVATE CORE HELPERS
    // ════════════════════════════════════════════════════════════════════════

    /**
     * Core polling engine used by `receive()` and `receiveAll()`.
     * Manages IMAP connection, continuous retry logic, timeout enforcement, and cleanup.
     */
    private async _pollMailbox(options: EmailReceiveOptions, returnAll: boolean): Promise<ReceivedEmail | ReceivedEmail[]> {
        const { filters, folder = 'INBOX', waitTimeout = 30000, pollInterval = 3000, downloadDir } = options;
        this.validateFilters(filters);

        const deadline = Date.now() + waitTimeout;
        const client = this.createImapClient();
        const seenUids = new Set<number>();

        try {
            await client.connect();
            this.logImapConnection();

            while (Date.now() < deadline) {
                await client.mailboxOpen(folder);

                const candidates = await this.fetchNewCandidates(client, filters, seenUids, downloadDir);
                const matches = this.applyFilters(candidates, filters);

                if (matches.length > 0) {
                    return returnAll ? matches : matches[matches.length - 1];
                }

                log('No matching email(s) found yet, retrying in %dms...', pollInterval);
                await new Promise(resolve => setTimeout(resolve, pollInterval));
            }

            throw new Error(`No email matching criteria found within ${waitTimeout}ms. Searched in "${folder}" for: ${this.formatFilterSummary(filters)}`);
        } finally {
            try { await client.logout(); } catch { /* ignore */ }
        }
    }

    /**
     * Core execution engine used by `clean()` and `mark()`.
     * Safely wraps IMAP connection, UID searching, custom action execution, and logout.
     */
    private async _executeImapAction(
        folder: string,
        filters: EmailFilter[] | undefined,
        actionName: string,
        actionFn: (client: ImapFlow, uids: number[]) => Promise<void>
    ): Promise<number> {
        const client = this.createImapClient();

        try {
            await client.connect();
            this.logImapConnection();

            try {
                await client.mailboxOpen(folder);
            } catch (err: any) {
                if (err.serverResponseCode === 'NONEXISTENT' || err.message.includes('Unknown Mailbox')) {
                    const available = await this._listAvailableFolders(client);
                    throw new Error(
                        `Failed to open folder "${folder}".\n` +
                        `Available folders on this server: [${available.join(', ')}]\n` +
                        `Check your ARCHIVE_FOLDER or folder settings.`
                    );
                }
                throw err;
            }

            const searchCriteria = filters && filters.length > 0
                ? this.buildSearchCriteria(filters)
                : { all: true };

            const uids = await client.search(searchCriteria);

            if (!uids || uids.length === 0) {
                log('No emails to %s in "%s"', actionName, folder);
                return 0;
            }

            try {
                await actionFn(client, uids);
            } catch (err: any) {
                if (err.message.includes('NONEXISTENT') || err.message.includes('Unknown Mailbox')) {
                    const available = await this._listAvailableFolders(client);
                    throw new Error(
                        `Action "${actionName}" failed. A target folder (${folder}) does not exist.\n` +
                        `Available folders: [${available.join(', ')}]`
                    );
                }
                throw err;
            }

            return uids.length;
        } finally {
            try { await client.logout(); } catch { /* ignore */ }
        }
    }

    /**
     * Helper to scrape mailbox paths for better error reporting
     */
    private async _listAvailableFolders(client: any): Promise<string[]> {
        const folders: string[] = [];
        try {
            const list = await client.list();
            for (const folder of list) {
                folders.push(folder.path);
            }
        } catch {
            return ['(could not retrieve list)'];
        }
        return folders;
    }

    /** Instantiates an ImapFlow client using the provided credentials. */
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

    /** Logs standard IMAP connection details. */
    private logImapConnection(): void {
        log('IMAP connected to %s as %s', this.credentials.receiverImapHost ?? 'imap.gmail.com', this.credentials.receiverEmail);
    }

    /** Retrieves or instantiates the cached NodeMailer SMTP transport. */
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

    // ════════════════════════════════════════════════════════════════════════
    // 6. PRIVATE PROCESSING HELPERS
    // ════════════════════════════════════════════════════════════════════════

    /** Ensures at least one filter is provided. */
    private validateFilters(filters: EmailFilter[]): void {
        if (!filters || filters.length === 0) {
            throw new Error('At least one email filter is required. Use EmailFilterType to specify filter criteria.');
        }
    }
    
    /** Maps standard `EmailFilter` objects to IMAP-compatible search criteria. */
    private buildSearchCriteria(filters: EmailFilter[]): Record<string, any> {
        const criteria: Record<string, any> = {};
        for (const filter of filters) {
            switch (filter.type) {
                case EmailFilterType.SUBJECT: if (!criteria.subject) criteria.subject = filter.value; break;
                case EmailFilterType.FROM: if (!criteria.from) criteria.from = filter.value; break;
                case EmailFilterType.TO: if (!criteria.to) criteria.to = filter.value; break;
                case EmailFilterType.CONTENT: if (!criteria.body) criteria.body = filter.value; break;
                case EmailFilterType.SINCE: if (!criteria.since) criteria.since = filter.value; break;
                default: throw new Error(`Unknown email filter type: ${(filter as any).type}`);
            }
        }
        return criteria;
    }

    /** Fetches unread/unseen messages from IMAP that match the search criteria. */
    private async fetchNewCandidates(
        client: ImapFlow,
        filters: EmailFilter[],
        seenUids: Set<number>,
        downloadDir?: string
    ): Promise<ReceivedEmail[]> {
        const searchCriteria = this.buildSearchCriteria(filters);
        const uids = await client.search(searchCriteria);
        if (!uids || uids.length === 0) return [];

        const newUids = uids.filter(uid => !seenUids.has(uid));
        if (newUids.length === 0) return [];

        // Safety measure: Prevent memory spikes by capping the raw MIME fetch to 50 emails.
        const MAX_FETCH_LIMIT = 50;
        const limitedUids = newUids.slice(-MAX_FETCH_LIMIT);

        if (newUids.length > MAX_FETCH_LIMIT) {
            log('Warning: Found %d matching emails. Capping fetch limit to the %d most recent to conserve memory.', newUids.length, MAX_FETCH_LIMIT);
            // Add the omitted UIDs to 'seen' so we don't fetch them in the next polling cycle
            newUids.slice(0, -MAX_FETCH_LIMIT).forEach(uid => seenUids.add(uid));
        }

        const candidates: ReceivedEmail[] = [];
        for await (const msg of client.fetch(limitedUids, { source: true, uid: true })) {
            seenUids.add(msg.uid);
            candidates.push(await this.parseMessage(msg, downloadDir));
        }
        return candidates;
    }

    /** Evaluates if a parsed email matches an array of specific filters. */
    private matchesAllFilters(email: any, filters: EmailFilter[], exact: boolean): boolean {
        return filters.every(filter => {
            const filterValue = String(filter.value);
            const fieldValue = this.getEmailField(email, filter.type);
            return exact ? fieldValue === filterValue : fieldValue.toLowerCase().includes(filterValue.toLowerCase());
        });
    }

    /** Extracts standard fields (Subject, To, From, etc) from a parsed email object. */
    private getEmailField(email: any, filterType: EmailFilterType): string {
        switch (filterType) {
            case EmailFilterType.SUBJECT: return email.subject || '';
            case EmailFilterType.FROM: return email.from || '';
            case EmailFilterType.TO: return email.to || '';
            case EmailFilterType.CONTENT: return (email.html || '') + '\n' + (email.text || '');
            default: return '';
        }
    }

    /** Formats a human-readable string summarizing the currently active filters for logging. */
    private formatFilterSummary(filters: EmailFilter[]): string {
        return filters.map(f => `${f.type}: ${f.value instanceof Date ? f.value.toISOString() : f.value}`).join(', ');
    }

    /** Parses raw IMAP source strings into a `ReceivedEmail` object and saves HTML to disk. */
    private async parseMessage(msg: any, downloadDir?: string): Promise<ReceivedEmail> {
        const parsed = await simpleParser(msg.source);

        const extractEmails = (field: AddressObject | AddressObject[] | undefined): string => {
            if (!field) return '';
            const items = Array.isArray(field) ? field : [field];
            return items
                .flatMap(item => item.value || [])
                .map(addr => addr.address)
                .filter((addr): addr is string => !!addr)
                .join(', ');
        };

        const htmlBody = parsed.html || '';
        const textBody = parsed.text || '';
        const subject = parsed.subject || '';
        const date = parsed.date || new Date();
        const from = extractEmails(parsed.from);
        const to = extractEmails(parsed.to);

        const outputDir = downloadDir ?? path.join(os.tmpdir(), 'pw-emails');
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        const sanitizedSubject = (subject || 'email').replace(/[^a-zA-Z0-9-_]/g, '_').substring(0, 50);
        const fileName = `${sanitizedSubject}-${Date.now()}.html`;
        const filePath = path.join(outputDir, fileName);

        fs.writeFileSync(filePath, htmlBody || `<pre>${textBody}</pre>`, 'utf-8');
        log('Email downloaded to %s', filePath);

        return { filePath, subject, from, to, date, html: htmlBody, text: textBody } as ReceivedEmail;
    }

    // ════════════════════════════════════════════════════════════════════════
    // 7. PRIVATE MIME HELPERS
    // ════════════════════════════════════════════════════════════════════════

    /** Recursively searches the raw source for a specific content type (e.g. text/html). */
    private extractContentFromSource(source: string, contentType: string): string {
        if (!source) return '';
        const boundaryMatch = source.match(/boundary="?([^"\r\n]+)"?/);
        if (boundaryMatch) return this.extractFromMultipart(source, boundaryMatch[1], contentType);

        const ctMatch = source.match(/Content-Type:\s*([^\s;]+)/i);
        if (!ctMatch || !ctMatch[1].toLowerCase().startsWith(contentType)) return '';

        return this.decodeContent(this.getBodyAfterHeaders(source), this.getTransferEncoding(source));
    }

    /** Extracts content split by MIME boundaries. */
    private extractFromMultipart(source: string, boundary: string, contentType: string): string {
        const parts = source.split(`--${boundary}`);
        for (const part of parts) {
            const ctMatch = part.match(/Content-Type:\s*([^\s;]+)/i);
            if (ctMatch && ctMatch[1].toLowerCase().startsWith(contentType)) {
                return this.decodeContent(this.getBodyAfterHeaders(part), this.getTransferEncoding(part));
            }
        }
        return '';
    }

    /** Identifies the transfer encoding used for a specific MIME part. */
    private getTransferEncoding(part: string): string {
        const match = part.match(/Content-Transfer-Encoding:\s*(\S+)/i);
        return match ? match[1].toLowerCase() : '7bit';
    }

    /** Strips out the MIME headers leaving only the payload body. */
    private getBodyAfterHeaders(part: string): string {
        const separatorIndex = part.indexOf('\r\n\r\n');
        if (separatorIndex === -1) {
            const lfIndex = part.indexOf('\n\n');
            return lfIndex === -1 ? '' : part.substring(lfIndex + 2).trim();
        }
        return part.substring(separatorIndex + 4).trim();
    }

    /** Decodes base64 or quoted-printable encoded text buffers into readable strings. */
    private decodeContent(body: string, encoding: string): string {
        if (encoding === 'base64') return Buffer.from(body, 'base64').toString('utf-8');
        if (encoding === 'quoted-printable') {
            return body.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
        }
        return body;
    }
}