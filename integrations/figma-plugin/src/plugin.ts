// Main-thread logic (Figma sandbox): exports the selection as SVG and sends it to the UI, which
// does the conversion. Takes the `figma` API as a parameter so that tests can pass a fake one.
import { messageOf } from './conversion.ts';
import { isUiToMain, type ExportedLayer, type MainToUi } from './messages.ts';

/** Layers exported per selection; the rest is reported as `truncated`. */
export const MAX_LAYERS = 50;

export const UI_SIZE = { width: 720, height: 560 };

const EXPORT_SETTINGS: FigmaExportSvgSettings = {
    format: 'SVG',
    svgOutlineText: true,
    svgIdAttribute: false,
    svgSimplifyStroke: true,
};

/** Exports `nodes` one by one; a failing node becomes an `error` entry instead of failing them all. */
export async function exportLayers(
    nodes: readonly FigmaSceneNode[],
    isStale: () => boolean = () => false,
): Promise<ExportedLayer[]> {
    const layers: ExportedLayer[] = [];
    for (const node of nodes) {
        if (isStale()) break;
        const layer: ExportedLayer = { id: node.id, name: node.name, type: node.type };
        try {
            layer.svg = await node.exportAsync(EXPORT_SETTINGS);
        } catch (error) {
            layer.error = `Figma could not export this layer as SVG (${messageOf(error)}).`;
        }
        layers.push(layer);
    }
    return layers;
}

export interface PluginHandle {
    /** Exports the current selection and posts it; resolves when done (or superseded). */
    sendSelection(): Promise<void>;
}

export function startPlugin(api: FigmaPluginAPI, html: string): PluginHandle {
    let generation = 0;
    const post = (message: MainToUi) => api.ui.postMessage(message);

    async function sendSelection(): Promise<void> {
        const current = ++generation;
        const selection = api.currentPage.selection;
        const nodes = selection.slice(0, MAX_LAYERS);
        post({ type: 'exporting', generation: current, count: nodes.length });
        const layers = await exportLayers(nodes, () => current !== generation);
        // A newer selection is being exported: drop this one.
        if (current !== generation) return;
        post({ type: 'selection', generation: current, layers, truncated: selection.length - nodes.length });
    }

    api.showUI(html, {
        width: UI_SIZE.width,
        height: UI_SIZE.height,
        title: 'SVG to VectorDrawable',
        themeColors: true,
    });
    api.ui.onmessage = (message) => {
        if (!isUiToMain(message)) return;
        if (message.type === 'notify') api.notify(message.message, { error: message.error === true });
        else void sendSelection();
    };
    api.on('selectionchange', () => void sendSelection());
    return { sendSelection };
}
