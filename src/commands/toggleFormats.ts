import * as vscode from 'vscode';
import { toggleFormat } from '../services/helpers/toggleFormat';
import { BLOCK_TOGGLE_ARGS } from './blockToggleArgs';
import { CommandConfig, Commands } from './commands';
import { inlineToggleArgs } from './inlineToggleArgs';

const togglers: CommandConfig[] = [
    { commandId: "markdownExtended.toggleBold", worker: toggle, args: inlineToggleArgs('bold') },
    { commandId: "markdownExtended.toggleItalics", worker: toggle, args: inlineToggleArgs('italics', true) },
    { commandId: "markdownExtended.toggleUnderLine", worker: toggle, args: inlineToggleArgs('underline') },
    { commandId: "markdownExtended.toggleMark", worker: toggle, args: inlineToggleArgs('mark') },
    { commandId: "markdownExtended.toggleSuperscript", worker: toggle, args: inlineToggleArgs('superscript') },
    { commandId: "markdownExtended.toggleSubscript", worker: toggle, args: inlineToggleArgs('subscript', true) },
    { commandId: "markdownExtended.toggleStrikethrough", worker: toggle, args: inlineToggleArgs('strikethrough') },
    { commandId: "markdownExtended.toggleCodeInline", worker: toggle, args: inlineToggleArgs('codeInline') },
    { commandId: "markdownExtended.toggleCodeBlock", worker: toggle, args: BLOCK_TOGGLE_ARGS.codeBlock },
    { commandId: "markdownExtended.toggleUList", worker: toggle, args: BLOCK_TOGGLE_ARGS.uList },
    { commandId: "markdownExtended.toggleOList", worker: toggle, args: BLOCK_TOGGLE_ARGS.oList },
    { commandId: "markdownExtended.toggleBlockQuote", worker: toggle, args: BLOCK_TOGGLE_ARGS.blockQuote },
]

export const commandToggles = new Commands(togglers);

function toggle(
    detect: RegExp,
    multiLine: boolean,
    on: RegExp, onReplace: string,
    off: RegExp, offReplace: string
) {
    return toggleFormat(
        vscode.window.activeTextEditor,
        detect, on, onReplace, off, offReplace, multiLine
    );
}