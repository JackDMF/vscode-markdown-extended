import * as assert from 'assert';
import * as puppeteer from 'puppeteer';
import { buildEditorEngine } from '../../../src/editor/host/engineHost';
import { parseDocument, parsedDocumentToJSON } from '../../../src/editor/parse';
import { EXTENSION_ID, EditorPage, delay, openEditorPage, shot, vscodeMarkdownCss } from './pageHarness';
import { DARK_MODERN, applyTheme } from './themes';

/**
 * A person's `markdown.styles`, as Req Explorer's corpus has one: a note
 * reference underlined by a border of 1.5px, a code chip with padding. The
 * colours are the test's, so the underline can be found in a screenshot.
 */
const UNDERLINE = [255, 68, 56];
const USER_STYLE = [
    'code { background: #3a3f4b; padding: .1em .35em; border-radius: 3px; font-size: .85em; }',
    `.sn-ref { border-bottom: 1.5px solid rgb(${UNDERLINE.join(', ')}); }`,
    '.mn-ref { border-bottom: 1.5px dotted #dddddd; }',
].join('\n');

type Branch = 'above' | 'beside' | 'below' | 'edge';

/** A document per branch of the bubble's ladder (`placeBubble`), and the word to select in it. */
const PLACES: { branch: Branch; text: string }[] = [
    { branch: 'above', text: 'Short.\n\nAlpha, a longer paragraph whose one line runs on and on, far along, until the word gamma.\n' },
    { branch: 'beside', text: 'A line above the table, long enough to run on across the column and on and on and on and on and on.\n\n| A | B |\n| - | - |\n| one | gamma |\n| three | four |\n' },
    { branch: 'below', text: 'A first paragraph whose one line runs on, well across where the word below it stands.\n\nAlpha beta gamma.\n' },
    {
        branch: 'edge', text: [
            'A first line that runs on across the whole column, and on and on and on and on, and on and on and on and on and on and on and on.  ',
            'Then gamma.  ',
            // Short, under the bubble's place below but not under the column's right end.
            'A third line, short.',
            '',
        ].join('\n'),
    },
];

/**
 * The selection bubble's samples are drawn by the page's cascade wherever the
 * bubble stands (ARCHITECTURE, "Toolbar"): in every branch of its ladder, and
 * at every sub-pixel offset, what a stylesheet paints around a sample — a
 * border, a background — lies inside the button, so none of it is cut by the
 * button's clipping. Held by its content box instead, a sample with a border
 * stood taller than the button, and a note's 1.5px underline showed above one
 * line of text and vanished above the next (Daniel, 2026-09-30).
 */
suite('Bubble samples (e2e)', () => {
    let editor: EditorPage | undefined;
    let page: puppeteer.Page;
    let version = 0;

    const showDocument = async (text: string) => {
        const md = await buildEditorEngine(EXTENSION_ID, () => undefined);
        const json = parsedDocumentToJSON(parseDocument(md, text, {}));
        version++;
        await (editor as EditorPage).send({ type: 'document', json, version, defaultWrap: 90, includes: false });
        await page.waitForFunction(() => document.querySelector('.ProseMirror')?.textContent?.includes('gamma'));
        await delay(50);
    };

    const selectText = async (needle: string) => {
        await page.focus('.ProseMirror');
        await page.evaluate(n => {
            const root = document.querySelector('.ProseMirror') as HTMLElement;
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
                const at = (node.textContent ?? '').indexOf(n);
                if (at >= 0) {
                    (document.getSelection() as Selection).setBaseAndExtent(node, at, node, at + n.length);
                    return;
                }
            }
            throw new Error(`no "${n}" in the document`);
        }, needle);
        await delay(150);
    };

    /** Which branch the bubble stands in, and every sample whose painted box its button cuts. */
    const read = () => page.evaluate(() => {
        const bubble = document.querySelector('.mep-bubble') as HTMLElement;
        const mount = bubble.parentElement as HTMLElement;
        const box = bubble.getBoundingClientRect();
        const sel = (document.getSelection() as Selection).getRangeAt(0);
        const range = sel.getBoundingClientRect();
        const block = (sel.startContainer.parentElement as HTMLElement).closest('.ProseMirror > *') as HTMLElement;
        const branch = box.bottom <= range.top + 1 ? 'above'
            : box.top >= range.bottom - 1 ? 'below'
                : box.left >= block.getBoundingClientRect().right ? 'beside'
                    : Math.abs(box.right - mount.getBoundingClientRect().right) < 1 ? 'edge' : 'elsewhere';
        const cut: string[] = [];
        const looks: string[] = [];
        for (const sample of Array.from(bubble.querySelectorAll<HTMLElement>('.mep-sample > *'))) {
            const cs = getComputedStyle(sample);
            looks.push([sample.tagName, sample.className, cs.borderBottom, cs.backgroundColor, cs.padding, cs.fontFamily, cs.fontSize].join(' '));
            const painted = ['Top', 'Right', 'Bottom', 'Left'].some(side => parseFloat(cs.getPropertyValue(`border-${side.toLowerCase()}-width`)) > 0)
                || cs.backgroundColor !== 'rgba(0, 0, 0, 0)';
            if (!painted) {
                continue;
            }
            // Where the button clips, as its computed style says: inside its border (its padding
            // box) unless `overflow-clip-margin` moves the edge out to its border box.
            const tool = sample.closest('.mep-tool') as HTMLElement;
            const t = tool.getBoundingClientRect();
            const ts = getComputedStyle(tool);
            const inset = ts.overflowClipMargin.startsWith('border-box') ? [0, 0, 0, 0]
                : [ts.borderTopWidth, ts.borderRightWidth, ts.borderBottomWidth, ts.borderLeftWidth].map(parseFloat);
            const clip = { top: t.top + inset[0], right: t.right - inset[1], bottom: t.bottom - inset[2], left: t.left + inset[3] };
            const s = sample.getBoundingClientRect();
            const e = 0.01;
            if (s.top < clip.top - e || s.bottom > clip.bottom + e || s.left < clip.left - e || s.right > clip.right + e) {
                cut.push(`${sample.tagName.toLowerCase()}${sample.className ? `.${sample.className}` : ''}: ${s.top - clip.top} .. ${s.bottom - clip.bottom} past the button`);
            }
        }
        return { branch, cut, looks };
    });

    /** How many pixels of the sidenote sample's button are the underline's colour, as the screen shows it. */
    const underlinePixels = async (): Promise<number> => {
        const tool = await page.$('.mep-bubble [data-action="sidenote"]') as puppeteer.ElementHandle;
        const png = await tool.screenshot({ encoding: 'base64' });
        return page.evaluate(async (data, [r, g, b]) => {
            const image = new Image();
            image.src = `data:image/png;base64,${data}`;
            await image.decode();
            const canvas = document.createElement('canvas');
            canvas.width = image.width;
            canvas.height = image.height;
            const context = canvas.getContext('2d') as CanvasRenderingContext2D;
            context.drawImage(image, 0, 0);
            const pixels = context.getImageData(0, 0, image.width, image.height).data;
            let count = 0;
            for (let i = 0; i < pixels.length; i += 4) {
                if (Math.abs(pixels[i] - r) < 60 && Math.abs(pixels[i + 1] - g) < 60 && Math.abs(pixels[i + 2] - b) < 60) {
                    count++;
                }
            }
            return count;
        }, png as string, UNDERLINE);
    };

    suiteSetup(async function () {
        this.timeout(60000);
        editor = await openEditorPage({ width: 1400, stylesheets: [vscodeMarkdownCss()], styles: ['markdown-extended.css', 'markdown-it-admonition.css', 'markdown-it-kbd.css'] });
        if (!editor) {
            this.skip();
        }
        page = editor.page;
        await applyTheme(page, DARK_MODERN);
        // After every sheet of the page, as `markdown.styles` comes after the extensions' (`html.ts`).
        await page.evaluate(css => {
            const style = document.createElement('style');
            style.textContent = css;
            document.head.append(style);
        }, USER_STYLE);
    });

    suiteTeardown(async () => {
        await editor?.close();
    });

    test('in every branch of its ladder, and at every sub-pixel offset, the bubble draws each sample\'s border and background whole, the same', async function () {
        this.timeout(30000);
        let looks: string[] | undefined;
        const cut: Record<string, string[]> = {};
        for (const { branch, text } of PLACES) {
            await showDocument(text);
            await selectText('gamma');
            const found = await read();
            await shot(page, `bubble-${branch}.png`);
            assert.strictEqual(found.branch, branch, `the document for "${branch}" puts the bubble there`);
            if (looks) {
                assert.deepStrictEqual(found.looks, looks, `${branch}: the cascade styles the samples as it does in the first branch`);
            }
            looks = found.looks;
            if (found.cut.length > 0) {
                cut[branch] = found.cut;
            }
        }
        // The same bubble a fraction of a pixel lower each time, as lines of 22.4px leave it:
        // the underline is on the screen at every offset, not at some.
        const top = await page.$eval('.mep-bubble', el => parseFloat((el as HTMLElement).style.top));
        const counts: number[] = [];
        for (const offset of [0, 0.25, 0.5, 0.75]) {
            await page.$eval('.mep-bubble', (el, at) => {
                (el as HTMLElement).style.top = `${at}px`;
            }, top + offset);
            counts.push(await underlinePixels());
        }
        const width = await page.$eval('.mep-bubble .sn-ref', el => el.getBoundingClientRect().width);
        assert.ok(counts.every(n => n >= width * 0.8), `the sidenote's underline is drawn at every offset: ${counts.join(', ')} pixels of a ${width.toFixed(1)}px reference`);
        assert.deepStrictEqual(cut, {}, 'in no branch is a sample\'s painted box cut by its button');
    });
});
