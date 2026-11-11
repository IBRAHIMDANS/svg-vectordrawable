# Playground

The online converter published on GitHub Pages: a static page with no framework and no build step
of its own. It runs the lightweight browser build (`dist/browser-lite.global.js`, global `svgvd`)
in a Web Worker, so nothing is uploaded and a slow input is stopped after 5 s without freezing the
page.

| File             | Role                                                                          |
| ---------------- | ----------------------------------------------------------------------------- |
| `index.html`     | Markup (strict CSP: same-origin scripts only, `data:` images for previews)    |
| `app.js`         | DOM wiring: input, drag and drop, options, highlighted output, previews       |
| `core.js`        | DOM-free logic: worker with timeout and respawn, option parsing, XML tokens   |
| `examples.js`    | Sample SVGs offered under the input (each one is converted by the smoke test) |
| `worker.js`      | Classic worker: `importScripts('browser-lite.global.js')`, convert + preview  |
| `style.css`      | Responsive layout, light / dark via `prefers-color-scheme`                    |
| `favicon.svg`    | Tab icon, same mark as the header                                             |
| `smoke-test.mjs` | `node --test` smoke test of the worker and `core.js` against `dist/`          |

## Convention

`browser-lite.global.js` sits **next to** `index.html`. The Pages workflow
(`.github/workflows/pages.yml`) copies the page files and `dist/browser-lite.global.js` into the same
folder (a new file must be added to its `cp` lines, which the smoke test checks); locally, copy the build into `playground/` (git-ignored).

## Run locally

```sh
pnpm build
cp dist/browser-lite.global.js playground/
python3 -m http.server -d playground 8080   # or any static server
# open http://localhost:8080
```

Opening `index.html` from `file://` does not work: browsers refuse to start a worker from a file URL.

## Test

```sh
pnpm build
node --test playground/smoke-test.mjs
```
