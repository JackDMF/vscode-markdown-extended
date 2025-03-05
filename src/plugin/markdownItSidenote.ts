export function MarkdownItSidenote(md: any) {
    const sidenoteRegex = /\(\((.*?)\|(.*?)\)\)/;

    md.inline.ruler.after('emphasis', 'sidenote', function(state: any) {
        const match = sidenoteRegex.exec(state.src.slice(state.pos));
        if (!match) return false;

        const text = match[1];
        const note = match[2];

        // Open wrapper span
        let token = state.push('sidenote_open', 'span', 1);
        token.attrs = [['class', 'sn-ref']];

        // Add main text
        token = state.push('text', '', 0);
        token.content = text;

        // Parse sidenote content with markdown
        const noteToken = state.push('sidenote', 'sn', 0);
        
        // Create a child instance for parsing the note content
        const childState = new state.constructor(note, md, state.env, []);
        childState.md = state.md;
        
        // Parse the note content
        md.inline.parse(note, md, state.env, childState.tokens);
        
        // Store the parsed tokens
        noteToken.children = childState.tokens;

        state.push('sidenote_close', 'span', -1);
        state.pos += match[0].length;
        return true;
    });

    md.renderer.rules.sidenote = function(tokens: any, idx: number, options: any, env: any, self: any) {
        // Render the child tokens
        const content = tokens[idx].children ? 
            tokens[idx].children.map((t: any) => self.renderToken([t], 0, options)).join('') :
            '';
        return `<sn>${content}</sn>`;
    };
}