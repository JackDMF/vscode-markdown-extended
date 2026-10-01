import { MarkdownIt, RuleInline, StateBase } from "../@types/markdown-it";
import markdownItKbd from 'markdown-it-kbd';
import { followsWikiEmbedMarker } from '../syntax/markers';

// markdown-it-kbd reads every `[[…]]` as a key, so Foam's wiki embed
// `![[path/to/img.png]]` was rendered as `!<kbd>path/to/img.png</kbd>`
// (qjebbs/vscode-markdown-extended#168). Its rule is kept, and refuses a `[[`
// right after an unescaped `!` (`followsWikiEmbedMarker`, which the Visual
// Editor's serializer reads too): that `[[` is the embed's, left as text for
// the extension that renders embeds. A plain `[[…]]` is still a key.
const RULE = 'kbd';

/** markdown-it's `Ruler` keeps its rules in `__rules__`; the package exports only its plugin, so its rule is found there. */
interface RulerInternals {
    __rules__: { name: string; fn: RuleInline }[];
}

// eslint-disable-next-line @typescript-eslint/naming-convention
export function MarkdownItKbd(md: MarkdownIt) {
    md.use(markdownItKbd);
    const keys = (md.inline.ruler as unknown as RulerInternals).__rules__.find(rule => rule.name === RULE)?.fn;
    if (!keys) { return; }
    md.inline.ruler.at(RULE, (state: StateBase, silent: boolean) =>
        !followsWikiEmbedMarker(state.src, state.pos as number) && keys(state, silent));
}
