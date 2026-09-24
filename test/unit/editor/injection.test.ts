import * as assert from 'assert';
import { Node } from 'prosemirror-model';
import { MarkdownIt, StateBase, Token } from '../../../src/@types/markdown-it';
import { InjectionMark, editorSchema, parseDocument, serializeDocument } from '../../../src/editor';
import { hostEngine, toCrlf, topChildren } from './helpers';

type TokenCtor = new (type: string, tag: string, nesting: number) => Token;

function mark(token: Token, value: InjectionMark): void {
    const meta = (typeof token.meta === 'object' && token.meta !== null ? token.meta : {}) as Record<string, unknown>;
    meta.reqExplorer = value;
    token.meta = meta;
}

function expansionOf(token: Token): InjectionMark | undefined {
    const m = (token.meta as Record<string, unknown> | null)?.reqExplorer as InjectionMark | undefined;
    return m?.kind === 'expansion' ? m : undefined;
}

const SNIPPET = 'Snippet body naming FR-X-003.\n\n- a snippet item\n';

/**
 * A stand-in for Req Explorer's preview plugin that injects exactly as its SPEC
 * §10.2 describes and marks under `token.meta.reqExplorer`: the include
 * expansion after `block`, then at the end of core the heading badge, the
 * summary table after the heading and the `req-ref` decoration around a bare id.
 */
function fakeReqExplorer(md: MarkdownIt): MarkdownIt {
    md.core.ruler.after('block', 'req-includes', (state: StateBase) => {
        const tokens = state.tokens;
        for (let i = tokens.length - 1; i >= 0; i--) {
            const t = tokens[i];
            const m = t.type === 'html_block' && t.map ? /^<!-- include: (\S+) -->\n?$/.exec(t.content) : null;
            if (!m) {
                continue;
            }
            const line = t.map[0];
            const expanded: Token[] = [];
            md.block.parse(SNIPPET, md, state.env, expanded);
            const expansion: InjectionMark = { rule: 'req-includes', kind: 'expansion', snippet: m[1], line };
            for (const e of expanded) {
                if (e.map) {
                    e.map = [line, line + 1];
                }
                mark(e, expansion);
            }
            tokens.splice(i, 1, ...expanded);
        }
    });
    md.core.ruler.push('req-status-badges', (state: StateBase) => {
        const tokens = state.tokens;
        const tokenClass = state.Token as TokenCtor;
        const summaries: Array<{ after: number; value: InjectionMark }> = [];
        for (let i = 0; i < tokens.length; i++) {
            const t = tokens[i];
            if (t.type === 'heading_open') {
                const inline = tokens[i + 1];
                const id = /^(FR-X-\d{3}):/.exec(inline.content)?.[1];
                if (!id) {
                    continue;
                }
                const value: InjectionMark = expansionOf(inline) ?? { rule: 'req-status-badges', kind: 'atom', artifact: id };
                const badge = new tokenClass('html_inline', '', 0);
                badge.content = '<span class="req-badge req-badge-implemented">implemented</span>';
                mark(badge, value);
                inline.children.push(badge);
                summaries.push({ after: i + 2, value });
                continue;
            }
            if (t.type !== 'inline' || tokens[i - 1]?.type === 'heading_open') {
                continue;
            }
            const inExpansion = expansionOf(t);
            const children: Token[] = [];
            for (const child of t.children) {
                if (child.type !== 'text') {
                    children.push(child);
                    continue;
                }
                const parts = child.content.split(/\b(FR-X-\d{3})\b/);
                parts.forEach((part, k) => {
                    if (k % 2 === 0) {
                        if (part !== '') {
                            const text = new tokenClass('text', '', 0);
                            text.content = part;
                            children.push(text);
                        }
                        return;
                    }
                    const wrapper: InjectionMark = inExpansion ?? { rule: 'req-status-badges', kind: 'decoration', text: part };
                    const open = new tokenClass('html_inline', '', 0);
                    open.content = `<span class="req-ref" title="Title of ${part} [implemented]"><code>`;
                    mark(open, wrapper);
                    const id = new tokenClass('text', '', 0);
                    id.content = part;
                    const close = new tokenClass('html_inline', '', 0);
                    close.content = '</code></span>';
                    mark(close, wrapper);
                    children.push(open, id, close);
                });
            }
            t.children = children;
        }
        for (const { after, value } of summaries.reverse()) {
            const table = new tokenClass('html_block', '', 0);
            table.content = '<table class="req-summary" data-req-id="FR-X-001"><tbody><tr><th>Status</th><td>implemented</td></tr></tbody></table>\n';
            table.block = true;
            mark(table, value);
            tokens.splice(after + 1, 0, table);
        }
    });
    return md;
}

const DOCUMENT = [
    '---',
    'doc: FR-X',
    '---',
    '',
    '# FR-X — Fake',
    '',
    '## FR-X-001: A requirement {#fr-x-001--abcdef12}',
    '',
    'Prose naming FR-X-002 bare, which the decoration wraps,',
    'and a second line.',
    '',
    '<!-- include: legal -->',
    '',
    'After the include.',
    '',
].join('\n');

suite('Editor treatment of injected content', () => {
    const md = hostEngine([fakeReqExplorer]);
    let nodes: Node[] = [];

    suiteSetup(() => {
        nodes = topChildren(parseDocument(md, DOCUMENT).doc);
    });

    const byType = (name: string) => nodes.filter(n => n.type.name === name);

    test('the requirement heading lifts "FR-X-001: " into reqPrefix, and the editable text starts after it', () => {
        const heading = nodes.find(n => n.type.name === 'heading' && n.attrs.level === 2);
        assert.strictEqual(heading.attrs.reqPrefix, 'FR-X-001: ');
        assert.strictEqual(heading.textContent, 'A requirement');
        assert.strictEqual(heading.attrs.attrsSuffix, '{#fr-x-001--abcdef12}');
        assert.strictEqual(heading.attrs.src, '## FR-X-001: A requirement {#fr-x-001--abcdef12}\n');
    });

    test('the badge on the heading is an inline_atom carrying its HTML and its mark', () => {
        const heading = nodes.find(n => n.type.name === 'heading' && n.attrs.level === 2);
        const atom = heading.lastChild;
        assert.strictEqual(atom.type.name, 'inline_atom');
        assert.ok((atom.attrs.html as string).includes('req-badge-implemented'));
        assert.deepStrictEqual(atom.attrs.mark, { rule: 'req-status-badges', kind: 'atom', artifact: 'FR-X-001' });
    });

    test('the summary table is an injected atom block with no source, which serializes to nothing', () => {
        const summary = byType('injected_block').filter(n => n.attrs.kind === 'atom');
        assert.strictEqual(summary.length, 1);
        assert.strictEqual(summary[0].attrs.src, null);
        assert.ok((summary[0].attrs.html as string).includes('table class="req-summary"'));
        const alone = editorSchema.topNodeType.create(null, [summary[0]]);
        assert.strictEqual(serializeDocument({ doc: alone, eol: '\n', tail: '' }, { defaultWrap: 90 }), '');
    });

    test('the include expansion is exactly one injected block whose src is the directive line, serializing to it', () => {
        const expansions = byType('injected_block').filter(n => n.attrs.kind === 'expansion');
        assert.strictEqual(expansions.length, 1, 'the snippet\'s paragraph and list form one atom');
        const expansion = expansions[0];
        assert.strictEqual(expansion.attrs.src, '<!-- include: legal -->\n');
        assert.deepStrictEqual(expansion.attrs.mark, { rule: 'req-includes', kind: 'expansion', snippet: 'legal', line: 11 });
        assert.ok((expansion.attrs.html as string).includes('Snippet body naming'));
        assert.ok((expansion.attrs.html as string).includes('a snippet item'));
        const alone = editorSchema.topNodeType.create(null, [expansion.type.create({ ...expansion.attrs, gap: '' })]);
        assert.strictEqual(serializeDocument({ doc: alone, eol: '\n', tail: '' }, { defaultWrap: 90 }), '<!-- include: legal -->\n');
    });

    test('the decoration is a req_ref mark on the authored id, and the paragraph text is unchanged', () => {
        const paragraph = byType('paragraph').find(p => p.textContent.startsWith('Prose naming'));
        assert.strictEqual(paragraph.textContent, 'Prose naming FR-X-002 bare, which the decoration wraps, and a second line.');
        const marked: string[] = [];
        paragraph.forEach(child => {
            if (child.marks.some(m => m.type.name === 'req_ref')) {
                marked.push(child.text ?? '');
            }
        });
        assert.deepStrictEqual(marked, ['FR-X-002']);
        const ref = paragraph.child(1).marks.find(m => m.type.name === 'req_ref');
        assert.strictEqual(ref.attrs.title, 'Title of FR-X-002 [implemented]');
    });

    test('the whole document round-trips byte for byte, in both line-ending styles', () => {
        for (const text of [DOCUMENT, toCrlf(DOCUMENT)]) {
            const out = serializeDocument(parseDocument(md, text), { defaultWrap: 90 });
            assert.strictEqual(out, text);
            assert.ok(!out.includes('Snippet body'), 'the snippet body is never written into the file');
        }
    });
});
