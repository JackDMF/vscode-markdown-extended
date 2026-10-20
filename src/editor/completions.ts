/**
 * What a field offers while a value is typed into it: the shape of one
 * completion and of the function that answers for the text typed so far.
 * Pure types, no DOM — the fields draw them (`webview/inlineField.ts`), and
 * what the document offers a field (a code block's languages, `fences.ts`)
 * answers in the same shape without importing a page module.
 */

/** One completion a field may take: `value` goes into the field, `label` and `detail` are what the list shows. */
export interface Completion {
    value: string;
    label: string;
    detail?: string;
    kind?: string;
}

/** Where a field's completions come from: the choices for what the field holds now (a link's: the host's `linkChoices`). */
export type Completer = (query: string) => Promise<readonly Completion[]>;
