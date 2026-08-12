import { randomBytes } from 'crypto';
import { EmailFilter, EmailFilterType } from '../../src/types.js';

/**
 * Per-run isolation for the live mail suite.
 *
 * WHY THIS EXISTS
 * ---------------
 * The live suite sends real mail to one shared mailbox, and more than one run
 * can be in flight against that mailbox at a time (a tagged release publish and
 * a pull-request check, for instance). Every message a run sends is therefore
 * sharing a mailbox with messages it does not own and must not touch.
 *
 * Distinguishing runs by a `Date.now()` component alone is not enough:
 *   * two runs that start together produce interleaved — and, at millisecond
 *     resolution, occasionally identical — timestamps, so a timestamp does not
 *     say WHICH run a message belongs to; and
 *   * because it does not, no cleanup can be scoped to "this run's mail", which
 *     leaves a suite with only two options, both wrong: delete nothing (the
 *     mailbox grows without bound and every IMAP search gets slower) or delete
 *     everything (which destroys the other run's in-flight messages).
 *
 * A `RunScope` stamps one identifier into EVERY subject the run sends. That
 * single token is what makes both halves of the problem solvable: a run can
 * find its own mail, and — critically — it can delete exactly its own mail and
 * nothing else.
 */

/**
 * Builds a token that identifies one execution of the suite and cannot collide
 * with a concurrently-running one.
 *
 * In CI the workflow run id and attempt number are already globally unique, and
 * including them means a failure can be traced from a leftover message back to
 * the run that sent it. Random entropy is appended regardless so that two local
 * runs — or two jobs of the same run — never share a tag.
 *
 * The token is restricted to characters that survive a subject header and an
 * IMAP SEARCH argument unescaped.
 */
export function createRunTag(env: NodeJS.ProcessEnv = process.env): string {
    const entropy = randomBytes(4).toString('hex');
    const runId = env.GITHUB_RUN_ID;

    if (runId) {
        const attempt = env.GITHUB_RUN_ATTEMPT ?? '1';
        return `ecrun-${runId}-${attempt}-${entropy}`;
    }

    return `ecrun-local-${process.pid}-${entropy}`;
}

/**
 * Names every artefact one suite run creates — subjects, run-owned folders, and
 * the filter that selects this run's mail and only this run's mail.
 */
export class RunScope {
    /** Number of subjects handed out so far; makes each subject unique within the run. */
    private sequence = 0;

    constructor(readonly tag: string = createRunTag()) {}

    /**
     * Builds a unique, run-stamped subject for one message.
     *
     * Two properties matter and are asserted in `tests/run-isolation.spec.ts`:
     *  1. every subject contains this run's tag, so `runFilters()` matches it;
     *  2. no two subjects are equal — including across retries of the same test,
     *     because a retried test body calls this again and gets a new sequence
     *     number. That is what makes a retry self-contained: the second attempt
     *     sends a message the first attempt's assertions could never match.
     */
    subject(label: string): string {
        this.sequence += 1;
        return `${label} [${this.tag}-${this.sequence}]`;
    }

    /**
     * The filter selecting everything this run has sent.
     *
     * IMAP SUBJECT search is a substring match, and `applyFilters` falls back to
     * a case-insensitive substring match, so filtering on the bare tag matches
     * every subject `subject()` produced and nothing else — no other run's tag
     * contains this one.
     */
    runFilters(): EmailFilter[] {
        return [{ type: EmailFilterType.SUBJECT, value: this.tag }];
    }

    /**
     * Names an IMAP folder owned exclusively by this run.
     *
     * Used by the destructive no-filter clean test, which needs a folder it can
     * legitimately empty without touching mail belonging to anyone else.
     */
    folder(label: string): string {
        return `${this.tag}-${label}`;
    }
}
