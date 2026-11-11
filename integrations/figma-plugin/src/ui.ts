// UI entry (inlined into dist/ui.html): renders the controller's state and wires the buttons.
// Every node is built with createElement / textContent and both previews are `<img>` data URLs,
// so neither the exported SVG nor the converter output is ever parsed as HTML in this document.
import { runConversion, svgDataUrl, type Outcome, type SvgvdLib } from './conversion.ts';
import { createConverter, type WorkerLike } from './converter.ts';
import {
    createUiController,
    layerDownload,
    outcomeSummary,
    selectionDownload,
    statusText,
    type DownloadFile,
    type LayerView,
    type UiState,
} from './ui-controller.ts';

/** dist/worker.js, injected as a string by scripts/build.ts. */
declare const __WORKER_SOURCE__: string;

const byId = <T extends HTMLElement>(id: string): T => {
    const element = document.getElementById(id);
    if (!element) throw new Error(`ui.html is missing #${id}`);
    return element as T;
};

const el = {
    status: byId<HTMLParagraphElement>('status'),
    refresh: byId<HTMLButtonElement>('refresh'),
    downloadAll: byId<HTMLButtonElement>('download-all'),
    layers: byId<HTMLUListElement>('layers'),
    detail: byId<HTMLElement>('detail'),
    title: byId<HTMLHeadingElement>('layer-title'),
    summary: byId<HTMLParagraphElement>('layer-summary'),
    xml: byId<HTMLTextAreaElement>('xml'),
    copy: byId<HTMLButtonElement>('copy'),
    downloadLayer: byId<HTMLButtonElement>('download-layer'),
    warnings: byId<HTMLUListElement>('warnings'),
    sourcePreview: byId<HTMLDivElement>('source-preview'),
    vdPreview: byId<HTMLDivElement>('vd-preview'),
};

// The converter runs in a worker started from the inlined bundle: no file and no network involved.
const bundleSource = byId<HTMLScriptElement>('svgvd-bundle').textContent ?? '';
let workerUrl: string | undefined;
const converter = createConverter({
    createWorker: () => {
        workerUrl ??= URL.createObjectURL(
            new Blob([bundleSource, '\n;\n', __WORKER_SOURCE__], { type: 'text/javascript' }),
        );
        // A DOM Worker types its handlers with MessageEvent / ErrorEvent: a superset of WorkerLike's.
        return new Worker(workerUrl) as unknown as WorkerLike;
    },
    inline: (request) => {
        const lib = (globalThis as { svgvd?: SvgvdLib }).svgvd;
        return lib
            ? runConversion(lib, request)
            : { status: 'error', message: 'The converter bundle did not load (rebuild the plugin).' };
    },
});

function outcomeKind(outcome: Outcome | null): string {
    if (!outcome) return 'pending';
    if (outcome.status !== 'ok') return 'error';
    return outcome.warnings.length ? 'warn' : 'ok';
}

/** Shows an `<img>` of `svg` in `container`, or `fallback` text when there is nothing to show. */
function setPreview(container: HTMLElement, svg: string | null, alt: string, fallback: string): void {
    if (!svg) {
        const note = document.createElement('p');
        note.className = 'preview-note';
        note.textContent = fallback;
        container.replaceChildren(note);
        return;
    }
    const img = document.createElement('img');
    img.alt = alt;
    img.addEventListener('error', () => setPreview(container, null, alt, 'This SVG cannot be rendered here.'));
    img.src = svgDataUrl(svg);
    container.replaceChildren(img);
}

function renderWarnings(outcome: Outcome | null): void {
    if (outcome?.status !== 'ok') {
        el.warnings.replaceChildren();
        return;
    }
    const items = outcome.warnings.map((warning) => {
        const li = document.createElement('li');
        const code = document.createElement('code');
        code.textContent = warning.code;
        const category = document.createElement('span');
        category.className = 'badge';
        category.dataset.category = warning.category ?? '';
        category.textContent = warning.category ?? 'unknown';
        const message = document.createElement('span');
        message.textContent = warning.message;
        li.append(code, ' ', category, ' ', message);
        return li;
    });
    if (items.length === 0) {
        const li = document.createElement('li');
        li.className = 'empty';
        li.textContent = 'None: the drawable represents the layer faithfully.';
        items.push(li);
    }
    el.warnings.replaceChildren(...items);
}

function renderList(state: UiState): void {
    const items = state.layers.map((layer, index) => {
        const li = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'layer';
        button.dataset.kind = outcomeKind(layer.outcome);
        if (index === state.selected) button.setAttribute('aria-current', 'true');
        const name = document.createElement('span');
        name.className = 'layer-name';
        name.textContent = layer.layerName;
        const file = document.createElement('code');
        file.textContent = `${layer.resourceName}.xml`;
        const summary = document.createElement('span');
        summary.className = 'layer-summary';
        summary.textContent = outcomeSummary(layer.outcome);
        button.append(name, file, summary);
        button.addEventListener('click', () => controller.select(index));
        li.append(button);
        return li;
    });
    el.layers.replaceChildren(...items);
}

let shownLayer: LayerView | undefined;
let shownOutcome: Outcome | null | undefined;

function renderDetail(layer: LayerView | undefined): void {
    el.detail.hidden = !layer;
    // Re-render only what changed: re-creating the previews on every progress tick would flicker.
    if (!layer || (layer === shownLayer && layer.outcome === shownOutcome)) return;
    shownLayer = layer;
    shownOutcome = layer.outcome;
    const { outcome } = layer;
    el.title.textContent = `${layer.layerName} → ${layer.resourceName}.xml`;
    el.summary.textContent = outcomeSummary(outcome);
    el.summary.dataset.kind = outcomeKind(outcome);
    el.xml.value = outcome?.status === 'ok' ? outcome.xml : '';
    el.copy.disabled = outcome?.status !== 'ok';
    el.downloadLayer.disabled = outcome?.status !== 'ok';
    renderWarnings(outcome);
    setPreview(el.sourcePreview, layer.sourceSvg, 'The layer as Figma exports it', 'No SVG export.');
    setPreview(
        el.vdPreview,
        outcome?.status === 'ok' ? outcome.preview : null,
        'The generated VectorDrawable, rendered back to SVG',
        outcome?.status === 'ok'
            ? `No preview: ${outcome.previewError ?? 'unknown error'}`
            : outcome
              ? 'Conversion failed.'
              : 'Converting…',
    );
}

function render(state: UiState): void {
    const { text, kind } = statusText(state);
    el.status.textContent = text;
    el.status.dataset.kind = kind;
    const all = state.phase === 'done' ? selectionDownload(state) : null;
    el.downloadAll.disabled = !all;
    el.downloadAll.textContent = all?.filename.endsWith('.zip') ? 'Download all (.zip)' : 'Download';
    renderList(state);
    renderDetail(state.layers[state.selected]);
}

const controller = createUiController({
    post: (message) => parent.postMessage({ pluginMessage: message }, '*'),
    converter,
    render,
});

function save(file: DownloadFile | null): void {
    if (!file) return;
    const url = URL.createObjectURL(new Blob([file.data as BlobPart], { type: file.mimeType }));
    const link = document.createElement('a');
    link.href = url;
    link.download = file.filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function copyXml(): void {
    // The Clipboard API is not available in the plugin iframe: select the text and use execCommand.
    el.xml.focus();
    el.xml.select();
    let copied: boolean;
    try {
        copied = document.execCommand('copy');
    } catch {
        copied = false;
    }
    if (copied) controller.notify('VectorDrawable XML copied');
    else el.status.textContent = 'Copy blocked: the XML is selected, press Ctrl+C (or Cmd+C).';
}

el.refresh.addEventListener('click', () => controller.refresh());
el.copy.addEventListener('click', copyXml);
el.downloadLayer.addEventListener('click', () => {
    const layer = controller.state.layers[controller.state.selected];
    if (layer) save(layerDownload(layer));
});
el.downloadAll.addEventListener('click', () => save(selectionDownload(controller.state)));
window.addEventListener('message', (event: MessageEvent) => {
    const data: unknown = event.data;
    if (typeof data === 'object' && data !== null && 'pluginMessage' in data)
        void controller.handle((data as { pluginMessage: unknown }).pluginMessage);
});

render(controller.state);
controller.start();
