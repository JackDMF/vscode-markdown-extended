import { MarkdownIt } from 'markdown-it';

// This plugin adds support for sidenotes and marginal notes in Markdown using custom tokens
// It allows users to create notes that can be displayed in the margin or as sidenotes

// Use WeakMap for thread-safe parse depth tracking per state
const parseDepthMap = new WeakMap<any, number>();
const MAX_PARSE_DEPTH = 3; // Reasonable limit for nesting

/**
 * Get current parse depth for a state
 */
function getParseDepth(state: any): number {
    return parseDepthMap.get(state) || 0;
}

/**
 * Increment parse depth for a state
 */
function incrementParseDepth(state: any): void {
    parseDepthMap.set(state, getParseDepth(state) + 1);
}

/**
 * Decrement parse depth for a state
 */
function decrementParseDepth(state: any): void {
    const current = getParseDepth(state);
    if (current > 0) {
        parseDepthMap.set(state, current - 1);
    }
}

// Constants for existing notes
const SN_TOKEN = '+';
const SN_TOKEN_CODE = SN_TOKEN.charCodeAt(0);

const MN_TOKEN = '!';
const MN_TOKEN_CODE = MN_TOKEN.charCodeAt(0);

const TOKEN_PIPE = '|';

// Constants for new sidebar tokens
const LEFT_SIDEBAR_TOKEN = '$';
const LEFT_SIDEBAR_TOKEN_CODE = LEFT_SIDEBAR_TOKEN.charCodeAt(0);

const RIGHT_SIDEBAR_TOKEN = '@';
const RIGHT_SIDEBAR_TOKEN_CODE = RIGHT_SIDEBAR_TOKEN.charCodeAt(0);

// Types for better readability
interface NoteConfig {
  type: 'sidenote' | 'marginal_note';
  openMarker: string;
  openMarkerCode: number;
  closeMarker: string;
  cssClass: string;
  refClass: string;
}

// Configuration for sidebar tokens
interface SidebarConfig {
  type: 'left_sidebar' | 'right_sidebar';
  openMarker: string;
  openMarkerCode: number;
  closeMarker: string;
  cssClass: string;
}

interface MarkdownItState {
    src: string;
    pos: number;
    posMax: number;
    md: MarkdownIt;
    push: (type: string, tag: string, nesting: number) => any;
}

// Note configurations
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

// Sidebar configurations
const LeftSidebarConfig: SidebarConfig = {
    type: 'left_sidebar',
    openMarker: LEFT_SIDEBAR_TOKEN,
    openMarkerCode: LEFT_SIDEBAR_TOKEN_CODE,
    closeMarker: LEFT_SIDEBAR_TOKEN,
    cssClass: 'left-sidebar'
};

const RightSidebarConfig: SidebarConfig = {
    type: 'right_sidebar',
    openMarker: RIGHT_SIDEBAR_TOKEN,
    openMarkerCode: RIGHT_SIDEBAR_TOKEN_CODE,
    closeMarker: RIGHT_SIDEBAR_TOKEN,
    cssClass: 'right-sidebar'
};

export default function (md: MarkdownIt) {
    // Register notes tokenizer
    md.inline.ruler.before('link', 'notes', notesTokenizer as any);
    registerRendererRules(md, SideNoteConfig);
    registerRendererRules(md, MarginNoteConfig);
    
    // Register sidebar tokenizers
    md.inline.ruler.before('link', 'sidebars', sidebarTokenizer as any);
    registerSidebarRendererRules(md, LeftSidebarConfig);
    registerSidebarRendererRules(md, RightSidebarConfig);
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

function registerSidebarRendererRules(md: MarkdownIt, config: SidebarConfig) {
    const type = config.type;
    
    // Simple renderer rules for sidebar tokens
    md.renderer.rules[`${type}_open`] = () => `<span class="${config.cssClass}">`;
    md.renderer.rules[`${type}_close`] = () => '</span>';
}

/**
 * Tokenizer for sidebars ($...$ and §...§)
 */
function sidebarTokenizer(state: MarkdownItState, silent: boolean): boolean {
    const start = state.pos;
    const char = state.src.charCodeAt(start);
    
    // Early exit if not a potential sidebar marker
    if (char !== LEFT_SIDEBAR_TOKEN_CODE && char !== RIGHT_SIDEBAR_TOKEN_CODE) {
        return false;
    }

    // Detect sidebar type based on opening marker
    let config: SidebarConfig;
    if (char === LEFT_SIDEBAR_TOKEN_CODE) {
        config = LeftSidebarConfig;
    } else if (char === RIGHT_SIDEBAR_TOKEN_CODE) {
        config = RightSidebarConfig;
    } else {
        return false;
    }

    // Check if we have enough characters
    if (start + 1 >= state.posMax) {
        return false;
    }

    // Find closing marker
    let endPos = state.src.indexOf(config.closeMarker, start + 1);
    if (endPos === -1) return false;

    // Skip in silent mode
    if (silent) {
        return true;
    }

    // Extract content
    const content = state.src.slice(start + 1, endPos);

    // Create token structure
    createSidebarTokens(state, content, config);

    // Update position
    state.pos = endPos + 1;
    return true;
}

/**
 * Create tokens for sidebar elements
 */
function createSidebarTokens(state: MarkdownItState, content: string, config: SidebarConfig): void {
    const type = config.type;
    
    // Opening token
    const tokenOpen = state.push(`${type}_open`, 'span', 1);
    tokenOpen.markup = config.openMarker;
    
    try {
        // Process content with markdown support
        processTextWithMarkdown(state, content);
    } catch (e) {
        console.error(`Error processing ${type}:`, e);
        // Fallback to plain text
        const fallbackText = state.push('text', '', 0);
        fallbackText.content = content;
    }
    
    // Closing token
    state.push(`${type}_close`, 'span', -1);
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

    // Limit search to a reasonable range - replace the existing endPos finding
    const SEARCH_LIMIT = 1000; // Reasonable limit to search within
    const searchEndBound = Math.min(max, start + 2 + SEARCH_LIMIT);
    
    // Search within the bounded region instead of the entire document
    const searchRegion = state.src.slice(start + 2, searchEndBound);
    const relativeEndPos = searchRegion.indexOf(config.closeMarker);
    
    if (relativeEndPos === -1) return false;
    
    // Convert relative position to absolute position
    const endPos = start + 2 + relativeEndPos;

    // Extract content
    const content = state.src.slice(start + 2, endPos);
    const pipePos = content.indexOf(TOKEN_PIPE);
    if (pipePos === -1) return false;

    const text = content.slice(0, pipePos);
    const note = content.slice(pipePos + 1);
    
    // Check for empty reference text
    if (text.trim().length === 0) {
        if (!silent) {
            console.warn('Empty reference text in note');
        }
        return false;
    }

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
    
    try {
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
    } catch (e) {
        console.error(`Critical error in ${type} token creation:`, e);
        // Emergency recovery - add a simple text token as fallback
        const emergencyText = state.push('text', '', 0);
        emergencyText.content = `${text}|${note}`;
    }
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
    
    // Check recursion depth using WeakMap-based tracking
    if (getParseDepth(state) >= MAX_PARSE_DEPTH) {
        // Exceeded maximum nesting level, treat as plain text
        const plainText = state.push('text', '', 0);
        plainText.content = content;
        console.warn('Maximum nesting level exceeded in markdown-it-sidenote');
        return;
    }
    
    // Increment parse depth counter
    incrementParseDepth(state);
    try {
    
        // Use parseInline for proper fragment parsing
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
    } finally {
        // Always decrement counter to prevent leaks
        decrementParseDepth(state);
    }
}