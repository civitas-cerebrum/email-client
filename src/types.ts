/**
 * Defines the type of filter to apply when searching for emails.
 */
export enum EmailFilterType {
    /** Filter by email subject. */
    SUBJECT = 'subject',
    /** Filter by sender address. */
    FROM = 'from',
    /** Filter by recipient address. */
    TO = 'to',
    /** Filter by email body content (HTML or plain text). */
    CONTENT = 'content',
    /** Filter to only include emails received after a given date. Value must be a Date object. */
    SINCE = 'since'
}

/**
 * A single email search filter. Combine multiple filters in an array
 * to narrow down the search.
 */
export interface EmailFilter {
    /** The filter type to apply. */
    type: EmailFilterType;
    /** The value to filter by. Use a string for SUBJECT/FROM/TO/CONTENT, or a Date for SINCE. */
    value: string | Date;
}

/**
 * SMTP and IMAP credentials for the email client.
 */
export interface EmailCredentials {
    /** SMTP sender email address. */
    senderEmail: string;
    /** SMTP sender password or app password. */
    senderPassword: string;
    /** SMTP host (e.g. 'smtp-relay.sendinblue.com'). */
    senderSmtpHost: string;
    /** SMTP port. Defaults to 587. */
    senderSmtpPort?: number;
    /** IMAP receiver email address. */
    receiverEmail: string;
    /** IMAP receiver password or app password. */
    receiverPassword: string;
    /** IMAP host. Defaults to 'imap.gmail.com'. */
    receiverImapHost?: string;
    /** IMAP port. Defaults to 993. */
    receiverImapPort?: number;
}

/**
 * SMTP credentials for sending emails.
 */
export interface SmtpCredentials {
    /** SMTP sender email address. */
    email: string;
    /** SMTP sender password or app password. */
    password: string;
    /** SMTP host (e.g. 'smtp-relay.sendinblue.com'). */
    host: string;
    /** SMTP port. Defaults to 587. */
    port?: number;
}

/**
 * IMAP credentials for receiving/managing emails.
 */
export interface ImapCredentials {
    /** IMAP email address. */
    email: string;
    /** IMAP password or app password. */
    password: string;
    /** IMAP host. Defaults to 'imap.gmail.com'. */
    host?: string;
    /** IMAP port. Defaults to 993. */
    port?: number;
}

/**
 * Flexible credential configuration.
 * Provide smtp, imap, or both depending on which features you need.
 */
export interface EmailClientConfig {
    /** SMTP credentials — required for send(). */
    smtp?: SmtpCredentials;
    /** IMAP credentials — required for receive(), receiveAll(), clean(), mark(). */
    imap?: ImapCredentials;
}

/**
 * Options for sending an email.
 * Provide `text` for plain-text, `html` for inline HTML, or `htmlFile` for an HTML template file.
 */
export interface EmailSendOptions {
    /** Recipient email address. */
    to: string;
    /** Email subject line. */
    subject: string;
    /** Plain-text body. Used when neither `html` nor `htmlFile` is provided. */
    text?: string;
    /** Inline HTML body. Takes precedence over `text`. */
    html?: string;
    /** Path to an HTML file to use as the email body. Takes precedence over `html` and `text`. */
    htmlFile?: string;
}

/**
 * Options for receiving (searching and downloading) an email via IMAP.
 */
export interface EmailReceiveOptions {
    /** Array of filters to apply when searching for emails. All filters are combined (AND logic). */
    filters: EmailFilter[];
    /** IMAP folder to search. Accepts a literal path or a specialUse role (e.g. '\\Sent', '\\Trash'). Defaults to 'INBOX'. */
    folder?: string;
    /**
     * Multiple IMAP folders to search in one call, each accepting a literal path or a
     * specialUse role. Every folder is searched on every polling cycle and the matches
     * are pooled, so a message the receiving server filed somewhere other than the
     * inbox (spam, for instance) is still found. Takes precedence over `folder`.
     *
     * A folder in this list that does not exist on the server is skipped with a log
     * line rather than throwing, so a portable folder set (e.g. `['INBOX', '\\Junk']`)
     * works against servers that lack one of them. If NONE of the listed folders can be
     * opened, the call throws. A single-folder search still throws on a missing folder.
     */
    folders?: string[];
    /** How long to poll for a matching email (ms). Defaults to 30000. */
    waitTimeout?: number;
    /** Interval between poll attempts (ms). Defaults to 3000. */
    pollInterval?: number;
    /** Specific number of expected results */
    expectedCount?: number;
    /** Directory to save downloaded email HTML. Defaults to os.tmpdir()/pw-emails. */
    downloadDir?: string;
    /** Maximum number of emails to fetch per polling cycle. Defaults to 50. */
    maxFetchLimit?: number;
}

/**
 * Represents a received email after download.
 */
export interface ReceivedEmail {
    /** Local file path of the downloaded HTML. Open with `navigateTo('file://' + filePath)`. */
    filePath: string;
    /** Email subject. */
    subject: string;
    /** Sender address. */
    from: string;
    /** Date the email was sent. */
    date: Date;
    /** Raw HTML content (empty string if plain-text only). */
    html: string;
    /** Plain-text content. */
    text: string;
}

/**
 * Options for deleting emails from the mailbox.
 */
export interface EmailCleanOptions {
    /** Filters identifying which emails to delete. If omitted, EVERY email in the target folder(s) is deleted. */
    filters?: EmailFilter[];
    /** The target mailbox folder. Accepts a literal path or a specialUse role. Defaults to 'INBOX'. */
    folder?: string;
    /**
     * Multiple target folders, each accepting a literal path or a specialUse role.
     * The delete is applied to each folder in turn and the returned count is the total.
     * Takes precedence over `folder`. Missing folders are skipped (see
     * {@link EmailReceiveOptions.folders}).
     */
    folders?: string[];
}

/**
 * Predefined actions for modifying email flags or state.
 */
export enum EmailMarkAction {
    READ = 'READ',
    UNREAD = 'UNREAD',
    FLAGGED = 'FLAGGED',
    UNFLAGGED = 'UNFLAGGED',
    ARCHIVED = 'ARCHIVED'
}

/**
 * Options for marking or modifying emails in the mailbox.
 */
export interface EmailMarkOptions {
    /** A predefined `EmailMarkAction` enum, or an array of standard IMAP flags (e.g., `['\\Draft']`). */
    action: EmailMarkAction | string[];
    /** Filters to identify which emails should be marked. If omitted, applies to all emails in the folder. */
    filters?: EmailFilter[];
    /** The target mailbox folder. Accepts a literal path or a specialUse role (e.g. '\\Trash', '\\Sent'). Defaults to 'INBOX'. */
    folder?: string;
    /**
     * Multiple source folders to mark across, each accepting a literal path or a
     * specialUse role. The action is applied in each folder in turn and the returned
     * count is the total. Takes precedence over `folder`. Missing folders are skipped
     * (see {@link EmailReceiveOptions.folders}).
     */
    folders?: string[];
    /** The destination folder for the `ARCHIVED` action. Accepts a literal path or a specialUse role (e.g. '\\Flagged', '\\All'). Defaults to 'Archive'. */
    archiveFolder?: string;
}
