# pi-slate

A minimal terminal UI for [Pi](https://pi.dev), with a resizable sidebar that keeps your work in view.

Keep your conversation in view, with a centered header, compact footer, and an optional muted-dark theme.

<!-- Proposed asset: assets/slate-workspace.png — a real fullscreen session with a short conversation, 2–4 changed files, a selected text diff, Last Turn activity, and Context visible. Crop for readable text at GitHub width; omit private paths and credentials. -->

- **Review changes beside the conversation.** Open working-tree diffs without leaving Pi, including changes you made yourself.
- **See what your latest request did.** Inspect tool activity in Last Turn, then expand the details that matter.
- **Keep session usage in sight.** See context usage and reported session spend without digging through the transcript.

## Install and start

Requires Pi **0.85.1 or newer** and Git.

<!-- Before release: this repository is currently private, so installation requires Git credentials with access to GaganSD/pi-slate. Remove this note once public installation is available. -->

```bash
pi install git:github.com/GaganSD/pi-slate
pi --tui-mode fullscreen
```

Run the second command from your project directory. Fullscreen gives the sidebar its own space beside the conversation; Pi currently marks this mode as experimental.

In Pi, open `/settings` and choose the **pi-slate** theme for the bundled palette—or keep your current theme. The layout does not depend on the palette.

For a project-local install, add `-l` to the install command.

## Explore the sidebar

**Files Changed** shows your working tree, not just the agent's edits. Click a text file to open its colorized diff in **Preview**. Use the mouse wheel over the file list or preview to scroll.

**Last Turn** tracks activity for the latest user request. Click a count or category to inspect its activity, then click an activity title in Preview to expand or collapse the tool details. Use **[clear]** to dismiss the selected preview.

**Context** keeps usage and spend visible at the bottom. Context usage may be estimated when provider usage is unavailable; spend reflects reported usage on the current session branch, not a live billing total.

Slate also turns supported Pi-generated clipboard image paths into `[image-N]` tokens. Move the cursor into a mapped token to peek at the image in Preview; move away to return to your selected diff or activity. Typing an arbitrary token does not attach an image.

<!-- Proposed asset: assets/slate-preview.gif — a short real-session loop: click a changed text file, scroll its diff, then select Last Turn activity and expand one tool detail. Keep Summary and Context visible; provide a static fallback when adding the asset. -->

## Make it yours

Run `/slate` for the settings picker, or use a command directly:

| Setting | Commands | Effect |
| --- | --- | --- |
| Sidebar width | `/slate width 30` · `/slate width default` | Request 30% of terminal width, or restore the 20% default. |
| Width presets | `/slate width narrow` · `/slate width medium` · `/slate width wide` | Minimum width, 30%, or 40%. |
| Editor density | `/slate density compact` · `/slate density comfortable` | Remove horizontal editor padding, or restore the default padding. |
| Footer | `/slate footer minimal` · `/slate footer standard` | Hide model and effort, or show them when space permits. |

You can also drag the sidebar's left divider to resize it. Width is bounded to keep at least 28 columns for the sidebar and 32 for the conversation. Settings are saved automatically in Pi's agent directory, normally `~/.pi/agent/pi-slate.json`.

<!-- Proposed asset: assets/slate-resize.gif — drag the left divider in the same demo session, showing the guide and resized conversation on release. Demonstrate width control only, not configurable widgets or tabs. -->

## No extra model context for the UI

Slate adds no tools, system prompts, or model calls for its interface. Sidebar data and previews stay local; they are not appended to the conversation sent to the model.

Image attachments are different: when you submit a prompt containing supported clipboard paths or mapped image tokens, Slate includes those images with your prompt. Previewing an image does not itself send it.

## Requirements and limits

- **Layout:** Fullscreen uses a side-by-side split. Regular TUI mode falls back to a top-right overlay. Below 60 terminal columns, the sidebar is hidden in either mode.
- **Interaction:** Sidebar selection, scrolling, and dragging use the mouse; Slate does not add sidebar keyboard navigation.
- **Git:** Files Changed is empty outside a Git repository. It refreshes after tool and turn activity, including background subagent completion—not by polling while idle. Binary files have no text diff.
- **Images:** Inline previews need Kitty or iTerm2 image-protocol support detected by Pi. Otherwise, previews fall back to text. Terminal multiplexers and proxies can affect detection.
- **Other UI extensions:** Slate replaces Pi's header, footer, and editor. Extensions that replace the same surfaces may conflict.

## Remove

If you selected the bundled palette, choose another theme in `/settings` first. Then exit Pi and run:

```bash
pi remove git:github.com/GaganSD/pi-slate
```

Add `-l` if you installed project-locally, then start a new Pi session. Saved Slate preferences remain in the agent directory; delete `pi-slate.json` there if you also want to reset them.

## Development

From a checkout with development dependencies available:

```bash
npm test
npm run typecheck
npm run pack:check
```

## License

[MIT](LICENSE)
