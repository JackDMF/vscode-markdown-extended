import * as vscode from 'vscode';
import { EditorEngineHost } from '../editor/host/engineHost';
import { toggleFormat, toggleInlineFormat } from '../services/helpers/toggleFormat';
import { INLINE_MARKERS } from '../syntax/markers';
import { BLOCK_TOGGLE_ARGS } from './blockToggleArgs';
import { CommandConfig, Commands } from './commands';

/**
 * The toggle commands. The inline toggles read the document with the engine
 * the Visual Editor parses with (`engines`), so they see what the preview
 * shows; the first one to run builds it.
 */
export function createToggleCommands(engines: EditorEngineHost): Commands {
    const toggleInline = async (marker: string) => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {return;}
        return toggleInlineFormat(editor, marker, await engines.get());
    };
    const togglers: CommandConfig[] = [
        { commandId: "markdownExtended.toggleBold", worker: toggleInline, args: [INLINE_MARKERS.bold] },
        { commandId: "markdownExtended.toggleItalics", worker: toggleInline, args: [INLINE_MARKERS.italics] },
        { commandId: "markdownExtended.toggleUnderLine", worker: toggleInline, args: [INLINE_MARKERS.underline] },
        { commandId: "markdownExtended.toggleMark", worker: toggleInline, args: [INLINE_MARKERS.mark] },
        { commandId: "markdownExtended.toggleSuperscript", worker: toggleInline, args: [INLINE_MARKERS.superscript] },
        { commandId: "markdownExtended.toggleSubscript", worker: toggleInline, args: [INLINE_MARKERS.subscript] },
        { commandId: "markdownExtended.toggleStrikethrough", worker: toggleInline, args: [INLINE_MARKERS.strikethrough] },
        { commandId: "markdownExtended.toggleCodeInline", worker: toggleInline, args: [INLINE_MARKERS.codeInline] },
        { commandId: "markdownExtended.toggleCodeBlock", worker: toggle, args: BLOCK_TOGGLE_ARGS.codeBlock },
        { commandId: "markdownExtended.toggleUList", worker: toggle, args: BLOCK_TOGGLE_ARGS.uList },
        { commandId: "markdownExtended.toggleOList", worker: toggle, args: BLOCK_TOGGLE_ARGS.oList },
        { commandId: "markdownExtended.toggleBlockQuote", worker: toggle, args: BLOCK_TOGGLE_ARGS.blockQuote },
    ];
    return new Commands(togglers);
}

function toggle(
    detect: RegExp,
    on: RegExp, onReplace: string,
    off: RegExp, offReplace: string
) {
    return toggleFormat(
        vscode.window.activeTextEditor,
        detect, on, onReplace, off, offReplace
    );
}
