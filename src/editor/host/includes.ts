import * as vscode from 'vscode';
import type { HostMessage, IncludeChoice } from '../protocol';
import { markdownItExtensions } from './engineHost';
import { message } from './errors';
import { SessionPort } from './lenses';

type Log = (line: string) => void;

/** What the host says when no extension has a line to offer; the page's refusal says the same. */
export const NO_INCLUDES_MESSAGE = 'No extension offers includes for this document';

/**
 * One extension that offers includes: its id, the name its choices are grouped
 * under, and its `listIncludeChoices`, called with its own exports as `this`.
 */
export interface IncludeProvider {
    id: string;
    displayName: string;
    listIncludeChoices(documentUri: vscode.Uri): unknown;
}

/**
 * The extensions that offer includes: those contributing a markdown-it plugin
 * (`markdownItExtensions`, the list the engine's extenders come from) that
 * export `listIncludeChoices` beside `extendMarkdownIt`. The extension whose
 * plugin resolves a directive is the one that knows the snippets and the
 * syntax; the editor asks it and inserts what it is given. One without the
 * function is skipped, silently — most plugins offer no includes.
 */
export async function collectIncludeProviders(selfId: string | undefined, log: Log): Promise<IncludeProvider[]> {
    const providers: IncludeProvider[] = [];
    for (const ext of await markdownItExtensions(selfId, log, 'its include choices')) {
        const exported = ext.exports;
        const list = (exported as { listIncludeChoices?: unknown } | undefined)?.listIncludeChoices;
        if (typeof list !== 'function') {
            continue;
        }
        providers.push({
            id: ext.id,
            displayName: ext.displayName,
            listIncludeChoices: uri => (list as (uri: vscode.Uri) => unknown).call(exported, uri),
        });
    }
    return providers;
}

/** A QuickPick item standing for one choice; a separator carries none. */
export interface IncludePickItem extends vscode.QuickPickItem {
    insert?: string;
}

/** The two pieces of VS Code's UI a pick uses, injected so a test can answer for the person. */
export interface IncludePicker {
    pick(items: IncludePickItem[], options: vscode.QuickPickOptions): Thenable<IncludePickItem | undefined>;
    inform(text: string): void;
}

export const vscodeIncludePicker: IncludePicker = {
    pick: (items, options) => vscode.window.showQuickPick(items, options),
    inform: text => {
        void vscode.window.showInformationMessage(text);
    },
};

/**
 * A choice as the provider returned it, checked rather than assumed: the
 * value is another extension's and may be anything. `insert` must be one
 * non-empty line — a terminator at its end is dropped, since the page writes
 * the line in the document's own line ending; one holding a line break inside
 * is refused, as it would be two lines the provider did not say it offers.
 */
export function validChoice(value: unknown): IncludeChoice | null {
    if (typeof value !== 'object' || value === null) {
        return null;
    }
    const { label, description, detail, insert } = value as Record<string, unknown>;
    if (typeof label !== 'string' || label === '' || typeof insert !== 'string') {
        return null;
    }
    const line = insert.replace(/\r?\n$/, '');
    if (line.trim() === '' || /[\r\n]/.test(line)) {
        return null;
    }
    return {
        label,
        ...(typeof description === 'string' && description !== '' ? { description } : {}),
        ...(typeof detail === 'string' && detail !== '' ? { detail } : {}),
        insert: line,
    };
}

/**
 * Include insertion (the page's **Insert → Include…** and an expansion's
 * **Change snippet…**).
 *
 * The directive's syntax and the snippet ids belong to the extension that
 * resolves them, so nothing about either lives here: the providers
 * (`collectIncludeProviders`) are asked for their choices for the document,
 * the choices are shown in VS Code's own QuickPick — one separator per
 * provider, its display name — and the chosen `insert` goes back to the page
 * as it was offered. The page writes it as a source block and asks for a
 * reparse, so the host's parser, with the provider's plugin in it, turns it
 * into the expansion.
 *
 * A provider that throws, rejects or answers something that is not a list is
 * logged and skipped, and so is a malformed choice (`validChoice`): one
 * broken provider must not take the others' choices with it.
 */
export class IncludeController {
    constructor(
        private readonly host: SessionPort,
        private readonly providers: () => Promise<IncludeProvider[]>,
        private readonly picker: IncludePicker = vscodeIncludePicker,
    ) { }

    /** Whether any extension offers includes: what the `document` message's `includes` says. Never throws. */
    async offered(): Promise<boolean> {
        try {
            return (await this.providers()).length > 0;
        } catch (error) {
            this.host.log(`[WARN] Visual Editor: the include providers could not be read: ${message(error)}`);
            return false;
        }
    }

    /**
     * Answer `pickInclude`: never throws, and always answers — with the chosen
     * line, or without one when the pick was dismissed or nothing was offered.
     */
    async answer(requestId: number, replacing: boolean): Promise<void> {
        let insert: string | undefined;
        try {
            insert = await this.choose(replacing);
        } catch (error) {
            this.host.log(`[WARN] Visual Editor: the include choices could not be shown: ${message(error)}`);
        }
        await this.send({ type: 'includeChosen', requestId, ...(insert !== undefined ? { insert } : {}) });
    }

    /** Every provider's choices for the document, in the providers' order; a failing provider contributes none. */
    async choices(): Promise<{ provider: IncludeProvider; choices: IncludeChoice[] }[]> {
        let providers: IncludeProvider[];
        try {
            providers = await this.providers();
        } catch (error) {
            this.host.log(`[WARN] Visual Editor: the include providers could not be read: ${message(error)}`);
            return [];
        }
        const uri = this.host.document.uri;
        const answers = await Promise.all(providers.map(async provider => {
            let listed: unknown;
            try {
                listed = await provider.listIncludeChoices(uri);
            } catch (error) {
                this.host.log(`[WARN] Visual Editor: ${provider.id} could not list its includes: ${message(error)}`);
                return { provider, choices: [] };
            }
            if (!Array.isArray(listed)) {
                this.host.log(`[WARN] Visual Editor: ${provider.id} answered listIncludeChoices with something that is not a list; skipped.`);
                return { provider, choices: [] };
            }
            const choices = listed.map(validChoice).filter((c): c is IncludeChoice => c !== null);
            if (choices.length < listed.length) {
                this.host.log(`[WARN] Visual Editor: ${provider.id} offered ${listed.length - choices.length} include choice(s) without a label or a one-line insert; skipped.`);
            }
            return { provider, choices };
        }));
        return answers.filter(a => a.choices.length > 0);
    }

    private async choose(replacing: boolean): Promise<string | undefined> {
        const groups = await this.choices();
        if (groups.length === 0) {
            this.picker.inform(NO_INCLUDES_MESSAGE);
            return undefined;
        }
        const items: IncludePickItem[] = [];
        for (const { provider, choices } of groups) {
            items.push({ label: provider.displayName, kind: vscode.QuickPickItemKind.Separator });
            items.push(...choices.map(c => ({
                label: c.label,
                ...(c.description !== undefined ? { description: c.description } : {}),
                ...(c.detail !== undefined ? { detail: c.detail } : {}),
                insert: c.insert,
            })));
        }
        const picked = await this.picker.pick(items, {
            placeHolder: replacing ? 'Change snippet…' : 'Include…',
            matchOnDescription: true,
            matchOnDetail: true,
        });
        return picked?.insert;
    }

    /** Post, never throwing: the page may be gone (the webview disposed) by the time the person has chosen. */
    private async send(msg: HostMessage): Promise<void> {
        try {
            await this.host.post(msg);
        } catch (error) {
            this.host.log(`[WARN] Visual Editor: the include choice could not be sent to the page: ${message(error)}`);
        }
    }
}
