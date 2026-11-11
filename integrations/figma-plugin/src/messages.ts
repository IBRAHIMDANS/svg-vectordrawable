// Messages between the plugin's main thread (code.js, Figma sandbox) and its UI (ui.html, iframe).
// main -> UI: `figma.ui.postMessage(msg)`, received as `event.data.pluginMessage`.
// UI -> main: `parent.postMessage({ pluginMessage: msg }, '*')`, received by `figma.ui.onmessage`.

/** One selected layer, exported by Figma. */
export interface ExportedLayer {
    id: string;
    name: string;
    /** Figma node type (`FRAME`, `COMPONENT`, `VECTOR`…), for display. */
    type: string;
    /**
     * The `exportAsync({ format: 'SVG' })` bytes (UTF-8). The main thread has no TextDecoder, so
     * the UI decodes them.
     */
    svg?: Uint8Array;
    /** Why the export failed, when it did (then `svg` is absent). */
    error?: string;
}

export type MainToUi =
    /** The selection changed and its export started; a `selection` with the same generation follows. */
    | { type: 'exporting'; generation: number; count: number }
    /** The exported selection. `truncated` layers beyond MAX_LAYERS were left out. */
    | { type: 'selection'; generation: number; layers: ExportedLayer[]; truncated: number };

export type UiToMain =
    /** The UI is listening: export the current selection. */
    | { type: 'ready' }
    /** Export the current selection again (e.g. after editing it). */
    | { type: 'refresh' }
    /** Show a Figma toast. */
    | { type: 'notify'; message: string; error?: boolean };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

export function isUiToMain(value: unknown): value is UiToMain {
    if (!isObject(value)) return false;
    if (value.type === 'ready' || value.type === 'refresh') return true;
    return value.type === 'notify' && typeof value.message === 'string';
}

export function isMainToUi(value: unknown): value is MainToUi {
    if (!isObject(value) || typeof value.generation !== 'number') return false;
    if (value.type === 'exporting') return typeof value.count === 'number';
    return value.type === 'selection' && Array.isArray(value.layers) && typeof value.truncated === 'number';
}
