/**
 * The card beside the text for what the pointer rests on: the diagnostics
 * there and the hover providers' Markdown — one component with two contents,
 * one card at a time (`hover.ts` decides what it shows). It never scrolls:
 * content taller than the card is clipped with a fade and a **Show more**
 * that opens VS Code's own hover in the text editor, which has the room.
 *
 * Every link in it goes through the page's handlers, never the browser: a
 * hover's command link (`data-mep-command`, an id the host registered only
 * for a command the hover was trusted to run) runs through the host, a quick
 * fix (`data-mep-action`) is a code action of the host's registry, and any
 * other link is followed as a Ctrl+clicked one in the text is.
 */
import { lensLabelNodes } from './lenses';

export interface CardHandlers {
    runCommand(id: string): void;
    runAction(id: string): void;
    openLink(href: string): void;
    showMore(): void;
}

/** Where a card is anchored, in viewport coordinates: the range it is about. */
export interface CardAnchor {
    left: number;
    top: number;
    bottom: number;
}

/**
 * The page's hover HTML made safe to show: a `command:` link the host did not
 * register (it strips them; this is the second line) loses its target, and the
 * `$(icon)`s of a part that allows them (`data-icons`) are drawn as the lenses
 * draw theirs (`lensLabelNodes`).
 */
export function hoverSection(html: string): HTMLElement {
    const section = document.createElement('div');
    section.className = 'mep-card-section mep-card-hover';
    const template = document.createElement('template');
    template.innerHTML = html;
    for (const a of Array.from(template.content.querySelectorAll('a'))) {
        const href = a.getAttribute('href') ?? '';
        if (!a.hasAttribute('data-mep-command') && /^\s*command:/i.test(href)) {
            a.replaceWith(...Array.from(a.childNodes));
        }
    }
    for (const part of Array.from(template.content.querySelectorAll<HTMLElement>('.mep-hover-part[data-icons]'))) {
        const walker = document.createTreeWalker(part, NodeFilter.SHOW_TEXT);
        const texts: Text[] = [];
        for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
            if (/\$\(/.test(n.nodeValue ?? '') && !(n.parentElement?.closest('code, pre'))) {
                texts.push(n as Text);
            }
        }
        for (const text of texts) {
            const value = text.nodeValue ?? '';
            // Keep the spaces the icon rule would drop at the ends of the run.
            const lead = /^\s/.test(value) ? ' ' : '';
            const trail = /\s$/.test(value) ? ' ' : '';
            text.replaceWith(document.createTextNode(lead), ...lensLabelNodes(value), document.createTextNode(trail));
        }
    }
    section.append(template.content);
    return section;
}

export class LanguageCard {
    readonly el: HTMLElement;
    private readonly body: HTMLElement;
    private readonly more: HTMLElement;
    private anchor: CardAnchor | null = null;

    constructor(private readonly mount: HTMLElement, private readonly handlers: CardHandlers) {
        this.el = document.createElement('div');
        this.el.className = 'mep-language-card';
        this.el.setAttribute('role', 'tooltip');
        this.el.hidden = true;
        this.body = document.createElement('div');
        this.body.className = 'mep-card-body';
        this.more = document.createElement('div');
        this.more.className = 'mep-card-more';
        const moreLink = document.createElement('a');
        moreLink.href = '#';
        moreLink.textContent = 'Show more';
        moreLink.title = 'Open the text editor beside, with the whole hover';
        this.more.append(moreLink);
        this.el.append(this.body, this.more);
        mount.append(this.el);
        // The text keeps the focus and the caret whatever is pressed here.
        this.el.addEventListener('mousedown', e => e.preventDefault());
        this.el.addEventListener('click', e => this.click(e));
    }

    get visible(): boolean {
        return !this.el.hidden;
    }

    contains(node: globalThis.Node | null): boolean {
        return node !== null && this.el.contains(node);
    }

    /** Show `sections` anchored at `anchor`, replacing what the card showed. */
    show(anchor: CardAnchor, sections: readonly HTMLElement[]): void {
        this.anchor = anchor;
        this.fill(sections);
    }

    /** Replace the sections, keeping the anchor (a hover arriving after the diagnostics). */
    fill(sections: readonly HTMLElement[]): void {
        if (this.anchor === null) {
            return;
        }
        this.body.replaceChildren(...sections);
        this.el.hidden = sections.length === 0;
        if (this.el.hidden) {
            return;
        }
        this.el.classList.remove('mep-card-clipped');
        this.place(this.anchor);
        // Taller than the card allows: clipped with a fade, and the rest one click away.
        const clipped = this.body.scrollHeight > this.body.clientHeight + 1;
        this.el.classList.toggle('mep-card-clipped', clipped);
        this.place(this.anchor);
    }

    hide(): void {
        this.el.hidden = true;
        this.anchor = null;
        this.body.replaceChildren();
    }

    destroy(): void {
        this.el.remove();
    }

    /** Below the range it is about, above it when below has no room; kept inside the page's width. */
    private place(anchor: CardAnchor): void {
        const base = this.mount.getBoundingClientRect();
        const width = this.el.offsetWidth;
        const height = this.el.offsetHeight;
        const gap = 4;
        let left = anchor.left - base.left;
        left = Math.max(0, Math.min(left, base.width - width));
        let top = anchor.bottom + gap;
        if (top + height > window.innerHeight && anchor.top - gap - height >= 0) {
            top = anchor.top - gap - height;
        }
        this.el.style.left = `${left}px`;
        this.el.style.top = `${top - base.top}px`;
    }

    private click(e: MouseEvent): void {
        const target = e.target as HTMLElement | null;
        const link = target?.closest('a');
        if (!link || !this.el.contains(link)) {
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        if (this.more.contains(link)) {
            this.handlers.showMore();
            return;
        }
        const command = link.getAttribute('data-mep-command');
        if (command !== null) {
            this.handlers.runCommand(command);
            return;
        }
        const action = link.getAttribute('data-mep-action');
        if (action !== null) {
            this.handlers.runAction(action);
            return;
        }
        const href = link.getAttribute('href') ?? '';
        if (href !== '' && href !== '#' && !/^\s*command:/i.test(href)) {
            this.handlers.openLink(href);
        }
    }
}
