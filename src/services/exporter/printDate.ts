/**
 * The print date of a PDF's header and footer.
 *
 * Chrome fills an element with class `date` itself, in the language it found on its own (the
 * operating system, and on Linux the launch environment), not in VS Code's. Its `--lang` switch
 * is not a remedy: it is ignored on some platforms and changes the fonts Chrome picks for
 * untagged CJK text. So MEP writes the print time itself, formatted with `Intl` in the export
 * locale (the `markdownExtended.pdf.locale` setting, else VS Code's display language), and
 * renames the element's class from `date` to `print-date`, because Chrome overwrites the text of
 * every element that still carries `date` when it prints. Nothing here touches a browser.
 */

import { VOID_ELEMENTS } from '../../syntax/voidElements';

/**
 * The locale the print date is formatted in. The `markdownExtended.pdf.locale` setting wins; else
 * VS Code's display language. Empty and the pseudo-locale `qps-ploc` (VS Code's localisation test
 * language) name no real language and give `undefined`, for which `Intl` uses the runtime's default.
 */
export function exportLocale(setting: string | undefined, envLanguage: string | undefined): string | undefined {
    const pick = (v: string | undefined) => (v ?? '').trim();
    const locale = pick(setting) || pick(envLanguage);
    return locale === '' || locale.toLowerCase() === 'qps-ploc' ? undefined : locale;
}

/**
 * The print time as Chrome itself writes the `date` class (`30.09.26, 13:20`, `9/30/26, 1:20 PM`),
 * but in a locale we choose: Chrome takes its own from the OS and the launch environment, which
 * differ per platform. An invalid or unknown tag falls back to the runtime default and is
 * reported through `warn`.
 */
export function formatPrintDate(locale: string | undefined, now: Date, warn?: (message: string) => void): string {
    const format = (l: string | undefined) => new Intl.DateTimeFormat(l, { dateStyle: 'short', timeStyle: 'short' }).format(now);
    try {
        if (locale !== undefined && Intl.DateTimeFormat.supportedLocalesOf(locale).length === 0) {
            throw new RangeError(`unknown locale ${locale}`); // well-formed but not a language Intl knows
        }
        return format(locale);
    } catch (error) {
        if (!(error instanceof RangeError)) {
            throw error;
        }
        warn?.(`[WARNING] markdownExtended.pdf.locale "${locale}" is not a known BCP 47 language tag; the print date uses the default locale.`);
        return format(undefined);
    }
}

/** One attribute of a start tag, with the source range of its value's text. */
interface TagAttribute {
    name: string;
    value: string;
    /** Range of the whole attribute in the tag's source. */
    start: number;
    end: number;
    /** Range of the value's text (inside the quotes, if any); equal bounds when there is none. */
    valueStart: number;
    valueEnd: number;
    quoted: boolean;
}

interface StartTag {
    name: string;
    attributes: TagAttribute[];
    /** Index after the closing `>`. */
    end: number;
    /** Index of the `/` of `/>`, or of the `>`; the source before it is the tag as written. */
    closer: number;
    selfClosing: boolean;
}

/**
 * Reads the start tag at `at` (which holds `<` and a letter), or undefined when the source
 * ends before its `>`. Tolerant: a `>` inside a quoted attribute value does not end the tag.
 */
function readStartTag(src: string, at: number): StartTag | undefined {
    const nameMatch = /^<([A-Za-z][^\s/>]*)/.exec(src.slice(at, at + 64));
    if (!nameMatch) {
        return undefined;
    }
    let i = at + nameMatch[0].length;
    const attributes: TagAttribute[] = [];
    for (;;) {
        while (i < src.length && /\s/.test(src[i])) {
            i++;
        }
        if (i >= src.length) {
            return undefined;
        }
        if (src[i] === '>' || (src[i] === '/' && src[i + 1] === '>')) {
            const selfClosing = src[i] === '/';
            return { name: nameMatch[1], attributes, end: selfClosing ? i + 2 : i + 1, closer: i, selfClosing };
        }
        if (src[i] === '/') {
            i++;
            continue;
        }
        const start = i;
        while (i < src.length && !/[\s=/>]/.test(src[i])) {
            i++;
        }
        const name = src.slice(start, i);
        if (name === '') {
            i++; // a stray '=' — skip it rather than loop
            continue;
        }
        let j = i;
        while (j < src.length && /\s/.test(src[j])) {
            j++;
        }
        let attribute: TagAttribute = { name, value: '', start, end: i, valueStart: i, valueEnd: i, quoted: false };
        if (src[j] === '=') {
            j++;
            while (j < src.length && /\s/.test(src[j])) {
                j++;
            }
            const quote = src[j] === '"' || src[j] === "'" ? src[j] : '';
            if (quote) {
                const close = src.indexOf(quote, j + 1);
                if (close < 0) {
                    return undefined;
                }
                attribute = { name, value: src.slice(j + 1, close), start, end: close + 1, valueStart: j + 1, valueEnd: close, quoted: true };
                i = close + 1;
            } else {
                let k = j;
                while (k < src.length && !/[\s>]/.test(src[k])) {
                    k++;
                }
                attribute = { name, value: src.slice(j, k), start, end: k, valueStart: j, valueEnd: k, quoted: false };
                i = k;
            }
        }
        attributes.push(attribute);
    }
}

/** The tag's class attribute, as its list of class names. */
function classList(tag: StartTag): { attribute?: TagAttribute; classes: string[] } {
    const attribute = tag.attributes.find(a => a.name.toLowerCase() === 'class');
    return { attribute, classes: attribute ? decodeEntities(attribute.value).split(/\s+/).filter(c => c !== '') : [] };
}

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** Decodes numeric character references and the five named entities, as the HTML parser does in an attribute. */
function decodeEntities(value: string): string {
    return value.replace(/&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|(amp|lt|gt|quot|apos));/g, (whole, dec?: string, hex?: string, named?: string) => {
        if (named) {
            return NAMED_ENTITIES[named];
        }
        const code = dec !== undefined ? parseInt(dec, 10) : parseInt(hex as string, 16);
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    });
}

function encodeAttribute(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * The start tag of a `date` element, opened again for the printed time: class `date` becomes
 * `print-date` (Chrome replaces the text of any element that carries `date`, which would throw
 * our text away), every other class and attribute stays, and a `/>` becomes `>`.
 */
function reopenAsPrintDate(src: string, at: number, tag: StartTag, attribute: TagAttribute, classes: string[]): string {
    const source = src.slice(at, tag.closer) + '>';
    const renamed: string[] = [];
    for (const c of classes) {
        const name = c === 'date' ? 'print-date' : c;
        if (!renamed.includes(name)) {
            renamed.push(name);
        }
    }
    const list = encodeAttribute(renamed.join(' '));
    const a = attribute.start - at;
    const b = attribute.end - at;
    const inQuotes = attribute.quoted ? source.slice(a, attribute.valueStart - at) + list + source.slice(attribute.valueEnd - at, b) : `class="${list}"`;
    return source.slice(0, a) + inQuotes + source.slice(b);
}

/**
 * Index after the end tag matching the start tag just read, counting same-named tags nested in
 * it and skipping comments. A `/>` on a non-void element opens it, as in HTML.
 */
function findElementEnd(src: string, tag: StartTag): { innerEnd: number; end: number } | undefined {
    const name = tag.name.toLowerCase();
    let depth = 1;
    let i = tag.end;
    while (i < src.length) {
        const lt = src.indexOf('<', i);
        if (lt < 0) {
            return undefined;
        }
        if (src.startsWith('<!--', lt)) {
            const endComment = src.indexOf('-->', lt + 4);
            i = endComment < 0 ? src.length : endComment + 3;
            continue;
        }
        const close = /^<\/([A-Za-z][^\s/>]*)\s*>/.exec(src.slice(lt, lt + 80));
        if (close) {
            if (close[1].toLowerCase() === name && --depth === 0) {
                return { innerEnd: lt, end: lt + close[0].length };
            }
            i = lt + close[0].length;
            continue;
        }
        const open = /[A-Za-z]/.test(src[lt + 1] ?? '') ? readStartTag(src, lt) : undefined;
        if (open) {
            if (open.name.toLowerCase() === name) {
                depth++;
            }
            i = open.end;
        } else {
            i = lt + 1;
        }
    }
    return undefined;
}

/**
 * Rewrites the selectors in a template's own CSS that name class `date` (`.date`, `[class~="date"]`,
 * `[class="date"]`) to `print-date`, leaving CSS strings and comments untouched.
 */
function renameDateSelectors(css: string): string {
    const attribute = /\[\s*class\s*(~?=)\s*(["']?)date\2\s*\]/iy;
    let out = '';
    let i = 0;
    while (i < css.length) {
        const c = css[i];
        if (css.startsWith('/*', i)) {
            const close = css.indexOf('*/', i + 2);
            const end = close < 0 ? css.length : close + 2;
            out += css.slice(i, end);
            i = end;
        } else if (c === '"' || c === "'") {
            let j = i + 1;
            while (j < css.length && css[j] !== c && css[j] !== '\n') {
                j += css[j] === '\\' ? 2 : 1;
            }
            out += css.slice(i, j + 1);
            i = j + 1;
        } else if (c === '[') {
            attribute.lastIndex = i;
            const m = attribute.exec(css);
            if (m) {
                out += `[class${m[1]}${m[2]}print-date${m[2]}]`;
                i += m[0].length;
            } else {
                out += c;
                i++;
            }
        } else if (c === '.' && /^\.date(?![\w-])/.test(css.slice(i, i + 6))) {
            out += '.print-date';
            i += 5;
        } else {
            out += c;
            i++;
        }
    }
    return out;
}

/**
 * Fills the `date` elements of a header or footer template with the preformatted print time.
 *
 * Any element whose class list contains `date` counts, whatever its name; its whole content
 * (nested tags included, up to its own end tag, comments skipped) is replaced; one without an end
 * tag runs to the end of the template, and only a void element (`<br>`) has no content. The class
 * value is read with its character references decoded. The filled element carries `print-date` instead of `date`, since Chrome overwrites
 * the text of any element with class `date` when it prints; the template's own `<style>` blocks
 * get `.date` rewritten to `.print-date` to follow it. An outer element never swallows a date
 * element inside it, and a `>` inside a quoted attribute does not end a tag.
 */
export function fillPrintDate(template: string, formatted: string): string {
    const text = formatted.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    let out = '';
    let i = 0;
    while (i < template.length) {
        const lt = template.indexOf('<', i);
        if (lt < 0) {
            break;
        }
        out += template.slice(i, lt);
        i = lt;
        if (template.startsWith('<!--', lt)) {
            const close = template.indexOf('-->', lt + 4);
            const end = close < 0 ? template.length : close + 3;
            out += template.slice(lt, end);
            i = end;
            continue;
        }
        const tag = /[A-Za-z]/.test(template[lt + 1] ?? '') ? readStartTag(template, lt) : undefined;
        if (!tag) {
            out += '<';
            i = lt + 1;
            continue;
        }
        const lower = tag.name.toLowerCase();
        if (lower === 'style' || lower === 'script') {
            const close = template.toLowerCase().indexOf(`</${lower}`, tag.end);
            const innerEnd = close < 0 ? template.length : close;
            const inner = template.slice(tag.end, innerEnd);
            out += template.slice(lt, tag.end) + (lower === 'style' ? renameDateSelectors(inner) : inner);
            i = innerEnd;
            continue;
        }
        const { attribute, classes } = classList(tag);
        if (attribute && classes.includes('date')) {
            out += reopenAsPrintDate(template, lt, tag, attribute, classes);
            if (VOID_ELEMENTS.has(lower)) {
                i = tag.end; // a void element has no content to fill; Chrome puts none either
                continue;
            }
            // No end tag: the element runs to the end of the template, as in HTML and in Chrome.
            const element = findElementEnd(template, tag);
            out += text + `</${tag.name}>`;
            i = element ? element.end : template.length;
            continue;
        }
        out += template.slice(lt, tag.end);
        i = tag.end;
    }
    return out + template.slice(i);
}

/** Fills the date elements of the header and footer templates in PDF options, in place, and renames their class (see `fillPrintDate`). */
export function applyPrintDate(pdfOptions: { headerTemplate?: unknown; footerTemplate?: unknown }, locale: string | undefined, now: Date, warn?: (message: string) => void): void {
    const formatted = formatPrintDate(locale, now, warn);
    for (const key of ['headerTemplate', 'footerTemplate'] as const) {
        const template = pdfOptions[key];
        if (typeof template === 'string') {
            pdfOptions[key] = fillPrintDate(template, formatted);
        }
    }
}
