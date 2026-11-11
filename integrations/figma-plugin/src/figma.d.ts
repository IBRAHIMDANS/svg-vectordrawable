// Minimal declarations of the Figma Plugin API surface this plugin uses, modelled on the official
// `@figma/plugin-typings` (not a dependency of this repository). Only what main.ts / plugin.ts call.

interface FigmaExportSvgSettings {
    format: 'SVG';
    /** Text as outlined paths (default true): a VectorDrawable has no text. */
    svgOutlineText?: boolean;
    /** `id` attributes from layer names (default false). */
    svgIdAttribute?: boolean;
    /** Strokes simplified to fills when possible (default true). */
    svgSimplifyStroke?: boolean;
}

interface FigmaSceneNode {
    readonly id: string;
    readonly name: string;
    readonly type: string;
    exportAsync(settings: FigmaExportSvgSettings): Promise<Uint8Array>;
}

interface FigmaShowUIOptions {
    width?: number;
    height?: number;
    title?: string;
    themeColors?: boolean;
    visible?: boolean;
}

interface FigmaUIAPI {
    postMessage(message: unknown): void;
    onmessage: ((message: unknown) => void) | undefined;
}

interface FigmaNotifyOptions {
    timeout?: number;
    error?: boolean;
}

interface FigmaPluginAPI {
    readonly currentPage: { readonly selection: readonly FigmaSceneNode[] };
    readonly ui: FigmaUIAPI;
    showUI(html: string, options?: FigmaShowUIOptions): void;
    on(event: 'selectionchange' | 'currentpagechange', callback: () => void): void;
    notify(message: string, options?: FigmaNotifyOptions): unknown;
}

declare const figma: FigmaPluginAPI;
/** The content of the manifest's `ui` file, injected by Figma. */
declare const __html__: string;
