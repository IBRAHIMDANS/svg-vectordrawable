// Page wiring: reads the input and the options, runs the conversion through core.js (in a
// worker) and renders the outcome. Every node is built with createElement / textContent, and both
// previews are `<img>` data URLs, so neither the user's SVG nor the converter output is ever parsed
// as HTML in this document.
import {
    MAX_HIGHLIGHT_CHARS,
    MAX_INPUT_BYTES,
    buildOptions,
    createConverter,
    describeError,
    describeSize,
    describeUnresolvedColors,
    formatBytes,
    parsePreviewColors,
    resourceFileName,
    svgDataUrl,
    tokenizeXml,
} from './core.js';
import { EXAMPLES } from './examples.js';

const DEBOUNCE_MS = 250;
const FEEDBACK_MS = 1500;

const el = {
    input: document.getElementById('svg-input'),
    inputMeta: document.getElementById('input-meta'),
    dropOverlay: document.getElementById('drop-overlay'),
    fileInput: document.getElementById('file-input'),
    examples: document.getElementById('examples'),
    clearButton: document.getElementById('clear-button'),
    settings: document.getElementById('settings'),
    strict: document.getElementById('opt-strict'),
    currentColor: document.getElementById('opt-current-color'),
    floatPrecision: document.getElementById('opt-float-precision'),
    minSdk: document.getElementById('opt-min-sdk'),
    tint: document.getElementById('opt-tint'),
    previewColors: document.getElementById('opt-preview-colors'),
    status: document.getElementById('status'),
    output: document.getElementById('xml-output'),
    outputCode: document.getElementById('xml-code'),
    outputMeta: document.getElementById('output-meta'),
    copyButton: document.getElementById('copy-button'),
    downloadButton: document.getElementById('download-button'),
    warnings: document.getElementById('warnings'),
    warningsCount: document.getElementById('warnings-count'),
    previews: document.getElementById('previews'),
    sourcePreview: document.getElementById('source-preview'),
    vdPreview: document.getElementById('vd-preview'),
};

// Lists the color references the drawable preview drew in gray; built here, under both previews
// (full width), so that the two captions stay level whatever the note's length.
el.unresolvedColors = document.createElement('p');
el.unresolvedColors.className = 'preview-note';
el.unresolvedColors.hidden = true;
el.previews.after(el.unresolvedColors);
// Ends the note: the fix for a gray reference is a pair in the Preview colors field.
el.previewColorsLink = document.createElement('button');
el.previewColorsLink.type = 'button';
el.previewColorsLink.className = 'link-button';
el.previewColorsLink.textContent = 'Set preview colors';
el.previewColorsLink.setAttribute('aria-controls', 'opt-preview-colors');

const converter = createConverter(() => new Worker(new URL('worker.js', import.meta.url)));
let debounceTimer;
/** The XML on screen (the highlighted `<code>` is only its rendering). */
let currentXml = '';
/** Name of the file the input came from, used to name the download; `''` for pasted markup. */
let sourceName = '';

const byteSize = (text) => new Blob([text]).size;

function setStatus(text, kind = 'info') {
    el.status.textContent = text;
    el.status.dataset.kind = kind;
}

/** Shows `text` on `button` for a moment, then its usual label back. */
function flashLabel(button, text) {
    const label = button.dataset.label || button.textContent;
    button.dataset.label = label;
    button.textContent = text;
    setTimeout(() => (button.textContent = label), FEEDBACK_MS);
}

/** Shows an `<img>` of `svg` in `container`, or `fallback` text when there is nothing to show. */
function setPreview(container, svg, alt, fallback) {
    if (!svg) {
        const note = document.createElement('p');
        note.className = 'preview-note';
        note.textContent = fallback;
        container.replaceChildren(note);
        return;
    }
    const img = document.createElement('img');
    img.alt = alt;
    img.addEventListener('error', () => setPreview(container, null, alt, 'The browser cannot render this SVG.'));
    img.src = svgDataUrl(svg);
    container.replaceChildren(img);
}

/**
 * Same text as describeUnresolvedColors, with each reference in its own `<code>` so that a line
 * never breaks inside `?attr/…`. The `,` that follows a reference shares its inline-block wrapper,
 * so that it stays right after the reference's last character even when the reference wraps.
 */
function renderUnresolvedColors(references) {
    const text = describeUnresolvedColors(references);
    const prefix = text.slice(0, text.length - references.join(', ').length);
    const parts = references.flatMap((reference, i) => {
        const item = document.createElement('span');
        item.className = 'color-reference';
        const code = document.createElement('code');
        code.textContent = reference;
        item.append(code);
        if (i < references.length - 1) item.append(',');
        return i ? [' ', item] : [item];
    });
    el.unresolvedColors.replaceChildren(prefix, ...parts, ' ', el.previewColorsLink);
    el.unresolvedColors.hidden = !text;
}

/** Takes the user from the note to the field that gives the gray references a preview color. */
function focusPreviewColors() {
    el.previewColors.scrollIntoView({ block: 'center' });
    el.previewColors.focus({ preventScroll: true });
}

/** Shows the XML with syntax colors: one `<span>` per token, plain text for very large outputs. */
function renderXml(xml) {
    currentXml = xml;
    el.copyButton.disabled = !xml;
    el.downloadButton.disabled = !xml;
    if (xml.length > MAX_HIGHLIGHT_CHARS) {
        el.outputCode.textContent = xml;
        return;
    }
    const nodes = tokenizeXml(xml).map(({ type, text }) => {
        if (type === 'text') return text;
        const span = document.createElement('span');
        span.className = `tok-${type}`;
        span.textContent = text;
        return span;
    });
    el.outputCode.replaceChildren(...nodes);
    el.output.scrollTop = 0;
}

function emptyWarningsItem(text, kind) {
    const li = document.createElement('li');
    li.className = 'empty';
    if (kind) li.dataset.kind = kind;
    li.textContent = text;
    return li;
}

function renderWarnings(warnings) {
    const items = warnings.map((warning) => {
        const li = document.createElement('li');
        li.dataset.category = warning.category || '';
        const code = document.createElement('code');
        code.textContent = warning.code;
        const category = document.createElement('span');
        category.className = 'badge';
        category.dataset.category = warning.category || '';
        category.textContent = warning.category || 'unknown';
        const message = document.createElement('p');
        message.textContent = warning.message;
        li.append(code, ' ', category, message);
        return li;
    });
    if (items.length === 0) {
        items.push(emptyWarningsItem('None: the drawable represents the SVG faithfully.', 'ok'));
    }
    el.warnings.replaceChildren(...items);
    el.warningsCount.textContent = String(warnings.length);
    el.warningsCount.hidden = warnings.length === 0;
}

function resetOutput(warningsText) {
    renderXml('');
    el.outputMeta.textContent = '';
    el.warnings.replaceChildren(emptyWarningsItem(warningsText));
    el.warningsCount.hidden = true;
    setPreview(el.vdPreview, null, '', 'No drawable yet.');
    renderUnresolvedColors([]);
}

function render(outcome) {
    if (outcome.status === 'ok') {
        renderXml(outcome.xml);
        el.outputMeta.textContent = [describeSize(outcome.xml), formatBytes(byteSize(outcome.xml))]
            .filter(Boolean)
            .join(' · ');
        renderWarnings(outcome.warnings);
        const count = outcome.warnings.length;
        setStatus(
            `Converted: needs API ${outcome.minSdk}+, ${count} warning${count === 1 ? '' : 's'}.`,
            count ? 'warn' : 'ok',
        );
        setPreview(
            el.vdPreview,
            outcome.preview,
            'The generated VectorDrawable, rendered back to SVG',
            `No preview: ${outcome.previewError || 'unknown error'}`,
        );
        renderUnresolvedColors(outcome.unresolvedColors);
        return;
    }
    resetOutput('No drawable: see the error under the XML pane.');
    setStatus(describeError(outcome), 'error');
    setPreview(el.vdPreview, null, '', outcome.status === 'timeout' ? 'Conversion timed out.' : 'Conversion failed.');
}

async function run() {
    const svg = el.input.value;
    const hasInput = Boolean(svg.trim());
    el.inputMeta.textContent = hasInput ? formatBytes(byteSize(svg)) : '';
    setPreview(el.sourcePreview, hasInput ? svg : null, 'The source SVG', 'No SVG yet.');
    if (!hasInput) {
        resetOutput('Warnings show up here once an SVG is converted.');
        setStatus('Paste or drop an SVG to start.');
        return;
    }
    if (byteSize(svg) > MAX_INPUT_BYTES) {
        resetOutput('No drawable: see the error under the XML pane.');
        setStatus(`This SVG is larger than ${MAX_INPUT_BYTES / 1024 / 1024} MB: use the CLI instead.`, 'error');
        return;
    }
    const options = buildOptions({
        strict: el.strict.value,
        currentColor: el.currentColor.value,
        floatPrecision: el.floatPrecision.value,
        minSdk: el.minSdk.value,
        tint: el.tint.value,
    });
    setStatus('Converting…');
    const preview = { applyTint: Boolean(options.tint), colors: parsePreviewColors(el.previewColors.value) };
    const outcome = await converter.convert(svg, options, preview);
    if (outcome.status !== 'superseded') render(outcome);
}

function schedule(delay = DEBOUNCE_MS) {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(run, delay);
}

/** Replaces the input. `exampleId` marks the sample it came from, if any, as selected. */
function setInput(svg, name = '', exampleId = '') {
    el.input.value = svg;
    sourceName = name;
    for (const chip of el.examples.children) chip.setAttribute('aria-pressed', String(chip.dataset.id === exampleId));
    schedule(0);
}

async function loadFile(file) {
    if (file.size > MAX_INPUT_BYTES) {
        setStatus(`${file.name} is larger than ${MAX_INPUT_BYTES / 1024 / 1024} MB: use the CLI instead.`, 'error');
        return;
    }
    setInput(await file.text(), file.name);
}

function selectOutput() {
    const range = document.createRange();
    range.selectNodeContents(el.outputCode);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
}

function copyXml() {
    navigator.clipboard.writeText(currentXml).then(
        () => flashLabel(el.copyButton, 'Copied'),
        () => {
            el.output.focus();
            selectOutput();
            setStatus('Copy blocked by the browser: the XML is selected, press Ctrl+C (or Cmd+C).', 'warn');
        },
    );
}

function downloadXml() {
    const url = URL.createObjectURL(new Blob([currentXml], { type: 'application/xml' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = resourceFileName(sourceName);
    link.click();
    URL.revokeObjectURL(url);
    setStatus(`Downloaded ${link.download}.`, 'ok');
}

for (const example of EXAMPLES) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.dataset.id = example.id;
    chip.textContent = example.label;
    chip.setAttribute('aria-pressed', 'false');
    chip.addEventListener('click', () => setInput(example.svg, example.fileName, example.id));
    el.examples.append(chip);
}

el.input.addEventListener('input', () => {
    // Edited markup is no longer the sample (or the file) it started from.
    for (const chip of el.examples.children) chip.setAttribute('aria-pressed', 'false');
    schedule();
});
el.settings.addEventListener('input', () => schedule());
el.settings.addEventListener('change', () => schedule(0));
el.clearButton.addEventListener('click', () => {
    setInput('');
    el.input.focus();
});
el.fileInput.addEventListener('change', () => {
    const [file] = el.fileInput.files;
    if (file) loadFile(file);
    el.fileInput.value = '';
});
el.previewColorsLink.addEventListener('click', focusPreviewColors);
el.copyButton.addEventListener('click', copyXml);
el.downloadButton.addEventListener('click', downloadXml);

for (const radio of document.querySelectorAll('input[name="preview-bg"]')) {
    radio.addEventListener('change', () => (el.previews.dataset.bg = radio.value));
}

for (const button of document.querySelectorAll('.copy-snippet')) {
    button.addEventListener('click', () => {
        const text = button.closest('.snippet').querySelector('code').textContent;
        navigator.clipboard.writeText(text).then(
            () => flashLabel(button, 'Copied'),
            () => flashLabel(button, 'Select and copy'),
        );
    });
}

// The whole page is a drop target: a file dropped anywhere is converted instead of opened.
let dragDepth = 0;
function endDrag() {
    dragDepth = 0;
    el.dropOverlay.hidden = true;
}
const hasFiles = (event) => event.dataTransfer.types.includes('Files');
window.addEventListener('dragenter', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth += 1;
    el.dropOverlay.hidden = false;
});
window.addEventListener('dragleave', (event) => {
    if (!hasFiles(event)) return;
    dragDepth -= 1;
    if (dragDepth <= 0) endDrag();
});
window.addEventListener('dragover', (event) => event.preventDefault());
window.addEventListener('drop', (event) => {
    endDrag();
    const [file] = event.dataTransfer.files;
    // Text dragged into the editor is inserted by the browser, at the caret.
    if (!file && event.target === el.input) return;
    event.preventDefault();
    if (file) {
        loadFile(file);
        return;
    }
    const text = event.dataTransfer.getData('text/plain');
    if (text) setInput(text);
});

const [firstExample] = EXAMPLES;
setInput(firstExample.svg, firstExample.fileName, firstExample.id);
