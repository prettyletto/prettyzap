# PrettyZap

PrettyZap is a desktop wrapper for [WhatsApp Web](https://web.whatsapp.com/)
with custom features for a better desktop experience.

WhatsApp Web remains responsible for authentication, messaging, encryption,
networking, and data. PrettyZap adds the desktop window and custom controls
around it.

> Tested on Linux, including Omarchy/Hyprland.

<img src="assets/prettyzap-banner.png" alt="PrettyZap banner">

## See it in action

### Keyboard controls

Use keyboard shortcuts to search, move through chats, navigate WhatsApp
sections, open Archived, and focus the composer.

![Keyboard controls demo](assets/keyboard-controls.gif)

[Watch the keyboard controls demo](assets/keyboard-controls.mp4)

### Theming

Switch between WhatsApp's native appearance and the active system palette
without reloading the conversation or changing its layout.

![Theming demo](assets/theming.gif)

[Watch the theming demo](assets/theming.mp4)

### Settings and widget controls

Use the desktop widget to open or hide PrettyZap and access its settings and
theme controls.

![Settings and widget demo](assets/settings-widget.gif)

[Watch the settings and widget demo](assets/settings-widget.mp4)

## What you get

- A native desktop window for WhatsApp Web with persistent login state.
- A collapsible chat drawer that keeps WhatsApp's own interface intact.
- Keyboard shortcuts for searching, navigating sections, cycling through chats,
  opening Archived, and focusing the composer.
- A theme toggle for WhatsApp's native appearance and the active system palette.
- A quick show/hide command for desktop keybindings and launchers.
- An optional Omarchy bar widget with controls for opening, hiding, theming,
  and quitting PrettyZap.
- Local shell preferences for window size, maximized state, and drawer state.

## Install

### Arch Linux

Install the core package from the AUR:

```bash
paru -S prettyzap-bin
```

For Omarchy, add the native bar plugin directly from GitHub:

```bash
omarchy plugin add https://github.com/prettyletto/prettyzap.git --enable --yes
```

Open the PrettyZap bar icon and choose **Install PrettyZap** if the core app
is not already installed.

### From an AppImage

Download the latest release, make it executable, and run it:

```bash
chmod +x PrettyZap-*.AppImage
./PrettyZap-*.AppImage
```

### From source

```bash
npm install
npm run build
npm start
```

## Using it

| Shortcut | Action |
| --- | --- |
| `Ctrl/Cmd + L` | Toggle the chat drawer |
| `Ctrl/Cmd + /` | Focus WhatsApp's chat search |
| `Ctrl/Cmd + 1` … `8` | Open WhatsApp navigation sections |
| `Ctrl/Cmd + J` / `K` | Move down/up in the active conversation |
| `Ctrl/Cmd + I` or `Ctrl/Cmd + Enter` | Focus the composer |
| `Ctrl/Cmd + Shift + J` / `K` | Cycle forward/backward through chats |
| `Ctrl/Cmd + Shift + A` | Open Archived |
| `Ctrl/Cmd + Shift + T` | Toggle the theme |
| `Ctrl/Cmd + Shift + Space` | Show or hide PrettyZap, when supported |

The show/hide action is also available from a desktop keybinding or launcher:

```bash
prettyzap --toggle
```

On Omarchy, the bar icon is the primary control surface. Install the published
plugin with:

```bash
omarchy plugin add https://github.com/prettyletto/prettyzap.git --enable --yes
```

Open the bar panel and click **Install PrettyZap** once to install
`prettyzap-bin` through `yay`; after that, left-click opens or hides the app
and right-click opens the control panel.
See [`packaging/omarchy/README.md`](packaging/omarchy/README.md) for the
local checkout installer, standalone Quickshell fallback, and uninstall
instructions.

## Privacy and security

PrettyZap loads the official WhatsApp Web client and does not replace it. It
does not add a backend, copy WhatsApp's message database, reverse-engineer
private APIs, or expose arbitrary Node.js/Electron APIs to the page.

The WhatsApp Web surface runs with Electron security boundaries enabled:

- `WebContentsView`
- `nodeIntegration: false`
- `contextIsolation: true`
- sandboxing where applicable
- a persistent partition for the WhatsApp session
- a narrow preload and IPC boundary
- separate microphone and camera controls in Settings; both stay enabled by
  default to preserve voice messages and calls for existing users

PrettyZap stores only its own shell preferences in
`$XDG_CONFIG_HOME/prettyzap/shell-state.json` or
`~/.config/prettyzap/shell-state.json`.

## How it works

PrettyZap opens WhatsApp Web in an Electron `WebContentsView`. Small feature
modules interact with WhatsApp's existing DOM and native controls, while the
Electron main process handles the window, shortcuts, shell state, and desktop
integration.

WhatsApp Web still handles the account, session, messages, media, encryption,
networking, and rendering. PrettyZap is the shell around it.

## Development

```bash
npm run dev          # build, watch TypeScript, and launch Electron
npm run typecheck    # type-check without emitting files
npm test             # build and run the tests
npm run package:linux  # build a Linux AppImage
```

### GPU and memory usage

PrettyZap disables Chromium GPU acceleration by default. WhatsApp Web can
cause Electron's GPU process to reserve several hundred megabytes on some
Linux/Wayland systems, while the wrapper's UI and normal messaging remain
usable without GPU rendering. Disabling it is intended to reduce the default
memory footprint.

GPU acceleration can be enabled for troubleshooting, video playback, or
voice/video calls:

```bash
PRETTYZAP_ENABLE_GPU=1 prettyzap
```

The equivalent one-shot override is:

```bash
prettyzap --enable-gpu
```

GPU acceleration may improve media rendering on some systems, but can also
increase memory usage substantially.

The implementation notes are in [`src/features/README.md`](src/features/README.md)
and [`src/main/README.md`](src/main/README.md).

## License

MIT — see [LICENSE](LICENSE).
