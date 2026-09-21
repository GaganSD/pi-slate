# pi-slate

A quiet Pi TUI: centered header, compact footer, sidebar, and a muted dark theme.

Presentation only. No new agent workflow, tools, or network service.

## Install

```bash
pi install git:github.com/GaganSD/pi-slate
```

Pick `pi-slate` in `/settings`, or set it in `~/.pi/agent/settings.json`:

```json
{
  "theme": "pi-slate"
}
```

Project-local: `pi install -l git:github.com/GaganSD/pi-slate`.

## Use

- **Sidebar** — Summary (Files Changed, Last Turn), Preview, Context. Drag the left `│` to resize; width is saved in `~/.pi/agent/pi-slate.json`.
- `/slate` — density, footer, and sidebar width. No args opens a picker. `/slate density compact`, `/slate footer minimal`, `/slate width 40` set a value. Width is at least 28 columns.
- Click a changed file or Last Turn count to open Preview. Click a Last Turn row again for the full tool message.
- Put the cursor on an `[image-N]` token to peek it. Image terminals render the file; others get text.

Files Changed reads local `git status` after Pi work. It does not poll while idle.

Fullscreen TUI only. Narrow or regular TUI falls back to Pi's overlay. Non-interactive modes are unchanged.

## Requirements

- Pi **0.85.1** or newer
- A Git repository for Files Changed (otherwise the list is empty)
- Kitty, iTerm2, Ghostty, WezTerm, or Warp for inline image previews

## Remove

```bash
pi remove git:github.com/GaganSD/pi-slate
```

## Development

```bash
npm test
npm run typecheck
npm run pack:check
```

## License

[MIT](LICENSE)
