import * as path from 'path';
import * as vscode from 'vscode';
import { Environment, MarkdownIt } from '../../@types/markdown-it';
import { decode, schemeOf } from '../paths';
import type { LinkChoice } from '../protocol';
import { message } from './errors';
import { encodeDestination, isImagePath, relativeDestination } from './images';
import { SessionPort } from './lenses';
import { HeadingAnchor, headingAnchors, resolveLinkTarget } from './links';

/** How many choices one answer carries: the field lists them, best first. */
export const LINK_CHOICES_CAP = 50;

/** How many workspace files are read for completion (`findFiles`' `maxResults`). */
export const FILE_SCAN_CAP = 5000;

/** How long a read of the workspace's files serves the queries typed after it. */
const FILE_LIST_TTL_MS = 10000;

/** The files a link may name: the workspace's, or the document's folder's outside any workspace. */
export type FileLister = (documentUri: vscode.Uri) => Promise<vscode.Uri[]>;

/**
 * `files.exclude` and `search.exclude` as one exclude glob for `findFiles`: the
 * files VS Code's own Quick Open leaves out (`node_modules` among them) are
 * not offered either. An entry with a `when` clause, or one whose braces would
 * not nest in a `{…}` group, is left out of the glob.
 */
function excludeGlob(uri: vscode.Uri): string | undefined {
    const patterns = new Set<string>();
    for (const section of ['files', 'search']) {
        const entries = vscode.workspace.getConfiguration(section, uri).get<Record<string, unknown>>('exclude') ?? {};
        for (const [glob, on] of Object.entries(entries)) {
            if (on === true && !/[{},]/.test(glob)) {
                patterns.add(glob);
            }
        }
    }
    return patterns.size === 0 ? undefined : `{${[...patterns].join(',')}}`;
}

/** The workspace's files, excludes respected and capped; outside a workspace, the files beside the document. */
export const workspaceFiles: FileLister = async documentUri => {
    if ((vscode.workspace.workspaceFolders ?? []).length > 0) {
        return vscode.workspace.findFiles('**/*', excludeGlob(documentUri) ?? null, FILE_SCAN_CAP);
    }
    const dir = vscode.Uri.joinPath(documentUri, '..');
    const entries = await vscode.workspace.fs.readDirectory(dir);
    return entries.filter(([, type]) => type === vscode.FileType.File).slice(0, FILE_SCAN_CAP).map(([name]) => vscode.Uri.joinPath(dir, name));
};

function isMarkdown(p: string): boolean {
    return /\.(md|markdown|mdown|mkd|mkdn)$/i.test(p);
}

/** A file a link may name, and what every query reads of it (`LinkChoiceController.candidates`). */
interface Candidate {
    /** Relative to the document, encoded: what the field is given. */
    value: string;
    /** The same path decoded: what the list shows. */
    relative: string;
    lower: string;
    /** The file's name, lower-cased. */
    name: string;
    markdown: boolean;
    image: boolean;
    /** How far from the document: `..` steps weigh a hundred folders. */
    distance: number;
}

/** `uri` as a candidate for `documentUri`'s links; none for the document itself, or a file no relative path reaches. */
function candidateOf(uri: vscode.Uri, documentUri: vscode.Uri): Candidate[] {
    if (uri.toString() === documentUri.toString()) {
        return [];
    }
    const value = relativeDestination(uri, documentUri);
    if (value === null) {
        return [];
    }
    const relative = decode(value);
    const lower = relative.toLowerCase();
    const segments = relative.split('/');
    return [{
        value,
        relative,
        lower,
        name: path.posix.basename(lower),
        markdown: isMarkdown(relative),
        image: isImagePath(uri.path),
        distance: segments.filter(s => s === '..').length * 100 + segments.length,
    }];
}

/**
 * Completion for a link's field (`linkChoices`): what a path typed into it may
 * become, from where each fact is true — the files from the workspace
 * (`findFiles`, excludes respected), the anchors from the target document's
 * headings as the editor's engine reads them (`headingAnchors`: an explicit
 * `{#id}`, else the heading's GitHub slug, the rule a followed link lands by).
 *
 * - `#…`: the current document's headings.
 * - `path#…`: that file's headings, when the path names a Markdown file.
 * - anything else: files whose path relative to the document holds the text,
 *   Markdown first, then by how well the name matches and how near the file is.
 *
 * Values are written as a destination is: relative, POSIX, percent-encoded
 * (`encodeDestination`). With `images`, image files only.
 */
export class LinkChoiceController {
    private files: { at: number; list: Promise<Candidate[]> } | null = null;

    constructor(
        private readonly host: SessionPort,
        private readonly engine: () => Promise<MarkdownIt>,
        private readonly lister: FileLister = workspaceFiles,
        private readonly now: () => number = Date.now,
    ) { }

    /** Answer `linkChoices`: never throws, and always answers — with nothing when the choices could not be read. */
    async answer(requestId: number, query: string, images: boolean): Promise<void> {
        let items: LinkChoice[] = [];
        try {
            items = await this.choices(query, images);
        } catch (error) {
            this.host.log(`[WARN] Visual Editor: the link choices for "${query}" could not be read: ${message(error)}`);
        }
        try {
            await this.host.post({ type: 'linkChoicesResult', requestId, items });
        } catch (error) {
            this.host.log(`[WARN] Visual Editor: the link choices could not be sent to the page: ${message(error)}`);
        }
    }

    async choices(query: string, images: boolean): Promise<LinkChoice[]> {
        const hash = query.indexOf('#');
        if (hash >= 0 && !images) {
            return this.anchors(query.slice(0, hash), query.slice(hash + 1));
        }
        if (schemeOf(query) !== undefined) {
            // A web address, a mail address: nothing in the workspace completes it.
            return [];
        }
        return this.fileChoices(query, images);
    }

    /**
     * The files a link may name, each with what every query reads of it —
     * its encoded relative path, the path decoded and lower-cased, its name,
     * how far away it is — derived once per read of the file list, not per
     * keystroke over thousands of files.
     */
    private candidates(): Promise<Candidate[]> {
        const now = this.now();
        if (this.files === null || now - this.files.at > FILE_LIST_TTL_MS) {
            const documentUri = this.host.document.uri;
            const list = this.lister(documentUri).then(uris => uris.flatMap(uri => candidateOf(uri, documentUri)));
            this.files = { at: now, list };
            // A failed read is not kept for the next query.
            list.catch(() => {
                if (this.files?.list === list) {
                    this.files = null;
                }
            });
        }
        return this.files.list;
    }

    private async fileChoices(query: string, images: boolean): Promise<LinkChoice[]> {
        const wanted = decode(query).replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
        const ranked: { candidate: Candidate; quality: number }[] = [];
        for (const candidate of await this.candidates()) {
            if (images && !candidate.image) {
                continue;
            }
            const { lower, name } = candidate;
            const quality = wanted === '' ? 0 : lower.startsWith(wanted) || name.startsWith(wanted) ? 0 : name.includes(wanted) ? 1 : lower.includes(wanted) ? 2 : -1;
            if (quality >= 0) {
                ranked.push({ candidate, quality });
            }
        }
        const kind = (c: Candidate) => (images || c.markdown ? 0 : 1);
        ranked.sort((a, b) => kind(a.candidate) - kind(b.candidate) || a.quality - b.quality
            || a.candidate.distance - b.candidate.distance || (a.candidate.lower < b.candidate.lower ? -1 : a.candidate.lower > b.candidate.lower ? 1 : 0));
        return ranked.slice(0, LINK_CHOICES_CAP).map(({ candidate }) => ({ value: candidate.value, label: candidate.relative, kind: 'file' }));
    }

    /** The headings of the document `target` names (empty: this one) whose anchor or text holds `fragment`. */
    private async anchors(target: string, fragment: string): Promise<LinkChoice[]> {
        const document = await this.targetDocument(target);
        if (document === null) {
            return [];
        }
        const md = await this.engine();
        const anchors: HeadingAnchor[] = headingAnchors(md, document.getText(), { currentDocument: document.uri } as unknown as Environment);
        const wanted = decode(fragment).toLowerCase();
        const choices: LinkChoice[] = [];
        for (const anchor of anchors) {
            const name = anchor.id ?? anchor.slug;
            if (name === '' || (wanted !== '' && !name.toLowerCase().includes(wanted) && !anchor.text.toLowerCase().includes(wanted))) {
                continue;
            }
            // The path is fixed once `#` is typed: the list shows the anchor, the value is the whole destination.
            choices.push({ value: `${target}#${encodeDestination(name)}`, label: `#${name}`, ...(anchor.text ? { detail: anchor.text } : {}), kind: 'heading' });
            if (choices.length >= LINK_CHOICES_CAP) {
                break;
            }
        }
        return choices;
    }

    /** The document a link's path names — this one for none — when it is Markdown; `null` otherwise. */
    private async targetDocument(target: string): Promise<vscode.TextDocument | null> {
        const self = this.host.document;
        if (target === '') {
            return self;
        }
        const folder = vscode.workspace.getWorkspaceFolder(self.uri)?.uri;
        const resolved = resolveLinkTarget(target, self.uri, folder);
        if (resolved.kind !== 'open') {
            return null;
        }
        const file = resolved.uri.with({ fragment: '' });
        if (file.toString() === self.uri.toString()) {
            return self;
        }
        if (!isMarkdown(file.path)) {
            return null;
        }
        try {
            return await vscode.workspace.openTextDocument(file);
        } catch {
            return null;
        }
    }
}
