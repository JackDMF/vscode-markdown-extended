/**
 * Links in the editor: a plain click does not follow one, a Ctrl/Cmd+click
 * does (Daniel's rule, 2026-09-25; README, "Links").
 *
 * Two paths hold the one rule. In rich text a plain click is ProseMirror's —
 * it places the caret — and a modified click is taken here. In a rendered
 * block (a raw block, injected content, a badge) a plain click selects the
 * block, as a click anywhere on it does, and a modified one is taken here too
 * — except in Req Explorer's summary table, a read model, whose links a plain
 * click follows as well (`followLinksIn`'s `plainFollows`).
 * Either way the click stops at the page: VS Code's webview follows every
 * clicked `<a>` from a listener on the window, with the href resolved against
 * the page's own origin instead of the document, so a relative link would
 * lead nowhere. The page posts `openLink` with the href as the element
 * carries it, and the host resolves it (`host/links.ts`).
 */
import { Plugin } from 'prosemirror-state';

/** The anchor a pointer event is on, if any. */
function anchorOf(event: Event): HTMLAnchorElement | null {
    const target = event.target as Element | null;
    return typeof target?.closest === 'function' ? target.closest('a[href]') : null;
}

function isModified(event: MouseEvent): boolean {
    return event.ctrlKey || event.metaKey;
}

/**
 * A rendered block's links: followed on a modified click, never by VS Code's
 * own listener. With `plainFollows` answering true — a rendering that is a
 * read model, not text anybody edits there (Req Explorer's summary table) —
 * a plain click follows a link too: the Ctrl+click rule keeps a click in text
 * placing the caret, and there is no text to place it in; a list of links a
 * click does not follow reads as broken (Daniel, 2026-09-28).
 */
export function followLinksIn(content: HTMLElement, open: (href: string) => void, plainFollows: () => boolean = () => false): void {
    const follows = (event: MouseEvent) => isModified(event) || (event.button === 0 && plainFollows());
    content.addEventListener('mousedown', event => {
        // A press on a link that follows it is the link's; ProseMirror would
        // take it for a node selection.
        if (follows(event) && anchorOf(event)) {
            event.preventDefault();
            event.stopPropagation();
        }
    });
    for (const type of ['click', 'auxclick'] as const) {
        content.addEventListener(type, event => {
            const anchor = anchorOf(event);
            if (!anchor || !content.contains(anchor)) {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            if (type === 'click' && follows(event)) {
                open(anchor.getAttribute('href') ?? '');
            }
        });
    }
}

/** Rich text's links: a plain click places the caret, a modified one follows the link. */
export function linkClickPlugin(open: (href: string) => void): Plugin {
    const inRichText = (root: HTMLElement, anchor: HTMLAnchorElement | null): anchor is HTMLAnchorElement =>
        anchor !== null && root.contains(anchor) && anchor.closest('.mep-atom') === null;
    return new Plugin({
        props: {
            handleDOMEvents: {
                mousedown(view, event) {
                    if (isModified(event) && inRichText(view.dom, anchorOf(event))) {
                        // Not ProseMirror's: a modified press would select the paragraph.
                        event.preventDefault();
                        return true;
                    }
                    return false;
                },
                click(view, event) {
                    const anchor = anchorOf(event);
                    if (!inRichText(view.dom, anchor)) {
                        return false;
                    }
                    event.preventDefault();
                    event.stopPropagation();
                    if (isModified(event)) {
                        open(anchor.getAttribute('href') ?? '');
                    }
                    return true;
                },
                auxclick(view, event) {
                    if (!inRichText(view.dom, anchorOf(event))) {
                        return false;
                    }
                    event.preventDefault();
                    event.stopPropagation();
                    return true;
                },
            },
        },
    });
}
