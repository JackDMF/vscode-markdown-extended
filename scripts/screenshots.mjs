#!/usr/bin/env node
/**
 * Documentation screenshot generator.
 *
 * Exists because every image in images/ dated from 2022 and had drifted away
 * from what the extension actually renders: the container demo used Bootstrap 3
 * grid classes that Bootstrap 4 had removed, and the command-palette shot listed
 * seven commands while the extension contributes twenty-seven.
 *
 * So no picture here is drawn by hand. Each one is rendered from a fenced
 * ```markdown block *in README.md itself*, through the extension's own compiled
 * plugins and its own stylesheets, in the order renderPage() emits them. The
 * README and its illustrations therefore cannot disagree: edit the code block,
 * re-run this, and the picture follows.
 *
 * Usage:
 *   npm run compile-tests                      once, to produce out/src/plugin/*.js
 *   npm run screenshots                        render every shot
 *   npm run screenshots -- sidenote-demo.png   render one
 *
 * Uses the Puppeteer that already powers export. Nothing here ships in the .vsix.
 */

import MarkdownIt from 'markdown-it';
import puppeteer from 'puppeteer';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';

const root = resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);

// ------------------------------------------------------------------ plugins
const compiled = resolve(root, 'out/src/plugin');
if (!existsSync(resolve(compiled, 'markdownItAdmonition.js'))) {
  console.error('out/src/plugin is missing - run `npm run compile-tests` first.');
  process.exit(1);
}
const { MarkdownItAdmonition } = require(resolve(compiled, 'markdownItAdmonition.js'));
const { MarkdownItContainer } = require(resolve(compiled, 'markdownItContainer.js'));
const MarkdownItSidenote = require(resolve(compiled, 'markdownItSidenote.js')).default;

/**
 * markdown-it wired like the extension's renderer.
 *
 * Registration ORDER mirrors src/plugin/plugins.ts, because markdown-it tries
 * inline rules in the order they were added and several of these compete for the
 * same delimiters. Keep it in step with that file rather than tidying it.
 *
 * Note `++...++` belongs to sidenotes alone (`++ref|note++`); markdown-it-ib
 * provides `_underline_`, not `++ins++`.
 */
function renderer() {
  const md = new MarkdownIt({ html: true, linkify: true });
  md.use(MarkdownItContainer);
  md.use(MarkdownItAdmonition);
  md.use(require('markdown-it-footnote'));
  md.use(require('markdown-it-abbr'));
  md.use(require('markdown-it-sup-alt'));
  md.use(require('markdown-it-sub-alt'));
  md.use(require('markdown-it-checkbox'));
  md.use(require('markdown-it-attrs'));
  md.use(require('markdown-it-kbd'));
  md.use(require('markdown-it-ib'));
  md.use(require('markdown-it-mark'));
  md.use(require('markdown-it-deflist'));
  md.use(require('markdown-it-emoji').full);
  md.use(MarkdownItSidenote);
  // markdown-it-multimd-table is deliberately absent: it calls md.utils.assign,
  // which markdown-it 14 removed, and no documentation shot needs it.
  return md;
}

// ------------------------------------------------------------------- styles
const css = (f) => readFileSync(resolve(root, 'styles', f), 'utf8');

/** Contributed styles, then the built-in export theme - renderPage()'s order. */
const EXTENSION = () => [
  css('markdown-extended.css'),
  css('markdown-it-admonition.css'),
  css('markdown-it-kbd.css'),
  css('markdown-extended-default.css'),
];

/** With Bootstrap in markdown.styles the built-in export theme is switched off,
 *  so the framework owns the whole page - that is what `bare` reproduces. */
const BOOTSTRAP = 'https://cdn.jsdelivr.net/npm/bootstrap@5.3.8/dist/css/bootstrap.min.css';

// -------------------------------------------------------------------- shots
const SHOTS = [
  { out: 'sidenote-demo.png', section: '### Sidenotes and Annotations', block: 0, width: 1360 },
  { out: 'admonition-demo1.png', section: '### Admonition', block: 0, width: 900 },
  { out: 'admonition-demo2.png', section: '### Admonition', block: 1, width: 900 },
  { out: 'inline-syntax-demo.png', section: '### Extended Inline Syntax', block: 0, width: 900 },
  { out: 'footnote-demo.png', section: '### markdown-it-footnote', block: 0, width: 900 },
  {
    out: 'container-demo.png', section: '### markdown-it-container', block: 0,
    width: 920, link: BOOTSTRAP, bare: true, frame: 756,
  },
];

// ---------------------------------------------------------------- extraction
const readme = readFileSync(resolve(root, 'README.md'), 'utf8').replace(/\r\n/g, '\n');

function source(shot) {
  const start = readme.indexOf(shot.section);
  if (start < 0) throw new Error(`README has no section "${shot.section}"`);
  // Stop at the next heading of the same level so #### subsections stay in.
  const level = shot.section.match(/^#+/)[0];
  const rest = readme.slice(start + shot.section.length);
  const next = rest.search(new RegExp(`^${level} `, 'm'));
  const sec = next < 0 ? rest : rest.slice(0, next);
  const blocks = [...sec.matchAll(/```markdown\n([\s\S]*?)```/g)].map((m) => m[1]);
  if (blocks[shot.block] === undefined) {
    throw new Error(`"${shot.section}" has no markdown block #${shot.block}`);
  }
  return blocks[shot.block];
}

// -------------------------------------------------------------------- render
const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const todo = only.length ? SHOTS.filter((s) => only.includes(s.out)) : SHOTS;
if (!todo.length) {
  console.error(`no shot matches: ${only.join(', ')}`);
  process.exit(1);
}

const browser = await puppeteer.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
});
const md = renderer();

for (const shot of todo) {
  const rendered = md.render(source(shot));
  const styles = shot.bare ? [] : EXTENSION();
  const frameCss = shot.bare
    ? `body{margin:0}#frame{display:inline-block;box-sizing:border-box;padding:18px;width:${shot.frame}px}`
    : '#frame{display:contents}';

  const html = [
    '<!DOCTYPE html><html><head><meta charset="UTF-8">',
    shot.link ? `<link rel="stylesheet" href="${shot.link}">` : '',
    ...styles.map((s) => `<style>${s}</style>`),
    `<style>html{background:#fff}${frameCss}</style>`,
    '</head><body class="markdown-body vscode-body vscode-light">',
    `<div id="frame">${rendered}</div>`,
    '</body></html>',
  ].join('\n');

  const page = await browser.newPage();
  await page.setViewport({ width: shot.width, height: 900, deviceScaleFactor: 2 });
  await page.setContent(html, { waitUntil: 'load' });
  await page.evaluateHandle('document.fonts.ready');

  // Crop to what was actually painted, floated margin notes included, so no shot
  // carries a baked-in gutter from the export theme's centered column.
  const clip = await page.evaluate((pad) => {
    const frame = document.querySelector('#frame');
    let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
    const grow = (x) => {
      if (!x.width || !x.height) return;
      l = Math.min(l, x.left); t = Math.min(t, x.top);
      r = Math.max(r, x.right); b = Math.max(b, x.bottom);
    };
    for (const el of frame.querySelectorAll('*')) {
      const s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden') continue;
      grow(el.getBoundingClientRect());
    }
    if (getComputedStyle(frame).display !== 'contents') grow(frame.getBoundingClientRect());
    return {
      x: Math.max(0, Math.round(l - pad)),
      y: Math.max(0, Math.round(t - pad)),
      width: Math.round(r - l + 2 * pad),
      height: Math.round(b - t + 2 * pad),
    };
  }, 18);

  // Grow the viewport so the clip is never cut off by the fold.
  await page.setViewport({
    width: shot.width,
    height: clip.y + clip.height + 40,
    deviceScaleFactor: 2,
  });
  await page.screenshot({ path: resolve(root, 'images', shot.out), clip });
  console.log(`  ${shot.out.padEnd(24)} ${clip.width}x${clip.height} @2x   <- ${shot.section}[${shot.block}]`);
  await page.close();
}

await browser.close();
console.log(`\n${todo.length} screenshot(s) written to images/`);
