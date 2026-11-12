# svg-vectordrawable-mcp

An [MCP](https://modelcontextprotocol.io) server (stdio) that lets an AI assistant convert SVG to
**Android VectorDrawable** XML and preview a VectorDrawable as SVG. It runs the
[`svg-vectordrawable`](https://www.npmjs.com/package/svg-vectordrawable) library (pure JavaScript,
svgo-based: no Android SDK, no JVM), so gradients (including `gradientTransform`), clip paths and
CSS colors are handled, and what a VectorDrawable cannot represent is reported, not silently dropped.

Requires Node.js 20 or later.

## Tools

### `convert`

SVG markup → VectorDrawable XML.

| Argument         | Type                       | Description                                                                                                                 |
| ---------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `svg`            | string (required)          | The SVG document (markup, not a path or URL). At most 2 MB.                                                                 |
| `strict`         | `true`, `false`, `"lossy"` | Fail instead of warning: `true` on lossy or approximated output, `"lossy"` on lossy output only.                            |
| `rules`          | object                     | Severity per warning code (`"off"`, `"warn"`, `"error"`), overriding `strict`, e.g. `{ "opacity-approximated": "warn" }`.   |
| `currentColor`   | string                     | What `currentColor` stands for: a CSS color, or a color reference (`?attr/…`, `@color/…`) emitted as is. Default `#000000`. |
| `colorMap`       | object                     | SVG colors to color references, e.g. `{ "#1A73E8": "@color/brand" }`, so the drawable follows the theme.                    |
| `floatPrecision` | integer 0–20               | Decimal places kept for generated numbers. Default 3.                                                                       |
| `minSdk`         | integer ≥ 1                | The app's `minSdk`: adds a `min-sdk-exceeded` warning when the output needs a higher API level.                             |
| `tint`           | string                     | `android:tint` on the `<vector>`: `#RRGGBB`, `#AARRGGBB`, `@color/…` or `?attr/…`.                                          |
| `autoMirrored`   | boolean                    | Adds `android:autoMirrored="true"`: Android flips the drawable in right-to-left layouts (arrows, chevrons).                 |
| `width`          | number > 0                 | `android:width` in dp, replacing the SVG size (the viewport is unchanged). Alone, the height keeps the aspect ratio.        |
| `height`         | number > 0                 | `android:height` in dp; same rules as `width`. With both, a different ratio stretches the drawing, as on Android.           |

A color reference is `@[package:]color/name` or `?[package:]attr/name`; a malformed `currentColor` or
`colorMap` entry is a tool error.

Result (`structuredContent`, also serialized as JSON in the text content):

```json
{
    "xml": "<vector xmlns:android=\"http://schemas.android.com/apk/res/android\" …>…</vector>\n",
    "warnings": [{ "code": "min-sdk-exceeded", "category": "info", "message": "Output needs API 24 …" }],
    "minSdk": 24
}
```

`category` is `lossy` (content dropped or drawn wrong), `approximation` (rendering differs slightly)
or `info` (advice: API level, performance). `minSdk` is the lowest Android API level that renders the
output natively (21, or 24 with gradients or `android:fillType`).

### `preview`

VectorDrawable XML → standalone SVG string (e.g. to look at the output of `convert`).

| Argument    | Type              | Description                                                        |
| ----------- | ----------------- | ------------------------------------------------------------------ |
| `xml`       | string (required) | The VectorDrawable XML. At most 2 MB.                              |
| `density`   | number (0, 16]    | Pixels per dp for the SVG size (1 = mdpi, 4 = xxxhdpi). Default 1. |
| `applyTint` | boolean           | Apply the vector's `android:tint`. Default `false`.                |

Result: `{ "svg": "<svg …>…</svg>" }`.

### Errors and limits

Invalid input (not an SVG, malformed XML, an option out of range, a `strict` violation, an input over
2 MB) returns a tool error (`isError: true`) whose text says what is wrong; the server keeps serving.

Each call runs in its own worker thread, stopped after **10 seconds** (set `SVGVD_MCP_TIMEOUT_MS` to
change it), so a pathological SVG cannot block the server.

## Setup

### Claude Code

```sh
claude mcp add svg-vectordrawable -- npx -y svg-vectordrawable-mcp
```

### Claude Desktop

In `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
    "mcpServers": {
        "svg-vectordrawable": {
            "command": "npx",
            "args": ["-y", "svg-vectordrawable-mcp"]
        }
    }
}
```

### Other clients

Any MCP client that launches stdio servers: command `npx`, arguments `-y svg-vectordrawable-mcp`.
Or install it globally (`npm i -g svg-vectordrawable-mcp`) and use the command
`svg-vectordrawable-mcp`. Optional environment variable: `SVGVD_MCP_TIMEOUT_MS` (milliseconds,
default `10000`).

The server talks MCP over stdin/stdout; it does not read files or open network connections.

## Option coverage

The tools expose the options of the published `svg-vectordrawable` release they depend on (0.4.x, see
`package.json`). Not exposed: `optimize`, `svgoConfig`, `fillBlackForUnfilled`, `indent`, `xmlTag`
(use the library or its CLI for those).

## Development

From this folder (a standalone package with its own lockfile, outside the root workspace):

```sh
pnpm install
pnpm test        # builds, then drives dist/index.js over stdio with the MCP SDK client
```

Try it interactively with the MCP Inspector: `npx @modelcontextprotocol/inspector node dist/index.js`.

## License

MIT
