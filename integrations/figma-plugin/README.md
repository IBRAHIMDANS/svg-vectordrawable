# Figma plugin: SVG to VectorDrawable

Converts the selected Figma layers to Android **VectorDrawable** XML with
[svg-vectordrawable](../../README.md) (the lightweight `browser-lite` build), entirely inside
Figma: no server, no network access. For each layer it shows the XML, the warnings (code and
category), the Figma export next to the drawable rendered back to SVG, and lets you copy the XML or
download it (one `.xml`, or a `.zip` of `drawable/<name>.xml` files for several layers).

Figma exports are the case this library is built for: radial / linear gradients with a
`gradientTransform`, frame clips (`clip0_…`) and `#D9D9D9` alpha masks convert exactly where
`svg2vectordrawable` misplaces them.

## How it works

| File                   | Role                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------ |
| `manifest.json`        | Figma manifest: `dist/code.js` + `dist/ui.html`, `networkAccess: none`               |
| `src/main.ts`          | Main thread entry (built to `dist/code.js`)                                          |
| `src/plugin.ts`        | Exports the selection with `node.exportAsync({ format: 'SVG' })`, posts it to the UI |
| `src/ui.ts`            | UI wiring: renders the state with `createElement` / `textContent` only               |
| `src/ui-controller.ts` | DOM-free UI logic: names, conversion loop, downloads, status line                    |
| `src/converter.ts`     | Worker with a 5 s time limit (port of `playground/core.js`), in-page fallback        |
| `src/conversion.ts`    | One conversion: XML + warnings with category + preview (`vectorDrawableToSvg`)       |
| `src/worker.ts`        | Worker body, started from a `blob:` URL (inlined bundle + this file)                 |
| `src/naming.ts`        | `androidResourceName` + `_2`, `_3`… suffixes so that no two layers share a file name |
| `src/zip.ts`           | Store-only ZIP writer (no dependency)                                                |
| `src/messages.ts`      | Message types between the main thread and the UI                                     |
| `src/ui.template.html` | UI markup and CSS (Figma theme colors); the build inlines both scripts into it       |
| `scripts/build.ts`     | Build (tsup, already a devDependency of the repository)                              |

Messages (`src/messages.ts`):

```text
UI -> main  { type: 'ready' }                      UI loaded: export the current selection
UI -> main  { type: 'refresh' }                    export again
UI -> main  { type: 'notify', message, error? }    figma.notify toast
main -> UI  { type: 'exporting', generation, count }
main -> UI  { type: 'selection', generation, layers: [{ id, name, type, svg?: Uint8Array, error? }], truncated }
```

The main thread exports again on every `selectionchange`; a newer `generation` supersedes the
export and the conversions still running for an older one. At most 50 layers are exported at once.
The conversion runs in the UI iframe, in a Web Worker started from a `blob:` URL built from the
inlined bundle; a conversion over 5 s is stopped. If the iframe refuses `blob:` workers, the UI
converts in the page instead (no time limit then). Previews are `<img src="data:image/svg+xml,…">`,
so no SVG is ever parsed as HTML in the plugin UI.

## Build

Requires Node 22.18+ (runs TypeScript directly) and the repository's dependencies.

```sh
# at the repository root
pnpm install
pnpm run build                      # produces dist/browser-lite.global.js, inlined by the plugin

# in integrations/figma-plugin
node scripts/build.ts               # -> dist/code.js and dist/ui.html (git-ignored)
```

## Install for development

1. Build (above).
2. Figma **desktop** app → any design file → menu **Plugins → Development → Import plugin from
   manifest…** → pick `integrations/figma-plugin/manifest.json`.
3. Select one or more layers (frames, components, icons), then **Plugins → Development → SVG to
   VectorDrawable**. Rebuild and re-run the plugin after a change (no hot reload).

**Plugins → Development → Show/Hide console** shows the logs of both the main thread and the UI.

## Test

```sh
# in integrations/figma-plugin (after `pnpm run build` at the root)
node scripts/build.ts && node --test "test/*-test.ts"
../../node_modules/.bin/tsc -p tsconfig.json   # typecheck (local, minimal Figma typings in src/figma.d.ts)
```

The tests run without Figma: naming, ZIP (read back, CRC checked against `node:zlib`, `unzip -t`
when installed), conversion of a Figma-style frame (`test/fixtures/figma-frame-radial.svg`:
transformed radial gradient, frame clip, `#D9D9D9` mask), the worker time limit and fallback, the
main thread against a fake `figma`, and the built `dist/code.js` + `dist/ui.html` wired together
through a fake `figma` / `parent.postMessage` and a small fake DOM, with network APIs that throw.
Test files are named `*-test.ts` so that the root `vitest` run does not collect them.

## Publish to the Figma Community (maintainer)

Done by the maintainer from the Figma desktop app, not by CI:

1. Build as above and check the plugin on a few real files (gradients, masks, components).
2. **Plugins → Development → Manage plugins in development** → the plugin → **Publish**. Figma
   assigns the plugin ID: put it in `manifest.json` (`"id"`, currently a placeholder) and commit it.
3. Fill in the listing (name, description, icon 128×128, cover 1920×1080, support contact) and
   declare that the plugin makes no network request. Figma reviews the plugin before it appears.
4. For an update: rebuild, then **Publish new version** from the same menu.

## Limitations

- Same as the `browser-lite` build: no svgo normalization (`optimize: false`), so inline `<style>`
  CSS is not applied. Figma exports use attributes, which is what this build handles.
- Text is exported outlined (`svgOutlineText: true`); embedded raster images (`<image>`) cannot
  become a VectorDrawable and are reported as warnings. Exports over 2 MB are not converted.
- Effects (shadows, blurs) have no VectorDrawable equivalent and are reported
  (`unsupported-attribute`); blend modes (`mix-blend-mode`) are dropped without a warning.
- Names come from the layer names; there is no rename field. Rename the layer in Figma instead.
- Not verified inside Figma by the automated tests (see `test/`): the `blob:` worker under Figma's
  iframe CSP (falls back to in-page conversion if refused), `data:` image previews, `execCommand`
  copy (falls back to selecting the XML) and `<a download>` downloads, which plugins commonly use.
