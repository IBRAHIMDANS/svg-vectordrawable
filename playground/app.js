// Page wiring: reads the input and the options, runs the conversion through core.js (in a
// worker) and renders the outcome. Every node is built with createElement / textContent, and both
// previews are `<img>` data URLs, so neither the user's SVG nor the converter output is ever parsed
// as HTML in this document.
import {
    MAX_HIGHLIGHT_CHARS,
    MAX_INPUT_BYTES,
    CLI_SNIPPETS,
    FORMATS,
    buildOptions,
    createConverter,
    describeApiLevel,
    describeConversion,
    describeError,
    describeSize,
    effectiveFormat,
    describeUnresolvedColors,
    formatBytes,
    isVectorDrawable,
    outputFileName,
    parsePreviewColors,
    resourceFileName,
    svgDataUrl,
    tokenizeXml,
    warningHelpUrl,
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
    outputTitle: document.getElementById('output-title'),
    inputTitle: document.getElementById('input-title'),
    sourceCaption: document.getElementById('source-caption'),
    formatRadios: document.querySelectorAll('input[name="format"]'),
    copyButton: document.getElementById('copy-button'),
    downloadButton: document.getElementById('download-button'),
    warnings: document.getElementById('warnings'),
    warningsCount: document.getElementById('warnings-count'),
    previews: document.getElementById('previews'),
    sourcePreview: document.getElementById('source-preview'),
    vdPreview: document.getElementById('vd-preview'),
    apiNote: document.getElementById('api-note'),
    cliSnippet: document.getElementById('cli-snippet'),
    resNames: document.querySelectorAll('.res-name'),
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
let currentOutput = '';
let currentFormat = 'vector';
let currentKotlinName = '';
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

/**
 * Shows the output: XML and SVG with syntax colors (one `<span>` per token), Kotlin and very large
 * outputs as plain text.
 */
function renderOutput(text, format = currentFormat) {
    currentOutput = text;
    el.copyButton.disabled = !text;
    el.downloadButton.disabled = !text;
    if (format === 'compose' || text.length > MAX_HIGHLIGHT_CHARS) {
        el.outputCode.textContent = text;
        el.output.scrollTop = 0;
        return;
    }
    const nodes = tokenizeXml(text).map(({ type, text }) => {
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
        const help = warningHelpUrl(warning.code);
        if (help) {
            const link = document.createElement('a');
            link.className = 'warning-help';
            link.href = help;
            link.target = '_blank';
            link.rel = 'noopener';
            link.textContent = 'What it means and how to fix it';
            li.append(link);
        }
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
    renderOutput('');
    el.outputMeta.textContent = '';
    el.warnings.replaceChildren(emptyWarningsItem(warningsText));
    el.warningsCount.hidden = true;
    setPreview(el.vdPreview, null, '', 'No drawable yet.');
    renderUnresolvedColors([]);
    el.apiNote.textContent = describeApiLevel(null);
}

function render(outcome) {
    if (outcome.status === 'ok') {
        currentFormat = outcome.format;
        currentKotlinName = outcome.kotlinName ?? '';
        el.outputTitle.textContent = FORMATS[outcome.format].title;
        renderOutput(outcome.output, outcome.format);
        el.outputMeta.textContent = [describeSize(outcome.xml ?? el.input.value), formatBytes(byteSize(outcome.output))]
            .filter(Boolean)
            .join(' · ');
        renderWarnings(outcome.warnings);
        if (outcome.input === 'vectordrawable') {
            setPreview(el.sourcePreview, outcome.sourcePreview, 'The source VectorDrawable', 'No preview.');
            const count = outcome.warnings.length;
            setStatus(
                `Read as an existing VectorDrawable (the SVG options do not apply)${count ? `: ${count} warning${count === 1 ? '' : 's'}.` : '.'}`,
                count ? 'warn' : 'ok',
            );
        } else {
            const status = describeConversion(outcome.minSdk, outcome.warnings);
            setStatus(status.text, status.tone);
        }
        setPreview(
            el.vdPreview,
            outcome.preview,
            'The generated VectorDrawable, rendered back to SVG',
            `No preview: ${outcome.previewError || 'unknown error'}`,
        );
        renderUnresolvedColors(outcome.unresolvedColors);
        if (outcome.minSdk) el.apiNote.textContent = describeApiLevel(outcome.minSdk);
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
    const vectorInput = isVectorDrawable(svg);
    const format = syncFormatSwitch(vectorInput);
    el.inputTitle.textContent = vectorInput ? 'VectorDrawable' : 'SVG';
    el.sourceCaption.textContent = vectorInput ? 'Source drawable' : 'Source SVG';
    // A VectorDrawable is not an image a browser can show: the worker renders it.
    if (!vectorInput) setPreview(el.sourcePreview, hasInput ? svg : null, 'The source SVG', 'No SVG yet.');
    else setPreview(el.sourcePreview, null, '', 'Reading the drawable…');
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
    const name = sourceName.replace(/\.(svg|xml)$/i, '') || 'Icon';
    const outcome = await converter.convert(svg, options, preview, { format, name });
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
    // The "Use the result" snippets name the resource the Download button writes.
    const resource = resourceFileName(sourceName.replace(/\.xml$/i, '')).replace(/\.xml$/, '');
    for (const span of el.resNames) span.textContent = resource;
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
    navigator.clipboard.writeText(currentOutput).then(
        () => flashLabel(el.copyButton, 'Copied'),
        () => {
            el.output.focus();
            selectOutput();
            setStatus('Copy blocked by the browser: the output is selected, press Ctrl+C (or Cmd+C).', 'warn');
        },
    );
}

function downloadXml() {
    const url = URL.createObjectURL(new Blob([currentOutput], { type: FORMATS[currentFormat].type }));
    const link = document.createElement('a');
    link.href = url;
    link.download = outputFileName(currentFormat, sourceName, currentKotlinName);
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

// Output format: the choice is remembered; the switch shows the format the input allows.
const FORMAT_KEY = 'svgvd-playground-format';
let requestedFormat = 'vector';
try {
    const saved = localStorage.getItem(FORMAT_KEY);
    if (saved && Object.hasOwn(FORMATS, saved)) requestedFormat = saved;
} catch {
    // Storage blocked (private window): the default format.
}

/** Checks and enables the format options for the input; returns the format to produce. */
function syncFormatSwitch(vectorInput) {
    const format = effectiveFormat(requestedFormat, vectorInput);
    for (const radio of el.formatRadios) {
        // An SVG becomes a drawable, a drawable becomes an SVG: the other way round is not offered.
        radio.disabled = vectorInput ? radio.value === 'vector' : radio.value === 'svg';
        radio.closest('label').title = radio.disabled
            ? vectorInput
                ? 'The input is already a VectorDrawable'
                : 'SVG output is for a VectorDrawable input'
            : '';
        radio.checked = radio.value === format;
    }
    return format;
}

for (const radio of el.formatRadios) {
    radio.addEventListener('change', () => {
        requestedFormat = radio.value;
        try {
            localStorage.setItem(FORMAT_KEY, requestedFormat);
        } catch {
            // Storage blocked: the choice only lasts for this visit.
        }
        schedule(0);
    });
}

// Command-line card: the commands of the chosen package manager, remembered for the next visit.
const PM_KEY = 'svgvd-playground-pm';
function showPackageManager(pm) {
    if (!Object.hasOwn(CLI_SNIPPETS, pm)) return;
    el.cliSnippet.textContent = CLI_SNIPPETS[pm];
    const radio = document.querySelector(`input[name="pm"][value="${pm}"]`);
    if (radio) radio.checked = true;
}
for (const radio of document.querySelectorAll('input[name="pm"]')) {
    radio.addEventListener('change', () => {
        showPackageManager(radio.value);
        try {
            localStorage.setItem(PM_KEY, radio.value);
        } catch {
            // Storage blocked (private window): the choice only lasts for this visit.
        }
    });
}
try {
    showPackageManager(localStorage.getItem(PM_KEY) ?? 'npm');
} catch {
    showPackageManager('npm');
}

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
