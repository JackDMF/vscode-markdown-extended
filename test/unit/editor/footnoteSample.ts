/**
 * CA-btk22's shape (Theokratie-Archiv): references in quotes under list items,
 * one inside a definition, a repeated one; fourteen definitions at the end in
 * another order than their numbers, the first four continued on a 2-space line
 * after a `␣␣` hard break, the rest on an unindented (lazy) one.
 */
export function entriesDocument(): string {
    const labels = ['Welt', 'geliebt', 'einziggezeugten_Sohn', 'an_ihn_glaubt', 'ewiges_Leben', 'nie_sterben', 'Gerechtigkeit',
        'Joh14:16', 'zu_wenig_Glauben', 'ich_versichere_euch', 'verständige', 'Sklave', 'Luk12:42', 'Senfkorn'];
    const out = ['# Die Bibel lesen', '', '- Punkt eins', '', '    > ^20^Er antwortete: „Weil ihr zu wenig Glauben[^zu_wenig_Glauben] habt. Denn ich versichere euch[^ich_versichere_euch]: Wenn euer Glaube …', ''];
    out.push('  > ^45^Wer ist der verständige[^verständige] Sklave[^Sklave]?', '');
    out.push('- Punkt zwei', '', '  > Denn Gott hat die Welt[^Welt] so sehr geliebt[^geliebt], dass er seinen einziggezeugten Sohn[^einziggezeugten_Sohn] gab, damit jeder, der an ihn glaubt[^an_ihn_glaubt], ewiges Leben[^ewiges_Leben] hat', '');
    out.push('      > Er wird überhaupt nie sterben[^nie_sterben]. Gerechtigkeit[^Gerechtigkeit] und noch einmal Gerechtigkeit[^Gerechtigkeit].', '');
    out.push('Zum Schluss ein Senfkorn[^Senfkorn] und der Helfer[^Joh14:16].', '');
    labels.forEach((label, i) => {
        out.push(`[^${label}]: *${label.replace(/_/g, ' ')}*  `);
        out.push(i < 4 ? '  Das Wort wird in der Bibel eng mit der Menschheit verbunden.' : `Oder „Diener“, Erklärung ${i}${label === 'Sklave' ? ', siehe Verwalter[^Luk12:42].' : '.'}`);
        out.push('');
    });
    return out.join('\n');
}

