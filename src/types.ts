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
    /** IMAP folder to search. Defaults to 'INBOX'. */
    folder?: string;
    /** How long to poll for a matching email (ms). Defaults to 30000. */
    waitTimeout?: number;
    /** Interval between poll attempts (ms). Defaults to 3000. */
    pollInterval?: number;
    /** Directory to save downloaded email HTML. Defaults to os.tmpdir()/pw-emails. */
    downloadDir?: string;
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
