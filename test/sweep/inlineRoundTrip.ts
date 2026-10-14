/**
 * The full brute-force sweep of inline formatting round trips
 * (`test/unit/editor/roundTripSweep.ts`): every two-run and three-run case,
 * judged against the real engine. Not part of the suite — it takes a while —
 * and run by hand after `npm run compile-tests`:
 *
 *     node out/test/sweep/inlineRoundTrip.js [two|three]
 *
 * It prints the tallies and every distinct written text the save lets through
 * though it reads back otherwise, or refuses though it reads back, and exits
 * non-zero when there is any.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Module = require('module') as { _load: (request: string, ...rest: unknown[]) => unknown };

// The editor's modules outside VS Code: `vscode` is a stub (nothing swept reads it).
const vscodeStub = {
    Disposable: class { static from() { return new this(); } dispose() { /* nothing */ } },
    workspace: {
        workspaceFolders: undefined,
        onDidChangeConfiguration: () => ({ dispose() { /* nothing */ } }),
        getConfiguration: () => ({ get: (_k: string, d: unknown) => d, inspect: () => ({}), has: () => false }),
        getWorkspaceFolder: () => undefined,
    },
    Uri: { file: (f: string) => ({ fsPath: f }) }, window: {}, commands: {}, languages: {}, env: {},
};
const load = Module._load;
Module._load = function (request: string, ...rest: unknown[]) {
    return request === 'vscode' ? vscodeStub : load.call(this, request, ...rest);
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const sweeps = require('../unit/editor/roundTripSweep') as typeof import('../unit/editor/roundTripSweep');

let failed = false;
for (const [name, cases] of [['two', sweeps.twoRunCases], ['three', sweeps.threeRunCases]] as const) {
    if (process.argv[2] !== undefined && process.argv[2] !== name) {
        continue;
    }
    const started = Date.now();
    const tally = sweeps.sweep(cases());
    const corrupt = [...new Set(tally.corrupt)];
    const over = [...new Set(tally.overRefused)];
    for (const w of corrupt) {
        console.log(`LET THROUGH, READS OTHERWISE  ${JSON.stringify(w)}`);
    }
    for (const w of over) {
        console.log(`REFUSED, READS BACK           ${JSON.stringify(w)}`);
    }
    console.log(`${name}-run: ${tally.cases} cases, ${tally.refused} refused, ${tally.corrupt.length} let through reading otherwise (${corrupt.length} distinct), ${tally.overRefused.length} refused reading back (${over.length} distinct), ${Date.now() - started} ms`);
    failed ||= corrupt.length + over.length > 0;
}
process.exitCode = failed ? 1 : 0;
