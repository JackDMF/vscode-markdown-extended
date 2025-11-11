// Type definitions for markdown-it
// Project: https://github.com/markdown-it/markdown-it
// Definitions by: York Yao <https://github.com/plantain-00/>, Robert Coie <https://github.com/rapropos>
// Definitions: https://github.com/DefinitelyTyped/DefinitelyTyped

interface MarkdownItStatic {
    new (): MarkdownIt.MarkdownIt;
    new (presetName: "commonmark" | "zero" | "default", options?: MarkdownIt.Options): MarkdownIt.MarkdownIt;
    new (options: MarkdownIt.Options): MarkdownIt.MarkdownIt;
    (): MarkdownIt.MarkdownIt;
    (presetName: "commonmark" | "zero" | "default", options ?: MarkdownIt.Options): MarkdownIt.MarkdownIt;
    (options: MarkdownIt.Options): MarkdownIt.MarkdownIt;
}

declare var MarkdownIt: MarkdownItStatic;
export = MarkdownIt;
export as namespace markdownit;

declare module MarkdownIt {
    /**
     * Environment object for markdown-it rendering
     */
    interface Environment {
        [key: string]: unknown;
    }
    
    /**
     * Plugin function type
     */
    type PluginSimple = (md: MarkdownIt, ...params: unknown[]) => void;
    type PluginWithOptions<T = unknown> = (md: MarkdownIt, options?: T) => void;
    type PluginWithParams = (md: MarkdownIt, ...params: unknown[]) => void;
    
    interface MarkdownIt {
        render(md: string, env?: Environment): string;
        renderInline(md: string, env?: Environment): string;
        parse(src: string, env: Environment): Token[];
        parseInline(src: string, env: Environment): Token[];
        use(plugin: PluginSimple | PluginWithOptions | PluginWithParams, ...params: unknown[]): MarkdownIt;
        utils: {
            assign<T extends object>(obj: T): T;
            isString(obj: unknown): obj is string;
            has(object: Record<string, unknown>, key: string): boolean;
            unescapeMd(str: string): string;
            unescapeAll(str: string): string;
            isValidEntityCode(code: number): boolean;
            fromCodePoint(str: string): string;
            escapeHtml(str: string): string;
            arrayReplaceAt<T>(src: T[], pos: number, newElements: T[]): T[]
            isSpace(code: number): boolean;
            isWhiteSpace(code: number): boolean
            isMdAsciiPunct(code: number): boolean;
            isPunctChar(ch: string): boolean;
            escapeRE(str: string): string;
            normalizeReference(str: string): string;
        }
        disable(rules: string[] | string, ignoreInvalid?: boolean): MarkdownIt;
        enable(rules: string[] | string, ignoreInvalid?: boolean): MarkdownIt;
        set(options: Options): MarkdownIt;
        normalizeLink(url: string): string;
        normalizeLinkText(url: string): string;
        validateLink(url: string): boolean;
        block: ParserBlock;
        core: Core;
        helpers: Record<string, unknown>;
        inline: ParserInline;
        linkify: LinkifyIt;
        renderer: Renderer;
    }
    interface Options {
        html?: boolean;
        xhtmlOut?: boolean;
        breaks?: boolean;
        langPrefix?: string;
        linkify?: boolean;
        typographer?: boolean;
        quotes?: string;
        highlight?: (str: string, lang: string) => string | void;
    }
    interface LinkifyIt {
        tlds(lang: string, linkified: boolean): void;
    }
    interface Renderer {
        rules: { [name: string]: TokenRender };
        render(tokens: Token[], options: Options, env: Environment): string;
        renderAttrs(token: Token): string;
        renderInline(tokens: Token[], options: Options, env: Environment): string;
        renderToken(tokens: Token[], idx: number, options: Options): string;
    }
    interface Token {
        attrGet: (name: string) => string | null;
        attrIndex: (name: string) => number;
        attrJoin: (name: string, value: string) => void;
        attrPush: (attrData: string[]) => void;
        attrSet: (name: string, value: string) => void;
        attrs: string[][];
        block: boolean;
        children: Token[];
        content: string;
        hidden: boolean;
        info: string;
        level: number;
        map: number[];
        markup: string;
        meta: unknown;
        nesting: number;
        tag: string;
        type: string;
    }

    type TokenRender = (tokens: Token[], index: number, options: Options, env: Environment, self: Renderer) => string;

    /**
     * State object passed to rules
     */
    interface StateBase {
        src: string;
        env: Environment;
        tokens: Token[];
        [key: string]: unknown;
    }
    
    /**
     * Block rule function
     */
    type RuleBlock = (state: StateBase, startLine: number, endLine: number, silent: boolean) => boolean;
    
    /**
     * Inline rule function
     */
    type RuleInline = (state: StateBase, silent: boolean) => boolean;
    
    /**
     * Core rule function
     */
    type RuleCore = (state: StateBase) => void;

    interface Ruler {
        after(afterName: string, ruleName: string, rule: RuleBlock | RuleInline | RuleCore, options?: Record<string, unknown>): void;
        at(name: string, rule: RuleBlock | RuleInline | RuleCore, options?: Record<string, unknown>): void;
        before(beforeName: string, ruleName: string, rule: RuleBlock | RuleInline | RuleCore, options?: Record<string, unknown>): void;
        disable(rules: string | string[], ignoreInvalid?: boolean): string[];
        enable(rules: string | string[], ignoreInvalid?: boolean): string[];
        enableOnly(rule: string, ignoreInvalid?: boolean): void;
        getRules(chain: string): (RuleBlock | RuleInline | RuleCore)[];
        push(ruleName: string, rule: RuleBlock | RuleInline | RuleCore, options?: Record<string, unknown>): void;
    }

    interface ParserBlock {
        parse(src: string, md: MarkdownIt, env: Environment, outTokens: Token[]): void;
        ruler: Ruler;
    }

    interface Core {
        process(state: StateBase): void;
        ruler: Ruler;
    }

    interface ParserInline {
        parse(src: string, md: MarkdownIt, env: Environment, outTokens: Token[]): void;
        ruler: Ruler;
        ruler2: Ruler;
    }
}
