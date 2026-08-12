import * as fs from 'fs';

/**
 * Records which live tests only passed because they were retried.
 *
 * WHY THIS EXISTS
 * ---------------
 * Retries make a suite look healthier than it is. Once a test can pass on its
 * second attempt, a test that has quietly become 50% flaky is reported exactly
 * like one that has never failed — and the suite keeps going green while it
 * degrades, until it degrades past the retry count and fails outright with no
 * warning history behind it.
 *
 * A retry is therefore only acceptable alongside something that makes the retry
 * itself visible. This ledger is that something: it turns each retried test into
 * a workflow warning annotation and a job-summary table, so an unstable test is
 * something a maintainer sees on the run's front page rather than something
 * buried in the log of a run that said "passed".
 */
export interface FlakeEntry {
    readonly name: string;
    /** Total attempts made, i.e. retries + 1. */
    readonly attempts: number;
    /** Whether the test ended up passing. */
    readonly passed: boolean;
}

export class FlakeLedger {
    private readonly records: FlakeEntry[] = [];

    /**
     * Records one finished test. Tests that passed first time are ignored —
     * only a non-zero retry count is worth reporting.
     */
    record(name: string, retryCount: number | undefined, state: string | undefined): void {
        if (!retryCount) return;
        this.records.push({ name, attempts: retryCount + 1, passed: state === 'pass' });
    }

    get entries(): readonly FlakeEntry[] {
        return this.records;
    }

    get isEmpty(): boolean {
        return this.records.length === 0;
    }

    /** One-line-per-test console form, for the run log. */
    consoleReport(runTag: string): string {
        const lines = this.records.map(entry =>
            `${entry.passed ? 'passed on retry' : 'failed after retries'}: "${entry.name}" (${entry.attempts} attempts)`);
        return `⚠️  ${this.records.length} unstable live test(s) in run ${runTag}:\n  ${lines.join('\n  ')}`;
    }

    /** GitHub workflow-command annotations, one per unstable test. */
    annotations(): string[] {
        return this.records.map(entry =>
            `::warning title=Flaky live mail test::${entry.name} needed ${entry.attempts} attempts`);
    }

    /** Markdown table for the job summary. */
    summaryMarkdown(runTag: string): string {
        return [
            '### ⚠️ Unstable live mail tests',
            '',
            `Run tag: \`${runTag}\``,
            '',
            '| Test | Attempts | Outcome |',
            '|---|---|---|',
            ...this.records.map(entry =>
                `| ${entry.name} | ${entry.attempts} | ${entry.passed ? 'passed on retry' : 'failed'} |`),
            '',
        ].join('\n');
    }

    /**
     * Publishes the ledger: console report, workflow annotations, and an append
     * to the job summary when running inside GitHub Actions.
     *
     * Never throws — a reporting failure must not turn a green run red.
     */
    publish(runTag: string, env: NodeJS.ProcessEnv = process.env): void {
        if (this.isEmpty) return;

        console.warn(`\n${this.consoleReport(runTag)}\n`);
        for (const annotation of this.annotations()) console.warn(annotation);

        const summaryPath = env.GITHUB_STEP_SUMMARY;
        if (!summaryPath) return;

        try {
            fs.appendFileSync(summaryPath, this.summaryMarkdown(runTag) + '\n', 'utf-8');
        } catch (err) {
            // One line, message only — deliberately NOT `%o`, which dumps the
            // whole Error with its stack. This branch is reached on a routine
            // non-event (no step-summary file, an unwritable path) and is
            // exercised on purpose by the unit tests, so a stack here reads as
            // a crash in the CI log for something that changed nothing. The
            // step summary is a convenience; the console report and the
            // ::warning:: annotations above have already been emitted.
            const reason = err instanceof Error ? err.message : String(err);
            console.warn(`Flake summary not written to ${summaryPath} (${reason}) — console report above is unaffected.`);
        }
    }
}
