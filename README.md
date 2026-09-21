# pi-slate

A minimal terminal UI/UX for [Pi](https://pi.dev), with a customizable sidebar that keeps your work in view. 

![Slate session with sidebar preview](assets/slate-overview.png)

## Setup

**Option 1: Copy-paste this into your Pi agent**:

```
- Save my pi-agent's tui and themes. Safely disable them for now. 
- install pi-slate to my local pi agent using:  `pi install git:github.com/GaganSD/pi-slate`
- Enable fullscreen mode. Slate replaces Pi's existing TUI; Existing state and replace with Slate/conflicts. Ask me to /reload session once complete. 
- For any existing replaced tui, list top 3 suggestions to integrate those into pi-slate. 
```

**Option 2: copy-paste this in your bash**
```bash
pi install git:github.com/GaganSD/pi-slate
pi --tui-mode fullscreen
```

Explore extension settings using `/slate` command after installation.

## Features

Slate cleanly renders into your terminal and is easily customizable in your pi. It adds no additional context bloat to your model.

### Rich Media Display In Your Terminal

Slate uses Kitty Graphics Protocol to display rich media inside your terminal. Caret-Peek over text to display. Click Preview to copy-path. Double-click to open/edit. Also supports Pi-generated clipboard image paths into `[image-N]` tokens.
[image of adding text & image in chat. then show right side]


### Observability 
1. **Get Work-tree observability**. Click to Preview in terminal. Double-Click to Open in editor. Use the mouse wheel to scroll.

2. **Last-Turn Observability.** Tracks activity for the latest user request. Click a count or category to inspect its activity, then click an activity title in Preview to expand or collapse the tool details. Use **[clear]** to dismiss the selected preview.

## **Session Context Overview** 

- keeps usage and spend visible at the bottom. Context usage may be estimated when provider usage is unavailable.

<!-- Proposed asset: assets/slate-preview.gif — a short real-session loop: click a changed text file, scroll its diff, then select Last Turn activity and expand one tool detail. Keep Summary and Context visible; provide a static fallback when adding the asset. -->

## Commands

TODO For Pi: List all commands and write a simple 1 liner about their effect in settings. Sorted by 'usefulness'. 

| Setting | Commands | Effect |
| --- | --- | --- |

## Minimal by design

Slate adds no context bloat -- no tools, prompts, or model calls. It's entirely deterministic and made to be customizable and purely improves your interface and pi experience while your Pi remains yours.

## Requirements/limits
- Tested on on Pi Agent 0.86+.
- Inline previews need Kitty or iTerm2 image-protocol support detected by Pi. Otherwise, previews fall back to text. Terminal multiplexers and proxies can affect detection.
- **Other UI extensions:** Slate replaces Pi's header, footer, and editor. Extensions that replace the same surfaces may conflict.
- File an issue for bug: [pi-slate](https://github.com/GaganSD/pi-slate/issues)

## License

Gagan Devagiri (GaganSD) - [MIT](LICENSE)
