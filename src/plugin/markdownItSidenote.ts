import { MarkdownIt } from 'markdown-it';

const TOKEN_OPEN = '+';
const TOKEN_OPEN_CODE = TOKEN_OPEN.charCodeAt(0);
const TOKEN_PIPE = '|';
const TOKEN_PIPE_CODE = TOKEN_PIPE.charCodeAt(0);
const TOKEN_CLOSE = '+';
const TOKEN_CLOSE_CODE = TOKEN_CLOSE.charCodeAt(0);

export default function(md: MarkdownIt) {
    // Registriere die Regel VOR dem Link-Tokenizer für bessere Priorität
    md.inline.ruler.before('link', 'sidenote', sidenoteTokenizer as any);

    // Verbesserte Renderer mit Token-Unterstützung
    md.renderer.rules.sidenote_open = (tokens, idx) => {
        return '<span class="sn-ref">';
    };
    
    md.renderer.rules.sidenote_text = (tokens, idx) => {
        return tokens[idx].content || '';
    };
    
    md.renderer.rules.sidenote_content_open = () => '<span class="sidenote">';
    md.renderer.rules.sidenote_content_close = () => '</span>';
    md.renderer.rules.sidenote_close = () => '</span>';
}

function sidenoteTokenizer(state: any, silent: boolean): boolean {
    // Frühe Prüfung für offensichtliche Nicht-Treffer
    if (state.src.charCodeAt(state.pos) !== TOKEN_OPEN_CODE) {
        return false;
    }
    
    console.log('sidenoteTokenizer', state.src.slice(state.pos, state.pos + 10));
    
    const max = state.posMax;
    const start = state.pos;

    // Check opening markers
    if (start + 2 >= max || 
        state.src.charCodeAt(start) !== TOKEN_OPEN_CODE || 
        state.src.charCodeAt(start + 1) !== TOKEN_OPEN_CODE) {
        return false;
    }

    // Find closing markers
    const endMarker = `${TOKEN_CLOSE}${TOKEN_CLOSE}`;
    let endPos = state.src.indexOf(endMarker, start + 2);
    if (endPos === -1) return false;

    // Extract full match
    const content = state.src.slice(start + 2, endPos);
    const pipePos = content.indexOf(TOKEN_PIPE);
    if (pipePos === -1) return false;

    const text = content.slice(0, pipePos);
    const note = content.slice(pipePos + 1);

    // Skip in silent mode (used for rule matching)
    if (silent) {
        return true;
    }
    
    console.log("Found sidenote:", text, "with note:", note);

    // Direkt Token-Struktur erstellen, ohne Postprocessor
    
    // Öffnungs-Token für die Sidenote
    const tokenOpen = state.push('sidenote_open', 'span', 1);
    tokenOpen.markup = `${TOKEN_OPEN}${TOKEN_OPEN}`;
    
    // Text-Token für den Anzeigetext
    const tokenText = state.push('sidenote_text', '', 0);
    tokenText.content = text;
    
    // Öffnungs-Token für den Notizinhalt
    const tokenNoteOpen = state.push('sidenote_content_open', 'span', 1);
    
    try {
        // Verarbeite den Notiztext mit Inline-Parsing für Formatierung im Notiztext
        const oldPos = state.pos;
        const oldMax = state.posMax;
        
        if (note && note.length > 0) {
            // Erstelle einen neuen State für den Notiztext
            const inlineState = new state.md.inline.State(note, state.md, state.env, []);
            state.pos = 0;
            state.posMax = note.length;
            
            // Tokenisiere und prüfe, ob ein Array zurückgegeben wird
            const tokens = state.md.inline.tokenize(inlineState);
            
            if (tokens && Array.isArray(tokens)) {
                tokens.forEach(token => {
                    state.push(token.type, token.tag, token.nesting);
                    const newToken = state.tokens[state.tokens.length - 1];
                    
                    // Kopiere alle Eigenschaften des Tokens
                    for (const key in token) {
                        if (key !== 'type' && key !== 'tag' && key !== 'nesting') {
                            newToken[key] = token[key];
                        }
                    }
                });
            } else {
                // Fallback, wenn keine Tokens zurückgegeben wurden
                const plainText = state.push('text', '', 0);
                plainText.content = note;
            }
        } else {
            // Leerer Notiztext
            const emptyText = state.push('text', '', 0);
            emptyText.content = '';
        }
        
        // Stelle den ursprünglichen Zustand wieder her
        state.pos = oldPos;
        state.posMax = oldMax;
    } catch (e) {
        console.error("Error processing sidenote:", e);
        // Bei Fehler einfach Rohtext einfügen
        const fallbackText = state.push('text', '', 0);
        fallbackText.content = note;
    }
    
    // Schließende Tokens
    state.push('sidenote_content_close', 'span', -1);
    state.push('sidenote_close', 'span', -1);

    // Position nach dem gesamten Sidenote-Block aktualisieren
    state.pos = endPos + 2;
    
    return true;
}