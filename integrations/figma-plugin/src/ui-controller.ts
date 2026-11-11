// DOM-free logic of the UI: receives the exported selection from the main thread, names the
// layers, converts them one at a time and builds the files to download. ui.ts only renders the
// state and wires the buttons; tests drive this module directly.
import type { ConvertOptions, Outcome } from './conversion.ts';
import { describeError } from './conversion.ts';
import type { Converter } from './converter.ts';
import { isMainToUi, type ExportedLayer, type UiToMain } from './messages.ts';
import { uniqueResourceNames } from './naming.ts';
import { createZip } from './zip.ts';

/** Exports above this size are not converted (same bound as the playground). */
export const MAX_INPUT_BYTES = 2 * 1024 * 1024;

export interface LayerView {
    id: string;
    layerName: string;
    type: string;
    /** Distinct Android resource name: the file is `<resourceName>.xml`. */
    resourceName: string;
    /** The SVG Figma exported, or null when the export failed or was too large. */
    sourceSvg: string | null;
    /** Null while waiting for its turn. */
    outcome: Outcome | null;
}

export interface UiState {
    phase: 'waiting' | 'exporting' | 'converting' | 'done';
    /** Layers being exported (phase `exporting`). */
    exportingCount: number;
    layers: LayerView[];
    /** Selected layers left out (beyond the main thread's MAX_LAYERS). */
    truncated: number;
    /** Index of the layer shown in detail. */
    selected: number;
}

export interface DownloadFile {
    filename: string;
    mimeType: string;
    data: Uint8Array | string;
}

export interface UiControllerConfig {
    post: (message: UiToMain) => void;
    converter: Pick<Converter, 'convert'>;
    render: (state: UiState) => void;
    options?: ConvertOptions;
}

export interface UiController {
    readonly state: UiState;
    /** Tells the main thread the UI listens (it then sends the selection). */
    start(): void;
    refresh(): void;
    select(index: number): void;
    /** Handles a `pluginMessage`; resolves once the layers it brought are converted. */
    handle(message: unknown): Promise<void>;
    notify(message: string, error?: boolean): void;
}

const withNewline = (xml: string): string => (xml.endsWith('\n') ? xml : `${xml}\n`);

function toLayerViews(layers: readonly ExportedLayer[]): LayerView[] {
    const names = uniqueResourceNames(layers.map((layer) => layer.name));
    const decoder = new TextDecoder();
    return layers.map((layer, index): LayerView => {
        const view: LayerView = {
            id: layer.id,
            layerName: layer.name,
            type: layer.type,
            resourceName: names[index]!,
            sourceSvg: null,
            outcome: null,
        };
        if (layer.error !== undefined || !layer.svg) {
            view.outcome = { status: 'error', message: layer.error ?? 'Figma returned no SVG for this layer.' };
        } else if (layer.svg.byteLength > MAX_INPUT_BYTES) {
            view.outcome = {
                status: 'error',
                message: `The exported SVG is larger than ${MAX_INPUT_BYTES / 1024 / 1024} MB (embedded images?): use the CLI instead.`,
            };
        } else {
            view.sourceSvg = decoder.decode(layer.svg);
        }
        return view;
    });
}

export function createUiController({ post, converter, render, options = {} }: UiControllerConfig): UiController {
    const state: UiState = { phase: 'waiting', exportingCount: 0, layers: [], truncated: 0, selected: 0 };
    let generation = -1;

    async function convertAll(current: number): Promise<void> {
        for (const layer of state.layers) {
            if (layer.outcome || layer.sourceSvg === null) continue;
            const outcome = await converter.convert({ svg: layer.sourceSvg, options });
            // A newer selection arrived meanwhile: its own loop takes over.
            if (current !== generation) return;
            layer.outcome = outcome;
            render(state);
        }
        state.phase = 'done';
        render(state);
    }

    async function handle(message: unknown): Promise<void> {
        if (!isMainToUi(message) || message.generation < generation) return;
        generation = message.generation;
        if (message.type === 'exporting') {
            state.phase = 'exporting';
            state.exportingCount = message.count;
            render(state);
            return;
        }
        state.layers = toLayerViews(message.layers);
        state.truncated = message.truncated;
        state.selected = 0;
        state.phase = state.layers.length === 0 ? 'waiting' : 'converting';
        render(state);
        if (state.layers.length > 0) await convertAll(generation);
    }

    return {
        state,
        start: () => post({ type: 'ready' }),
        refresh: () => post({ type: 'refresh' }),
        select(index) {
            if (index < 0 || index >= state.layers.length) return;
            state.selected = index;
            render(state);
        },
        handle,
        notify: (message, error = false) => post({ type: 'notify', message, error }),
    };
}

/** The converted layers: those that can be copied or downloaded. */
export function convertedLayers(state: UiState): (LayerView & { outcome: Extract<Outcome, { status: 'ok' }> })[] {
    return state.layers.filter(
        (layer): layer is LayerView & { outcome: Extract<Outcome, { status: 'ok' }> } => layer.outcome?.status === 'ok',
    );
}

/** `<name>.xml` for one layer. */
export function layerDownload(layer: LayerView): DownloadFile | null {
    if (layer.outcome?.status !== 'ok') return null;
    return { filename: `${layer.resourceName}.xml`, mimeType: 'application/xml', data: withNewline(layer.outcome.xml) };
}

/**
 * Every converted layer: a single `.xml` when there is one, else `drawables.zip` with
 * `drawable/<name>.xml` entries (ready to merge into `res/`). Null when nothing converted.
 */
export function selectionDownload(state: UiState, modified: Date = new Date()): DownloadFile | null {
    const layers = convertedLayers(state);
    if (layers.length === 0) return null;
    if (layers.length === 1) return layerDownload(layers[0]!);
    const entries = layers.map((layer) => ({
        path: `drawable/${layer.resourceName}.xml`,
        data: withNewline(layer.outcome.xml),
    }));
    return { filename: 'drawables.zip', mimeType: 'application/zip', data: createZip(entries, modified) };
}

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

/** The status line above the results. */
export function statusText(state: UiState): { text: string; kind: 'info' | 'ok' | 'warn' | 'error' } {
    const skipped =
        state.truncated > 0 ? ` (${plural(state.truncated, 'more layer')} not exported: limit reached)` : '';
    if (state.phase === 'waiting')
        return { text: 'Select one or more layers (frames, components, vectors) to convert them.', kind: 'info' };
    if (state.phase === 'exporting')
        return { text: `Exporting ${plural(state.exportingCount, 'layer')} from Figma…`, kind: 'info' };
    const done = state.layers.filter((layer) => layer.outcome).length;
    if (state.phase === 'converting')
        return { text: `Converting ${done}/${state.layers.length}…${skipped}`, kind: 'info' };
    const failed = state.layers.filter((layer) => layer.outcome && layer.outcome.status !== 'ok').length;
    const converted = convertedLayers(state);
    const warned = converted.filter((layer) => layer.outcome.warnings.length > 0).length;
    const parts = [`${converted.length}/${state.layers.length} converted`];
    if (warned) parts.push(`${warned} with warnings`);
    if (failed) parts.push(`${failed} failed`);
    return { text: parts.join(', ') + skipped + '.', kind: failed ? 'error' : warned || skipped ? 'warn' : 'ok' };
}

/** One line describing a layer's outcome, for the list and the detail view. */
export function outcomeSummary(outcome: Outcome | null): string {
    if (!outcome) return 'Waiting…';
    if (outcome.status === 'ok') {
        const count = outcome.warnings.length;
        return `API ${outcome.minSdk}+, ${count ? plural(count, 'warning') : 'no warnings'}`;
    }
    if (outcome.status === 'superseded') return 'Cancelled.';
    return outcome.status === 'error' ? describeError(outcome) : outcome.message;
}
