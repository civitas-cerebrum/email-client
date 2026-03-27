import { simpleParser, AddressObject } from 'mailparser';
import { createLogger } from './logger.js';
import * as nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import {
    EmailSendOptions,
    EmailReceiveOptions,
    EmailCredentials,
    ReceivedEmail,
    EmailFilterType,
    EmailFilter,
    EmailMarkOptions,
    EmailMarkAction,
    EmailClientConfig,
    SmtpCredentials,
    ImapCredentials
} from './types.js';

const log = createLogger('imap');
const smtpLog = createLogger('smtp');

/**
 * A comprehensive client for handling SMTP sending and IMAP polling/management.
 * Provides unified APIs for interacting with mail servers using robust polling mechanisms.
 */
export class EmailClient {
    private smtpTransport: nodemailer.Transporter | null = null;
    private smtpConfig?: SmtpCredentials;
    private imapConfig?: ImapCredentials;

    /**
     * Initializes the EmailClient.
     * @param credentials Configuration for connecting to the SMTP and IMAP servers.
     */
    constructor(credentials: EmailClientConfig | EmailCredentials) {
        const resolved = this.normalizeCredentials(credentials);
        this.smtpConfig = resolved.smtp;
        this.imapConfig = resolved.imap;
    }

    private normalizeCredentials(input: EmailClientConfig | EmailCredentials): EmailClientConfig {
        if ('senderEmail' in input || 'receiverEmail' in input) {
            const legacy = input as EmailCredentials;
            log('Legacy EmailCredentials detected — consider migrating to { smtp, imap } format');
            return {
                smtp: legacy.senderEmail ? {
                    email: legacy.senderEmail,
                    password: legacy.senderPassword,
                    host: legacy.senderSmtpHost,
                    port: legacy.senderSmtpPort,
                } : undefined,
                imap: legacy.receiverEmail ? {
                    email: legacy.receiverEmail,
                    password: legacy.receiverPassword,
                    host: legacy.receiverImapHost,
                    port: legacy.receiverImapPort,
                } : undefined,
            };
        }
        return input as EmailClientConfig;
    }

    private requireSmtp(): SmtpCredentials {
        if (!this.smtpConfig) {
            throw new Error('SMTP credentials are required to send emails. Provide { smtp: { email, password, host } } when constructing EmailClient.');
        }
        return this.smtpConfig;
    }

    private requireImap(): ImapCredentials {
        if (!this.imapConfig) {
            throw new Error('IMAP credentials are required to receive/manage emails. Provide { imap: { email, password } } when constructing EmailClient.');
        }
        return this.imapConfig;
    }

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
            from: this.requireSmtp().email,
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
                    const resolvedArchive = await this._resolveFolder(client, archiveFolder);
                    const moveResult = await client.messageMove(uids, resolvedArchive, { uid: true });
                    if (!moveResult) {
                        throw new Error(`Failed to move ${uids.length} email(s) to "${resolvedArchive}". The server rejected the move.`);
                    }
                    log('Archived %d email(s) from "%s" to "%s"', uids.length, folder, resolvedArchive);
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
        const { filters, folder = 'INBOX', waitTimeout = 30000, pollInterval = 3000, downloadDir, expectedCount = 1, maxFetchLimit = 50 } = options;
        this.validateFilters(filters);

        const deadline = Date.now() + waitTimeout;
        const client = this.createImapClient();
        const seenUids = new Set<number>();
        const accumulatedMatches: ReceivedEmail[] = []; // Track across polling cycles

        try {
            await client.connect();
            this.logImapConnection();

            const resolvedFolder = await this._resolveFolder(client, folder);

            while (Date.now() < deadline) {
                await client.mailboxOpen(resolvedFolder);

                const candidates = await this.fetchNewCandidates(client, filters, seenUids, downloadDir, maxFetchLimit);
                const newMatches = this.applyFilters(candidates, filters);

                accumulatedMatches.push(...newMatches);

                if (accumulatedMatches.length >= expectedCount) {
                    if (returnAll) {
                        return accumulatedMatches;
                    }
                    accumulatedMatches.sort((a, b) => b.date.getTime() - a.date.getTime());
                    log('Returning the most recent email (date: %s) from %d match(es)', accumulatedMatches[0].date.toISOString(), accumulatedMatches.length);
                    return accumulatedMatches[0];
                }

                if (returnAll) {
                    log('Found %d/%d email(s), retrying in %dms...', accumulatedMatches.length, expectedCount, pollInterval);
                } else {
                    log('No matching email(s) found yet, retrying in %dms...', pollInterval);
                }

                await new Promise(resolve => setTimeout(resolve, pollInterval));
            }

            throw new Error(`Found ${accumulatedMatches.length}/${expectedCount} emails within ${waitTimeout}ms. Searched in "${resolvedFolder}" for: ${this.formatFilterSummary(filters)}`);
        } finally {
            try { await client.logout(); } catch (err) { log('IMAP logout failed (ignored): %o', err); }
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

            const resolvedFolder = await this._resolveFolder(client, folder);

            try {
                await client.mailboxOpen(resolvedFolder);
            } catch (err: any) {
                if (err.serverResponseCode === 'NONEXISTENT' || err.message.includes('Unknown Mailbox')) {
                    const available = await this._listAvailableFolders(client);
                    throw new Error(
                        `Failed to open folder "${resolvedFolder}".\n` +
                        `Available folders on this server: [${available.join(', ')}]\n` +
                        `Check your ARCHIVE_FOLDER or folder settings.`
                    );
                }
                throw err;
            }

            const searchCriteria = filters && filters.length > 0
                ? this.buildSearchCriteria(filters)
                : { all: true };

            const uids = await client.search(searchCriteria, { uid: true });

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
            try { await client.logout(); } catch (err) { log('IMAP logout failed (ignored): %o', err); }
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

    /**
     * Resolves a folder name to its actual IMAP path using `specialUse` metadata.
     * Accepts either a literal path (e.g. '[Gmail]/Trash') or a specialUse role
     * (e.g. '\\Trash', '\\All', '\\Sent', '\\Flagged', '\\Drafts', '\\Junk').
     * Returns the original value if no specialUse match is found.
     */
    private async _resolveFolder(client: ImapFlow, folder: string): Promise<string> {
        if (!folder.startsWith('\\')) return folder;

        const list = await client.list();
        for (const entry of list) {
            if (entry.specialUse === folder) {
                log('Resolved specialUse "%s" to folder "%s"', folder, entry.path);
                return entry.path;
            }
        }

        throw new Error(
            `No folder with specialUse "${folder}" found on this server. ` +
            `Available folders: [${(list as any[]).map((f: any) => `${f.path} (${f.specialUse || 'none'})`).join(', ')}]`
        );
    }

    /** Instantiates an ImapFlow client using the provided credentials. */
    private createImapClient(): ImapFlow {
        const imap = this.requireImap();
        return new ImapFlow({
            host: imap.host ?? 'imap.gmail.com',
            port: imap.port ?? 993,
            secure: true,
            auth: { user: imap.email, pass: imap.password },
            logger: false,
        });
    }

    /** Logs standard IMAP connection details. */
    private logImapConnection(): void {
        const imap = this.requireImap();
        log('IMAP connected to %s as %s', imap.host ?? 'imap.gmail.com', imap.email);
    }

    /** Retrieves or instantiates the cached NodeMailer SMTP transport. */
    private getSmtpTransport(): nodemailer.Transporter {
        if (!this.smtpTransport) {
            const smtp = this.requireSmtp();
            this.smtpTransport = nodemailer.createTransport({
                host: smtp.host,
                port: smtp.port ?? 587,
                secure: smtp.port === 465,
                auth: { user: smtp.email, pass: smtp.password },
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
        downloadDir?: string,
        maxFetchLimit: number = 50
    ): Promise<ReceivedEmail[]> {
        const searchCriteria = this.buildSearchCriteria(filters);
        const uids = await client.search(searchCriteria, { uid: true });
        if (!uids || uids.length === 0) return [];

        const newUids = uids.filter(uid => !seenUids.has(uid));
        if (newUids.length === 0) return [];

        // Safety measure: Prevent memory spikes by capping the raw MIME fetch.
        const limitedUids = newUids.slice(-maxFetchLimit);

        if (newUids.length > maxFetchLimit) {
            log('Warning: Found %d matching emails. Capping fetch limit to the %d most recent to conserve memory.', newUids.length, maxFetchLimit);
            // Add the omitted UIDs to 'seen' so we don't fetch them in the next polling cycle
            newUids.slice(0, -maxFetchLimit).forEach(uid => seenUids.add(uid));
        }

        const candidates: ReceivedEmail[] = [];
        for await (const msg of client.fetch(limitedUids, { source: true }, { uid: true })) {
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