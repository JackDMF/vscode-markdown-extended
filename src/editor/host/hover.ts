import * as crypto from 'crypto';
import markdownIt from 'markdown-it';
import * as vscode from 'vscode';
import { SourcePosition, SourceRange, toSourceRange } from '../positions';
import { message } from './errors';
import { sanitizeHoverHtml } from './hoverHtml';
import type { LanguageHost } from './language';

/** What a hover part's `isTrusted` says about the command links it may run. */
export type HoverTrust = boolean | { readonly enabledCommands: readonly string[] } | undefined;

/**
 * Whether a hover part may run `command` from a `command:` link — the rule
 * VS Code's own hover follows: a part trusted outright (`isTrusted: true`)
 * runs any command; one trusted for `enabledCommands` only those; any other
 * (`false`, absent, a plain string) none. Read from the part itself, never
 * from the page, which only ever names a link the host registered.
 */
export function commandLinkAllowed(trust: HoverTrust, command: string): boolean {
    if (trust === true) {
        return true;
    }
    if (typeof trust === 'object' && trust !== null && Array.isArray(trust.enabledCommands)) {
        return trust.enabledCommands.includes(command);
    }
    return false;
}

/**
 * A `command:id?args` link as VS Code's opener reads one: the command id, and
 * its arguments — the query `decodeURIComponent`ed and parsed as JSON (else
 * parsed as it stands), a value that is not an array its only argument, none
 * without a query or when neither parses. `null` for any other link.
 */
export function parseCommandLink(href: string): { command: string; args: unknown[] } | null {
    const m = /^command:([^?#]+)(?:\?([^#]*))?/i.exec(href.trim());
    if (!m) {
        return null;
    }
    let command = m[1];
    try {
        command = decodeURIComponent(command);
    } catch {
        // As written.
    }
    const query = m[2];
    if (query === undefined || query === '') {
        return { command, args: [] };
    }
    let args: unknown = [];
    try {
        args = JSON.parse(decodeURIComponent(query));
    } catch {
        try {
            args = JSON.parse(query);
        } catch {
            args = [];
        }
    }
    return { command, args: Array.isArray(args) ? args : [args] };
}

/** One part of a hover, as the page renders it: its Markdown, and what the provider allowed of it. */
export interface HoverPart {
    value: string;
    trust: HoverTrust;
    supportHtml: boolean;
    supportThemeIcons: boolean;
}

/** A hover's contents as parts: a `MarkdownString` as it is, a plain `MarkedString` untrusted, a `{ language, value }` one a fenced block. */
export function hoverParts(hovers: readonly vscode.Hover[]): HoverPart[] {
    const parts: HoverPart[] = [];
    for (const hover of hovers) {
        for (const content of hover.contents ?? []) {
            if (content instanceof vscode.MarkdownString) {
                parts.push({
                    value: content.value,
                    trust: content.isTrusted as HoverTrust,
                    supportHtml: content.supportHtml === true,
                    supportThemeIcons: content.supportThemeIcons === true,
                });
            } else if (typeof content === 'string') {
                parts.push({ value: content, trust: false, supportHtml: false, supportThemeIcons: false });
            } else if (content && typeof content === 'object' && typeof (content as { value?: unknown }).value === 'string') {
                const { language, value } = content as { language?: string; value: string };
                const fence = value.includes('```') ? '~~~~' : '```';
                parts.push({ value: `${fence}${language ?? ''}\n${value}\n${fence}`, trust: false, supportHtml: false, supportThemeIcons: false });
            }
        }
    }
    return parts.filter(part => part.value.trim() !== '');
}

interface HoverEnv {
    [key: string]: unknown;
    /** Decide a link: its `data-mep-command` id when it may run, `null` to strip it to its text, `undefined` to keep it. */
    link(href: string): string | null | undefined;
    stack: boolean[];
    /** For a part with raw HTML: marks the command links this rule made, which the sanitizer then keeps (`sanitizeHoverHtml`). */
    nonce?: string;
}

const engines = new Map<boolean, ReturnType<typeof markdownIt>>();

/**
 * The engine a hover is rendered with — not the preview's: a hover is VS
 * Code's Markdown, rendered in the text editor by the workbench's own
 * renderer, and the preview's plugins (this extension's `++note++`, another's
 * injections) would read its text as their syntax. Raw HTML only for a part
 * that allows it (`supportHtml`), and then only what VS Code's own hover lets
 * through (`sanitizeHoverHtml`); `file:` links are links, as in a hover.
 */
function hoverEngine(html: boolean): ReturnType<typeof markdownIt> {
    let md = engines.get(html);
    if (md) {
        return md;
    }
    md = markdownIt({ html, linkify: false });
    md.validateLink = url => !/^\s*(javascript|vbscript|data):/i.test(url);
    const defaultOpen = md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
    const defaultClose = md.renderer.rules.link_close ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
    md.renderer.rules.link_open = (tokens, idx, options, rawEnv, self) => {
        const env = rawEnv as HoverEnv;
        const token = tokens[idx];
        const decision = env.link(token.attrGet('href') ?? '');
        if (decision === null) {
            env.stack.push(false);
            return '';
        }
        env.stack.push(true);
        if (decision !== undefined) {
            token.attrs = (token.attrs ?? []).filter(([name]) => name !== 'href');
            token.attrPush(['href', '#']);
            token.attrPush(['data-mep-command', decision]);
            if (env.nonce) {
                token.attrPush(['data-mep-nonce', env.nonce]);
            }
        }
        return defaultOpen(tokens, idx, options, env, self);
    };
    md.renderer.rules.link_close = (tokens, idx, options, env, self) =>
        (env as HoverEnv).stack.pop() === false ? '' : defaultClose(tokens, idx, options, env, self);
    engines.set(html, md);
    return md;
}

/**
 * The parts rendered as the card's HTML, each in a `div.mep-hover-part` (with
 * `data-icons` when its `$(icon)`s are to be drawn), in order. A command link
 * the part may run (`commandLinkAllowed`) is registered — `register` gives its
 * id — and carries it as `data-mep-command`; any other command link is its
 * text alone. Raw HTML is sanitized to VS Code's hover allowlist, so it keeps
 * no `command:` target and no `data-*` attribute: only the link rule makes a
 * `data-mep-command`.
 */
export function renderHoverParts(parts: readonly HoverPart[], register: (command: string, args: unknown[]) => string): string {
    return parts.map(part => {
        const env: HoverEnv = {
            stack: [],
            link: href => {
                const link = parseCommandLink(href);
                if (link === null) {
                    return /^\s*command:/i.test(href) ? null : undefined;
                }
                return commandLinkAllowed(part.trust, link.command) ? register(link.command, link.args) : null;
            },
        };
        if (part.supportHtml) {
            env.nonce = crypto.randomBytes(12).toString('hex');
        }
        const rendered = hoverEngine(part.supportHtml).render(part.value, env);
        // The whole rendering, not token by token: markdown-it splits `<script>x</script>` in a
        // line into three tokens, and only the whole says the text between is the element's.
        const html = part.supportHtml ? sanitizeHoverHtml(rendered, env.nonce) : rendered;
        return `<div class="mep-hover-part"${part.supportThemeIcons ? ' data-icons' : ''}>${html}</div>`;
    }).join('');
}

/**
 * Hovers at the page's pointer: VS Code runs every hover provider for the
 * document (`vscode.executeHoverProvider`) at the pointer's source position;
 * the host renders the Markdown and keeps the command links the hover may
 * run, in a registry replaced with every answer — the page gets ids, and
 * `runHoverCommand` runs a registered one with its own arguments.
 */
export class HoverController {
    private commands = new Map<string, { command: string; args: unknown[] }>();
    /** The position of the last answer, for **Show more**. */
    private shown: { requestId: number; position: vscode.Position } | undefined;
    /** The newest question whose answer is kept: an older one resolving later does not replace it. */
    private latestAnswered = 0;

    constructor(private readonly host: LanguageHost) { }

    async answer(requestId: number, baseVersion: number, position: SourcePosition): Promise<void> {
        let html = '';
        let range: SourceRange | undefined;
        try {
            const result = await this.hover(requestId, baseVersion, position);
            html = result.html;
            range = result.range;
        } catch (error) {
            this.host.port.log(`[WARN] Visual Editor: the hover could not be read: ${message(error)}`);
        }
        await this.host.send({ type: 'hoverResult', requestId, html, ...(range ? { range } : {}) });
    }

    private async hover(requestId: number, baseVersion: number, position: SourcePosition): Promise<{ html: string; range?: SourceRange }> {
        const document = this.host.port.document;
        const text = document.getText();
        if (baseVersion !== this.host.postedVersion() || !this.host.port.pageHolds(text)) {
            return { html: '' };
        }
        const version = document.version;
        const at = document.validatePosition(new vscode.Position(position.line, position.character));
        const hovers = await this.host.execute<vscode.Hover[] | undefined>('vscode.executeHoverProvider', document.uri, at) ?? [];
        if (document.version !== version || !this.host.port.pageHolds(text)) {
            return { html: '' };
        }
        const commands = new Map<string, { command: string; args: unknown[] }>();
        const html = renderHoverParts(hoverParts(hovers), (command, args) => {
            const id = `${requestId}.${commands.size}`;
            commands.set(id, { command, args });
            return id;
        });
        if (requestId <= this.latestAnswered) {
            // A newer question was answered first: its commands stay, this answer is not the page's.
            return { html: '' };
        }
        this.latestAnswered = requestId;
        this.commands = commands;
        this.shown = { requestId, position: at };
        const withRange = hovers.find(h => h.range !== undefined)?.range;
        return { html, ...(withRange ? { range: toSourceRange(withRange) } : {}) };
    }

    /** Run a command link of the last answer; one of an earlier answer, or none, is refused. Started, not awaited. */
    run(id: string): void {
        const entry = this.commands.get(id);
        if (entry === undefined) {
            this.host.port.log(`[WARN] Visual Editor: the hover's command ${id} is no longer current; nothing was run.`);
            return;
        }
        void Promise.resolve(this.host.execute(entry.command, ...entry.args)).catch(error => {
            this.host.port.log(`[WARN] Visual Editor: the hover's command ${entry.command} failed: ${message(error)}`);
        });
    }

    /** **Show more**: the text editor beside, the caret at the hover's position, and VS Code's own hover there. */
    async showInEditor(requestId: number): Promise<void> {
        const shown = this.shown;
        if (!shown || shown.requestId !== requestId) {
            return;
        }
        try {
            const at = new vscode.Range(shown.position, shown.position);
            const editor = await vscode.window.showTextDocument(this.host.port.document, { viewColumn: vscode.ViewColumn.Beside, preview: false, selection: at });
            editor.revealRange(at, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
            await this.host.execute('editor.action.showHover');
        } catch (error) {
            this.host.port.log(`[WARN] Visual Editor: the hover could not be shown in the text editor: ${message(error)}`);
        }
    }
}
