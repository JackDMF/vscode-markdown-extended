/**
 * The card for what the pointer rests on (ARCHITECTURE.md, *Completion,
 * diagnostics and hover*): after it rests ~500 ms on text, the diagnostics
 * drawn there — message, code, source, and the quick fixes VS Code offers for
 * each — and the hover providers' Markdown for that source position, in one
 * card (`languageCard.ts`), the diagnostics first as in the text editor's
 * hover. The card closes when the pointer leaves the range and the card, on
 * any key, on scroll; `Esc` closes it and goes no further.
 *
 * Every question goes after the page's pending edit and names the document
 * version it was asked in; an answer to a question the card no longer shows
 * is dropped, and an edit under the card hides it.
 */
import { Plugin, PluginView } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { PositionMap, SourceRange, holdsText } from '../positions';
import type { CodeActionItem, DiagnosticEntry, HostMessage, WebviewMessage } from '../protocol';
import { completionOpen } from './completion';
import { SEVERITY_ICON, diagnosticsAt, diagnosticsPlacedOn } from './diagnostics';
import { CardAnchor, LanguageCard, hoverSection } from './languageCard';
import { lensLabel, lensLabelNodes } from './lenses';

/** How long the pointer rests before the card is asked for. */
export const HOVER_DELAY_MS = 500;

/** How long the pointer may be off the range and the card before the card closes: time to cross the gap to it. */
const LEAVE_DELAY_MS = 300;

/** How many diagnostics at one place are asked for quick fixes. */
const FIX_QUESTIONS = 3;

/** How far the pointer may be from the nearest character boundary and still be on the text, in pixels. */
const ON_TEXT_SLACK = 12;

export interface HoverPort {
    version(): number | undefined;
    flush(): void;
    map(): PositionMap | undefined;
    post(message: WebviewMessage): void;
    openLink(href: string): void;
    /** Run a quick fix of the host's registry, behind the pending edit. */
    runAction(id: string): void;
    /** Run a hover's command link, behind the pending edit. */
    runCommand(id: string): void;
}

/** One diagnostic as the card shows it: the message with its severity and code, the source dimmed, then its quick fixes. */
export function diagnosticSection(entry: DiagnosticEntry, fixes: readonly CodeActionItem[] | undefined): HTMLElement {
    const section = document.createElement('div');
    section.className = 'mep-card-section mep-card-diagnostic';
    section.dataset.severity = entry.severity;
    const line = document.createElement('div');
    line.className = 'mep-card-message';
    const icon = document.createElement('span');
    icon.className = `mep-card-severity mep-card-severity-${entry.severity}`;
    icon.append(...lensLabelNodes(SEVERITY_ICON[entry.severity]));
    const text = document.createElement('span');
    text.className = 'mep-card-text';
    text.textContent = entry.message;
    line.append(icon, text);
    if (entry.code) {
        const code = document.createElement('span');
        code.className = 'mep-card-code';
        code.textContent = entry.code;
        line.append(code);
    }
    section.append(line);
    if (entry.source) {
        const source = document.createElement('div');
        source.className = 'mep-card-source';
        source.textContent = entry.source;
        section.append(source);
    }
    if (fixes && fixes.length > 0) {
        // One label for the fixes, then each as a link: a prefix on every one repeats itself.
        const label = document.createElement('div');
        label.className = 'mep-card-fixes-label';
        label.textContent = fixes.length === 1 ? 'Quick fix' : 'Quick fixes';
        section.append(label);
    }
    for (const fix of fixes ?? []) {
        const row = document.createElement('div');
        row.className = 'mep-card-fix';
        if (fix.refusal) {
            const off = document.createElement('span');
            off.className = 'mep-card-action mep-disabled';
            off.title = fix.refusal;
            off.append(...lensLabelNodes(fix.title));
            row.append(off);
        } else {
            const a = document.createElement('a');
            a.href = '#';
            a.className = 'mep-card-action';
            a.dataset.mepAction = fix.id;
            a.title = lensLabel(fix.title);
            a.append(...lensLabelNodes(fix.title));
            row.append(a);
        }
        section.append(row);
    }
    return section;
}

/** What the card shows now, and the questions it waits on. */
interface Shown {
    /** The page range the card is about: the pointer stays on it or on the card. */
    from: number;
    to: number;
    diagnostics: { entry: DiagnosticEntry; from: number; to: number; whole: boolean }[];
    fixes: Map<number, readonly CodeActionItem[]>;
    /** The quick-fix questions in flight: request → index into `diagnostics`. */
    fixRequests: Map<number, number>;
    hoverRequest: number | null;
    hoverHtml: string;
    anchor: CardAnchor;
}

const MODIFIER_KEYS: ReadonlySet<string> = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock']);

class PointerCard implements PluginView {
    private readonly card: LanguageCard;
    private shown: Shown | null = null;
    private restTimer: ReturnType<typeof setTimeout> | undefined;
    private leaveTimer: ReturnType<typeof setTimeout> | undefined;
    private last: { x: number; y: number } | null = null;
    private seq = 0;
    private readonly listeners: [EventTarget, string, EventListener, boolean][] = [];

    constructor(private readonly view: EditorView, private readonly port: HoverPort) {
        const mount = view.dom.parentElement as HTMLElement;
        this.card = new LanguageCard(mount, {
            runCommand: id => {
                this.hide();
                this.port.runCommand(id);
            },
            runAction: id => {
                this.hide();
                this.port.runAction(id);
            },
            openLink: href => {
                this.hide();
                this.port.openLink(href);
            },
            showMore: () => {
                const request = this.shown?.hoverRequest;
                this.hide();
                if (request !== null && request !== undefined) {
                    this.port.post({ type: 'showHoverInEditor', requestId: request });
                }
            },
        });
        this.listen(view.dom, 'mousemove', e => this.moved(e as MouseEvent));
        this.listen(view.dom, 'mouseleave', () => {
            clearTimeout(this.restTimer);
            this.leaving();
        });
        this.listen(document, 'mousemove', e => this.pointerAnywhere(e as MouseEvent), true);
        this.listen(window, 'keydown', e => this.key(e as KeyboardEvent), true);
        this.listen(window, 'scroll', e => {
            if (!this.card.contains(e.target as globalThis.Node | null)) {
                this.hide();
            }
        }, true);
    }

    get visible(): boolean {
        return this.card.visible;
    }

    update(view: EditorView, prev: { doc: unknown }): void {
        if (view.state.doc !== prev.doc) {
            // The text under the card changed: what it says may be of another text.
            this.hide();
        }
    }

    destroy(): void {
        clearTimeout(this.restTimer);
        clearTimeout(this.leaveTimer);
        for (const [target, type, listener, capture] of this.listeners) {
            target.removeEventListener(type, listener, capture);
        }
        this.card.destroy();
    }

    hide(): void {
        clearTimeout(this.leaveTimer);
        this.shown = null;
        this.card.hide();
    }

    /** The host's answers: shown when they are for what the card shows now. */
    answered(msg: Extract<HostMessage, { type: 'quickFixes' | 'hoverResult' }>): void {
        const shown = this.shown;
        if (!shown) {
            return;
        }
        if (msg.type === 'quickFixes') {
            const index = shown.fixRequests.get(msg.requestId);
            if (index === undefined) {
                return;
            }
            shown.fixRequests.delete(msg.requestId);
            shown.fixes.set(index, msg.items);
        } else {
            if (msg.requestId !== shown.hoverRequest) {
                return;
            }
            shown.hoverHtml = msg.html;
            if (msg.range && shown.diagnostics.length === 0) {
                // The hover's own range is what the card is about.
                const range = this.port.map()?.pageRangeOf(msg.range);
                if (range && !range.approximate && range.from <= range.to) {
                    shown.from = Math.min(shown.from, range.from);
                    shown.to = Math.max(shown.to, range.to);
                    shown.anchor = this.anchorAt(range.from, shown.anchor);
                }
            }
        }
        this.draw();
    }

    private listen(target: EventTarget, type: string, listener: EventListener, capture = false): void {
        target.addEventListener(type, listener, capture);
        this.listeners.push([target, type, listener, capture]);
    }

    private key(e: KeyboardEvent): void {
        if (!this.card.visible || MODIFIER_KEYS.has(e.key)) {
            return;
        }
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
        }
        this.hide();
    }

    private moved(e: MouseEvent): void {
        if (this.card.contains(e.target as globalThis.Node | null)) {
            return;
        }
        if (this.last && Math.abs(this.last.x - e.clientX) < 2 && Math.abs(this.last.y - e.clientY) < 2) {
            return;
        }
        this.last = { x: e.clientX, y: e.clientY };
        clearTimeout(this.restTimer);
        if (e.buttons !== 0) {
            return;
        }
        const { x, y } = this.last;
        this.restTimer = setTimeout(() => this.rest(x, y), HOVER_DELAY_MS);
    }

    /** Anywhere in the page: on the card or on its range the card stays, elsewhere it goes after a moment. */
    private pointerAnywhere(e: MouseEvent): void {
        const shown = this.shown;
        if (!shown || !this.card.visible) {
            return;
        }
        if (this.card.contains(e.target as globalThis.Node | null)) {
            clearTimeout(this.leaveTimer);
            return;
        }
        const probe = this.probe(e.clientX, e.clientY);
        if (probe !== null && probe.pos >= shown.from && probe.pos <= shown.to && (probe.onText || probe.whole)) {
            clearTimeout(this.leaveTimer);
            return;
        }
        this.leaving();
    }

    private leaving(): void {
        if (!this.card.visible) {
            return;
        }
        clearTimeout(this.leaveTimer);
        this.leaveTimer = setTimeout(() => this.hide(), LEAVE_DELAY_MS);
    }

    /** Where the pointer is in the document: the position, whether it is on a character of text, and whether it is on a whole block's mark. */
    private probe(x: number, y: number): { pos: number; onText: boolean; whole: boolean } | null {
        const view = this.view;
        const target = document.elementFromPoint(x, y);
        if (!target || !view.dom.contains(target) || target.closest('.mep-lens-row, .mep-diag-marker, .mep-object-toolbar')) {
            return null;
        }
        const at = view.posAtCoords({ left: x, top: y });
        if (!at) {
            return null;
        }
        const pos = at.inside >= 0 && view.state.doc.nodeAt(at.inside)?.isAtom ? at.inside : at.pos;
        const $pos = view.state.doc.resolve(pos);
        let onText = false;
        if (holdsText($pos.parent) && $pos.parent.content.size > 0) {
            const c = view.coordsAtPos(pos);
            onText = Math.abs(c.left - x) <= ON_TEXT_SLACK && y >= c.top - 2 && y <= c.bottom + 2;
        }
        const whole = !!target.closest('.mep-diag-block');
        return { pos, onText, whole };
    }

    /** The pointer rested: the diagnostics there at once, the hover and the quick fixes once the host answers. */
    private rest(x: number, y: number): void {
        const version = this.port.version();
        if (version === undefined || completionOpen(this.view) || this.view.composing) {
            return;
        }
        const probe = this.probe(x, y);
        if (probe === null) {
            return;
        }
        const shown = this.shown;
        if (shown && this.card.visible && probe.pos >= shown.from && probe.pos <= shown.to) {
            return;
        }
        const diagnostics = (probe.onText || probe.whole) ? diagnosticsAt(this.view.state, probe.pos) : [];
        if (diagnostics.length === 0 && !probe.onText) {
            return;
        }
        const inline = diagnostics.find(d => this.view.state.doc.resolve(d.from).parent.inlineContent);
        const pointer: CardAnchor = { left: x, top: y - 8, bottom: y + 8 };
        const from = diagnostics.length > 0 ? Math.min(...diagnostics.map(d => d.from)) : probe.pos;
        const to = diagnostics.length > 0 ? Math.max(...diagnostics.map(d => d.to)) : probe.pos;
        const next: Shown = {
            from,
            to,
            diagnostics,
            fixes: new Map(),
            fixRequests: new Map(),
            hoverRequest: null,
            hoverHtml: '',
            anchor: inline ? this.anchorAt(inline.from, pointer) : probe.onText ? this.anchorAt(probe.pos, pointer) : pointer,
        };
        this.hide();
        this.shown = next;
        // Behind the pending edit, so every position below is in the text the host holds.
        const placed = diagnosticsPlacedOn(this.view.state);
        this.port.flush();
        const map = this.port.map();
        diagnostics.slice(0, FIX_QUESTIONS).forEach((d, index) => {
            // Its own range while the text is the one it was placed on; after an edit, where its
            // squiggle now is, read back through the position map — a block's mark has no such place.
            let range: SourceRange | null = placed ? d.entry.range : null;
            if (!placed && !d.whole && map) {
                const start = map.sourcePositionOf(d.from);
                const end = map.sourcePositionOf(d.to);
                range = start && end && !start.approximate && !end.approximate
                    ? { start: { line: start.line, character: start.character }, end: { line: end.line, character: end.character } }
                    : null;
            }
            if (range === null) {
                return;
            }
            const requestId = ++this.seq;
            next.fixRequests.set(requestId, index);
            this.port.post({ type: 'quickFixesFor', requestId, baseVersion: version, range });
        });
        if (probe.onText) {
            const position = this.port.map()?.sourcePositionOf(probe.pos);
            if (position && !position.approximate) {
                const requestId = ++this.seq;
                next.hoverRequest = requestId;
                this.port.post({ type: 'hover', requestId, baseVersion: version, position: { line: position.line, character: position.character } });
            }
        }
        this.draw();
    }

    private anchorAt(pos: number, fallback: CardAnchor): CardAnchor {
        try {
            const c = this.view.coordsAtPos(pos);
            return { left: c.left, top: c.top, bottom: c.bottom };
        } catch {
            return fallback;
        }
    }

    private draw(): void {
        const shown = this.shown;
        if (!shown) {
            return;
        }
        const sections = shown.diagnostics.map((d, i) => diagnosticSection(d.entry, shown.fixes.get(i)));
        if (shown.hoverHtml.trim() !== '') {
            sections.push(hoverSection(shown.hoverHtml));
        }
        if (sections.length === 0) {
            return;
        }
        if (this.card.visible) {
            this.card.fill(sections);
        } else {
            this.card.show(shown.anchor, sections);
        }
    }
}

const instances = new WeakMap<EditorView, PointerCard>();

/** Deliver the host's `quickFixes` or `hoverResult` to the view's card. */
export function hoverMessage(view: EditorView, msg: Extract<HostMessage, { type: 'quickFixes' | 'hoverResult' }>): void {
    instances.get(view)?.answered(msg);
}

/** A new document arrived: the card goes. */
export function hoverDocumentShown(view: EditorView): void {
    instances.get(view)?.hide();
}

/** Whether the view's card shows: for tests. */
export function hoverCardVisible(view: EditorView): boolean {
    return instances.get(view)?.visible ?? false;
}

/** The card, as a plugin whose view follows the pointer. */
export function hoverPlugin(port: HoverPort): Plugin {
    return new Plugin({
        view: view => {
            const card = new PointerCard(view, port);
            instances.set(view, card);
            return card;
        },
    });
}
