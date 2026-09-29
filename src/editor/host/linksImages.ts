import * as vscode from 'vscode';
import { MarkdownIt } from '../../@types/markdown-it';
import type { HostMessage, LinkedFile, WebviewMessage } from '../protocol';
import { message } from './errors';
import { IMAGE_EXTENSIONS, displaySources, linkedFiles, savePastedImage, uriOf } from './images';
import { SessionPort } from './lenses';
import { FileLister, LinkChoiceController } from './linkChoices';

/** What the links and images of a page need from the session around them. */
export interface LinksAndImagesHost {
    port: SessionPort;
    engine(): Promise<MarkdownIt>;
    /** Run `work` in the session's queue, behind the edits the page sent before. */
    enqueue(work: () => Promise<void>): void;
    /** The address the page loads a local file from (`webview.asWebviewUri`); without it no image is resolved. */
    asWebviewUri?(uri: vscode.Uri): vscode.Uri;
    /** The files a link's field completes with (`workspaceFiles`, the default). */
    linkFiles?: FileLister;
    /** VS Code's open dialog (the default). */
    openDialog?(options: vscode.OpenDialogOptions): Thenable<vscode.Uri[] | undefined>;
}

/**
 * The host's half of links and images (ARCHITECTURE.md, *Links and images*):
 * completion for a link's field, the open dialog of **Insert → Image…**, the
 * relative path of a dropped file, the file a pasted bitmap is written to, and
 * the address the page loads an image from. Every answer carries the
 * request's id, and the page drops an answer to nothing it asked.
 */
export class LinksAndImages {
    private readonly choices: LinkChoiceController;

    constructor(private readonly host: LinksAndImagesHost) {
        this.choices = new LinkChoiceController(host.port, () => host.engine(), host.linkFiles);
    }

    private get document(): vscode.TextDocument {
        return this.host.port.document;
    }

    receive(msg: WebviewMessage): void {
        switch (msg.type) {
            case 'linkChoices':
                // Behind the edit the page flushed before a `#` query, so this
                // document's headings are those of the page's text; not waited
                // for there, as a read of the workspace's files may take a moment.
                this.host.enqueue(async () => {
                    void this.choices.answer(msg.requestId, msg.query, msg.images === true);
                });
                break;
            case 'pickImage':
                void this.pickImage(msg.requestId);
                break;
            case 'insertFiles':
                void this.insertFiles(msg.requestId, msg.uris);
                break;
            case 'saveImage':
                void this.saveImage(msg.requestId, msg.bytes, msg.suggestedName);
                break;
            case 'resolveImages':
                void this.resolveImages(msg.requestId, msg.srcs);
                break;
        }
    }

    /** Post an answer, never throwing: the page may be gone by the time a dialog or a write is done. */
    private async answer(msg: HostMessage): Promise<void> {
        try {
            await this.host.port.post(msg);
        } catch (error) {
            this.host.port.log(`[WARN] Visual Editor: the answer to the page (${msg.type}) could not be sent: ${message(error)}`);
        }
    }

    /**
     * **Insert → Image…**: VS Code's open dialog, in the document's folder,
     * images only; the chosen file goes back as the page inserts it
     * (`linkedFiles`: relative, encoded, its stem the alt text).
     */
    private async pickImage(requestId: number): Promise<void> {
        let files: LinkedFile[] = [];
        try {
            const dialog = this.host.openDialog ?? ((options: vscode.OpenDialogOptions) => vscode.window.showOpenDialog(options));
            const picked = await dialog({
                defaultUri: vscode.Uri.joinPath(this.document.uri, '..'),
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: false,
                openLabel: 'Insert image',
                filters: { Images: [...IMAGE_EXTENSIONS] },
            });
            files = linkedFiles(picked ?? [], this.document.uri);
            if ((picked ?? []).length > files.length) {
                void vscode.window.showWarningMessage('The image was not inserted: no relative path from this document reaches it (another drive or file system).');
            }
        } catch (error) {
            this.host.port.log(`[WARN] Visual Editor: the image could not be chosen: ${message(error)}`);
        }
        await this.answer({ type: 'filesChosen', requestId, files });
    }

    /** Files dropped or pasted into the page, made relative to the document (`linkedFiles`). */
    private async insertFiles(requestId: number, values: readonly string[]): Promise<void> {
        const uris = values.map(uriOf).filter((u): u is vscode.Uri => u !== null);
        const files = linkedFiles(uris, this.document.uri);
        if (uris.length > files.length) {
            this.host.port.log(`[INFO] Visual Editor: ${uris.length - files.length} dropped file(s) left out: no relative path from ${this.document.uri.fsPath} reaches them.`);
        }
        await this.answer({ type: 'filesChosen', requestId, files });
    }

    /** A pasted bitmap written beside the document (`savePastedImage`); a failure is said, and answered without a path. */
    private async saveImage(requestId: number, bytes: string, suggestedName: string): Promise<void> {
        let path: string | undefined;
        try {
            path = await savePastedImage(this.document, bytes, suggestedName);
        } catch (error) {
            this.host.port.log(`[WARN] Visual Editor: the pasted image could not be saved: ${message(error)}`);
            void vscode.window.showWarningMessage(`The pasted image could not be saved: ${message(error)}`);
        }
        await this.answer({ type: 'imageSaved', requestId, ...(path !== undefined ? { path } : {}) });
    }

    /**
     * The address the page loads each image from (`displaySources`): a `src`
     * naming a file, resolved against this document as a followed link is,
     * as a webview uri. Resolved on every request, against the document as it
     * is: a document that is renamed opens as a new editor, with its own session.
     */
    private async resolveImages(requestId: number, srcs: readonly string[]): Promise<void> {
        const asWebviewUri = this.host.asWebviewUri;
        const folder = vscode.workspace.getWorkspaceFolder(this.document.uri)?.uri;
        const sources = asWebviewUri ? displaySources(srcs, this.document.uri, folder, asWebviewUri) : {};
        await this.answer({ type: 'imagesResolved', requestId, sources });
    }
}
