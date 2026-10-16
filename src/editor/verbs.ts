/**
 * What every object bar reads (`webview/objectToolbar.ts`): the slots its verbs
 * stand in, their order, where a divider goes, which verb `Alt+Enter` focuses,
 * how a verb is worded and what its undo hint says, and how the bar is named.
 * One model, so a bar cannot order, word or divide its verbs its own way
 * (Daniel's decisions #7 and #14, 2026-10-15/16):
 *
 * - **Slots, in this order:** Open (Show in text editor fills it too) · Edit… ·
 *   the object's type verbs (Language…, Row/Column/Align, Convert…, Type) ·
 *   Attributes… · Edit source · other extensions' actions (lenses, code
 *   actions) · divider · Remove/Delete — the verb that destroys stands last.
 * - **Remove keeps, Delete destroys** (VS Code's convention): "Remove …" says
 *   what stays (", keep text"); "Delete …" is where the content goes.
 * - **First focus** is the first verb that opens something in place (a field,
 *   a choice, a menu, a source box) and is not refused — never Open, never a
 *   verb that acts at once, never another extension's — else the bar itself.
 * - **Undo hints** read "<Object> <past participle> — <undo key>"
 *   (`hint.ts` `undoHint`): the participle is the verb's, said here.
 * - **Overflow:** where the bar's title names the object, a verb may drop the
 *   noun ("Delete", "Edit…") before the title truncates; verbs never truncate.
 *
 * No ProseMirror and no DOM here: the host side (`schema.ts`) and the objects'
 * refusals (`webview/objects.ts`) quote the verbs' names from `VERB`.
 */

/** Where a verb stands on its bar. */
export type Slot = 'open' | 'edit' | 'type' | 'attributes' | 'source' | 'actions' | 'destroy';

/** The slots in the order a bar draws them. */
export const SLOT_ORDER: readonly Slot[] = ['open', 'edit', 'type', 'attributes', 'source', 'actions', 'destroy'];

/** What the model needs of a verb. */
export interface Slotted {
    slot: Slot;
    /** Why it cannot be chosen here; `null` or absent when it can. */
    refusal?: string | null;
    /** Drawn after a divider. */
    separated?: boolean;
    /** It opens something in place — a field, a choice, a menu, a source box — rather than acting at once or elsewhere. */
    opensInPlace: boolean;
}

/**
 * The verbs in slot order, stable within a slot, with the dividers the rule
 * gives: before the first other extension's verb when a verb of the object's
 * own precedes it, and before the verb that destroys when any verb precedes
 * it. A divider the presentation set itself (a table's, before Attributes…)
 * stays; every other is the rule's.
 */
export function arrange<V extends Pick<Slotted, 'slot' | 'separated'>>(verbs: readonly V[]): V[] {
    const rank = (v: V) => SLOT_ORDER.indexOf(v.slot);
    const sorted = verbs.map((v, k) => ({ v, k })).sort((a, b) => rank(a.v) - rank(b.v) || a.k - b.k).map(x => x.v);
    const firstAction = sorted.findIndex(v => v.slot === 'actions');
    const firstDestroy = sorted.findIndex(v => v.slot === 'destroy');
    return sorted.map((v, k) => {
        const separated = (k === firstAction && k > 0) || (k === firstDestroy && k > 0) || (v.separated === true && v.slot !== 'actions' && v.slot !== 'destroy');
        return v.separated === separated || (!separated && v.separated === undefined) ? v : { ...v, separated };
    });
}

/**
 * Where `Alt+Enter` puts the focus: the index of the first verb that opens in
 * place and is not refused — never Open, never another extension's, never one
 * that acts at once — or `-1`, the bar itself.
 */
export function firstFocus(verbs: readonly Slotted[]): number {
    return verbs.findIndex(v => v.opensInPlace && !v.refusal && v.slot !== 'open' && v.slot !== 'actions' && v.slot !== 'destroy');
}

/** A verb built from its verb word and its noun. */
export interface Wording {
    verb: 'Open' | 'Edit' | 'Change' | 'Delete' | 'Remove' | 'Convert to text';
    /** The object it acts on: `link`, `image`, `note`, `attributes` …; `''` for Open alone and Convert to text. */
    noun: string;
    /** Remove only: what stays — `, keep text`, `, keep content`, `, keep formatting`. */
    keeps?: string;
    /** It opens a field or a choice: the label ends in `…`. */
    opens?: boolean;
    /**
     * Whether the bar's title names the noun (default), so the short form may
     * drop it; `false`: the short form is the label (a span's "Remove
     * attributes, keep text" — its title says Span, not attributes).
     */
    titled?: boolean;
}

/** What a hint says a verb did: its participle, or none for a verb that leaves something to see. */
const PARTICIPLE: Readonly<Partial<Record<Wording['verb'], string>>> = {
    Delete: 'deleted',
    Remove: 'removed',
    'Convert to text': 'converted to text',
};

/**
 * A verb's label, its short form without the noun the title already names,
 * and the sentence its undo hint says (`done`, without the key; `null` for a
 * verb that leaves something to see): `Delete image` → `Delete`,
 * `Image deleted`; `Remove link, keep text` → `Remove, keep text`,
 * `Link removed`; `Edit link…` → `Edit…`, `null`.
 */
export function wording(w: Wording & { verb: 'Delete' | 'Remove' | 'Convert to text' }): { label: string; short: string; done: string };
export function wording(w: Wording): { label: string; short: string; done: string | null };
export function wording(w: Wording): { label: string; short: string; done: string | null } {
    const dots = w.opens ? '…' : '';
    const keeps = w.keeps ?? '';
    const word = w.verb === 'Convert to text' || w.noun === '' ? w.verb : `${w.verb} ${w.noun}`;
    const label = `${word}${keeps}${dots}`;
    const short = w.titled === false ? label : `${w.verb}${keeps}${dots}`;
    const participle = PARTICIPLE[w.verb];
    const done = participle === undefined ? null : `${w.noun.charAt(0).toUpperCase()}${w.noun.slice(1)} ${participle}`;
    return { label, short, done };
}

/** What a bar shows as its title: the object's name and, after it, its spelling (`Emoji :rocket:`). */
export function barName(label: string, code?: string): string {
    return code === undefined ? label : `${label} ${code}`;
}

/** A bar's accessible name: the object, its verbs' count and the keys (`Emoji :rocket:, 2 actions, arrow keys to choose`). */
export function barDescription(name: string, count: number): string {
    return count === 0 ? `${name}, no actions` : `${name}, ${count} ${count === 1 ? 'action' : 'actions'}, arrow keys to choose`;
}

/** The tooltip of a Delete whose file stays: an image's, an embed's, a snippet directive's. */
export const FILE_STAYS = 'Delete from this document — the file stays';

/** Verb names other surfaces quote: the wiki embed's tooltip, the emoji's and the notes' ways out, the objects' refusals. */
export const VERB = {
    convertToText: 'Convert to text',
    editClasses: 'Edit classes…',
    type: 'Type',
    editSource: 'Edit source',
    showInTextEditor: 'Show in text editor',
    attributes: 'Attributes…',
    /** As the emoji's bar words it (`wording`): the notes' and the emoji's refusals name it as a way out. */
    deleteEmoji: wording({ verb: 'Delete', noun: 'emoji' }).label,
} as const;
