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
    tokens: any[];
    md: any;
    env: any;
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
    md.renderer.rules[`${type}_open`] = (tokens, idx) => `<span class="${config.refClass}">`;
    md.renderer.rules[`${type}_text`] = (tokens, idx) => tokens[idx].content || '';
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
    
    // Text token
    const tokenText = state.push(`${type}_text`, '', 0);
    tokenText.content = text;
    
    // Note content opening token
    const tokenNoteOpen = state.push(`${type}_content_open`, 'span', 1);

    try {
        processNoteContent(state, note);
    } catch (e) {
        console.error(`Error processing ${type}:`, e);
        // Fallback to plain text
        const fallbackText = state.push('text', '', 0);
        fallbackText.content = note;
    }
    
    // Closing tokens
    state.push(`${type}_content_close`, 'span', -1);
    state.push(`${type}_close`, 'span', -1);
}

/**
 * Process the content of a note with inline markdown support
 */
function processNoteContent(state: MarkdownItState, note: string): void {
    if (!note || note.length === 0) {
        // Empty note content
        const emptyText = state.push('text', '', 0);
        emptyText.content = '';
        return;
    }
    
    // Save original state
    const oldPos = state.pos;
    const oldMax = state.posMax;
    
    // Create a new state for note content
    const inlineState = new state.md.inline.State(note, state.md, state.env, []);
    state.pos = 0;
    state.posMax = note.length;
    
    // Tokenize the note content
    const tokens = state.md.inline.tokenize(inlineState);
    
    if (tokens && Array.isArray(tokens)) {
        tokens.forEach(token => {
            state.push(token.type, token.tag, token.nesting);
            const newToken = state.tokens[state.tokens.length - 1];
            
            // Copy all token properties
            Object.keys(token).forEach(key => {
                if (key !== 'type' && key !== 'tag' && key !== 'nesting') {
                    newToken[key] = token[key];
                }
            });
        });
    } else {
        // Fallback if tokenization fails
        const plainText = state.push('text', '', 0);
        plainText.content = note;
    }
    
    // Restore original state
    state.pos = oldPos;
    state.posMax = oldMax;
}