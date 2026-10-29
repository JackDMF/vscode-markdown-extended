import * as assert from 'assert';
import * as fs from 'fs';
import * as puppeteer from 'puppeteer';
import { buildEditorEngine } from '../../../src/editor/host/engineHost';
import { parseDocument, parsedDocumentToJSON } from '../../../src/editor/parse';
import { DEFAULT_INLINE_ENGINE } from '../../../src/editor/inlineEngine';
import { HOVER_DELAY_MS } from '../../../src/editor/webview/hover';
import { closeEditorPage, delay, EditorPage, EXTENSION_ID, leaveObjects, MOD, openEditorPage, settle, shot, SHOTS_DIR } from './pageHarness';
import { DARK_MODERN, HC_DARK, LIGHT_MODERN, Theme, applyTheme } from './themes';
import { COTK } from './footnotes.e2e.test';

/** CA-cotk22's shape with `liebst` referenced twice: entry 1's bar counts "· 2 references". */
const TWICE = COTK.replace('fragte, wurde', 'und liebst[^liebst] fragte, wurde');

/** CA-btk22's multi-line entries: `␣␣` + a lazy line; three hard breaks and a sidenote across lines. */
const MULTILINE = [
    'Wer ist der verständige Sklave[^Sklave], und wer hat ewiges Leben[^ewiges_Leben]?',
    '',
    '[^Sklave]: *Sklave*  ',
    'Oder „Diener“. Die Tatsache, dass „Sklave“ hier im Singular steht, bedeutet nicht unbedingt, dass damit eine bestimmte Einzelperson gemeint ist.',
    '',
    '[^ewiges_Leben]: *ewiges Leben*  ',
    'Bei dieser Begebenheit fiel mehrfach der Ausdruck „ewiges Leben“: Jesus sprach vier Mal davon (++Joh 6:27, 40, 47, 54|&bull; Nahrung &rarr; ewiges Leben  ',
    '&bull; Glauben &rarr; ewiges Leben  ',
    '&bull; von Fleisch essen und Blut trinken &rarr; ewiges Leben++) und ein Jünger ein Mal.',
    '',
].join('\n');

/** Two definitions with one label: the engine keeps the last, the first is "same label as footnote 1". */
const DUPLICATE = 'Ein Satz[^satz] und mehr.\n\n[^satz]: Der erste Text.\n\n[^satz]: Der zweite, den die Vorschau zeigt.\n';

/** A reference whose label is misspelt, written as text, dotted; the entry it meant not referenced. */
const LITERAL = 'Meine Schäfchen[^Schaefchen] hüten.\n\n[^Schäfchen]: *Schäfchen*: Kleine Schafe.\n';

/** CA-btk22's `++Helfer|… Joh 14:16.[^Joh14:16]++`: a reference in a sidenote's text, in the margin. */
const SIDENOTE = [
    'Doch der ++Helfer|Oder „Tröster“, „Ermutiger“, „Anwalt“. (Siehe Anm. zu Joh 14:16.[^Joh14:16])++, der heilige Geist, den der Vater in meinem Namen senden wird, wird euch alles lehren.',
    '',
    '[^Joh14:16]: *Helfer*  ',
    'Oder „Tröster“, „Ermutiger“, „Anwalt“. Das mit „Helfer“ übersetzte griechische Wort paráklētos.',
    '',
].join('\n');

/** `SIDENOTE` with the paragraph running on: full lines of the column beside the note and under its reference. */
const SIDENOTE_FULL = SIDENOTE.replace('wird euch alles lehren.', `wird euch alles lehren. ${'Der Vater wird euch einen anderen Helfer geben, der für immer bei euch sein wird, den Geist der Wahrheit, den die Welt nicht empfangen kann, weil sie ihn weder sieht noch kennt. '.repeat(3).trim()}`);

/** CA-cotk22's verse run on: its second line is full, so the bar at [1] stands above it. */
const FLIPPED = COTK.replace('Petrus traurig.', 'Petrus traurig, und er sagte zu ihm: „Herr, du weißt alles; du weißt, dass ich dich lieb habe.“ Jesus sagte zu ihm: „Füttere meine Schäfchen.“');

/** Footnote 2 inline: the entries read 1, 3. */
const GAP = 'Erst[^eins], dann eine Anleitung^[Oder „Lenkung“.], dann[^drei].\n\n[^eins]: Eins.\n\n[^drei]: Drei.\n';

/** The text for an insert: `Taufe“.` selected; the entry above the new one runs over two lines (UX review 2). */
const INSERT = '> Die Taufe, die dem entspricht, rettet jetzt auch euch, die Bitte an Gott um ein gutes Gewissen — Taufe“.\n\n[^x]: *x*: Eine Erklärung, die über zwei Zeilen läuft: so steht über dem neuen Eintrag Text, den der Hinweis nicht verdecken darf, wenn der Balken kommt und ihn verschiebt.\n\nDanach[^x].\n';

const THEMES: [Theme, string][] = [[LIGHT_MODERN, 'light'], [DARK_MODERN, 'dark'], [HC_DARK, 'hc']];

/**
 * Footnotes in place, drawn (wave 4 #5b, plan section 10): every scene of the
 * shot list in Light Modern, Dark Modern and High Contrast at 1280 and 520 px,
 * saved with `MEP_SHOTS_DIR`; and, always, the contrast of every footnote
 * colour against the page behind it in all three themes (AC15) and the names a
 * screen reader is given (AC14).
 */
suite('Editor footnotes drawn: names, contrast, shots (e2e)', () => {
    let editor: EditorPage | undefined;
    let page: puppeteer.Page;
    let version = 0;

    const show = async (text: string) => {
        const md = await buildEditorEngine(EXTENSION_ID, () => undefined);
        version++;
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        await (editor as EditorPage).send({ type: 'document', json: parsedDocumentToJSON(parseDocument(md, text, {})), version, defaultWrap: 90, includes: false, inline: DEFAULT_INLINE_ENGINE });
        await page.waitForSelector('.ProseMirror .mep-fn-entry, .ProseMirror .mep-fn-ref');
        await page.mouse.move(2, 2);
        await page.evaluate(() => {
            window.scrollTo(0, 0);
            const hint = document.querySelector('.mep-hint') as HTMLElement | null;
            if (hint) {
                hint.hidden = true;
            }
        });
        await delay(200);
    };
    const BAR = '.mep-object-toolbar[data-trigger="selection"]:not([hidden])';
    const clickAtom = async (n: number) => {
        const box = await (await page.$$('.ProseMirror .mep-fn-ref'))[n].boundingBox();
        assert.ok(box);
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForSelector(`${BAR}[data-object="footnote"]`, { timeout: 3000 });
        await page.mouse.move(2, box.y + 400);
        await delay(350);
    };
    const caretAt = async (needle: string, k = 1) => {
        await page.focus('.ProseMirror');
        await page.evaluate((n, i) => {
            const walker = document.createTreeWalker(document.querySelector('.ProseMirror') as HTMLElement, NodeFilter.SHOW_TEXT);
            for (let t = walker.nextNode() as Text | null; t; t = walker.nextNode() as Text | null) {
                const at = t.data.indexOf(n);
                if (at >= 0) {
                    window.getSelection()?.collapse(t, at + i);
                    return;
                }
            }
            throw new Error(`no ${n}`);
        }, needle, k);
        await delay(700);
    };
    const selectText = (needle: string) => page.evaluate(n => {
        const walker = document.createTreeWalker(document.querySelector('.ProseMirror') as HTMLElement, NodeFilter.SHOW_TEXT);
        for (let t = walker.nextNode() as Text | null; t; t = walker.nextNode() as Text | null) {
            const at = t.data.indexOf(n);
            if (at >= 0) {
                (document.querySelector('.ProseMirror') as HTMLElement).focus();
                window.getSelection()?.setBaseAndExtent(t, at, t, at + n.length);
                return;
            }
        }
    }, needle);
    const alt = async (key: puppeteer.KeyInput) => {
        await page.keyboard.down('Alt');
        await page.keyboard.press(key);
        await page.keyboard.up('Alt');
        await delay(250);
    };
    const hover = async (selector: string, n = 0) => {
        const box = await (await page.$$(selector))[n].boundingBox();
        assert.ok(box);
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await delay(HOVER_DELAY_MS + 400);
    };
    const each = async (themes: [Theme, string][], widths: number[], scene: string, draw: () => Promise<void>) => {
        if (!SHOTS_DIR) {
            return;
        }
        for (const [theme, name] of themes) {
            await applyTheme(page, theme);
            for (const width of widths) {
                await page.setViewport({ width, height: 760 });
                await draw();
                await shot(page, `${scene}-${width}-${name}.png`);
                await page.keyboard.press('Escape');
                // What Esc dismissed is over once the caret leaves it: the next scene's bar shows again.
                await leaveObjects(page);
                await page.mouse.move(2, 2);
            }
        }
        await page.setViewport({ width: 1280, height: 760 });
        await applyTheme(page, LIGHT_MODERN);
    };

    suiteSetup(async function () {
        this.timeout(60000);
        editor = await openEditorPage({ width: 1280, height: 760, styles: ['markdown-extended.css', 'markdown-it-admonition.css'] });
        if (!editor) {
            this.skip();
        }
        page = (editor as EditorPage).page;
        if (SHOTS_DIR) {
            fs.mkdirSync(SHOTS_DIR, { recursive: true });
        }
    });

    suiteTeardown(async function () {
        await closeEditorPage(this, editor);
    });

    test('a screen reader hears "Footnote 1" with the label as description, an inline footnote\'s text, an orphan "not referenced", a ↩ "Back to reference 1" (AC14)', async function () {
        this.timeout(20000);
        await show(`${TWICE}\nEine Anleitung^[Oder *Lenkung*.] hier.\n`);
        const names = await page.evaluate(() => ({
            refs: Array.from(document.querySelectorAll('.ProseMirror .mep-fn-ref')).map(el => [el.getAttribute('role'), el.getAttribute('aria-label'), el.getAttribute('aria-description')]),
            entries: Array.from(document.querySelectorAll('.ProseMirror .mep-fn-entry')).map(el => el.getAttribute('aria-label')),
            backs: Array.from(document.querySelectorAll('.ProseMirror .mep-fn-back')).map(el => el.getAttribute('aria-label')),
            numHidden: Array.from(document.querySelectorAll('.ProseMirror .mep-fn-num')).every(el => el.getAttribute('aria-hidden') === 'true'),
        }));
        assert.deepStrictEqual(names.refs, [
            ['link', 'Footnote 1', 'liebst'], ['link', 'Footnote 2', 'Schäfchen'], ['link', 'Footnote 3', 'drittes'], ['link', 'Footnote 1', 'liebst'],
            ['link', 'Footnote 4: Oder Lenkung.', null],
        ]);
        assert.deepStrictEqual(names.entries, ['Footnote 2, Schäfchen', 'Footnote 1, liebst', 'Footnote 3, drittes', 'Footnote Senfkorn, not referenced']);
        assert.deepStrictEqual(names.backs, ['Back to reference 2', 'Back to reference 1 (1 of 2)', 'Back to reference 1 (2 of 2)', 'Back to reference 3']);
        assert.ok(names.numHidden, 'the number is drawn, the name says it');
    });

    test('every footnote colour against the page behind it, in Light, Dark and High Contrast: text 4.5:1, the chip\'s border and the orphan\'s edge 3:1 (AC15)', async function () {
        this.timeout(40000);
        const found: string[] = [];
        try {
            for (const [theme, name] of THEMES) {
                await applyTheme(page, theme);
                await show(`${COTK}\n${LITERAL.split('\n\n')[0]}\n`);
                const ratios = await page.evaluate(() => {
                    const ctx = document.createElement('canvas').getContext('2d') as CanvasRenderingContext2D;
                    const rgba = (css: string): number[] => {
                        ctx.clearRect(0, 0, 1, 1);
                        ctx.fillStyle = css;
                        ctx.fillRect(0, 0, 1, 1);
                        const d = ctx.getImageData(0, 0, 1, 1).data;
                        return [d[0], d[1], d[2], d[3] / 255];
                    };
                    const over = (top: number[], under: number[]) => [0, 1, 2].map(i => top[i] * top[3] + under[i] * (1 - top[3])).concat([1]);
                    const behind = (el: Element): number[] => {
                        const layers: number[][] = [];
                        for (let n: Element | null = el; n; n = n.parentElement) {
                            const c = rgba(getComputedStyle(n).backgroundColor);
                            if (c[3] > 0) {
                                layers.push(c);
                            }
                        }
                        let bg = rgba(getComputedStyle(document.body).getPropertyValue('--vscode-editor-background').trim() || 'white');
                        bg[3] = 1;
                        for (const c of layers.reverse()) {
                            bg = over(c, bg);
                        }
                        return bg;
                    };
                    const lum = (c: number[]) => {
                        const [r, g, b] = c.slice(0, 3).map(v => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); });
                        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
                    };
                    const ratio = (fg: number[], bg: number[]) => {
                        const [a, b] = [lum(over(fg, bg)), lum(bg)];
                        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
                    };
                    const of = (sel: string, prop: 'color' | 'borderTopColor' | 'borderLeftColor' | 'textDecorationColor') => {
                        const el = document.querySelector(`.ProseMirror ${sel}`) as HTMLElement;
                        return ratio(rgba(getComputedStyle(el)[prop]), behind(el));
                    };
                    return {
                        number: of('.mep-fn-num', 'color'),
                        reference: of('.mep-fn-ref', 'color'),
                        back: of('.mep-fn-back', 'color'),
                        chip: of('.mep-fn-chip', 'color'),
                        chipBorder: of('.mep-fn-chip', 'borderTopColor'),
                        orphanEdge: of('.mep-fn-orphan .mep-fn-body', 'borderLeftColor'),
                        literalLine: of('.mep-fn-literal', 'textDecorationColor'),
                    };
                });
                found.push(`${name}: ${Object.entries(ratios).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(', ')}`);
                for (const key of ['number', 'reference', 'back', 'chip'] as const) {
                    assert.ok(ratios[key] >= 4.5, `${name} ${key}: ${ratios[key].toFixed(2)}:1`);
                }
                for (const key of ['chipBorder', 'orphanEdge', 'literalLine'] as const) {
                    assert.ok(ratios[key] >= 3, `${name} ${key}: ${ratios[key].toFixed(2)}:1`);
                }
            }
        } finally {
            await applyTheme(page, LIGHT_MODERN);
        }
        console.log(`footnote contrast: ${found.join(' | ')}`);
    });

    test('shots: the scenes of the shot list, in light, dark and high contrast, at 1280 and 520 px', async function () {
        if (!SHOTS_DIR) {
            this.skip();
        }
        this.timeout(600000);
        const all = THEMES;
        const lightDark = THEMES.slice(0, 2);
        const light = THEMES.slice(0, 1);
        await each(all, [1280], 'rest', () => show(COTK));
        await each(light, [520], 'rest', () => show(COTK));
        await each(light, [1280], 'rest-sorted', async () => {
            await show(COTK);
            await (editor as EditorPage).send({ type: 'sortFootnotes' } as never);
            await settle();
            await page.evaluate(() => { (document.querySelector('.mep-hint') as HTMLElement).hidden = true; });
        });
        await each(all, [1280], 'atom-selected', async () => {
            await show(COTK);
            await clickAtom(0);
            await alt('Enter');
        });
        await each(light, [520], 'atom-selected', async () => {
            await show(COTK);
            await clickAtom(0);
            await alt('Enter');
        });
        // Text under [1], none above: the bar stands above it, and its first verb's tooltip above the bar.
        await each(lightDark, [1280], 'atom-flipped', async () => {
            await show(FLIPPED);
            await clickAtom(0);
            await alt('Enter');
            // Alt+Enter's first focus shows no tooltip (UX review 2): an arrow key's does, above the flipped bar.
            await page.keyboard.press('ArrowRight');
            await page.keyboard.press('ArrowLeft');
            await delay(150);
        });
        await each(light, [1280], 'atom-delete-reference', async () => {
            await show(TWICE);
            await clickAtom(0);
        });
        await each(lightDark, [1280], 'hover', async () => {
            await show(COTK);
            await hover('.ProseMirror .mep-fn-ref');
        });
        await each(all, [1280], 'entry-bar', async () => {
            await show(TWICE);
            await caretAt('Jesus fragte');
        });
        await each(light, [520], 'entry-bar', async () => {
            await show(TWICE);
            await caretAt('Jesus fragte');
        });
        await each(lightDark, [1280], 'entry-multiline', () => show(MULTILINE));
        await each(light, [520], 'entry-multiline', () => show(MULTILINE));
        await each(all, [1280], 'orphan', async () => {
            await show(COTK);
            await caretAt('Senfpflanze');
        });
        await each(light, [520], 'orphan', async () => {
            await show(COTK);
            await caretAt('Senfpflanze');
        });
        await each(light, [1280], 'duplicate', async () => {
            await show(DUPLICATE);
            await caretAt('erste Text');
        });
        await each(light, [1280], 'literal-dotted', async () => {
            await show(LITERAL);
            await hover('.ProseMirror .mep-fn-literal');
        });
        // At 600 ms: the bar has come (REST_MS) and the hint was placed again off it.
        const firstPress = async () => {
            await show(COTK);
            await caretAt(' fragte, wurde', 0);
            await page.keyboard.press('Backspace');
            await delay(600);
        };
        await each(all, [1280], 'delete-first-press', firstPress);
        await each(light, [520], 'delete-first-press', firstPress);
        await each(lightDark, [1280], 'delete-hint', async () => {
            await show(COTK);
            await caretAt(' fragte, wurde', 0);
            await page.keyboard.press('Backspace');
            await delay(150);
            await page.keyboard.press('Backspace');
            await delay(300);
        });
        // After the entry's bar came (REST_MS): the hint placed again off it.
        const insert = async () => {
            await show(INSERT);
            await selectText('Taufe“.');
            await delay(150);
            await page.click('.mep-toolbar .mep-menu-face[data-menu="annotation"]');
            await page.waitForSelector('.mep-menu[data-menu="annotation"]:not([hidden]) [data-action="footnote-reference"]');
            await page.click('.mep-menu[data-menu="annotation"] [data-action="footnote-reference"]');
            await page.mouse.move(2, 2);
            await delay(900);
        };
        await each(all, [1280], 'insert', insert);
        await each(all, [1280], 'inline-field', async () => {
            await show(GAP);
            await clickAtom(1);
            await page.click(`${BAR} [data-verb="edit-inline-footnote"]`);
            await delay(300);
        });
        await each(all, [1280], 'inline-refusal', async () => {
            await show(GAP);
            await clickAtom(1);
            await page.click(`${BAR} [data-verb="edit-inline-footnote"]`);
            await delay(300);
            await page.keyboard.press('End');
            await page.keyboard.type('] mehr');
            await page.keyboard.press('Enter');
            await delay(300);
        });
        await each(lightDark, [1280], 'ref-in-sidenote', async () => {
            await show(SIDENOTE);
            await clickAtom(0);
        });
        await each(light, [520], 'ref-in-sidenote', async () => {
            await show(SIDENOTE);
            await clickAtom(0);
        });
        // Full lines of the column beside the note: the bar keeps to the margin, its verbs short.
        await each(light, [1280], 'ref-in-sidenote-full', async () => {
            await show(SIDENOTE_FULL);
            await clickAtom(0);
        });
        await each(light, [1280], 'inline-gap', () => show(GAP));
        // The undo key named in a hint is the platform's; nothing here may stay pressed.
        await page.keyboard.up(MOD);
    });
});
