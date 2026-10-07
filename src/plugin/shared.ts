export function slugify(s: string) {
    // Unicode-friendly
    const spaceRegex = /[ \xA0\u1680\u2000-\u200A\u202F\u205F\u3000]/g;
    return encodeURIComponent(s.replace(spaceRegex, '-').toLowerCase());
}

/**
 * Whether `ruler` (a markdown-it `Ruler`: `md.core.ruler`, `md.inline.ruler`)
 * holds an enabled rule named `name`, as the engine was actually built.
 */
export function hasEnabledRule(ruler: unknown, name: string): boolean {
    const rules = (ruler as { __rules__?: { name: string; enabled: boolean }[] }).__rules__ ?? [];
    return rules.some(rule => rule.name === name && rule.enabled);
}
