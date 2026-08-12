import { describe, test, expect, beforeAll, afterEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ImapFlow } from 'imapflow';
import { EmailClient, EmailFilterType, EmailMarkAction } from '../src';
import { RunScope } from './helpers/runScope';
import { FlakeLedger } from './helpers/flakeLedger';

// ── Per-run isolation ────────────────────────────────────────────────────
// This suite sends real mail to ONE shared mailbox, and more than one run can
// be in flight against that mailbox at a time — a tagged release publish and a
// pull-request check, for instance. Anything this suite does that is scoped to
// "the mailbox" rather than to "this run" is therefore reaching into another
// run's fixtures.
//
// That is not a theoretical risk. A release run failed on
// `should verify mark() actually modifies the correct email flags on the
// server` with `expected [] to have a length of 1 but got +0` after 583717ms
// of a 660000ms budget. It did not time out — the wait model worked. The
// message had been received seconds earlier and then DISAPPEARED, because a
// concurrent run had reached the no-filter clean test and emptied the inbox
// out from under it.
//
// Every message this run sends is stamped with `run.tag`, every search and
// every delete this suite performs is scoped by it, and the one test that
// legitimately deletes without a filter now owns the folder it empties.
const run = new RunScope();

/**
 * Folders the suite searches for its own mail.
 *
 * WHY MORE THAN THE INBOX. Sending goes through a free-tier provider to a
 * hosted receiver, and such mail is intermittently filed as spam. A message
 * sitting in the spam folder is never found by an inbox-only search at ANY
 * timeout — an earlier run failed with "Found 0/1 emails within 240000ms" for
 * exactly that reason, and no amount of extra waiting could have saved it.
 *
 * These tests exist to verify THIS LIBRARY's IMAP receive path — that a search
 * finds a message, that flags are applied to the right one, that a clean really
 * removes it. They are not a test of the receiving provider's spam classifier,
 * so a message being filed as spam should not fail them.
 *
 * BE HONEST ABOUT THE COST: this deliberately hides genuine deliverability
 * regressions. If the sending domain's reputation collapses and every message
 * starts going to spam, this suite stays green. That signal is real and worth
 * having — it just does not belong here, because a library test cannot tell a
 * provider reputation problem from a library bug. It belongs in a dedicated
 * deliverability check that asserts placement (mail must arrive in INBOX
 * specifically) and is allowed to fail without blocking a library release.
 *
 * `[Gmail]/All Mail` was considered and rejected: it also contains sent,
 * archived and recently-deleted copies, so it would break the suite's negative
 * assertions — the clean-verify and archive tests prove a message is ABSENT
 * from where it used to be, and All Mail keeps showing it. INBOX + Spam widens
 * the search exactly as far as the spam problem requires and no further.
 *
 * Overridable so the suite is portable to a non-Gmail receiver.
 */
const SEARCH_FOLDERS: string[] = (process.env.MAIL_SEARCH_FOLDERS ?? 'INBOX,[Gmail]/Spam')
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean);

/**
 * Retries for the live suite only.
 *
 * Safe here because every attempt is self-contained: each test builds its
 * subject from `run.subject(...)` INSIDE the test body, so a second attempt
 * sends a message with a subject the first attempt never used and asserts only
 * against that message. No test reads state a previous attempt left behind, and
 * no test's assertion can be satisfied by a previous attempt's mail.
 *
 * A failed attempt may not reach its own trailing `clean()`, so retries do add
 * orphans to the mailbox. That is what the run-scoped cleanup in `afterAll`
 * below is for — it deletes this run's messages including every abandoned
 * attempt's, and cannot touch anyone else's.
 */
const LIVE_RETRIES = Number(process.env.LIVE_MAIL_RETRIES ?? 1);

/** Opens a raw ImapFlow connection with the receiver's credentials. */
function rawImapClient(): ImapFlow {
    return new ImapFlow({
        host: 'imap.gmail.com',
        port: 993,
        secure: true,
        auth: { user: process.env.RECEIVER_EMAIL!, pass: process.env.RECEIVER_PASSWORD! },
        logger: false,
    });
}

/**
 * Returns the flags for emails matching the given subject.
 *
 * Searches the same folder set as the client does — a message the receiver
 * filed as spam still has flags, and asserting on it from the inbox alone would
 * report "no such message" for a message that is plainly there.
 */
async function getImapFlags(subject: string): Promise<Set<string>[]> {
    const client = rawImapClient();

    try {
        await client.connect();

        const results: Set<string>[] = [];
        for (const folder of SEARCH_FOLDERS) {
            try {
                await client.mailboxOpen(folder);
            } catch {
                continue; // folder absent on this server — the other folders still count
            }

            const uids = await client.search({ subject }, { uid: true });
            if (!uids || uids.length === 0) continue;

            for await (const msg of client.fetch(uids, { flags: true }, { uid: true })) {
                results.push(msg.flags);
            }
        }
        return results;
    } finally {
        try { await client.logout(); } catch { /* ignore */ }
    }
}

/**
 * Creates a folder and APPENDs messages straight into it over IMAP.
 *
 * Used by the no-filter clean test so it can own its fixtures outright: no SMTP
 * send, no delivery latency, no dependence on where the receiving provider
 * decides to file the message — and, crucially, nothing in the folder that this
 * run did not put there.
 */
async function seedFolder(folder: string, subjects: string[]): Promise<void> {
    const client = rawImapClient();

    try {
        await client.connect();

        // Tolerate a folder left over from an earlier attempt: create it if it
        // is missing, then empty it, so a retry seeds a known-clean folder and
        // the exact-count assertion below stays meaningful.
        try {
            await client.mailboxCreate(folder);
        } catch { /* already exists */ }

        await client.mailboxOpen(folder);
        const stale = await client.search({ all: true }, { uid: true });
        if (stale && stale.length > 0) {
            await client.messageDelete(stale, { uid: true });
        }

        for (const subject of subjects) {
            const source = [
                `From: ${process.env.RECEIVER_EMAIL}`,
                `To: ${process.env.RECEIVER_EMAIL}`,
                `Subject: ${subject}`,
                'Content-Type: text/plain; charset="utf-8"',
                '',
                'Seed message for the unfiltered-clean test.',
                '',
            ].join('\r\n');

            await client.append(folder, source);
        }
    } finally {
        try { await client.logout(); } catch { /* ignore */ }
    }
}

/** Counts the messages currently in a folder. Returns -1 if the folder is gone. */
async function countMessages(folder: string): Promise<number> {
    const client = rawImapClient();

    try {
        await client.connect();
        await client.mailboxOpen(folder);
        const uids = await client.search({ all: true }, { uid: true });
        return uids ? uids.length : 0;
    } catch {
        return -1;
    } finally {
        try { await client.logout(); } catch { /* ignore */ }
    }
}

/** Removes a run-owned folder. Best effort — never fails a test. */
async function dropFolder(folder: string): Promise<void> {
    const client = rawImapClient();

    try {
        await client.connect();
        await client.mailboxDelete(folder);
    } catch { /* folder may never have been created */ } finally {
        try { await client.logout(); } catch { /* ignore */ }
    }
}

// ── Flake visibility ─────────────────────────────────────────────────────
// A test that only passes on its second attempt must not look identical to one
// that passed first time. Without this, adding retries converts a visible
// failure into an invisible one and the suite degrades silently until it fails
// outright. Vitest already annotates the retried line in its own output; this
// additionally raises a workflow warning and writes a job-summary table, so the
// flake is visible from the run's front page rather than only to whoever reads
// the full log.
const flaky = new FlakeLedger();

afterEach((ctx) => {
    flaky.record(ctx.task.name, ctx.task.result?.retryCount, ctx.task.result?.state);
});

afterAll(() => {
    flaky.publish(run.tag);
});

describe('EmailClient Integration Workflows', { retry: LIVE_RETRIES }, () => {
    let emailClient: EmailClient;

    // ── Timeout model ────────────────────────────────────────────────────
    // Invariant: a test's vitest budget must ALWAYS exceed the sum of the
    // internal client waits it can spend, with margin for the non-waiting
    // work around them.
    //
    // WHY THESE NUMBERS ARE LARGE — READ BEFORE TIGHTENING THEM.
    // This suite runs against a free-tier hosted mail provider. The dominant
    // cost is that provider's delivery latency, not this library's speed: an
    // email can take minutes to become visible over IMAP on a slow day. The
    // budgets are sized for the provider, not for the code. Tightening them
    // back down does not make the suite faster on a good day (a passing test
    // returns as soon as the mail lands) — it only makes the suite fail on a
    // slow one, which is exactly the release-blocking failure these numbers
    // were raised to stop.
    //
    // `receive()` / `receiveAll()` poll until `Date.now() + waitTimeout` and
    // only then throw the diagnostic "Found 0/N emails within Nms" error, so
    // an unlucky-but-legitimate slow delivery consumes the ENTIRE wait budget
    // before a single assertion runs. If the vitest budget equals the wait
    // budget, vitest kills the test at the same instant — the test cannot
    // pass except by luck and the useful error is never surfaced.
    //
    // Every test below therefore declares `{ timeout: budget(...) }` counting
    // the waits it can actually spend on its worst path. The global default
    // in vitest.config.ts is budget(1), so a test that forgets to declare one
    // still gets a full wait plus margin.
    //
    // NOTE ON RETRIES: `retry` gives each ATTEMPT the full declared budget —
    // it does not divide it — so no budget below needs adjusting for retries.
    // The job-level `timeout-minutes` is what bounds total retried time.

    /**
     * Standard wait for a real email to arrive and be matched. Sized for the
     * free-tier provider's delivery latency, not for the library.
     *
     * 300000 after a run in which a send was still not visible over IMAP
     * 240000ms later ("Found 0/1 emails within 240000ms"). Note what that
     * error means: the budget model is working — the wait ran to exhaustion
     * and produced its diagnostic instead of being killed by vitest — so a
     * failure at this line is a DELIVERY problem, not a budget one. The most
     * common cause of that shape, a free-tier sender's mail being filed as
     * spam by the receiver, is now covered by SEARCH_FOLDERS rather than by
     * waiting longer; raising this number would not have found that message.
     */
    const TIMEOUT = 300000;
    /**
     * Negative-path wait — used ONLY where the wait is EXPECTED to expire
     * (proving an email is absent). Deliberately not scaled with TIMEOUT:
     * widening a wait that must run to exhaustion only adds dead time to
     * every run.
     */
    const SHORT_TIMEOUT = 15000;
    /** Poll interval for the mailbox polling loop. */
    const POLLING = 5000;
    /**
     * Allowance for ONE unbounded server-side mutation on the critical path.
     *
     * This is the term whose absence broke the earlier attempts at this fix.
     * `clean()`, `mark()` and the ARCHIVED move take NO waitTimeout — they
     * run until the server finishes the delete/expunge/flag/move, and on a
     * free-tier provider that is not fast. A budget that counts only the
     * polling waits charges those mutations to the margin, and the test dies
     * right at the edge: the observed failure was a full 120000 wait plus an
     * unbounded clean() plus a 15000 expiry, landing at 195020ms against a
     * 195000ms budget.
     */
    const MUTATION = 120000;

    /**
     * Margin over the waits themselves: SMTP send, IMAP connect/logout per
     * call, the fact that `_pollMailbox` checks its deadline at the top of
     * the loop and can therefore overrun by one fetch cycle, and ONE trailing
     * best-effort `clean()` for tests that tidy up after their assertions.
     */
    const OVERHEAD = 120000;

    /**
     * Vitest budget for a test that can spend `longWaits` full waits,
     * `shortWaits` expiring short waits, and `mutations` unbounded
     * server-side mutations beyond the single trailing cleanup already
     * covered by OVERHEAD.
     *
     * Counting rules:
     *  - a `rejects`-style absence check ALWAYS burns its whole short wait by
     *    construction (it must expire to prove absence) — count it at 100%,
     *    never optimistically;
     *  - a mutation the test then ASSERTS on is on the critical path and gets
     *    its own MUTATION allowance; a trailing cleanup that runs after the
     *    last assertion is the one OVERHEAD already covers.
     */
    const budget = (longWaits: number, shortWaits = 0, mutations = 0): number =>
        longWaits * TIMEOUT + shortWaits * SHORT_TIMEOUT + mutations * MUTATION + OVERHEAD;

    beforeAll(async () => {
        emailClient = await import('../src/fixtures').then(m => m.setupGlobalEmailClient());
        console.log(`📬 Live mail run tag: ${run.tag} — searching [${SEARCH_FOLDERS.join(', ')}]`);
    });

    // ── Mailbox hygiene ──────────────────────────────────────────────────
    // Deletes THIS RUN's mail and nothing else. Scoping by the run tag is the
    // whole point: a global cleanup here would be the very bug this change
    // exists to fix, because it would delete a concurrent run's in-flight
    // messages exactly the way the no-filter clean test used to.
    //
    // This matters beyond tidiness. Every message left behind is another
    // message the server has to walk on every future SUBJECT search, so an
    // accumulating mailbox slowly inflates the delivery waits that the whole
    // budget model is sized around. It also picks up the orphans a failed
    // attempt left behind before its own trailing clean() could run.
    afterAll(async () => {
        if (!emailClient) return;
        try {
            const removed = await emailClient.clean({
                filters: run.runFilters(),
                folders: SEARCH_FOLDERS,
            });
            console.log(`🧹 Removed ${removed} message(s) belonging to run ${run.tag}`);
        } catch (err) {
            console.warn(`🧹 Run-scoped cleanup for ${run.tag} failed (ignored): %o`, err);
        }
    });

    // One full receive() wait. The trailing clean() needs no allowance: it
    // runs after the last assertion and is the single cleanup OVERHEAD covers.
    test('should send, receive, and clean a plain text email (Exact Match)', { timeout: budget(1) }, async () => {
        const uniqueSubject = run.subject('Test OTP Code');
        const recipient = process.env.RECEIVER_EMAIL!;

        await emailClient.send({
            to: recipient,
            subject: uniqueSubject,
            text: 'Your verification code is 847291.',
        });

        const email = await emailClient.receive({
            filters: [
                { type: EmailFilterType.SUBJECT, value: uniqueSubject },
                { type: EmailFilterType.TO, value: recipient }
            ],
            folders: SEARCH_FOLDERS,
            waitTimeout: TIMEOUT,
            pollInterval: POLLING,
        });

        expect(email.subject).toBe(uniqueSubject);
        expect(email.text).toContain('847291');

        await emailClient.clean({
            filters: [{ type: EmailFilterType.SUBJECT, value: uniqueSubject }],
            folders: SEARCH_FOLDERS,
        });
    });

    // One full receive() wait; trailing clean() covered by OVERHEAD.
    test('should successfully send and verify an HTML formatted email', { timeout: budget(1) }, async () => {
        const uniqueSubject = run.subject('HTML Content Test');
        const recipient = process.env.RECEIVER_EMAIL!;
        const expectedHtml = '<h1 style="color: blue;">Welcome to Civitas!</h1><p>Your journey begins here.</p>';

        await emailClient.send({
            to: recipient,
            subject: uniqueSubject,
            html: expectedHtml,
        });

        const email = await emailClient.receive({
            filters: [{ type: EmailFilterType.SUBJECT, value: uniqueSubject }],
            folders: SEARCH_FOLDERS,
            waitTimeout: TIMEOUT,
        });

        expect(email.subject).toBe(uniqueSubject);
        expect(email.html).toContain('<h1 style="color: blue;">Welcome to Civitas!</h1>');
        expect(email.text).toMatch(/Welcome to Civitas!/i);

        await emailClient.clean({
            filters: [{ type: EmailFilterType.SUBJECT, value: uniqueSubject }],
            folders: SEARCH_FOLDERS,
        });
    });

    // One full receiveAll() wait; the 3 parallel sends and the trailing
    // clean() sit inside OVERHEAD.
    test('should fetch multiple emails using receiveAll', { timeout: budget(1) }, async () => {
        const batchId = run.subject('BatchTest');
        const recipient = process.env.RECEIVER_EMAIL!;

        await Promise.all([
            emailClient.send({ to: recipient, subject: `${batchId} - Invoice 1`, text: 'Amount: $10' }),
            emailClient.send({ to: recipient, subject: `${batchId} - Invoice 2`, text: 'Amount: $20' }),
            emailClient.send({ to: recipient, subject: `${batchId} - Invoice 3`, text: 'Amount: $30' })
        ]);

        const emails = await emailClient.receiveAll({
            filters: [{ type: EmailFilterType.SUBJECT, value: batchId }],
            folders: SEARCH_FOLDERS,
            waitTimeout: TIMEOUT,
            pollInterval: POLLING,
            expectedCount: 3,
        });

        expect(emails.length).toBeGreaterThanOrEqual(3);

        for (const email of emails) {
            expect(email.subject).toContain(batchId);
            expect(email.text).toMatch(/Amount:\s*\$/);
        }

        await emailClient.clean({
            filters: [{ type: EmailFilterType.SUBJECT, value: batchId }],
            folders: SEARCH_FOLDERS,
        });
    });

    // One full receive() wait; trailing clean() covered by OVERHEAD.
    test('should match emails using the CONTENT filter', { timeout: budget(1) }, async () => {
        const uniqueSubject = run.subject('Content Filter Test');
        const uniqueSecret = `SECRET_KEY_${run.tag}`;
        const recipient = process.env.RECEIVER_EMAIL!;

        await emailClient.send({
            to: recipient,
            subject: uniqueSubject,
            text: `Please store this key securely: ${uniqueSecret}`,
        });

        const email = await emailClient.receive({
            filters: [
                { type: EmailFilterType.SUBJECT, value: uniqueSubject },
                { type: EmailFilterType.CONTENT, value: uniqueSecret }
            ],
            folders: SEARCH_FOLDERS,
            waitTimeout: TIMEOUT,
        });

        expect(email.text).toContain(uniqueSecret);

        await emailClient.clean({
            filters: [{ type: EmailFilterType.SUBJECT, value: uniqueSubject }],
            folders: SEARCH_FOLDERS,
        });
    });

    // One short wait that is expected to expire.
    test('should throw a timeout error if no email matches the criteria', { timeout: budget(0, 1) }, async () => {
        const shortTimeout = SHORT_TIMEOUT;
        const impossibleSubject = run.subject('This email will never exist');

        await expect(
            emailClient.receive({
                filters: [{ type: EmailFilterType.SUBJECT, value: impossibleSubject }],
                folders: SEARCH_FOLDERS,
                waitTimeout: shortTimeout,
                pollInterval: POLLING,
            })
        ).rejects.toThrow(new RegExp(`within ${shortTimeout}ms`));
    });

    // One full receiveAll() wait; trailing clean() covered by OVERHEAD.
    test('should apply filters client-side to a batch of fetched emails (applyFilters E2E)', { timeout: budget(1) }, async () => {
        const batchId = run.subject('ClientFilterTest');
        const uniqueToken = `XTOKEN_${run.tag}`;
        const recipient = process.env.RECEIVER_EMAIL!;

        await Promise.all([
            emailClient.send({ to: recipient, subject: `${batchId} - Target`, text: `Match on ${uniqueToken}` }),
            emailClient.send({ to: recipient, subject: `${batchId} - Ignore`, text: 'No match here' }),
        ]);

        const allEmails = await emailClient.receiveAll({
            filters: [{ type: EmailFilterType.SUBJECT, value: batchId }],
            folders: SEARCH_FOLDERS,
            waitTimeout: TIMEOUT,
            pollInterval: POLLING,
            expectedCount: 2,
        });

        expect(allEmails.length).toBeGreaterThanOrEqual(2);

        // Now we can safely test the client-side filtering with the unique token
        const filtered = emailClient.applyFilters(allEmails, [
            { type: EmailFilterType.CONTENT, value: uniqueToken }
        ]);

        expect(filtered).toHaveLength(1);
        expect(filtered[0].subject).toContain('Target');

        await emailClient.clean({
            filters: [{ type: EmailFilterType.SUBJECT, value: batchId }],
            folders: SEARCH_FOLDERS,
        });
    });

    test('should accurately extract HTML and Text from raw source (extractHtmlFromSource / extractTextFromSource)', async () => {
        const rawEmailSource = [
            'Content-Type: multipart/alternative; boundary="test-boundary-123"',
            '',
            '--test-boundary-123',
            'Content-Type: text/plain; charset="utf-8"',
            '',
            'Fallback text content',
            '--test-boundary-123',
            'Content-Type: text/html; charset="utf-8"',
            '',
            '<div><h1>Title</h1><p>Paragraph</p></div>',
            '--test-boundary-123--'
        ].join('\r\n');

        const extractedHtml = (emailClient as any).extractHtmlFromSource(rawEmailSource);
        expect(extractedHtml).toContain('<h1>Title</h1>');

        const extractedText = (emailClient as any).extractTextFromSource(rawEmailSource);
        expect(extractedText).toContain('Fallback text content');
    });

    // One full receive() wait, then 3 asserted mark() mutations (unbounded,
    // no waitTimeout) before the trailing clean().
    test('should successfully apply standard IMAP flags (READ, UNREAD, FLAGGED) using mark()', { timeout: budget(1, 0, 1) }, async () => {
        const uniqueSubject = run.subject('Mark Standard Flags Test');
        const recipient = process.env.RECEIVER_EMAIL!;

        await emailClient.send({
            to: recipient,
            subject: uniqueSubject,
            text: 'Testing the standard mark() enumerations.',
        });

        await emailClient.receive({
            filters: [{ type: EmailFilterType.SUBJECT, value: uniqueSubject }],
            folders: SEARCH_FOLDERS,
            waitTimeout: TIMEOUT,
        });

        const filterCriteria = [{ type: EmailFilterType.SUBJECT, value: uniqueSubject }];

        const readCount = await emailClient.mark({
            action: EmailMarkAction.READ,
            filters: filterCriteria,
            folders: SEARCH_FOLDERS,
        });
        expect(readCount).toBe(1);

        const unreadCount = await emailClient.mark({
            action: EmailMarkAction.UNREAD,
            filters: filterCriteria,
            folders: SEARCH_FOLDERS,
        });
        expect(unreadCount).toBe(1);

        const flaggedCount = await emailClient.mark({
            action: EmailMarkAction.FLAGGED,
            filters: filterCriteria,
            folders: SEARCH_FOLDERS,
        });
        expect(flaggedCount).toBe(1);

        await emailClient.clean({ filters: filterCriteria, folders: SEARCH_FOLDERS });
    });

    // One full receive() wait, then a long serial tail of UNBOUNDED server
    // mutations: 4 asserted mark() calls, each interleaved with a
    // getImapFlags() call that opens, searches, fetches and logs out of its
    // own IMAP connection, plus clean(). This tail — not the wait — is what
    // exhausted the original 180000 budget in the release run, so it is
    // charged as two mutation allowances instead of being left to the margin.
    //
    // This is also the test that a concurrent run's unfiltered clean used to
    // destroy: it asserts `flags` has length 1, and got 0 because the message
    // had been deleted by another run between the receive() and the mark().
    // The subject is now run-scoped and no other run's clean can select it.
    test('should verify mark() actually modifies the correct email flags on the server', { timeout: budget(1, 0, 2) }, async () => {
        const uniqueSubject = run.subject('Mark Verify Flags');
        const recipient = process.env.RECEIVER_EMAIL!;

        await emailClient.send({
            to: recipient,
            subject: uniqueSubject,
            text: 'Verifying flags are applied to the correct email.',
        });

        await emailClient.receive({
            filters: [{ type: EmailFilterType.SUBJECT, value: uniqueSubject }],
            folders: SEARCH_FOLDERS,
            waitTimeout: TIMEOUT,
            pollInterval: POLLING,
        });

        const filterCriteria = [{ type: EmailFilterType.SUBJECT, value: uniqueSubject }];
        const markOptions = { filters: filterCriteria, folders: SEARCH_FOLDERS };

        // Mark as READ and verify \\Seen flag is present
        await emailClient.mark({ action: EmailMarkAction.READ, ...markOptions });
        let flags = await getImapFlags(uniqueSubject);
        expect(flags).toHaveLength(1);
        expect(flags[0].has('\\Seen')).toBe(true);

        // Mark as UNREAD and verify \\Seen flag is removed
        await emailClient.mark({ action: EmailMarkAction.UNREAD, ...markOptions });
        flags = await getImapFlags(uniqueSubject);
        expect(flags).toHaveLength(1);
        expect(flags[0].has('\\Seen')).toBe(false);

        // Mark as FLAGGED and verify \\Flagged is present
        await emailClient.mark({ action: EmailMarkAction.FLAGGED, ...markOptions });
        flags = await getImapFlags(uniqueSubject);
        expect(flags).toHaveLength(1);
        expect(flags[0].has('\\Flagged')).toBe(true);

        // Mark as UNFLAGGED and verify \\Flagged is removed
        await emailClient.mark({ action: EmailMarkAction.UNFLAGGED, ...markOptions });
        flags = await getImapFlags(uniqueSubject);
        expect(flags).toHaveLength(1);
        expect(flags[0].has('\\Flagged')).toBe(false);

        await emailClient.clean({ filters: filterCriteria, folders: SEARCH_FOLDERS });
    });

    // One full receive() wait plus ONE asserted mark(); that single mutation
    // plus the trailing clean() is what OVERHEAD is sized for.
    test('should apply custom IMAP string flags using mark()', { timeout: budget(1) }, async () => {
        const uniqueSubject = run.subject('Mark Custom Flags Test');
        const recipient = process.env.RECEIVER_EMAIL!;

        await emailClient.send({
            to: recipient,
            subject: uniqueSubject,
            text: 'Testing custom string arrays in the mark method.',
        });

        await emailClient.receive({
            filters: [{ type: EmailFilterType.SUBJECT, value: uniqueSubject }],
            folders: SEARCH_FOLDERS,
            waitTimeout: TIMEOUT,
        });

        const customFlagCount = await emailClient.mark({
            action: ['\\Draft', '\\Answered'],
            filters: [{ type: EmailFilterType.SUBJECT, value: uniqueSubject }],
            folders: SEARCH_FOLDERS,
        });

        expect(customFlagCount).toBe(1);

        await emailClient.clean({
            filters: [{ type: EmailFilterType.SUBJECT, value: uniqueSubject }],
            folders: SEARCH_FOLDERS,
        });
    });

    // ─── RECEIVE() LATEST EMAIL ──────────────────────────────────────────

    // Worst path is two full waits: one receiveAll() and one receive().
    // It used to be three, because a receiveAll() that expired on the INBOX
    // was retried against the spam folder in a `.catch` — a hand-rolled,
    // single-test version of the folder set every call now searches. With
    // SEARCH_FOLDERS the fallback is gone and so is the wait it could spend.
    test('receive() should return the most recent email when multiple match', { timeout: budget(2) }, async () => {
        const batchId = run.subject('LatestEmailTest');
        const recipient = process.env.RECEIVER_EMAIL!;

        // Send two emails with the same subject but different content
        await emailClient.send({
            to: recipient,
            subject: `${batchId}`,
            text: 'First email - older',
        });

        // Small delay to ensure distinct timestamps
        await new Promise(resolve => setTimeout(resolve, 2000));

        await emailClient.send({
            to: recipient,
            subject: `${batchId}`,
            text: 'Second email - newer',
        });

        const allEmails = await emailClient.receiveAll({
            filters: [{ type: EmailFilterType.SUBJECT, value: batchId }],
            folders: SEARCH_FOLDERS,
            waitTimeout: TIMEOUT,
            pollInterval: POLLING,
            expectedCount: 2,
        });

        expect(allEmails.length).toBeGreaterThanOrEqual(2);

        // Now test that receive() returns the most recent one
        const latestEmail = await emailClient.receive({
            filters: [{ type: EmailFilterType.SUBJECT, value: batchId }],
            folders: SEARCH_FOLDERS,
            waitTimeout: TIMEOUT,
            pollInterval: POLLING,
        });

        // The latest email should be the second one sent.
        // Note: the sending provider may prepend tracking URLs to plain text,
        // so use a partial match.
        expect(latestEmail.text).toContain('newer');
        expect(latestEmail.text).not.toContain('older');

        // Verify receive() picked the email with the later date
        const olderEmail = allEmails.find(e => e.text.includes('older'));
        expect(olderEmail).toBeDefined();
        expect(latestEmail.date.getTime()).toBeGreaterThan(olderEmail!.date.getTime());

        await emailClient.clean({
            filters: [{ type: EmailFilterType.SUBJECT, value: batchId }],
            folders: SEARCH_FOLDERS,
        });
    });

    // ─── SEND() ────────────────────────────────────────────────────────────

    describe('send()', () => {
        // One full receive() wait; trailing clean() covered by OVERHEAD.
        test('should load and send HTML content from a local file (htmlFile option)', { timeout: budget(1) }, async () => {
            const uniqueSubject = run.subject('HtmlFile Send Test');
            const recipient = process.env.RECEIVER_EMAIL!;

            const tmpFile = path.join(os.tmpdir(), `test-email-${run.tag}.html`);
            fs.writeFileSync(tmpFile, '<h2>From file</h2><p>Loaded from disk.</p>', 'utf-8');

            try {
                await emailClient.send({
                    to: recipient,
                    subject: uniqueSubject,
                    htmlFile: tmpFile,
                });

                const email = await emailClient.receive({
                    filters: [{ type: EmailFilterType.SUBJECT, value: uniqueSubject }],
                    folders: SEARCH_FOLDERS,
                    waitTimeout: TIMEOUT,
                });

                expect(email.html).toContain('From file');
                expect(email.html).toContain('Loaded from disk');
            } finally {
                fs.unlinkSync(tmpFile);
                await emailClient.clean({
                    filters: [{ type: EmailFilterType.SUBJECT, value: uniqueSubject }],
                    folders: SEARCH_FOLDERS,
                });
            }
        });

        test('should throw if the htmlFile path does not exist', async () => {
            await expect(
                emailClient.send({
                    to: process.env.RECEIVER_EMAIL!,
                    subject: 'Should not send',
                    htmlFile: '/tmp/this-file-does-not-exist-at-all.html',
                })
            ).rejects.toThrow(/HTML file not found/);
        });
    });

    // ─── RECEIVEALL() TIMEOUT ──────────────────────────────────────────────

    describe('receiveAll()', () => {
        // One short wait that is expected to expire.
        test('should throw a timeout error when no emails match within the deadline', { timeout: budget(0, 1) }, async () => {
            const shortTimeout = SHORT_TIMEOUT;
            const impossibleSubject = run.subject('receiveAll-never-exists');

            await expect(
                emailClient.receiveAll({
                    filters: [{ type: EmailFilterType.SUBJECT, value: impossibleSubject }],
                    folders: SEARCH_FOLDERS,
                    waitTimeout: shortTimeout,
                    pollInterval: POLLING,
                })
            ).rejects.toThrow(new RegExp(`within ${shortTimeout}ms`));
        });
    });

    // ─── FILTER VALIDATION ─────────────────────────────────────────────────

    describe('receive() / receiveAll() — filter validation', () => {
        test('should throw when no filters are supplied to receive()', async () => {
            await expect(
                emailClient.receive({
                    filters: [],
                    waitTimeout: TIMEOUT,
                })
            ).rejects.toThrow(/At least one email filter is required/);
        });

        test('should throw when no filters are supplied to receiveAll()', async () => {
            await expect(
                emailClient.receiveAll({
                    filters: [],
                    waitTimeout: TIMEOUT,
                })
            ).rejects.toThrow(/At least one email filter is required/);
        });
    });

    // ─── CLEAN() ───────────────────────────────────────────────────────────

    describe('clean()', () => {
        test('should return 0 when no emails match the filter criteria', async () => {
            const deletedCount = await emailClient.clean({
                filters: [{ type: EmailFilterType.SUBJECT, value: run.subject('no-such-email') }],
                folders: SEARCH_FOLDERS,
            });

            expect(deletedCount).toBe(0);
        });

        // Single named folder — the strict path, which must still report the
        // missing folder rather than silently searching nothing.
        test('should throw when the specified folder does not exist on the server', async () => {
            await expect(
                emailClient.clean({
                    filters: [{ type: EmailFilterType.SUBJECT, value: run.subject('folder-test') }],
                    folder: 'Trash',
                })
            ).rejects.toThrow(/Failed to open folder "Trash"/i);
        });

        // The test that exposed the missing mutation term. It spends THREE
        // things, not two: a full receive() wait, an UNBOUNDED clean()
        // (delete + expunge, no waitTimeout) whose result it asserts on, and
        // a short wait that is GUARANTEED to burn in full because it must
        // expire to prove the email is gone. Charging that clean() to the
        // margin is what made this test die at exactly its budget — 195020ms
        // against 195000ms.
        test('should verify emails are permanently removed after clean()', { timeout: budget(1, 1, 1) }, async () => {
            const uniqueSubject = run.subject('CleanVerify');
            const recipient = process.env.RECEIVER_EMAIL!;

            await emailClient.send({ to: recipient, subject: uniqueSubject, text: 'This email should be deleted.' });

            await emailClient.receive({
                filters: [{ type: EmailFilterType.SUBJECT, value: uniqueSubject }],
                folders: SEARCH_FOLDERS,
                waitTimeout: TIMEOUT,
                pollInterval: POLLING,
            });

            const deletedCount = await emailClient.clean({
                filters: [{ type: EmailFilterType.SUBJECT, value: uniqueSubject }],
                folders: SEARCH_FOLDERS,
            });
            expect(deletedCount).toBe(1);

            // Verify the email is actually gone by attempting to receive it again
            await expect(
                emailClient.receive({
                    filters: [{ type: EmailFilterType.SUBJECT, value: uniqueSubject }],
                    folders: SEARCH_FOLDERS,
                    waitTimeout: SHORT_TIMEOUT,
                    pollInterval: POLLING,
                })
            ).rejects.toThrow(new RegExp(`within ${SHORT_TIMEOUT}ms`));
        });

        // ── The unfiltered-clean path, on a folder this run owns ─────────
        //
        // This test used to call `clean()` with no options at all, which
        // deletes EVERY message in the shared INBOX — including the in-flight
        // fixtures of any other run against the same mailbox. That is exactly
        // what broke the release run described at the top of this file: a
        // concurrent run's message was received and then vanished before its
        // flags could be asserted.
        //
        // The assertion is NOT weakened — it is strengthened. It still proves
        // that a clean with no filters empties its target: the folder is
        // seeded with a known number of messages, the returned delete count
        // must equal that number exactly (the old test could only manage
        // `>= 2`, because it had no idea what else was in the inbox), and the
        // folder must then be verifiably empty.
        //
        // The folder is seeded over IMAP APPEND rather than by sending mail.
        // Nothing about the unfiltered-clean path depends on how the messages
        // got there, and appending removes both the delivery latency and the
        // possibility that the receiving provider files a fixture somewhere
        // the test is not looking.
        //
        // Two unbounded mutations on the critical path: the seed and the
        // clean. No delivery wait is spent at all.
        test('should delete ALL emails in a folder when called with no filters', { timeout: budget(0, 0, 2) }, async () => {
            const folder = run.folder('cleanall');
            const seeded = [
                `${run.subject('CleanAll')} - A`,
                `${run.subject('CleanAll')} - B`,
                `${run.subject('CleanAll')} - C`,
            ];

            try {
                await seedFolder(folder, seeded);
                expect(await countMessages(folder)).toBe(seeded.length);

                // No filters: every message in the folder must go.
                const deletedCount = await emailClient.clean({ folder });

                expect(deletedCount).toBe(seeded.length);
                expect(await countMessages(folder)).toBe(0);
            } finally {
                await dropFolder(folder);
            }
        });

        // ─── MARK() ────────────────────────────────────────────────────────────

        describe('mark() — UNFLAGGED, ARCHIVED, and error cases', () => {
            // One full receive() wait + 2 asserted mark() mutations + clean().
            test('should mark an email as UNFLAGGED', { timeout: budget(1, 0, 1) }, async () => {
                const uniqueSubject = run.subject('Mark UNFLAGGED Test');
                const recipient = process.env.RECEIVER_EMAIL!;

                await emailClient.send({ to: recipient, subject: uniqueSubject, text: 'unflagged test' });
                await emailClient.receive({
                    filters: [{ type: EmailFilterType.SUBJECT, value: uniqueSubject }],
                    folders: SEARCH_FOLDERS,
                    waitTimeout: TIMEOUT,
                });

                const filterCriteria = [{ type: EmailFilterType.SUBJECT, value: uniqueSubject }];

                await emailClient.mark({ action: EmailMarkAction.FLAGGED, filters: filterCriteria, folders: SEARCH_FOLDERS });

                const count = await emailClient.mark({
                    action: EmailMarkAction.UNFLAGGED,
                    filters: filterCriteria,
                    folders: SEARCH_FOLDERS,
                });

                expect(count).toBe(1);

                await emailClient.clean({ filters: filterCriteria, folders: SEARCH_FOLDERS });
            });

            // Two full waits (receive from the search folders, then receive
            // from the archive folder), one short wait that is guaranteed to
            // expire, and an asserted ARCHIVED mark() — a server-side MOVE
            // with no waitTimeout, so it gets its own mutation allowance.
            test('should archive an email by moving it to the archive folder', { timeout: budget(2, 1, 1) }, async () => {
                const uniqueSubject = run.subject('Mark ARCHIVED Test');
                const recipient = process.env.RECEIVER_EMAIL!;

                const testArchiveFolder = '\\Flagged';

                await emailClient.send({ to: recipient, subject: uniqueSubject, text: 'archive test' });
                await emailClient.receive({
                    filters: [{ type: EmailFilterType.SUBJECT, value: uniqueSubject }],
                    folders: SEARCH_FOLDERS,
                    waitTimeout: TIMEOUT,
                });

                const count = await emailClient.mark({
                    action: EmailMarkAction.ARCHIVED,
                    filters: [{ type: EmailFilterType.SUBJECT, value: uniqueSubject }],
                    folders: SEARCH_FOLDERS,
                    archiveFolder: testArchiveFolder,
                });

                expect(count).toBe(1);

                // Verify the email is no longer where it was delivered
                await expect(
                    emailClient.receive({
                        filters: [{ type: EmailFilterType.SUBJECT, value: uniqueSubject }],
                        folders: SEARCH_FOLDERS,
                        waitTimeout: SHORT_TIMEOUT,
                        pollInterval: POLLING,
                    })
                ).rejects.toThrow(new RegExp(`within ${SHORT_TIMEOUT}ms`));

                // Verify the email arrived in the archive folder
                const archived = await emailClient.receive({
                    filters: [{ type: EmailFilterType.SUBJECT, value: uniqueSubject }],
                    folder: testArchiveFolder,
                    waitTimeout: TIMEOUT,
                    pollInterval: POLLING,
                });
                expect(archived.subject).toContain(uniqueSubject);

                await emailClient.clean({
                    filters: [{ type: EmailFilterType.SUBJECT, value: uniqueSubject }],
                    folder: testArchiveFolder,
                });
            });

            // One full receive() wait. The mark() here rejects on validation
            // before touching the server, so it is not a mutation.
            test('should throw for an unsupported mark action string', { timeout: budget(1) }, async () => {
                const uniqueSubject = run.subject('Mark Bad Action Test');
                const recipient = process.env.RECEIVER_EMAIL!;

                await emailClient.send({ to: recipient, subject: uniqueSubject, text: 'bad action' });

                try {
                    await emailClient.receive({
                        filters: [{ type: EmailFilterType.SUBJECT, value: uniqueSubject }],
                        folders: SEARCH_FOLDERS,
                        waitTimeout: TIMEOUT,
                    });

                    await expect(
                        emailClient.mark({
                            action: 'NONEXISTENT_ACTION' as unknown as EmailMarkAction,
                            filters: [{ type: EmailFilterType.SUBJECT, value: uniqueSubject }],
                            folders: SEARCH_FOLDERS,
                        })
                    ).rejects.toThrow(/Unsupported mark action/);
                } finally {
                    await emailClient.clean({
                        filters: [{ type: EmailFilterType.SUBJECT, value: uniqueSubject }],
                        folders: SEARCH_FOLDERS,
                    });
                }
            });

            test('should return 0 when mark() finds no matching emails', async () => {
                const count = await emailClient.mark({
                    action: EmailMarkAction.READ,
                    filters: [{ type: EmailFilterType.SUBJECT, value: run.subject('no-such-email') }],
                    folders: SEARCH_FOLDERS,
                });

                expect(count).toBe(0);
            });
        });

        // ─── APPLYFILTERS() ────────────────────────────────────────────────────

        describe('applyFilters()', () => {
            test('should return all candidates when the filters array is empty', () => {
                const candidates = [
                    { subject: 'a', from: '', to: '', html: '', text: 'alpha', date: new Date(), filePath: '' },
                    { subject: 'b', from: '', to: '', html: '', text: 'beta', date: new Date(), filePath: '' },
                ];

                const result = (emailClient as any).applyFilters(candidates, []);
                expect(result).toHaveLength(2);
            });

            test('should return an empty array when no candidates match', () => {
                const candidates = [
                    { subject: 'hello', from: '', to: '', html: '', text: 'world', date: new Date(), filePath: '' },
                ];

                const result = (emailClient as any).applyFilters(candidates, [
                    { type: EmailFilterType.CONTENT, value: 'will-never-match-xyz' },
                ]);

                expect(result).toHaveLength(0);
            });

            test('should ignore SINCE filters during client-side applyFilters', () => {
                const candidates = [
                    { subject: 'test', from: '', to: '', html: '', text: 'some content', date: new Date(), filePath: '' },
                ];

                const result = (emailClient as any).applyFilters(candidates, [
                    { type: EmailFilterType.SINCE, value: new Date('2099-01-01') },
                ]);

                expect(result).toHaveLength(1);
            });

            test('should fall back to partial case-insensitive match when no exact match exists', () => {
                const candidates = [
                    { subject: 'Hello World', from: '', to: '', html: '', text: '', date: new Date(), filePath: '' },
                    { subject: 'Goodbye', from: '', to: '', html: '', text: '', date: new Date(), filePath: '' },
                ];

                const result = (emailClient as any).applyFilters(candidates, [
                    { type: EmailFilterType.SUBJECT, value: 'hello world' },
                ]);

                expect(result).toHaveLength(1);
                expect(result[0].subject).toBe('Hello World');
            });
        });

        // ─── EXTRACT*FROMSOURCE() ──────────────────────────────────────────────

        describe('extractHtmlFromSource() / extractTextFromSource() — edge cases', () => {
            test('should return empty string for an empty source', () => {
                expect((emailClient as any).extractHtmlFromSource('')).toBe('');
                expect((emailClient as any).extractTextFromSource('')).toBe('');
            });

            test('should decode base64-encoded MIME part content', () => {
                const htmlContent = '<p>base64 decoded content</p>';
                const encoded = Buffer.from(htmlContent).toString('base64');

                const rawEmailSource = [
                    'Content-Type: multipart/alternative; boundary="b64-boundary"',
                    '',
                    '--b64-boundary',
                    'Content-Type: text/html; charset="utf-8"',
                    'Content-Transfer-Encoding: base64',
                    '',
                    encoded,
                    '--b64-boundary--',
                ].join('\r\n');

                const result = (emailClient as any).extractHtmlFromSource(rawEmailSource);
                expect(result).toContain('base64 decoded content');
            });

            test('should decode quoted-printable encoded MIME part content', () => {
                const qpEncoded = 'caf=E9 from quoted-printable';

                const rawEmailSource = [
                    'Content-Type: multipart/alternative; boundary="qp-boundary"',
                    '',
                    '--qp-boundary',
                    'Content-Type: text/plain; charset="utf-8"',
                    'Content-Transfer-Encoding: quoted-printable',
                    '',
                    qpEncoded,
                    '--qp-boundary--',
                ].join('\r\n');

                const result = (emailClient as any).extractTextFromSource(rawEmailSource);
                expect(result).toContain('café from quoted-printable');
            });

            test('should return empty string when the requested content-type is absent', () => {
                const rawEmailSource = [
                    'Content-Type: multipart/alternative; boundary="plain-only-boundary"',
                    '',
                    '--plain-only-boundary',
                    'Content-Type: text/plain; charset="utf-8"',
                    '',
                    'Only plain text here.',
                    '--plain-only-boundary--',
                ].join('\r\n');

                const result = (emailClient as any).extractHtmlFromSource(rawEmailSource);
                expect(result).toBe('');
            });

            test('should extract content from a non-multipart single-part MIME source', () => {
                const rawSinglePart = [
                    'Content-Type: text/plain; charset="utf-8"',
                    'Content-Transfer-Encoding: 7bit',
                    '',
                    'Single part plain text.',
                ].join('\r\n');

                const result = (emailClient as any).extractTextFromSource(rawSinglePart);
                expect(result).toContain('Single part plain text.');
            });
        });

        // ─── BUILDSEARCHCRITERIA() ─────────────────────────────────────────────

        describe('buildSearchCriteria() — unknown filter type', () => {
            test('should throw for an unrecognised EmailFilterType', () => {
                expect(() =>
                    (emailClient as any).buildSearchCriteria([
                        { type: 'UNKNOWN_TYPE', value: 'something' },
                    ])
                ).toThrow(/Unknown email filter type/);
            });
        });
    });
});
