#!/usr/bin/env node
/**
 * Release guard and driver.
 *
 * Exists because a release went out the wrong way: the version was bumped and
 * the extension was built and installed from a tree that was two commits behind
 * the remote, so a published fix (Puppeteer's setContent lifecycle) silently
 * disappeared from the build. The version bump for v3.0.1 had also never been
 * committed — package.json said 3.0.0 while the Marketplace served 3.0.1 — which
 * is what made building from a stale base so easy.
 *
 * The checks therefore mirror the actual failure modes, in order:
 *   1. working tree clean            — no unversioned change slips into a build
 *   2. up to date with the remote    — never build behind origin again
 *   3. version committed             — package.json's version is in HEAD, not just on disk
 *   4. CHANGELOG has this version    — the release is described before it ships
 *   5. tag free                      — this version was not released before
 *   6. lint and the full test suite
 *   7. package ONCE, then publish exactly that file
 *
 * Usage:
 *   npm run release            checks + lint + tests + package (nothing leaves the machine)
 *   npm run release:publish    the same, then tag, push and publish that very .vsix
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const wurzel = resolve(import.meta.dirname, '..');
const veroeffentlichen = process.argv.includes('--publish');

const lauf = (befehl, argumente, still = false) =>
  execFileSync(befehl, argumente, {
    cwd: wurzel,
    encoding: 'utf8',
    stdio: still ? 'pipe' : ['inherit', 'inherit', 'inherit'],
    // npm/npx sind unter Windows .cmd-Wrapper: ohne Shell findet execFileSync
    // sie nicht (ENOENT), und seit CVE-2024-27980 verweigert Node .cmd ohne
    // shell ohnehin. git bleibt shell-frei — die Tag-Botschaft enthält
    // Zeilenumbrüche, die eine Shell zerlegen würde.
    shell: process.platform === 'win32' && befehl !== 'git',
  });
const git = (...argumente) => lauf('git', argumente, true).trim();

const schritt = (text) => console.log(`\n[36m▶ ${text}[0m`);
const gut = (text) => console.log(`  [32m✔[0m ${text}`);
const abbruch = (text, rat) => {
  console.error(`\n[31m✖ ${text}[0m`);
  if (rat) console.error(`  ${rat}`);
  process.exit(1);
};

// ---------------------------------------------------------------- 1–5: Zustand
const { version, name, publisher } = JSON.parse(
  readFileSync(resolve(wurzel, 'package.json'), 'utf8'));
const marke = `v${version}`;
console.log(`[1m${publisher}.${name} ${marke}[0m`);

schritt('Arbeitsbaum und Remote');
const dreckig = git('status', '--porcelain');
if (dreckig) {
  abbruch('Der Arbeitsbaum ist nicht sauber.',
    'Erst einchecken — sonst enthält das Paket Änderungen, die niemand nachvollziehen kann:\n'
    + dreckig.split('\n').slice(0, 8).map((z) => '    ' + z).join('\n'));
}
gut('Arbeitsbaum sauber');

const zweig = git('rev-parse', '--abbrev-ref', 'HEAD');
try {
  lauf('git', ['fetch', '--tags', 'origin'], true);
  gut('vom Remote geholt');
} catch {
  abbruch('git fetch ist fehlgeschlagen.',
    'Ohne Abgleich mit dem Remote kann dieses Skript nicht ausschließen, dass hier ein '
    + 'veralteter Stand gebaut wird — genau das ist bei v3.0.2 passiert.');
}

const hinterher = git('rev-list', '--count', `HEAD..origin/${zweig}`);
if (hinterher !== '0') {
  abbruch(`${hinterher} Commit(s) hinter origin/${zweig}.`,
    `Erst holen: git pull --rebase origin ${zweig}`);
}
gut(`auf dem Stand von origin/${zweig}`);

schritt('Version, Changelog und Tag');
const versionImCommit = JSON.parse(git('show', 'HEAD:package.json')).version;
if (versionImCommit !== version) {
  abbruch(`package.json sagt ${version}, HEAD sagt ${versionImCommit}.`,
    'Die Versionsanhebung muss eingecheckt sein — sonst weicht der Marketplace vom Repo ab, '
    + 'und der nächste Build startet auf der falschen Basis.');
}
gut(`Version ${version} ist eingecheckt`);

const changelog = readFileSync(resolve(wurzel, 'CHANGELOG.md'), 'utf8');
const abschnitt = new RegExp(`^##\\s+${marke.replaceAll('.', '\\.')}(\\s|$)`, 'm');
if (!abschnitt.test(changelog)) {
  abbruch(`CHANGELOG.md hat keinen Abschnitt „## ${marke}".`,
    'Was veröffentlicht wird, soll vorher beschrieben sein.');
}
gut(`CHANGELOG nennt ${marke}`);

const tags = git('tag', '--list', marke);
if (tags) {
  abbruch(`Tag ${marke} gibt es schon.`,
    'Version in package.json anheben und einen CHANGELOG-Abschnitt dafür schreiben.');
}
gut(`Tag ${marke} ist frei`);

// ---------------------------------------------------------------- 6: Prüfungen
schritt('Lint');
lauf('npm', ['run', 'lint']);
gut('Lint durch');

schritt('Tests');
lauf('npm', ['test']);
gut('Tests durch');

// ---------------------------------------------------------------- 7: Paket
schritt('Paket bauen');
const vsix = `${name}-${version}.vsix`;
lauf('npx', ['vsce', 'package', '--no-dependencies', '--out', vsix]);
if (!existsSync(resolve(wurzel, vsix))) abbruch(`${vsix} wurde nicht erzeugt.`);
gut(vsix);

if (!veroeffentlichen) {
  console.log(`\n[32mBereit.[0m Nichts hat die Maschine verlassen.`);
  console.log(`  Zum Veröffentlichen: npm run release:publish`);
  process.exit(0);
}

// ---------------------------------------------------------------- Ausliefern
schritt('Tag setzen und schieben');
lauf('git', ['tag', '-a', marke, '-m', `${marke}\n\nSiehe CHANGELOG.md.`], true);
lauf('git', ['push', 'origin', zweig], true);
lauf('git', ['push', 'origin', marke], true);
gut(`${marke} getaggt und geschoben`);

schritt('Veröffentlichen');
// Genau das geprüfte Artefakt — ohne --packagePath würde vsce neu packen und
// etwas anderes ausliefern, als die Tests gesehen haben.
lauf('npx', ['vsce', 'publish', '--packagePath', vsix]);
console.log(`\n[32m✔ ${publisher}.${name} ${marke} veröffentlicht.[0m`);
