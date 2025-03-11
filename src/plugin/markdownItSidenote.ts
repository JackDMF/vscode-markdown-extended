import { MarkdownIt } from 'markdown-it';

// Constants
const SN_TOKEN = '+';
const SN_TOKEN_CODE = SN_TOKEN.charCodeAt(0);

const MN_TOKEN = '!';
const MN_TOKEN_CODE = MN_TOKEN.charCodeAt(0);

const TOKEN_PIPE = '|';

// Types for better readability
interface NoteConfig {
  type: 'sidenote' | 'marginal_note';
  openMarker: string;
  openMarkerCode: number;
  closeMarker: string;
  cssClass: string;
  refClass: string;
}

interface MarkdownItState {
    src: string;
    pos: number;
    posMax: number;
    md: MarkdownIt;
    push: (type: string, tag: string, nesting: number) => any;
}

const MarginNoteConfig: NoteConfig = {
    type: 'marginal_note',
    openMarker: MN_TOKEN + MN_TOKEN,
    openMarkerCode: MN_TOKEN_CODE,
    closeMarker: MN_TOKEN + MN_TOKEN,
    cssClass: 'mnote',
    refClass: 'mn-ref'
};

const SideNoteConfig: NoteConfig = {
    type: 'sidenote',
    openMarker: SN_TOKEN + SN_TOKEN,
    openMarkerCode: SN_TOKEN_CODE,
    closeMarker: SN_TOKEN + SN_TOKEN,
    cssClass: 'sidenote',
    refClass: 'sn-ref'
};

export default function (md: MarkdownIt) {
    md.inline.ruler.before('link', 'notes', notesTokenizer as any);

    // Renderer rules for sidenotes
    registerRendererRules(md, SideNoteConfig);
    registerRendererRules(md, MarginNoteConfig);
}

function registerRendererRules(md: MarkdownIt, config: NoteConfig) {
    const type = config.type;
    
    // Updated renderer rules for new token structure
    md.renderer.rules[`${type}_open`] = (tokens, idx) => `<span class="${config.refClass}">`;
    md.renderer.rules[`${type}_ref_open`] = () => ''; // No additional HTML needed
    md.renderer.rules[`${type}_ref_close`] = () => ''; // No additional HTML needed
    md.renderer.rules[`${type}_content_open`] = () => `<span class="${config.cssClass}">`;
    md.renderer.rules[`${type}_content_close`] = () => '</span>';
    md.renderer.rules[`${type}_close`] = () => '</span>';
}

/**
 * Process both sidenotes and marginal notes
 */
function notesTokenizer(state: MarkdownItState, silent: boolean): boolean {
    const start = state.pos;
    const char = state.src.charCodeAt(start);
    
    // Early exit if not a potential note marker
    if (char !== SideNoteConfig.openMarkerCode && char !== MarginNoteConfig.openMarkerCode) {
        return false;
    }

    // Detect note type based on opening marker
    let noteConfig: NoteConfig;
    if (char === SideNoteConfig.openMarkerCode && state.src.charCodeAt(start + 1) === SideNoteConfig.openMarkerCode) {
        noteConfig = SideNoteConfig;
    } else if (char === MarginNoteConfig.openMarkerCode && state.src.charCodeAt(start + 1) === MarginNoteConfig.openMarkerCode) {
        noteConfig = MarginNoteConfig;
    } else {
        return false;
    }

    return processNote(state, silent, start, noteConfig);
}

/**
 * Process a note (either sidenote or marginal note)
 */
function processNote(state: MarkdownItState, silent: boolean, start: number, config: NoteConfig): boolean {
    const max = state.posMax;
    
    // Check if we have enough characters
    if (start + 2 >= max) {
        return false;
    }

    // Find closing markers
    let endPos = state.src.indexOf(config.closeMarker, start + 2);
    if (endPos === -1) return false;

    // Extract content
    const content = state.src.slice(start + 2, endPos);
    const pipePos = content.indexOf(TOKEN_PIPE);
    if (pipePos === -1) return false;

    const text = content.slice(0, pipePos);
    const note = content.slice(pipePos + 1);

    // Skip in silent mode
    if (silent) {
        return true;
    }

    // Create token structure
    createNoteTokens(state, text, note, config);

    // Update position
    state.pos = endPos + 2;
    return true;
}

/**
 * Create the token structure for a note
 */
function createNoteTokens(state: MarkdownItState, text: string, note: string, config: NoteConfig): void {
    const type = config.type;
    
    // Opening token
    const tokenOpen = state.push(`${type}_open`, 'span', 1);
    tokenOpen.markup = config.openMarker;
    
    // Reference section with markdown support
    const tokenRefOpen = state.push(`${type}_ref_open`, '', 1);
    
    try {
        // Process reference text with markdown support
        processTextWithMarkdown(state, text);
    } catch (e) {
        console.error(`Error processing ${type} reference:`, e);
        // Fallback to plain text
        const fallbackText = state.push('text', '', 0);
        fallbackText.content = text;
    }
    
    const tokenRefClose = state.push(`${type}_ref_close`, '', -1);
    
    // Note content opening token
    const tokenNoteOpen = state.push(`${type}_content_open`, 'span', 1);

    try {
        // Process note content with markdown support
        processTextWithMarkdown(state, note);
    } catch (e) {
        console.error(`Error processing ${type} note:`, e);
        // Fallback to plain text
        const fallbackText = state.push('text', '', 0);
        fallbackText.content = note;
    }
    
    // Closing tokens
    state.push(`${type}_content_close`, 'span', -1);
    state.push(`${type}_close`, 'span', -1);
}

/**
 * Process text with inline markdown support
 */
function processTextWithMarkdown(state: MarkdownItState, content: string): void {
    if (!content || content.length === 0) {
        // Empty content
        const emptyText = state.push('text', '', 0);
        emptyText.content = '';
        return;
    }
    
    // DON'T modify the existing state - use parseInline instead
    // This is the key fix - use the proper API for parsing fragments
    const tempEnv = {};
    const tokens = state.md.parseInline(content, tempEnv);
    
    if (tokens && tokens[0] && tokens[0].children) {
        // Transfer the resulting inline tokens to our token stream
        tokens[0].children.forEach((token) => {
            const newToken = state.push(token.type, token.tag, token.nesting);
            
            // Copy all token properties
            Object.keys(token).forEach(key => {
                if (key !== 'type' && key !== 'tag' && key !== 'nesting') {
                    newToken[key] = token[key];
                }
            });
        });
    } else {
        // Fallback if parsing fails
        const plainText = state.push('text', '', 0);
        plainText.content = content;
    }
}