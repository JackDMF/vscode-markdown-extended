import { DOMOutputSpec, DOMSerializer, Fragment, Node } from 'prosemirror-model';
import { admonitionTitleSpec, editorSchema } from '../../../src/editor/schema';

/**
 * A DOM small enough for `DOMSerializer`, so the schema's drawing can be read in
 * the extension host, where there is no document, and compared with the HTML
 * the engine renders.
 */

export const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export class FakeNode {
    readonly childNodes: FakeNode[] = [];
    constructor(readonly nodeType: number, readonly tag = '', readonly text = '') { }
    readonly attrs: [string, string][] = [];
    get nodeName(): string {
        return this.nodeType === 3 ? '#text' : this.nodeType === 8 ? '#comment' : this.nodeType === 11 ? '#document-fragment' : this.tag.toUpperCase();
    }
    get nodeValue(): string | null {
        return this.nodeType === 3 || this.nodeType === 8 ? this.text : null;
    }
    appendChild(child: FakeNode): FakeNode {
        this.childNodes.push(child);
        return child;
    }
    setAttribute(name: string, value: string): void {
        this.attrs.push([name, value]);
    }
    getAttribute(name: string): string | null {
        return this.attrs.find(([n]) => n === name)?.[1] ?? null;
    }
    html(skip: (name: string) => boolean = () => false): string {
        if (this.nodeType === 3) {
            return escapeHtml(this.text);
        }
        const inner = this.childNodes.map(c => c.html(skip)).join('');
        if (this.nodeType === 11) {
            return inner;
        }
        const attrs = this.attrs.filter(([n]) => !skip(n)).map(([n, v]) => ` ${n}="${escapeHtml(v)}"`).join('');
        return /^(hr|br|img|input)$/.test(this.tag) ? `<${this.tag}${attrs}>` : `<${this.tag}${attrs}>${inner}</${this.tag}>`;
    }
}

export const fakeDocument = {
    createElement: (tag: string) => new FakeNode(1, tag),
    createTextNode: (text: string) => new FakeNode(3, '', text),
    createDocumentFragment: () => new FakeNode(11),
};

const asDocument = fakeDocument as unknown as Document;

/** The attributes the editor adds for itself, which no stylesheet of the preview names. */
export const editorOnly = (name: string) => name.startsWith('data-mep-') || name === 'contenteditable' || name === 'data-tight' || name === 'data-params';

/**
 * A block as the page draws it: the schema's DOM, with each admonition's title
 * bar put first in it, as the page's widget puts it (`webview/wrappers.ts`).
 */
export function drawBlock(node: Node): FakeNode {
    const dom = DOMSerializer.fromSchema(editorSchema).serializeNode(node, { document: asDocument }) as unknown as FakeNode;
    const addTitles = (el: FakeNode) => {
        for (const child of el.childNodes) {
            addTitles(child);
        }
        const title = el.getAttribute('data-mep-title');
        if (el.tag === 'div' && title !== null && title !== '' && (el.getAttribute('class') ?? '').startsWith('admonition')) {
            const bar = DOMSerializer.renderSpec(asDocument, admonitionTitleSpec(title) as DOMOutputSpec).dom as unknown as FakeNode;
            el.childNodes.unshift(bar);
        }
    };
    addTitles(dom);
    return dom;
}

/** An inline fragment as the page draws it. */
export function drawInline(content: Fragment): FakeNode {
    return DOMSerializer.fromSchema(editorSchema).serializeFragment(content, { document: asDocument }) as unknown as FakeNode;
}

/** The engine's HTML with the newlines it puts between block tags removed. */
export function engineHtml(html: string): string {
    return html.replace(/>\n+/g, '>').replace(/\n+</g, '<').trim();
}
