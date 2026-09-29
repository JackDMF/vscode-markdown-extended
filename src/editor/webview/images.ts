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
import { schemeOf } from '../paths';
import { showHint } from './hint';
import { DROP_LOCK, IMAGE_LOCK, insertLockReason } from './objects';

/** The attribute an image element carries its written `src` in. */
export const WRITTEN_SRC_ATTR = 'data-mep-src';

export class ImageSources {
    /** Each `src` asked about: the address to load, or `null` to show it as written. */
    private readonly known = new Map<string, string | null>();
    private readonly waiting = new Set<string>();
    private readonly queued = new Set<string>();
    private readonly pending = new Map<number, Set<string>>();
    private seq = 0;
    private timer: ReturnType<typeof setTimeout> | undefined;

    constructor(
        private readonly ask: (requestId: number, srcs: string[]) => void,
        private readonly root: () => ParentNode | null,
    ) { }

    /**
     * The address to load `src` from; `undefined` while the host has not said
     * (it is asked). A `src` with a scheme other than `file:` — a web address,
     * a `data:` image of any size — names no file the host could resolve, and
     * is shown as written without asking or keeping it.
     */
    display(src: string): string | undefined {
        const scheme = schemeOf(src);
        if (scheme !== undefined && scheme !== 'file') {
            return src;
        }
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
            if (asked.has(src)) {
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
        this.pending.set(requestId, new Set(srcs));
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

/** How a file reached the page; a refusal is said in its terms. */
export type FileGesture = 'drop' | 'paste';

/** What the page does with files the person dropped or pasted. */
export interface FileTarget {
    /** Files VS Code's Explorer view named by uri: the host makes each relative to the document (`insertFiles`). */
    insertFiles(uris: string[], gesture: FileGesture): void;
    /** A bitmap with no file behind it the page can name (a screenshot, an image from the system): the host writes a copy beside the document (`saveImage`). */
    saveImage(file: File, gesture: FileGesture): void;
}

/** What a drop of files from the system that are not images is told: only the Explorer view's files are linked. */
export const SYSTEM_FILE_LOCK = 'Drop a file from the Explorer view to link it.';

/**
 * The files a drop or a paste names by uri: VS Code's `resourceurls` (the
 * Explorer view), else the `file:` lines of a `text/uri-list`. A web address
 * in a uri list is not a file and is left to the browser, which inserts it as
 * text. A file from the system is never named: a sandboxed webview gets its
 * bytes and its name, not its path (`File.path` is gone since Electron 32).
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
            // Not the list VS Code writes; read the uri list.
        }
    }
    return data.getData('text/uri-list')
        .split(/\r?\n/).map(l => l.trim()).filter(l => l !== '' && !l.startsWith('#') && /^file:/i.test(l));
}

/** The image files of a drop or a paste: bitmaps the host copies beside the document. */
export function bitmaps(data: DataTransfer): File[] {
    return Array.from(data.files ?? []).filter(f => f.type.startsWith('image/'));
}

/**
 * Files dropped into the text, or pasted.
 *
 * - Files the Explorer view names (`namedFiles`) are inserted by their path
 *   relative to the document: linked, not copied.
 * - An image with no file the page can name — a screenshot, an image copied
 *   from a browser, an image dropped from the system — is **copied**: the host
 *   writes it beside the document, under its own name when it has one, and it
 *   is inserted by the path it was saved at. A paste counts only while the
 *   clipboard holds no text, since a copy from an office program carries a
 *   picture of its text beside the text itself.
 * - Any other file from the system is not inserted, and the hint says to drop
 *   it from the Explorer view.
 *
 * A drop puts the caret at the drop point first, and nothing is written — no
 * file saved — where nothing could go in (`insertLockReason`, said in the
 * gesture's terms). The answer is inserted at the caret. Anything else is
 * ProseMirror's.
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
                const files = named.length === 0 ? Array.from(data.files ?? []) : [];
                if (named.length === 0 && files.length === 0) {
                    return false;
                }
                event.preventDefault();
                place(view, event);
                if (named.length === 0 && images.length === 0) {
                    showHint(view, SYSTEM_FILE_LOCK, 'refusal');
                    return true;
                }
                const refusal = insertLockReason(view.state, DROP_LOCK);
                if (refusal !== null) {
                    showHint(view, refusal, 'refusal');
                    return true;
                }
                if (named.length > 0) {
                    target.insertFiles(named, 'drop');
                } else {
                    images.forEach(file => target.saveImage(file, 'drop'));
                }
                return true;
            },
            handlePaste(view, event) {
                const data = event.clipboardData;
                if (!data) {
                    return false;
                }
                const named = data.getData('resourceurls') ? namedFiles(data) : [];
                const images = named.length === 0 && data.getData('text/plain') === '' ? bitmaps(data) : [];
                if (named.length === 0 && images.length === 0) {
                    return false;
                }
                event.preventDefault();
                const refusal = insertLockReason(view.state, IMAGE_LOCK);
                if (refusal !== null) {
                    showHint(view, refusal, 'refusal');
                    return true;
                }
                if (named.length > 0) {
                    target.insertFiles(named, 'paste');
                } else {
                    images.forEach(file => target.saveImage(file, 'paste'));
                }
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
