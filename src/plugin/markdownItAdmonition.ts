import { MarkdownIt, Token, Renderer } from "../@types/markdown-it";
import { ADMONITION_MARKER, ADMONITION_TYPES } from "../syntax/markers";

// The types and the marker live in `src/syntax/markers.ts`, which the Visual
// Editor's toolbar reads too: its admonition menu lists exactly these. Each
// type's colour and icon are in `styles/markdown-it-admonition.css`.
const
    _marker = ADMONITION_MARKER.charCodeAt(0),
    _minMarkerLen = ADMONITION_MARKER.length,
    _types = ADMONITION_TYPES;

// eslint-disable-next-line @typescript-eslint/naming-convention
export function MarkdownItAdmonition(md: MarkdownIt) {
    md.block.ruler.after("fence", "admonition", admonition, {});
    md.renderer.rules["admonition_open"] = render;
    md.renderer.rules["admonition_title_open"] = render;
    md.renderer.rules["admonition_title_close"] = render;
    md.renderer.rules["admonition_close"] = render;
}

function render(tokens: Token[], idx: number, _options: any, env: any, self: Renderer) {
    const token = tokens[idx];
    if (token.type === "admonition_open") {
        tokens[idx].attrJoin("class", "admonition " + token.info);
    } else if (token.type === "admonition_title_open") {
        tokens[idx].attrJoin("class", "admonition-title");
    }
    return self.renderToken(tokens, idx, _options);
}

function admonition(state: any, startLine: number, endLine: number, silent: boolean) {
    // if it's indented more than 3 spaces, it should be a code block
    if (state.tShift[startLine] - state.blkIndent >= 4) {return false;}
    let pos: number = state.bMarks[startLine] + state.tShift[startLine];
    let max: number = state.eMarks[startLine];
    const marker: number = state.src.charCodeAt(pos);
    if (marker !== _marker) {return false;}

    // scan marker length
    let mem = pos;
    pos = state.skipChars(pos, marker);
    const len = pos - mem;
    if (len < _minMarkerLen) {return false;}

    const markup: string = state.src.slice(mem, pos);
    const { type, classes, title } = admonitionParams(state.src.slice(pos, max));

    // Since start is found, we can report success here in validation mode
    if (silent) {return true;}

    const oldParent = state.parentType;
    const oldLineMax = state.lineMax;
    const oldIndent = state.blkIndent;

    state.blkIndent += 4;

    // search end of block
    let nextLine = startLine;
    for (; ;) {
        nextLine++;
        if (nextLine >= endLine) {
            // unclosed block should be autoclosed by end of document.
            // also block seems to be autoclosed by end of parent
            break;
        }
        pos = mem = state.bMarks[nextLine] + state.tShift[nextLine];
        max = state.eMarks[nextLine];

        if (pos < max && state.sCount[nextLine] < state.blkIndent) {
            // non-empty line with negative indent should stop the list:
            // - !!!
            //  test
            break;
        }
    }

    state.parentType = "admonition";
    // this will prevent lazy continuations from ever going past our end marker
    state.lineMax = nextLine;

    let token = state.push("admonition_open", "div", 1);
    token.markup = markup;
    token.block = true;
    token.info = classes.join(' ');
    token.map = [startLine, startLine + 1];

    if (title !== '') {
        // admonition title
        token = state.push("admonition_title_open", "p", 1);
        token.markup = markup + " " + type;
        token.map = [startLine, startLine + 1];

        token = state.push("inline", "", 0);
        token.content = title;
        token.map = [startLine, startLine + 1];
        token.children = [];

        token = state.push("admonition_title_close", "p", -1);
        token.markup = markup + " " + type;
    }

    // parse admonition body, its lines seen from where the body starts
    const saved = indentBody(state, startLine + 1, nextLine, state.blkIndent);
    state.blkIndent = 0;
    state.md.block.tokenize(state, startLine + 1, nextLine);
    restoreBody(state, startLine + 1, saved);

    token = state.push("admonition_close", "div", -1);
    token.markup = markup;
    token.map = [startLine, nextLine];
    token.block = true;

    state.parentType = oldParent;
    state.lineMax = oldLineMax;
    state.line = nextLine;
    state.blkIndent = oldIndent;
    return true;
}

/**
 * Moves the start of each body line past the body's indentation, `indent`
 * columns, as markdown-it's blockquote rule moves it past `> `, and returns
 * the offsets it replaced: `[bMarks, tShift, sCount, bsCount]` per line.
 * Every rule inside then reads the body as a document of its own (indent 0),
 * so a rule that cuts `bMarks + blkIndent` characters, as
 * markdown-it-multimd-table does, cuts no text when a tab (one character,
 * four columns) indents the body (qjebbs/vscode-markdown-extended#110). A tab
 * the indentation ends inside is kept, its remaining columns counted through
 * `bsCount`.
 */
function indentBody(state: any, startLine: number, endLine: number, indent: number): number[][] {
    const saved: number[][] = [];
    for (let line = startLine; line < endLine; line++) {
        saved.push([state.bMarks[line], state.tShift[line], state.sCount[line], state.bsCount[line]]);
        const max: number = state.eMarks[line];
        const bsCount: number = state.bsCount[line];
        let pos: number = state.bMarks[line];
        let col = 0;
        while (pos < max && col < indent) {
            const width = columnsOf(state.src.charCodeAt(pos), col, bsCount);
            if (width === 0 || col + width > indent) {break;}
            col += width;
            pos++;
        }
        // `pos` is where the body's text starts, or a tab reaching past it.
        const start = pos;
        let offset = col;
        for (let width; pos < max && (width = columnsOf(state.src.charCodeAt(pos), offset, bsCount)) > 0; pos++) {
            offset += width;
        }
        state.bMarks[line] = start;
        state.tShift[line] = pos - start;
        state.sCount[line] = Math.max(0, offset - indent);
        state.bsCount[line] = bsCount + indent;
    }
    return saved;
}

/** Puts back the offsets `indentBody` replaced, from `startLine` on. */
function restoreBody(state: any, startLine: number, saved: number[][]) {
    saved.forEach(([bMarks, tShift, sCount, bsCount], i) => {
        state.bMarks[startLine + i] = bMarks;
        state.tShift[startLine + i] = tShift;
        state.sCount[startLine + i] = sCount;
        state.bsCount[startLine + i] = bsCount;
    });
}

/**
 * How many columns the character at column `col` takes: a space one, a tab
 * up to the next tab stop, as markdown-it counts it (`bsCount` being the
 * line's columns before its `bMarks`); `0` for anything else.
 */
function columnsOf(ch: number, col: number, bsCount: number): number {
    return ch === 0x09 ? 4 - (col + bsCount) % 4 : ch === 0x20 ? 1 : 0;
}

/**
 * The opening line after the marker
 * (https://python-markdown.github.io/extensions/admonition/):
 * `type "Title"`, `type class … "Title"` or `type Title`. A title is quoted
 * only when its `"` follows the type and its classes, words separated by
 * whitespace (a lone type may touch it: `!!! warning"Careful"`), and its
 * closing `"` ends the line; otherwise the rest of the line after the type
 * is the title, quotes and all, so `!!! note <font color="red">…</font>` is
 * a note titled by its HTML (qjebbs/vscode-markdown-extended#131). A quoted
 * title is kept as written, spaces and all, and `""` is none; an unquoted
 * one is trimmed. A `{…}` after the closing quote stays with the title,
 * where markdown-it-attrs gives it to the title bar. The type is the first
 * word, lowercased; a first word that is no type is a note's title, unless a
 * quoted title follows it: then it is a class beside `note`.
 */
export function admonitionParams(line: string): { type: string; classes: string[]; title: string } {
    const params = line.trim();
    const quoted = /^(?:([^\s"]+(?:\s+[^\s"]+)*)\s+|([^\s"]+))?"([\s\S]*)"(\s*\{[^{}]*\})?$/.exec(params);
    if (quoted) {
        const classes = (quoted[1] ?? quoted[2] ?? "").split(/\s+/).filter(s => !!s);
        if (classes.length) {
            classes[0] = classes[0].toLowerCase();
        }
        if (_types.indexOf(classes[0]) < 0) {
            classes.unshift("note");
        }
        const title = quoted[3] === "" ? "" : quoted[3] + (quoted[4] ?? "");
        return { type: classes[0], classes, title };
    }
    const [, first, rest] = /^(\S*)\s*([\s\S]*)$/.exec(params);
    const type = first.toLowerCase();
    return _types.indexOf(type) < 0
        ? { type: "note", classes: ["note"], title: params }
        : { type, classes: [type], title: rest };
}
