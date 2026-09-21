# pi-extensions

Public session radar for the [Pi](https://github.com/badlogic/pi-mono) coding agent. The sidebar shows four sections:

1. **Files Changed · N** — `git status` porcelain (`N` / `M` / `D` / `R` / `U`). Scroll the list. Click a path to copy it.
2. **Plan** — the `todo` tool tree, or `none`.
3. **Preview** — paste a clipboard image to insert `[image-N]`. Put the caret on that token (or click it) to preview the picture here. Click the filename to copy its path. Move the caret off the token to return to `none`.
4. **Context** — tokens (percent) · tokens/sec, plus skills loaded and MCPs connected.

It does not ship a theme, header, footer, or editor.

## Install

```bash
pi install git:github.com/GaganSD/pi-extensions
```

Do not install this beside another sidebar or split UI (zentui layout, or the old pi-minimal-ui sidebar). Only one extension can own the layout root.

## `/sidebar`

Live settings:

- enable / disable
- width percent (10–40)
- files max lines (2–20)
- ASCII marks
- reset

Disable tears down the split or overlay and leaves tools registered. Enable remounts the pane.

## Config

`~/.pi/agent/sidebar.json` (via `getAgentDir()`). Missing or malformed files use defaults. Unknown keys are kept. Writes are atomic (`tmp` + rename).

| Key | Default | Bounds |
| --- | --- | --- |
| `enabled` | `true` | boolean |
| `widthPercent` | `20` | 10–40 |
| `minWidth` | `28` | 16–80 |
| `minTerminalWidth` | `60` | 40–200 |
| `filesMaxLines` | `5` | 2–20 |
| `ascii` | `false` | boolean |

Colors must be Theme API token names (`text`, `muted`, `dim`, `accent`, `success`, `warning`, `error`, `borderMuted`, …). Invalid tokens fall back to defaults. Marks must be a single visible cell with no control or escape sequences.

ASCII mode draws `|` / `-` rules and plan marks `o` / `*` / `x`.

## License

MIT
