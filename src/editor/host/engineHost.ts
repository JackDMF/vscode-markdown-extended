import * as vscode from 'vscode';
import { MarkdownIt } from '../../@types/markdown-it';
import { MarkdownItExtender, createEditorEngine } from '../engine';
import { plugins } from '../../plugin/plugins';

/** VS Code's own Markdown extension. Its engine is the preview's, not a plugin to it. */
export const BUILTIN_MARKDOWN_EXTENSION = 'vscode.markdown-language-features';

/** The preview settings that change how the engine tokenizes or renders. */
const PREVIEW_SETTINGS = ['markdown.preview.linkify', 'markdown.preview.typographer', 'markdown.preview.breaks'];

type Log = (line: string) => void;

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Every other extension's `extendMarkdownIt`, in the order VS Code hands them
 * to the preview (the order of `vscode.extensions.all`).
 *
 * An extension counts when its manifest sets `markdown.markdownItPlugins`, as
 * the preview's contribution reader decides. `selfId` is left out because its
 * plugins are already in the registry the engine starts from; the built-in
 * Markdown extension is left out because it contributes the preview itself.
 *
 * Each one is activated first, since `exports` is empty until then. An
 * extension that fails to activate, exports no extender, or throws while
 * extending is logged and skipped: one broken plugin must not keep a person out
 * of the editor, and the preview treats it the same way.
 */
export async function collectMarkdownItExtenders(selfId: string, log: Log): Promise<MarkdownItExtender[]> {
    const extenders: MarkdownItExtender[] = [];
    for (const ext of vscode.extensions.all) {
        const contributes = (ext.packageJSON as { contributes?: Record<string, unknown> } | undefined)?.contributes;
        if (contributes?.['markdown.markdownItPlugins'] !== true) {
            continue;
        }
        if (ext.id.toLowerCase() === selfId.toLowerCase() || ext.id === BUILTIN_MARKDOWN_EXTENSION) {
            continue;
        }
        let exported: unknown;
        try {
            exported = await ext.activate();
        } catch (error) {
            log(`[ERROR] WYSIWYG editor: could not activate ${ext.id} for its markdown-it plugin: ${message(error)}`);
            continue;
        }
        const extend = (exported as { extendMarkdownIt?: unknown } | undefined)?.extendMarkdownIt;
        if (typeof extend !== 'function') {
            continue;
        }
        extenders.push((md: MarkdownIt) => {
            try {
                return (extend as MarkdownItExtender).call(exported, md) || md;
            } catch (error) {
                log(`[ERROR] WYSIWYG editor: the markdown-it plugin of ${ext.id} failed: ${message(error)}`);
                return md;
            }
        });
    }
    return extenders;
}

/**
 * The engine the rich editor parses and renders with, composed like VS Code's
 * preview engine so the two see the same tokens.
 *
 * The core (`createEditorEngine`) is pinned to markdown-it 14. VS Code 1.139's
 * preview bundles markdown-it 14 as well — its `markdown-language-features`
 * bundle carries the ES-module build whose `utils` still exports `assign`, which
 * 15 removed — so the two engines tokenize alike. Checked against the build the
 * test suite downloads (`.vscode-test/…/extensions/markdown-language-features/dist/extension.js`).
 *
 * Two things the preview does to its engine that `createEditorEngine` does not
 * do, repeated here so the host is not a second opinion on what the file says:
 * linkify runs with `fuzzyLink: false` (a bare `example.com` is not a link in
 * the preview, so it must not be one here), and `breaks` follows
 * `markdown.preview.breaks` (it changes only how a raw block renders).
 *
 * One difference is kept deliberately: the preview's front-matter rule is VS
 * Code's own, registered after the plugins; this engine's is
 * `markdown-it-front-matter`, registered first by the core. Both emit one
 * `front_matter` token mapped over the fences, which is all the editor reads.
 */
export async function buildEditorEngine(selfId: string, log: Log): Promise<MarkdownIt> {
    const preview = vscode.workspace.getConfiguration('markdown.preview');
    const extend = await collectMarkdownItExtenders(selfId, log);
    const md = createEditorEngine({
        linkify: preview.get<boolean>('linkify', true),
        typographer: preview.get<boolean>('typographer', false),
        plugins,
        extend,
    });
    // linkify-it's `set` is missing from the project's markdown-it declaration.
    (md.linkify as unknown as { set(options: { fuzzyLink: boolean }): void }).set({ fuzzyLink: false });
    md.set({ breaks: preview.get<boolean>('breaks', false) });
    return md;
}

/**
 * Holds one engine for every open rich editor and builds a new one when what it
 * was built from changes: the set of installed extensions, or a preview setting
 * that changes tokenizing. `onDidChange` tells the open editors to re-parse.
 */
export class EditorEngineHost implements vscode.Disposable {
    private engine: Promise<MarkdownIt> | undefined;
    private readonly changed = new vscode.EventEmitter<void>();
    private readonly subscriptions: vscode.Disposable[];

    readonly onDidChange = this.changed.event;

    /**
     * `build` makes one engine; the default composes it from the installed
     * extensions. A test passes its own to decide when a build settles.
     */
    constructor(
        selfId: string,
        log: Log,
        private readonly build: () => Promise<MarkdownIt> = () => buildEditorEngine(selfId, log),
    ) {
        this.subscriptions = [
            this.changed,
            vscode.extensions.onDidChange(() => this.invalidate()),
            vscode.workspace.onDidChangeConfiguration(e => {
                if (PREVIEW_SETTINGS.some(s => e.affectsConfiguration(s))) {
                    this.invalidate();
                }
            }),
        ];
    }

    get(): Promise<MarkdownIt> {
        if (this.engine === undefined) {
            const engine = this.build();
            this.engine = engine;
            // A failed build is not cached: the next request tries again. Only
            // this build is forgotten: when `invalidate()` has replaced it and a
            // later `get()` started a newer one, that one outlives its failure.
            engine.catch(() => {
                if (this.engine === engine) {
                    this.engine = undefined;
                }
            });
        }
        return this.engine;
    }

    invalidate(): void {
        this.engine = undefined;
        this.changed.fire();
    }

    dispose(): void {
        this.subscriptions.forEach(d => d.dispose());
    }
}
