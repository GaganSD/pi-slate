# pi-minimal-ui

A quiet, dark UI package for [Pi](https://pi.dev). It keeps Pi's terminal-first workflow intact while replacing the header, footer, editor chrome, and adding a compact sidebar.

> This is presentation-first, not a new agent workflow. It does not add subagents, permission gates, background shells, or a remote service.

## Install

```bash
pi install git:github.com/GaganSD/pi-extensions
```

Choose the bundled theme with `/settings`, or add it to `~/.pi/agent/settings.json`:

```json
{
  "theme": "pi-minimal"
}
```

For a project-local install, use `pi install -l git:github.com/GaganSD/pi-extensions`.

## What it changes

- Centered Pi header and compact footer.
- A muted `pi-minimal` theme.
- A right sidebar with **Files Changed**, **Plan**, **Preview**, and **Context**.
- Files Changed reads local `git status` at startup and after Pi work; it does not poll while Pi is idle.
- Image peek: put the cursor on an `[image-N]` attachment token to preview it in the sidebar. Image-capable terminals render the image; other terminals get a text fallback.
- A compact, session-backed `todo` tool for the sidebar plan.
- `/minimal-ui` toggles comfortable/compact editor density and the standard/minimal footer. Preferences are stored in `~/.pi/agent/pi-minimal-ui.json`.

The split sidebar is used in fullscreen TUI mode. On narrower terminals or regular TUI mode, Pi falls back to an overlay; non-interactive Pi modes have no UI changes.

## Requirements

- Pi **0.85.1** or newer (tested with 0.85.1).
- A Git repository for Files Changed; outside one it simply shows no files.
- An image-capable terminal (Kitty, iTerm2, Ghostty, WezTerm, or Warp) for inline image previews.

## Design and trade-offs

Pi keeps its core minimal by leaving workflow choices to packages. `pi-minimal-ui` follows that boundary for most features: it is local, uses Pi's extension API, and avoids dependencies beyond Pi's peer packages.

The `todo` tool is the intentional exception. Pi deliberately has no built-in todo system; this package adds one only to make the Plan panel useful. If you do not want that agent-facing tool, this package is not yet the right fit—use the bundled theme alone or remove the tool in a fork.

## Remove

```bash
pi remove git:github.com/GaganSD/pi-extensions
```

## Development

```bash
npm test
npm run typecheck
npm run pack:check
```

## License

[MIT](LICENSE)
