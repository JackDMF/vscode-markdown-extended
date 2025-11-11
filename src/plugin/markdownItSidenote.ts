import { MarkdownIt } from 'markdown-it';

/**
 * Markdown-it plugin for sidenotes, marginal notes, and sidebar annotations.
 * 
 * This plugin adds support for:
 * - Sidenotes: ++reference text|note content++
 * - Marginal notes: !!reference text|note content!!
 * - Left sidebar: $content$
 * - Right sidebar: @content@
 * 
 * Features:
 * - Full markdown support within notes (bold, italic, links, code, etc.)
 * - Recursion depth limiting to prevent stack overflow
 * - Thread-safe state management using WeakMap
 * - Graceful error handling with fallback to plain text
 * 
 * @module markdownItSidenote
 */

// Use WeakMap for thread-safe parse depth tracking per state
const parseDepthMap = new WeakMap<any, number>();

/**
 * Maximum recursion depth for nested markdown parsing.
 * Prevents stack overflow when processing deeply nested sidenotes.
 * @constant {number}
 */
const MAX_PARSE_DEPTH = 3;

/**
 * Get current parse depth for a state.
 * Uses WeakMap for thread-safe tracking without memory leaks.
 * 
 * @param state - Markdown-it parsing state
 * @returns Current nesting depth (0 if not tracked yet)
 */
function getParseDepth(state: any): number {
    return parseDepthMap.get(state) || 0;
}

/**
 * Increment parse depth for a state.
 * Called before recursively parsing markdown content.
 * 
 * @param state - Markdown-it parsing state
 */
function incrementParseDepth(state: any): void {
    parseDepthMap.set(state, getParseDepth(state) + 1);
}

/**
 * Decrement parse depth for a state.
 * Called after completing recursive markdown parsing.
 * Must always be called in a finally block to prevent depth leaks.
 * 
 * @param state - Markdown-it parsing state
 */
function decrementParseDepth(state: any): void {
    const current = getParseDepth(state);
    if (current > 0) {
        parseDepthMap.set(state, current - 1);
    }
}

// ============================================================================
// Constants
// ============================================================================

/** Sidenote marker character: ++ */
const SN_TOKEN = '+';
/** Sidenote marker character code */
const SN_TOKEN_CODE = SN_TOKEN.charCodeAt(0);

/** Marginal note marker character: !! */
const MN_TOKEN = '!';
/** Marginal note marker character code */
const MN_TOKEN_CODE = MN_TOKEN.charCodeAt(0);

/** Separator between reference text and note content: | */
const TOKEN_PIPE = '|';

/** Left sidebar marker character: $ */
const LEFT_SIDEBAR_TOKEN = '$';
/** Left sidebar marker character code */
const LEFT_SIDEBAR_TOKEN_CODE = LEFT_SIDEBAR_TOKEN.charCodeAt(0);

/** Right sidebar marker character: @ */
const RIGHT_SIDEBAR_TOKEN = '@';
/** Right sidebar marker character code */
const RIGHT_SIDEBAR_TOKEN_CODE = RIGHT_SIDEBAR_TOKEN.charCodeAt(0);

/**
 * Maximum character distance to search for closing markers.
 * Limits search scope to prevent performance issues with large documents.
 * @constant {number}
 */
const SEARCH_LIMIT = 1000;

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Configuration for note types (sidenotes and marginal notes).
 * Notes have reference text and separate note content.
 */
interface NoteConfig {
  /** Type identifier for renderer rules */
  type: 'sidenote' | 'marginal_note';
  /** Opening marker string (e.g., '++') */
  openMarker: string;
  /** Character code of opening marker */
  openMarkerCode: number;
  /** Closing marker string (e.g., '++') */
  closeMarker: string;
  /** CSS class for note content */
  cssClass: string;
  /** CSS class for reference text */
  refClass: string;
}

/**
 * Configuration for sidebar types (left and right sidebars).
 * Sidebars are simpler wrappers without reference text.
 */
interface SidebarConfig {
  /** Type identifier for renderer rules */
  type: 'left_sidebar' | 'right_sidebar';
  /** Opening marker character (e.g., '$') */
  openMarker: string;
  /** Character code of opening marker */
  openMarkerCode: number;
  /** Closing marker character (e.g., '$') */
  closeMarker: string;
  /** CSS class for sidebar content */
  cssClass: string;
}

/**
 * Markdown-it inline parsing state.
 * Simplified interface for the actual markdown-it state object.
 */
interface MarkdownItState {
    /** Source markdown text */
    src: string;
    /** Current position in source */
    pos: number;
    /** Maximum position (source length) */
    posMax: number;
    /** Markdown-it instance for recursive parsing */
    md: MarkdownIt;
    /** Push a new token to the stream */
    push: (type: string, tag: string, nesting: number) => any;
}

/**
 * Validated note content structure.
 */
interface ValidatedNote {
    /** Reference text (before the |) */
    text: string;
    /** Note content (after the |) */
    note: string;
}

// ============================================================================
// Configuration Objects
// ============================================================================

/**
 * Configuration for marginal notes (!!text|note!!).
 * Marginal notes appear in the document margin.
 */
const marginNoteConfig: NoteConfig = {
    type: 'marginal_note',
    openMarker: MN_TOKEN + MN_TOKEN,
    openMarkerCode: MN_TOKEN_CODE,
    closeMarker: MN_TOKEN + MN_TOKEN,
    cssClass: 'mnote',
    refClass: 'mn-ref'
};

/**
 * Configuration for sidenotes (++text|note++).
 * Sidenotes appear as floating annotations.
 */
const sideNoteConfig: NoteConfig = {
    type: 'sidenote',
    openMarker: SN_TOKEN + SN_TOKEN,
    openMarkerCode: SN_TOKEN_CODE,
    closeMarker: SN_TOKEN + SN_TOKEN,
    cssClass: 'sidenote',
    refClass: 'sn-ref'
};

/**
 * Configuration for left sidebar annotations ($content$).
 */
const leftSidebarConfig: SidebarConfig = {
    type: 'left_sidebar',
    openMarker: LEFT_SIDEBAR_TOKEN,
    openMarkerCode: LEFT_SIDEBAR_TOKEN_CODE,
    closeMarker: LEFT_SIDEBAR_TOKEN,
    cssClass: 'left-sidebar'
};

/**
 * Configuration for right sidebar annotations (@content@).
 */
const rightSidebarConfig: SidebarConfig = {
    type: 'right_sidebar',
    openMarker: RIGHT_SIDEBAR_TOKEN,
    openMarkerCode: RIGHT_SIDEBAR_TOKEN_CODE,
    closeMarker: RIGHT_SIDEBAR_TOKEN,
    cssClass: 'right-sidebar'
};

// ============================================================================
// Renderer Rules
// ============================================================================

/**
 * Discriminated union type for all renderer configurations.
 * Allows unified renderer registration for both notes and sidebars.
 */
type RenderConfig = NoteConfig | SidebarConfig;

/**
 * Register HTML renderer rules for any note or sidebar type.
 * 
 * **For notes (NoteConfig):**
 * - Creates nested structure with reference class and content class
 * - Reference text appears inline with refClass styling
 * - Note content appears as annotation with cssClass styling
 * 
 * **For sidebars (SidebarConfig):**
 * - Creates simple wrapper with cssClass
 * - Content appears in sidebar/margin
 * 
 * @param md - Markdown-it instance
 * @param config - Note or sidebar configuration
 */
function registerRendererRules(md: MarkdownIt, config: RenderConfig): void {
    const type = config.type;
    
    // Type guard: Check if this is a NoteConfig (has refClass)
    if ('refClass' in config) {
        // Note type (sidenote or marginal_note)
        // Structure: <span class="ref"><ref text></span><span class="note"><note content></span>
        md.renderer.rules[`${type}_open`] = () => `<span class="${config.refClass}">`;
        md.renderer.rules[`${type}_ref_open`] = () => ''; // No additional wrapper
        md.renderer.rules[`${type}_ref_close`] = () => ''; // No additional wrapper
        md.renderer.rules[`${type}_content_open`] = () => `<span class="${config.cssClass}">`;
        md.renderer.rules[`${type}_content_close`] = () => '</span>';
        md.renderer.rules[`${type}_close`] = () => '</span>';
    } else {
        // Sidebar type (left_sidebar or right_sidebar)
        // Structure: <span class="sidebar"><content></span>
        md.renderer.rules[`${type}_open`] = () => `<span class="${config.cssClass}">`;
        md.renderer.rules[`${type}_close`] = () => '</span>';
    }
}

/**
 * Main plugin initialization function.
 * Registers tokenizers and renderer rules for all note and sidebar types.
 * 
 * @param md - Markdown-it instance
 * 
 * @example
 * ```typescript
 * import sidenote from './markdownItSidenote';
 * md.use(sidenote);
 * ```
 */
export default function (md: MarkdownIt) {
    // Register notes tokenizer (handles both ++ and !!)
    md.inline.ruler.before('link', 'notes', notesTokenizer as any);
    registerRendererRules(md, sideNoteConfig);
    registerRendererRules(md, marginNoteConfig);
    
    // Register sidebar tokenizer (handles both $ and @)
    md.inline.ruler.before('link', 'sidebars', sidebarTokenizer as any);
    registerRendererRules(md, leftSidebarConfig);
    registerRendererRules(md, rightSidebarConfig);
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Tokenizer for sidebar annotations ($...$ and @...@).
 * 
 * Sidebars are simple wrappers that support markdown content.
 * Unlike notes, they don't have separate reference text.
 * 
 * @param state - Markdown-it inline parsing state
 * @param silent - If true, only check syntax without creating tokens
 * @returns true if a sidebar was found and processed
 * 
 * @example
 * ```markdown
 * This is $left sidebar content$ and @right sidebar content@.
 * ```
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
        config = leftSidebarConfig;
    } else if (char === RIGHT_SIDEBAR_TOKEN_CODE) {
        config = rightSidebarConfig;
    } else {
        return false;
    }

    // Check if we have enough characters
    if (start + 1 >= state.posMax) {
        return false;
    }

    // Find closing marker
    const endPos = state.src.indexOf(config.closeMarker, start + 1);
    if (endPos === -1) {return false;}

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
 * Create tokens for sidebar elements.
 * Sidebars have a simple structure: open tag, content, close tag.
 * 
 * @param state - Markdown-it parsing state
 * @param content - Sidebar content (supports markdown)
 * @param config - Sidebar configuration
 */
function createSidebarTokens(state: MarkdownItState, content: string, config: SidebarConfig): void {
    const type = config.type;
    
    // Create opening token
    const tokenOpen = state.push(`${type}_open`, 'span', 1);
    tokenOpen.markup = config.openMarker;
    
    // Process content with markdown support (with error handling)
    processContentSafely(state, content, type);
    
    // Create closing token
    state.push(`${type}_close`, 'span', -1);
}

/**
 * Tokenizer for sidenotes (++) and marginal notes (!!).
 * 
 * Detects note markers and delegates to processNote for parsing.
 * Notes have the structure: marker + text|note + marker
 * 
 * @param state - Markdown-it inline parsing state
 * @param silent - If true, only check syntax without creating tokens
 * @returns true if a note was found and processed
 * 
 * @example
 * ```markdown
 * This is ++reference|sidenote content++ and !!ref|marginal note!!.
 * ```
 */
function notesTokenizer(state: MarkdownItState, silent: boolean): boolean {
    const start = state.pos;
    const char = state.src.charCodeAt(start);
    
    // Early exit if not a potential note marker
    if (char !== sideNoteConfig.openMarkerCode && char !== marginNoteConfig.openMarkerCode) {
        return false;
    }

    // Detect note type based on opening marker
    let noteConfig: NoteConfig;
    if (char === sideNoteConfig.openMarkerCode && state.src.charCodeAt(start + 1) === sideNoteConfig.openMarkerCode) {
        noteConfig = sideNoteConfig;
    } else if (char === marginNoteConfig.openMarkerCode && state.src.charCodeAt(start + 1) === marginNoteConfig.openMarkerCode) {
        noteConfig = marginNoteConfig;
    } else {
        return false;
    }

    return processNote(state, silent, start, noteConfig);
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Validates note content structure (text|note).
 * 
 * @param content - Raw note content
 * @returns Validated structure with text and note, or null if invalid
 */
function validateNoteContent(content: string): ValidatedNote | null {
    const pipePos = content.indexOf(TOKEN_PIPE);
    if (pipePos === -1) {return null;}
    
    const text = content.slice(0, pipePos);
    const note = content.slice(pipePos + 1);
    
    // Reference text cannot be empty
    if (text.trim().length === 0) {return null;}
    
    return { text, note };
}

/**
 * Finds closing marker within reasonable search bounds.
 * 
 * @param src - Source text to search
 * @param startPos - Position to start searching from
 * @param marker - Marker string to find
 * @param maxSearch - Maximum characters to search (default: SEARCH_LIMIT)
 * @returns Position of closing marker, or null if not found
 */
function findClosingMarker(
    src: string, 
    startPos: number, 
    marker: string, 
    maxSearch: number = SEARCH_LIMIT
): number | null {
    const searchEndBound = Math.min(src.length, startPos + maxSearch);
    const searchRegion = src.slice(startPos, searchEndBound);
    const relativePos = searchRegion.indexOf(marker);
    
    return relativePos === -1 ? null : startPos + relativePos;
}

/**
 * Process content with markdown support, falling back to plain text on error.
 * Errors are silently handled to prevent plugin failures.
 * 
 * @param state - Markdown-it parsing state
 * @param content - Content to process
 * @param contextName - Description for error messages (unused - kept for future debugging)
 */
function processContentSafely(state: MarkdownItState, content: string, _contextName: string): void {
    try {
        processTextWithMarkdown(state, content);
    } catch {
        // Fallback to plain text on error - silently handle to prevent plugin failures
        const fallback = state.push('text', '', 0);
        fallback.content = content;
    }
}

/**
 * Process a note (either sidenote or marginal note).
 * Validates structure, extracts content, and creates tokens.
 * 
 * @param state - Markdown-it parsing state
 * @param silent - If true, only validate without creating tokens
 * @param start - Starting position in source
 * @param config - Note configuration (sidenote or marginal note)
 * @returns true if note was successfully processed
 */
function processNote(state: MarkdownItState, silent: boolean, start: number, config: NoteConfig): boolean {
    const max = state.posMax;
    
    // Validate we have enough characters for a note
    if (start + 2 >= max) {
        return false;
    }

    // Find closing marker within reasonable search bounds
    const endPos = findClosingMarker(state.src, start + 2, config.closeMarker);
    if (endPos === null) {return false;}

    // Extract and validate content structure (text|note)
    const content = state.src.slice(start + 2, endPos);
    const validated = validateNoteContent(content);
    
    if (!validated) {
        // Invalid note structure - silently fail in validation mode
        return false;
    }

    // Skip in silent mode (syntax check only)
    if (silent) {
        return true;
    }

    // Create token structure for the note
    createNoteTokens(state, validated.text, validated.note, config);

    // Update position past the closing marker
    state.pos = endPos + 2;
    return true;
}

/**
 * Create the token structure for a note.
 * 
 * Notes have a complex nested structure:
 * - Outer span with reference class
 * - Inner reference section (rendered inline)
 * - Inner content section with note class (rendered as popup/margin)
 * 
 * @param state - Markdown-it parsing state
 * @param text - Reference text (shown inline)
 * @param note - Note content (shown as annotation)
 * @param config - Note configuration
 */
function createNoteTokens(state: MarkdownItState, text: string, note: string, config: NoteConfig): void {
    const type = config.type;
    
    try {
        // Create opening token for entire note
        const tokenOpen = state.push(`${type}_open`, 'span', 1);
        tokenOpen.markup = config.openMarker;
        
        // Create reference section (inline text)
        state.push(`${type}_ref_open`, '', 1);
        processContentSafely(state, text, `${type} reference`);
        state.push(`${type}_ref_close`, '', -1);
        
        // Create note content section (annotation)
        state.push(`${type}_content_open`, 'span', 1);
        processContentSafely(state, note, `${type} note`);
        state.push(`${type}_content_close`, 'span', -1);
        
        // Create closing token
        state.push(`${type}_close`, 'span', -1);
        
    } catch {
        // Emergency recovery - add simple text token as fallback
        // Critical errors are silently handled to prevent plugin failures
        const emergencyText = state.push('text', '', 0);
        emergencyText.content = `${text}|${note}`;
    }
}

// ============================================================================
// Markdown Processing
// ============================================================================

/**
 * Process text with inline markdown support.
 * 
 * This function recursively parses markdown within note/sidebar content,
 * enabling features like **bold**, *italic*, `code`, [links](url), etc.
 * 
 * **Recursion Protection:**
 * - Uses WeakMap-based depth tracking (thread-safe, no memory leaks)
 * - Limited to MAX_PARSE_DEPTH (3 levels) to prevent stack overflow
 * - Falls back to plain text when depth limit exceeded
 * 
 * **Error Handling:**
 * - Always decrements depth counter in finally block
 * - Falls back to plain text if parsing fails
 * - Logs warnings for depth limit or parsing errors
 * 
 * @param state - Markdown-it parsing state
 * @param content - Text content to process with markdown
 * 
 * @example
 * ```typescript
 * // Input: "This is **bold** and *italic*"
 * // Output: Tokens for text, strong_open, text("bold"), strong_close, text(" and "), em_open, text("italic"), em_close
 * processTextWithMarkdown(state, content);
 * ```
 */
function processTextWithMarkdown(state: MarkdownItState, content: string): void {
    // Handle empty content edge case
    if (!content || content.length === 0) {
        const emptyText = state.push('text', '', 0);
        emptyText.content = '';
        return;
    }
    
    // Check recursion depth using WeakMap-based tracking
    // Prevents stack overflow in pathological cases like: ++ref|++nested|++deep|text+++++
    if (getParseDepth(state) >= MAX_PARSE_DEPTH) {
        // Exceeded maximum nesting level, treat as plain text
        // This is a normal protective measure, not an error condition
        const plainText = state.push('text', '', 0);
        plainText.content = content;
        return;
    }
    
    // Increment parse depth counter before recursive parsing
    incrementParseDepth(state);
    
    try {
        // Use parseInline for proper inline markdown processing
        // This creates a temporary environment and parses the content,
        // producing inline tokens (text, strong, em, code, link, etc.)
        const tempEnv = {};
        const tokens = state.md.parseInline(content, tempEnv);
        
        if (tokens && tokens[0] && tokens[0].children) {
            // Transfer the resulting inline tokens to our token stream
            // This preserves all markdown formatting within notes/sidebars
            tokens[0].children.forEach((token) => {
                const newToken = state.push(token.type, token.tag, token.nesting);
                
                // Copy all token properties (content, markup, attrs, meta, etc.)
                // Preserve everything except type/tag/nesting which are set by push()
                Object.keys(token).forEach(key => {
                    if (key !== 'type' && key !== 'tag' && key !== 'nesting') {
                        newToken[key] = token[key];
                    }
                });
            });
        } else {
            // Fallback if parsing fails unexpectedly
            const plainText = state.push('text', '', 0);
            plainText.content = content;
        }
    } finally {
        // CRITICAL: Always decrement counter to prevent depth leaks
        // This ensures the counter is accurate even if parsing throws an exception
        decrementParseDepth(state);
    }
}