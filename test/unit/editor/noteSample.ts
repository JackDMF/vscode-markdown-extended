/**
 * The margin-notes test document (the sketch's `sample.md`): headings, a list,
 * sidenotes short and long, a marginal note, a right sidebar and — at the start
 * of a paragraph — a left sidebar, so every side of the page is in use.
 */
export const NOTE_SAMPLE_TWO_SIDED = [
    '# Offline Sync',
    '',
    'The mobile client keeps a **local replica** of the user\'s workspace so that ++field staff|mostly technicians on site, often without signal for a whole shift++ can work *without a connection*. Changes are queued and sent with `POST /sync/batch` once the device is back online; see the API reference for the payload.',
    '',
    '$Status$ On track for the November release. The schedule holds !!unless the review slips|Reviews are booked for week 44.!! and the field team has been briefed on the change.',
    '',
    '## Conflicts',
    '',
    'When two devices edit the same record offline, the server keeps both versions ++and asks the user|The conflict dialog lists both versions side by side, with the device name, the time of each edit and the fields that differ. The user picks one, or merges field by field; nothing is resolved silently, and the losing version stays in the record\'s history for thirty days so that a wrong choice can be undone.++ which one to keep. The rest of this paragraph continues after the reference, so the page shows whether the line is broken at the note or flows on past it to the end of the sentence.',
    '',
    '## Goals',
    '',
    '- Edits made offline are never lost.',
    '- A conflict is shown to the user, ++not resolved silently|see the conflict dialog above++, and the choice is logged.',
    '- Sync completes within **5 seconds** for a typical day\'s work. @Owner: Mia@',
    '',
    '## Open tasks',
    '',
    'The last open point is the batch size: the client sends ++at most 200 records|Measured on the 2025 test fleet: 200 records per batch kept the median upload under two seconds on 3G, and larger batches timed out on the slowest devices.++ per request.',
    '',
].join('\n');

/** The same without its left sidebar: every note on the right, one side of the page. */
export const NOTE_SAMPLE_ONE_SIDED = NOTE_SAMPLE_TWO_SIDED.replace('$Status$ ', '');

/** Daniel's line (Theokratie-Archiv, Vorsitz 06-30): a marginal note carrying `{.tipp}` (#15). */
export const TEMPO = '!!Tempo|nicht zu abrupt ändern, nicht zu schnell!!{.tipp}';
