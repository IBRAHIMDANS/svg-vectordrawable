// Page wiring: reads the input and the options, runs the conversion through core.js (in a
// worker) and renders the outcome. Every node is built with createElement / textContent, and both
// previews are `<img>` data URLs, so neither the user's SVG nor the converter output is ever parsed
// as HTML in this document.
import { MAX_INPUT_BYTES, buildOptions, createConverter, describeError, svgDataUrl } from './core.js';

const EXAMPLE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="24" y2="24" gradientUnits="userSpaceOnUse">
      <stop stop-color="#504E9C"/>
      <stop offset="1" stop-color="#07B8D8"/>
    </linearGradient>
  </defs>
  <rect x="2" y="2" width="20" height="20" rx="5" fill="url(#g)"/>
  <circle cx="12" cy="12" r="4" fill="none" stroke="#FFFFFF" stroke-width="2"/>
  <text x="4" y="21" font-size="3" fill="#FFFFFF">Text</text>
</svg>
`;

const DEBOUNCE_MS = 250;

const el = {
    input: document.getElementById('svg-input'),
    dropZone: document.getElementById('drop-zone'),
    fileInput: document.getElementById('file-input'),
    exampleButton: document.getElementById('example-button'),
    clearButton: document.getElementById('clear-button'),
    settings: document.getElementById('settings'),
    strict: document.getElementById('opt-strict'),
    currentColor: document.getElementById('opt-current-color'),
    floatPrecision: document.getElementById('opt-float-precision'),
    minSdk: document.getElementById('opt-min-sdk'),
    tint: document.getElementById('opt-tint'),
    status: document.getElementById('status'),
    output: document.getElementById('xml-output'),
    copyButton: document.getElementById('copy-button'),
    warnings: document.getElementById('warnings'),
    sourcePreview: document.getElementById('source-preview'),
    vdPreview: document.getElementById('vd-preview'),
};

const converter = createConverter(() => new Worker(new URL('worker.js', import.meta.url)));
let debounceTimer;

function setStatus(text, kind = 'info') {
    el.status.textContent = text;
    el.status.dataset.kind = kind;
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

function renderWarnings(warnings) {
    const items = warnings.map((warning) => {
        const li = document.createElement('li');
        const code = document.createElement('code');
        code.textContent = warning.code;
        const category = document.createElement('span');
        category.className = 'badge';
        category.dataset.category = warning.category || '';
        category.textContent = warning.category || 'unknown';
        const message = document.createElement('span');
        message.textContent = warning.message;
        li.append(code, ' ', category, ' ', message);
        return li;
    });
    if (items.length === 0) {
        const li = document.createElement('li');
        li.className = 'empty';
        li.textContent = 'None: the drawable represents the SVG faithfully.';
        items.push(li);
    }
    el.warnings.replaceChildren(...items);
}

function resetOutput() {
    el.output.value = '';
    el.copyButton.disabled = true;
    el.warnings.replaceChildren();
    setPreview(el.vdPreview, null, '', 'No drawable yet.');
}

function render(outcome) {
    if (outcome.status === 'ok') {
        el.output.value = outcome.xml;
        el.copyButton.disabled = false;
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
        return;
    }
    resetOutput();
    setStatus(describeError(outcome), 'error');
    setPreview(el.vdPreview, null, '', outcome.status === 'timeout' ? 'Conversion timed out.' : 'Conversion failed.');
}

async function run() {
    const svg = el.input.value;
    setPreview(el.sourcePreview, svg.trim() ? svg : null, 'The source SVG', 'No SVG yet.');
    if (!svg.trim()) {
        resetOutput();
        setStatus('Paste or drop an SVG to start.');
        return;
    }
    if (new Blob([svg]).size > MAX_INPUT_BYTES) {
        resetOutput();
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
    const outcome = await converter.convert(svg, options, { applyTint: Boolean(options.tint) });
    if (outcome.status !== 'superseded') render(outcome);
}

function schedule(delay = DEBOUNCE_MS) {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(run, delay);
}

async function loadFile(file) {
    if (file.size > MAX_INPUT_BYTES) {
        setStatus(`${file.name} is larger than ${MAX_INPUT_BYTES / 1024 / 1024} MB: use the CLI instead.`, 'error');
        return;
    }
    el.input.value = await file.text();
    schedule(0);
}

function copyXml() {
    const restore = () => (el.copyButton.textContent = 'Copy XML');
    navigator.clipboard.writeText(el.output.value).then(
        () => {
            el.copyButton.textContent = 'Copied';
            setTimeout(restore, 1500);
        },
        () => {
            el.output.focus();
            el.output.select();
            setStatus('Copy blocked by the browser: the XML is selected, press Ctrl+C (or Cmd+C).', 'warn');
        },
    );
}

el.input.addEventListener('input', () => schedule());
el.settings.addEventListener('input', () => schedule());
el.settings.addEventListener('change', () => schedule(0));
el.exampleButton.addEventListener('click', () => {
    el.input.value = EXAMPLE_SVG;
    schedule(0);
});
el.clearButton.addEventListener('click', () => {
    el.input.value = '';
    el.input.focus();
    schedule(0);
});
el.fileInput.addEventListener('change', () => {
    const [file] = el.fileInput.files;
    if (file) loadFile(file);
    el.fileInput.value = '';
});
el.copyButton.addEventListener('click', copyXml);

// A file dropped anywhere else must not navigate away from the page.
window.addEventListener('dragover', (event) => event.preventDefault());
window.addEventListener('drop', (event) => event.preventDefault());
el.dropZone.addEventListener('dragover', (event) => {
    event.preventDefault();
    el.dropZone.classList.add('dragging');
});
el.dropZone.addEventListener('dragleave', () => el.dropZone.classList.remove('dragging'));
el.dropZone.addEventListener('drop', (event) => {
    event.preventDefault();
    el.dropZone.classList.remove('dragging');
    const [file] = event.dataTransfer.files;
    if (file) {
        loadFile(file);
        return;
    }
    const text = event.dataTransfer.getData('text/plain');
    if (text) {
        el.input.value = text;
        schedule(0);
    }
});

el.input.value = EXAMPLE_SVG;
schedule(0);
