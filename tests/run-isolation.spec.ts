import { describe, test, expect, afterEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EmailClient } from '../src/EmailClient.js';
import { EmailFilterType, ReceivedEmail } from '../src/types.js';
import { RunScope, createRunTag } from './helpers/runScope.js';
import { FlakeLedger } from './helpers/flakeLedger.js';

/**
 * Proves the per-run isolation property WITHOUT touching a mail server.
 *
 * The live suite's real verification is the live workflow, which needs mailbox
 * credentials. The property these tests cover — that one run's filters can
 * never select another run's messages — is a property of subject and filter
 * CONSTRUCTION, not of the network, so it can be verified here and get a
 * regression guard that runs on every push instead of only when a mailbox is
 * reachable.
 */

/** Builds a message shaped like one the live suite would receive. */
function message(subject: string): ReceivedEmail {
    return { subject, from: 'a@b.c', to: 'd@e.f', html: '', text: '', date: new Date(), filePath: '' } as ReceivedEmail;
}

/** A client with throwaway credentials — nothing here performs I/O. */
const client = new EmailClient({
    smtp: { email: 'sender@example.invalid', password: 'x', host: 'smtp.example.invalid' },
    imap: { email: 'receiver@example.invalid', password: 'x' },
});

describe('RunScope — per-run isolation', () => {
    test('two concurrent runs get different tags', () => {
        const tags = new Set(Array.from({ length: 200 }, () => createRunTag({} as NodeJS.ProcessEnv)));
        expect(tags.size).toBe(200);
    });

    test('a CI tag carries the workflow run id and attempt, so leftover mail is traceable', () => {
        const tag = createRunTag({ GITHUB_RUN_ID: '31577198070', GITHUB_RUN_ATTEMPT: '2' } as unknown as NodeJS.ProcessEnv);
        expect(tag).toMatch(/^ecrun-31577198070-2-[0-9a-f]{8}$/);
    });

    test('two runs of the same workflow attempt still get different tags', () => {
        const env = { GITHUB_RUN_ID: '1', GITHUB_RUN_ATTEMPT: '1' } as unknown as NodeJS.ProcessEnv;
        expect(createRunTag(env)).not.toBe(createRunTag(env));
    });

    test('every subject a run hands out is unique and carries that run tag', () => {
        const run = new RunScope('ecrun-A');
        const subjects = [run.subject('Mark Verify Flags'), run.subject('Mark Verify Flags'), run.subject('Clean Verify')];

        expect(new Set(subjects).size).toBe(3);
        for (const subject of subjects) expect(subject).toContain('ecrun-A');
    });

    // The property the whole design rests on.
    test("a run's filter matches its own mail and cannot match another run's", () => {
        const runA = new RunScope('ecrun-A');
        const runB = new RunScope('ecrun-B');

        // Both runs exercise the SAME tests, so they produce the same labels.
        const mailbox = [
            message(runA.subject('Mark Verify Flags')),
            message(runA.subject('Clean Verify')),
            message(runB.subject('Mark Verify Flags')),
            message(runB.subject('Clean Verify')),
        ];

        const matchedByB = client.applyFilters(mailbox, runB.runFilters());

        expect(matchedByB).toHaveLength(2);
        for (const email of matchedByB) expect(email.subject).toContain('ecrun-B');
        // Explicitly: run B's cleanup cannot reach run A's in-flight mail.
        for (const email of matchedByB) expect(email.subject).not.toContain('ecrun-A');
    });

    test("a run's IMAP search criteria name only that run", () => {
        const runB = new RunScope('ecrun-B');
        const criteria = (client as any).buildSearchCriteria(runB.runFilters());

        expect(criteria).toEqual({ subject: 'ecrun-B' });
    });

    // Why the pre-existing `Date.now()` component was not sufficient on its own.
    test('a bare timestamp does not separate runs the way a run tag does', () => {
        const now = Date.now();
        const legacyA = `Mark Verify Flags ${now}`;
        const legacyB = `Mark Verify Flags ${now}`;

        // Two runs that reach the same test in the same millisecond collide...
        expect(legacyA).toBe(legacyB);

        // ...whereas run tags do not, even when the timestamps do.
        expect(new RunScope('ecrun-A').subject('Mark Verify Flags'))
            .not.toBe(new RunScope('ecrun-B').subject('Mark Verify Flags'));
    });

    test('a run-owned folder name is namespaced to that run', () => {
        const runA = new RunScope('ecrun-A');
        const runB = new RunScope('ecrun-B');

        expect(runA.folder('cleanall')).toBe('ecrun-A-cleanall');
        expect(runA.folder('cleanall')).not.toBe(runB.folder('cleanall'));
    });
});

describe('folder scope normalisation', () => {
    const normalize = (folder?: string, folders?: string[]): string[] =>
        (client as any).normalizeFolders(folder, folders);

    test('defaults to INBOX when neither option is supplied', () => {
        expect(normalize()).toEqual(['INBOX']);
    });

    test('honours a single explicit folder', () => {
        expect(normalize('[Gmail]/Spam')).toEqual(['[Gmail]/Spam']);
    });

    test('a folder list takes precedence over the singular option', () => {
        expect(normalize('INBOX', ['[Gmail]/Spam', '\\Junk'])).toEqual(['[Gmail]/Spam', '\\Junk']);
    });

    test('an empty folder list falls back to the singular option', () => {
        expect(normalize('\\Sent', [])).toEqual(['\\Sent']);
    });

    test('the returned list is a copy, so a caller cannot mutate the search scope after the fact', () => {
        const requested = ['INBOX', '[Gmail]/Spam'];
        const normalized = normalize(undefined, requested);
        requested.push('[Gmail]/Trash');

        expect(normalized).toEqual(['INBOX', '[Gmail]/Spam']);
    });
});

describe('multi-folder UID keying', () => {
    // UIDs are per-mailbox: message 42 in INBOX and message 42 in Spam are
    // different messages. A poll that searches both folders with a single
    // numeric seen-set would treat the second as already fetched and silently
    // drop it — the exact shape of "the mail was there but the suite never saw
    // it". The seen-set is therefore keyed by folder.
    test('the same UID in two folders is two distinct seen-keys', () => {
        const seen = new Set<string>();
        seen.add('INBOX:42');

        expect(seen.has('INBOX:42')).toBe(true);
        expect(seen.has('[Gmail]/Spam:42')).toBe(false);
    });
});

describe('FlakeLedger — retried tests must not look like clean passes', () => {
    test('a test that passed first time is not recorded', () => {
        const ledger = new FlakeLedger();
        ledger.record('stable test', 0, 'pass');
        ledger.record('never ran', undefined, undefined);

        expect(ledger.isEmpty).toBe(true);
    });

    test('a test that passed only on retry is recorded with its attempt count', () => {
        const ledger = new FlakeLedger();
        ledger.record('flaky test', 1, 'pass');

        expect(ledger.entries).toEqual([{ name: 'flaky test', attempts: 2, passed: true }]);
    });

    test('a test that failed after exhausting its retries is recorded as failed', () => {
        const ledger = new FlakeLedger();
        ledger.record('broken test', 2, 'fail');

        expect(ledger.entries[0]).toEqual({ name: 'broken test', attempts: 3, passed: false });
    });

    test('every unstable test raises a workflow warning annotation', () => {
        const ledger = new FlakeLedger();
        ledger.record('flaky test', 1, 'pass');

        expect(ledger.annotations()).toEqual([
            '::warning title=Flaky live mail test::flaky test needed 2 attempts',
        ]);
    });

    test('the job summary names the run and every unstable test', () => {
        const ledger = new FlakeLedger();
        ledger.record('flaky test', 1, 'pass');
        ledger.record('broken test', 2, 'fail');

        const markdown = ledger.summaryMarkdown('ecrun-A');

        expect(markdown).toContain('ecrun-A');
        expect(markdown).toContain('| flaky test | 2 | passed on retry |');
        expect(markdown).toContain('| broken test | 3 | failed |');
    });

    test('publishing appends the summary to the GitHub step summary file', () => {
        const summaryPath = path.join(os.tmpdir(), `flake-summary-${Date.now()}.md`);
        const ledger = new FlakeLedger();
        ledger.record('flaky test', 1, 'pass');

        try {
            ledger.publish('ecrun-A', { GITHUB_STEP_SUMMARY: summaryPath } as unknown as NodeJS.ProcessEnv);
            expect(fs.readFileSync(summaryPath, 'utf-8')).toContain('| flaky test | 2 | passed on retry |');
        } finally {
            fs.rmSync(summaryPath, { force: true });
        }
    });

    test('publishing a clean run writes nothing at all', () => {
        const summaryPath = path.join(os.tmpdir(), `flake-summary-clean-${Date.now()}.md`);
        const ledger = new FlakeLedger();
        ledger.record('stable test', 0, 'pass');

        ledger.publish('ecrun-A', { GITHUB_STEP_SUMMARY: summaryPath } as unknown as NodeJS.ProcessEnv);

        expect(fs.existsSync(summaryPath)).toBe(false);
    });

    test('an unwritable summary path is reported but never fails the run', () => {
        const ledger = new FlakeLedger();
        ledger.record('flaky test', 1, 'pass');

        expect(() =>
            ledger.publish('ecrun-A', { GITHUB_STEP_SUMMARY: '/nonexistent-dir/summary.md' } as unknown as NodeJS.ProcessEnv)
        ).not.toThrow();
    });
});

// Proves the ledger is fed by the mechanism the live suite actually relies on:
// vitest's own retry bookkeeping, read through the afterEach task context. If
// vitest ever changes where the retry count lives, this fails here rather than
// silently reporting every live run as clean.
describe('vitest retry bookkeeping feeds the ledger', () => {
    const wired = new FlakeLedger();
    let attempts = 0;

    describe('inner', { retry: 2 }, () => {
        test('needs two attempts', () => {
            attempts += 1;
            expect(attempts).toBeGreaterThan(1);
        });

        test('passes first time', () => {
            expect(true).toBe(true);
        });

        afterEach((ctx) => {
            wired.record(ctx.task.name, ctx.task.result?.retryCount, ctx.task.result?.state);
        });
    });

    afterAll(() => {
        // Only the retried test is recorded, and only its final attempt.
        expect(wired.entries).toEqual([{ name: 'needs two attempts', attempts: 2, passed: true }]);
    });
});
