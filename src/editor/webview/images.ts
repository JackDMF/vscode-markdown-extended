/**
 * Images in the page: where each one is loaded from, and files dropped or
 * pasted into the text.
 *
 * **An image's `src` is the file's, its display the page's.** A webview cannot
 * load a `file:` path, and a relative `src` would be resolved against the
 * page's own origin, so `images/x.png` showed nothing. The node keeps the `src`
 * the file holds — it is what the serializer writes — and the element the page
 * draws carries it in `data-mep-src`, its `src` set to the address the host
 * resolved it to (`imagesResolved`, `host/images.ts`: relative to the
 * document, as a followed link is, then `webview.asWebviewUri`). The page never
 * resolves a path itself; it asks for every `src` it has not seen, once, and a
 * `src` the host leaves out of its answer (a web address, a `data:` image) is
 * shown as written. Until the answer arrives the element has no `src`, so no
 * request for a path the page cannot load is made.
 *
 * The same holds for the images of a rendered block — a source block, injected
 * content — whose HTML the host rendered: `showImagesIn` moves each `src` to
 * `data-mep-src` the same way. That HTML is display only; the block's `src` is
 * its Markdown.
 */
import { Plugin } from 'prosemirror-state';
import { EditorView, NodeView } from 'prosemirror-view';
import { Node } from 'prosemirror-model';

/** The attribute an image element carries its written `src` in. */
export const WRITTEN_SRC_ATTR = 'data-mep-src';

export class ImageSources {
    /** Each `src` asked about: the address to load, or `null` to show it as written. */
    private readonly known = new Map<string, string | null>();
    private readonly waiting = new Set<string>();
    private readonly queued = new Set<string>();
    private readonly pending = new Map<number, string[]>();
    private seq = 0;
    private timer: ReturnType<typeof setTimeout> | undefined;

    constructor(
        private readonly ask: (requestId: number, srcs: string[]) => void,
        private readonly root: () => ParentNode | null,
    ) { }

    /** The address to load `src` from; `undefined` while the host has not said (it is asked). */
    display(src: string): string | undefined {
        if (this.known.has(src)) {
            return this.known.get(src) ?? src;
        }
        if (!this.waiting.has(src)) {
            this.queued.add(src);
            this.waiting.add(src);
            if (this.timer === undefined) {
                this.timer = setTimeout(() => this.send(), 0);
            }
        }
        return undefined;
    }

    /** Draw `img` for the written `src`: kept in `data-mep-src`, loaded from where the host said. */
    apply(img: HTMLImageElement, src: string): void {
        img.setAttribute(WRITTEN_SRC_ATTR, src);
        const shown = this.display(src);
        if (shown === undefined) {
            img.removeAttribute('src');
        } else if (img.getAttribute('src') !== shown) {
            img.setAttribute('src', shown);
        }
    }

    /** The host's answer: every image in the page showing an asked `src` is drawn again. An answer to nothing asked is dropped. */
    resolved(requestId: number, sources: Record<string, string>): void {
        const asked = this.pending.get(requestId);
        this.pending.delete(requestId);
        if (asked === undefined) {
            return;
        }
        for (const src of asked) {
            this.waiting.delete(src);
            this.known.set(src, Object.prototype.hasOwnProperty.call(sources, src) ? sources[src] : null);
        }
        const root = this.root();
        for (const img of Array.from(root?.querySelectorAll<HTMLImageElement>(`img[${WRITTEN_SRC_ATTR}]`) ?? [])) {
            const src = img.getAttribute(WRITTEN_SRC_ATTR) as string;
            if (asked.includes(src)) {
                this.apply(img, src);
            }
        }
    }

    /** Forget what was asked and not answered: the page is gone (the error state). Answers already known stay. */
    reset(): void {
        clearTimeout(this.timer);
        this.timer = undefined;
        this.pending.clear();
        this.queued.clear();
        this.waiting.clear();
    }

    private send(): void {
        this.timer = undefined;
        const srcs = [...this.queued];
        this.queued.clear();
        if (srcs.length === 0) {
            return;
        }
        const requestId = ++this.seq;
        this.pending.set(requestId, srcs);
        this.ask(requestId, srcs);
    }
}

/** A rendering's images, their written `src` kept in `data-mep-src` and each loaded from where the host says. */
export function showImagesIn(container: HTMLElement, sources: ImageSources): void {
    for (const img of Array.from(container.querySelectorAll<HTMLImageElement>('img'))) {
        const src = img.getAttribute(WRITTEN_SRC_ATTR) ?? img.getAttribute('src');
        if (src !== null && src !== '') {
            sources.apply(img, src);
        }
    }
}

/**
 * An image node as the page draws it: the schema's `<img>` (its alt text and
 * title), its written `src` in `data-mep-src` and the address it is loaded
 * from in `src`. The schema's `toDOM` stays the written form — copy and paste
 * carry the file's `src`, never a webview address.
 */
export class ImageView implements NodeView {
    readonly dom: HTMLImageElement;

    constructor(private node: Node, private readonly sources: ImageSources) {
        this.dom = document.createElement('img');
        this.render();
    }

    update(node: Node): boolean {
        if (node.type !== this.node.type) {
            return false;
        }
        this.node = node;
        this.render();
        return true;
    }

    private render(): void {
        const { src, alt, title } = this.node.attrs as { src: string; alt: string | null; title: string | null };
        for (const [name, value] of [['alt', alt], ['title', title]] as const) {
            if (value === null) {
                this.dom.removeAttribute(name);
            } else {
                this.dom.setAttribute(name, value);
            }
        }
        this.sources.apply(this.dom, src);
    }
}

// ---------------------------------------------------------------------------
// Files dropped or pasted
// ---------------------------------------------------------------------------

/** What the page does with files the person dropped or pasted. */
export interface FileTarget {
    /** Files named by uri or path: the host makes each relative to the document (`insertFiles`). */
    insertFiles(uris: string[]): void;
    /** A bitmap with no path (a screenshot): the host writes it beside the document (`saveImage`). */
    saveImage(file: File): void;
}

/**
 * The files a drop or a paste names: VS Code's `resourceurls` (the explorer),
 * else the `file:` lines of a `text/uri-list`, else the paths of the `File`s
 * that carry one. A web address in a uri list is not a file and is left to
 * the browser, which inserts it as text.
 */
export function namedFiles(data: DataTransfer): string[] {
    const resources = data.getData('resourceurls');
    if (resources) {
        try {
            const list = JSON.parse(resources) as unknown;
            if (Array.isArray(list)) {
                const uris = list.filter((u): u is string => typeof u === 'string' && u !== '');
                if (uris.length > 0) {
                    return uris;
                }
            }
        } catch {
            // Not the list VS Code writes; read the others.
        }
    }
    const uriList = data.getData('text/uri-list')
        .split(/\r?\n/).map(l => l.trim()).filter(l => l !== '' && !l.startsWith('#') && /^file:/i.test(l));
    if (uriList.length > 0) {
        return uriList;
    }
    return Array.from(data.files ?? [])
        .map(f => (f as File & { path?: unknown }).path)
        .filter((p): p is string => typeof p === 'string' && p !== '');
}

/** The image files of a drop or a paste that have no path: bitmaps, to be saved. */
export function bitmaps(data: DataTransfer): File[] {
    return Array.from(data.files ?? []).filter(f => f.type.startsWith('image/') && !(f as File & { path?: unknown }).path);
}

/**
 * Files dropped into the text, or pasted: named ones (`namedFiles`) are
 * inserted by their path relative to the document, a bitmap without one
 * (a screenshot, an image copied from a browser) is saved by the host and
 * inserted by the path it was saved at — a paste only when the clipboard holds
 * no text, since a copy from an office program carries a picture of its text
 * beside the text itself. A drop puts the caret at the drop point first; the
 * answer is inserted at the caret. Anything else is ProseMirror's.
 */
export function fileDropPlugin(target: FileTarget, place: (view: EditorView, event: DragEvent) => void): Plugin {
    return new Plugin({
        props: {
            handleDrop(view, event, _slice, moved) {
                const data = event.dataTransfer;
                if (moved || !data) {
                    return false;
                }
                const named = namedFiles(data);
                const images = named.length === 0 ? bitmaps(data) : [];
                if (named.length === 0 && images.length === 0) {
                    return false;
                }
                event.preventDefault();
                place(view, event);
                if (named.length > 0) {
                    target.insertFiles(named);
                } else {
                    images.forEach(file => target.saveImage(file));
                }
                return true;
            },
            handlePaste(_view, event) {
                const data = event.clipboardData;
                if (!data) {
                    return false;
                }
                const named = data.getData('resourceurls') ? namedFiles(data) : [];
                if (named.length > 0) {
                    event.preventDefault();
                    target.insertFiles(named);
                    return true;
                }
                const images = data.getData('text/plain') === '' ? bitmaps(data) : [];
                if (images.length === 0) {
                    return false;
                }
                event.preventDefault();
                images.forEach(file => target.saveImage(file));
                return true;
            },
        },
    });
}

/** A file's bytes as base64, for `saveImage`. */
export function readBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const url = String(reader.result ?? '');
            resolve(url.slice(url.indexOf(',') + 1));
        };
        reader.onerror = () => reject(reader.error ?? new Error('the file could not be read'));
        reader.readAsDataURL(file);
    });
}
