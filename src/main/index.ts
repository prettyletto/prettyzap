import {
  app,
  BrowserWindow,
  Menu,
  nativeImage,
  Tray,
  globalShortcut,
  ipcMain,
  session,
  shell,
  WebContentsView,
} from "electron";
import * as path from "node:path";
import { installWhatsAppDrawer } from "../features/whatsapp-drawer";
import { installWhatsAppTheme } from "../features/whatsapp-theme";
import type { WhatsAppThemeController } from "../features/whatsapp-theme";
import { focusActiveComposer } from "../features/whatsapp-focus";
import {
  loadShellState,
  normalizeShortcutPreferences,
  saveShellState,
  type ShellState,
  type ShortcutPreferences,
} from "./shell-state";
import {
  clearStatus,
  writeStatus,
  type AppStatus,
  type PrettyZapTheme,
} from "./status";
import { startDesktopControl, type DesktopControl } from "./desktop-control";
import { isWindowPresented, resolveToggleAction } from "./window-state";
import { isMediaAccessAllowed } from "./media-permissions";
import { notificationPolicyScript, parseUnreadCount } from "./unread-count";
import {
  DEFAULT_CUSTOM_PALETTE,
  isRunningUnderOmarchy,
  paletteToRecord,
  readOmarchyPalette,
  readPrettyZapPalette,
  recordToPalette,
  removePrettyZapPalette,
  writePrettyZapPalette,
  type PaletteSnapshot,
} from "./palette";

app.setName("PrettyZap");

// WhatsApp Web's Chromium GPU process can consume several hundred megabytes
// on some Linux/Wayland systems. Keep the wrapper's default footprint lower
// and make GPU rendering an explicit opt-in for users who need it for calls
// or video playback. This must be set before Electron creates any windows.
const gpuEnabled = process.env.PRETTYZAP_ENABLE_GPU === "1" || process.argv.includes("--enable-gpu");
if (!gpuEnabled) app.commandLine.appendSwitch("disable-gpu");

// Keep the existing profile created by the earlier Pjzap builds. The product
// is now named PrettyZap, but changing Electron's userData directory would
// unnecessarily discard the user's existing WhatsApp Web session.
app.setPath("userData", path.join(app.getPath("appData"), "pjzap"));

const WHATSAPP_URL = "https://web.whatsapp.com/";
// Keep the existing WhatsApp Web cache so the current login survives this reset.
const WHATSAPP_PARTITION = "persist:whatsapp";
const WHATSAPP_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/132.0.6834.210 Safari/537.36";
function isWhatsAppUrl(url: string): boolean {
  try {
    const parsedUrl = new URL(url);
    return parsedUrl.protocol === "https:" && parsedUrl.origin === "https://web.whatsapp.com";
  } catch {
    return false;
  }
}

function openExternalUrl(url: string): void {
  try {
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") return;

    void shell.openExternal(parsedUrl.toString()).catch((error: unknown) => {
      console.warn("Unable to open external URL", error);
    });
  } catch {
    // Ignore malformed URLs and unsupported schemes at the shell boundary.
  }
}
const SHOW_HIDE_ACCELERATOR = "CommandOrControl+Shift+Space";
const TOGGLE_ARGUMENT = "--toggle";
const SHOW_ARGUMENT = "--show";
const HIDE_ARGUMENT = "--hide";
const SETTINGS_ARGUMENT = "--settings";
const QUIT_ARGUMENT = "--quit";
const THEME_ARGUMENT = "--theme";
const NOTIFICATIONS_ARGUMENT = "--notifications";

type ThemeArgument = PrettyZapTheme | "toggle";

interface CliAction {
  toggle?: boolean;
  show?: boolean;
  hide?: boolean;
  settings?: boolean;
  quit?: boolean;
  theme?: ThemeArgument;
  notifications?: "toggle" | "on" | "off";
}

// Parse the command line for the Omarchy widget's driver flags. Unknown and
// positional args are ignored so `prettyzap file.pdf`-style invocations keep
// working. `--theme` consumes the next token as its value.
function parseCliArgs(args: readonly string[]): CliAction {
  const action: CliAction = {};
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case TOGGLE_ARGUMENT:
        action.toggle = true;
        break;
      case SHOW_ARGUMENT:
        action.show = true;
        break;
      case HIDE_ARGUMENT:
        action.hide = true;
        break;
      case SETTINGS_ARGUMENT:
        action.settings = true;
        break;
      case QUIT_ARGUMENT:
        action.quit = true;
        break;
      case THEME_ARGUMENT: {
        const value = args[i + 1];
        if (value === "whatsapp" || value === "system" || value === "toggle") {
          action.theme = value;
          i += 1;
        }
        break;
      }
      case NOTIFICATIONS_ARGUMENT: {
        const value = args[i + 1];
        if (value === "toggle" || value === "on" || value === "off") {
          action.notifications = value;
          i += 1;
        }
        break;
      }
      default:
        // Chromium only preserves switch values in the `--theme=<value>` form;
        // the two-token `--theme <value>` arrives detached and reordered.
        if (args[i].startsWith("--theme=")) {
          const value = args[i].slice("--theme=".length);
          if (value === "whatsapp" || value === "system" || value === "toggle") {
            action.theme = value;
          }
        }
        if (args[i].startsWith("--notifications=")) {
          const value = args[i].slice("--notifications=".length);
          if (value === "toggle" || value === "on" || value === "off") {
            action.notifications = value;
          }
        }
        break;
    }
  }
  return action;
}
const DRAWER_STATE_CHANNEL = "prettyzap:drawer-state";
const WHATSAPP_UNREAD_CHANNEL = "prettyzap:whatsapp-unread";
const SETTINGS_GET_CHANNEL = "prettyzap:settings-get";
const SETTINGS_UPDATE_CHANNEL = "prettyzap:settings-update";
const SETTINGS_CLOSE_CHANNEL = "prettyzap:settings-close";
const PALETTE_GET_CHANNEL = "prettyzap:palette-get";
const PALETTE_SET_CHANNEL = "prettyzap:palette-set";
const PALETTE_RESET_CHANNEL = "prettyzap:palette-reset";
const PALETTE_PIN_CHANNEL = "prettyzap:palette-pin";
const MEMORY_RECOVERY_TIMEOUT_MS = 30_000;
const TRAY_ICON = nativeImage.createFromDataURL(
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQEAIAAADAAbR1AAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGYktHRP///////wlY99wAAAAHdElNRQfqCBAAKTh3JqlvAAAAJXRFWHRkYXRlOmNyZWF0ZQAyMDI2LTA4LTE2VDAwOjQxOjU2KzAwOjAw19CgsgAAACV0RVh0ZGF0ZTptb2RpZnkAMjAyNi0wOC0xNlQwMDo0MTo1NiswMDowMKaNGA4AAAAodEVYdGRhdGU6dGltZXN0YW1wADIwMjYtMDgtMTZUMDA6NDE6NTYrMDA6MDDxmDnRAAAAYklEQVQ4y2NkYFixoqWFgWaAiXZG08kCFmIU/f8fHl5djSkuyLhertf2A8Ov7h8eFFkAMQhTHL/RBCxAc3U4QzV+g3D5ZuhH8qgFBAHOVIQraeICuJIsC6kaSAVDPw5obgEALmsjxWv//f0AAAAASUVORK5CYII=",
);

let prettyZapWindow: BrowserWindow | undefined;
let whatsappWebContents: WebContentsView["webContents"] | undefined;
let pendingToggle = false;
let pendingFocus = false;
let tray: Tray | undefined;
let isQuitting = false;
let shellState = loadShellState();
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let whatsappThemeController: WhatsAppThemeController | undefined;
let whatsappThemeMenuItems: { whatsapp?: Electron.MenuItem; system?: Electron.MenuItem } = {};
let settingsWindow: BrowserWindow | undefined;
let removeDrawerFeature: (() => void) | undefined;
let recoverMemoryMenuItem: Electron.MenuItem | undefined;
let recoveringMemory = false;
let desktopControl: DesktopControl | undefined;
let appReady = false;
let unreadCount = 0;

function paletteSnapshot(): PaletteSnapshot {
  const underOmarchy = isRunningUnderOmarchy();
  // On Omarchy the saved palette only counts while pinned; elsewhere it
  // always applies. Unpinning preserves the file for later.
  const pinned = underOmarchy && shellState.colorsPinned;
  const custom = (underOmarchy ? pinned : true) ? readPrettyZapPalette() : undefined;
  const fallback = underOmarchy ? readOmarchyPalette() : undefined;
  const palette = custom ?? fallback ?? DEFAULT_CUSTOM_PALETTE;
  const record = paletteToRecord(palette);
  return {
    kind: custom ? "custom" : underOmarchy ? "omarchy" : "custom",
    omarchy: underOmarchy,
    pinned,
    mode: record.mode,
    colors: record.colors,
  };
}

function isSettingsSender(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean {
  return Boolean(settingsWindow && !settingsWindow.isDestroyed() && event.sender.id === settingsWindow.webContents.id);
}

function publishStatus(): AppStatus {
  const mode = whatsappThemeController?.getMode() ?? shellState.whatsappTheme;
  const status = writeStatus(
    mode,
    isWindowPresented(prettyZapWindow),
    appReady,
    unreadCount,
    shellState.notificationsEnabled,
  );
  desktopControl?.publish(status);
  return status;
}

function persistShellState(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveShellState(shellState);
}

function scheduleShellStateSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = undefined;
    saveShellState(shellState);
  }, 150);
}

function updateWindowState(window: BrowserWindow): void {
  const [width, height] = window.getContentSize();
  if (!window.isMaximized()) {
    shellState.width = width;
    shellState.height = height;
  }
  shellState.maximized = window.isMaximized();
  scheduleShellStateSave();
}

function showWindow(): void {
  restoreAndFocusPrettyZapWindow();
}

/**
 * Wipe everything Chromium persists for the WhatsApp partition (cookies,
 * local/indexed storage, cache). Used by Privacy mode (sign-out-on-quit) and
 * the manual “Log out of WhatsApp” action. The partitioned store is fully
 * readable on disk by any same-user process, so this is the only way to
 * guarantee no session material survives an exit.
 */
async function clearWhatsAppSession(): Promise<void> {
  try {
    const webContents = whatsappWebContents;
    if (webContents && !webContents.isDestroyed()) webContents.close();
    // Let any in-flight renderer flush settle before clearing the store.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const whatsappSession = session.fromPartition(WHATSAPP_PARTITION);
    await whatsappSession.clearStorageData();
    await whatsappSession.cookies.flushStore();
    console.info("PrettyZap signed out: WhatsApp session storage cleared");
  } catch (error: unknown) {
    console.warn("PrettyZap could not clear the WhatsApp session", error);
  }
}

async function quitPrettyZap(): Promise<void> {
  isQuitting = true;
  persistShellState();
  if (shellState.signOutOnQuit) await clearWhatsAppSession();
  app.quit();
}

function settingsSnapshot(): Pick<ShellState, "drawerCollapsed" | "whatsappTheme" | "notificationsEnabled" | "microphoneEnabled" | "cameraEnabled" | "shortcuts" | "signOutOnQuit"> {
  return {
    drawerCollapsed: shellState.drawerCollapsed,
    whatsappTheme: shellState.whatsappTheme,
    notificationsEnabled: shellState.notificationsEnabled,
    microphoneEnabled: shellState.microphoneEnabled,
    cameraEnabled: shellState.cameraEnabled,
    shortcuts: { ...shellState.shortcuts },
    signOutOnQuit: shellState.signOutOnQuit,
  };
}

function settingsPage(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PrettyZap Settings</title>
<style>
:root{color-scheme:dark;font-family:Inter,system-ui,sans-serif;background:#0e1420;color:#e8edf5}*{box-sizing:border-box}html,body{height:100%}body{margin:0;display:flex;flex-direction:column;overflow:hidden;background:radial-gradient(1100px 560px at 85% -10%,#1c3044 0%,#101722 55%,#0e1420 100%)}main{flex:1;min-height:0;overflow-y:auto;width:min(100%,760px);margin:0 auto;padding:clamp(18px,4vw,36px) clamp(16px,4vw,34px) 14px}main::-webkit-scrollbar{width:10px}main::-webkit-scrollbar-track{background:transparent}main::-webkit-scrollbar-thumb{background:#2b3b50;border-radius:6px;border:2px solid transparent;background-clip:content-box}main::-webkit-scrollbar-thumb:hover{background:#3d5270;border:2px solid transparent;background-clip:content-box}h1{font-size:clamp(24px,5vw,30px);margin:0 0 6px;letter-spacing:-.01em}p{color:#8fa0b8;margin:0 0 26px;line-height:1.5;max-width:60ch}.card{background:linear-gradient(180deg,#16202e,#141d2a);border:1px solid #263448;border-radius:14px;padding:clamp(16px,3vw,24px);margin:16px 0;box-shadow:0 12px 32px rgba(4,10,20,.35)}h2{font-size:13px;margin:0 0 18px;color:#79d5b0;letter-spacing:.12em;text-transform:uppercase;font-weight:600}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px 20px}label{display:grid;min-width:0;gap:8px;color:#c6d0dc;font-size:13px}input{width:100%;min-width:0;border:1px solid #2c3c52;border-radius:8px;background:#0d1520;color:#f2f6fa;padding:11px 12px;font:inherit;transition:border-color .15s ease,box-shadow .15s ease}input:hover{border-color:#4a6079}input:focus{outline:none;border-color:#79d5b0;box-shadow:0 0 0 3px rgba(121,213,176,.18)}.check{display:flex;grid-template-columns:none;align-items:center;gap:12px;margin:14px 0}.check input{width:auto;accent-color:#79d5b0}.hint{font-size:12px;color:#77879d;margin:10px 0 0;line-height:1.5}.actions{flex:none;display:flex;align-items:center;gap:16px;border-top:1px solid #22303f;background:rgba(14,20,32,.88);backdrop-filter:blur(14px);padding:14px clamp(16px,4vw,34px)}#status{flex:1;min-width:0;max-width:460px;min-height:36px;display:flex;align-items:center;padding:8px 12px;border-radius:8px;font-size:12px}#status.success{color:#a5f0d0;background:#173b35;border:1px solid #286b5d}#status.error{color:#ffb7b7;background:#45252b;border:1px solid #85434d}.buttons{display:flex;gap:10px;flex:none}button{border:1px solid #33455c;border-radius:9px;padding:10px 18px;background:#1c2b3e;color:#dce7f1;font:inherit;font-weight:500;cursor:pointer;transition:background .15s ease,border-color .15s ease,transform .08s ease}button:hover{background:#27394f;border-color:#5e7893}button:focus-visible{outline:2px solid #79d5b0;outline-offset:2px}button:active{transform:translateY(1px)}button.primary{background:#79d5b0;border-color:#79d5b0;color:#0f241e;font-weight:600;box-shadow:0 2px 10px rgba(121,213,176,.25)}button.primary:hover{background:#8fe2bf;border-color:#8fe2bf}button.primary:active{background:#62bd9a;box-shadow:none}button:disabled{cursor:wait;opacity:.65}.color-row{display:flex;align-items:center;gap:8px;min-width:0}.color-row input[type="color"]{width:44px;height:36px;padding:3px;flex:none;cursor:pointer;border-radius:8px}.color-row input[type="text"]{flex:1;min-width:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;text-transform:lowercase}select{width:100%;min-width:0;border:1px solid #2c3c52;border-radius:8px;background:#0d1520;color:#f2f6fa;padding:11px 12px;font:inherit;transition:border-color .15s ease,box-shadow .15s ease}select:hover{border-color:#4a6079}select:focus{outline:none;border-color:#79d5b0;box-shadow:0 0 0 3px rgba(121,213,176,.18)}select:disabled,input:disabled{opacity:.55;cursor:not-allowed}.inline-actions{display:flex;gap:10px;align-items:center;margin-top:16px}@media(max-width:560px){.grid{grid-template-columns:1fr}.buttons button{flex:1}.card{margin:12px 0}}
</style></head><body><main><h1>PrettyZap Settings</h1><p>Customize shortcuts and the way PrettyZap behaves around WhatsApp Web.</p>
<section class="card"><h2>Appearance</h2><label class="check"><input id="systemTheme" type="checkbox"> Apply the system theme to WhatsApp</label><div class="hint">When disabled, WhatsApp keeps its own appearance. Changes apply immediately.</div></section>
<section class="card" id="colors-card"><h2>Colors</h2><div class="hint" id="colorsNote"></div><label class="check" id="colorsPinWrap" style="display:none;margin:14px 0 4px"><input id="colorsPin" type="checkbox"> Keep these colors even when the Omarchy theme changes</label><div class="grid">
<label>Mode<select id="paletteMode"><option value="dark">Dark</option><option value="light">Light</option></select></label>
<label>Background<span class="color-row"><input type="color" data-color-key="background" value="#121212"><input type="text" data-color-hex="background" value="#121212" spellcheck="false" autocomplete="off"></span></label>
<label>Dark background<span class="color-row"><input type="color" data-color-key="darkBackground" value="#0d0d0d"><input type="text" data-color-hex="darkBackground" value="#0d0d0d" spellcheck="false" autocomplete="off"></span></label>
<label>Darker background<span class="color-row"><input type="color" data-color-key="darkerBackground" value="#090909"><input type="text" data-color-hex="darkerBackground" value="#090909" spellcheck="false" autocomplete="off"></span></label>
<label>Foreground<span class="color-row"><input type="color" data-color-key="foreground" value="#bebebe"><input type="text" data-color-hex="foreground" value="#bebebe" spellcheck="false" autocomplete="off"></span></label>
<label>Muted<span class="color-row"><input type="color" data-color-key="muted" value="#333333"><input type="text" data-color-hex="muted" value="#333333" spellcheck="false" autocomplete="off"></span></label>
<label>Accent<span class="color-row"><input type="color" data-color-key="accent" value="#e68e0d"><input type="text" data-color-hex="accent" value="#e68e0d" spellcheck="false" autocomplete="off"></span></label>
<label>Selection<span class="color-row"><input type="color" data-color-key="selection" value="#2a2a2a"><input type="text" data-color-hex="selection" value="#2a2a2a" spellcheck="false" autocomplete="off"></span></label>
<label>Red<span class="color-row"><input type="color" data-color-key="red" value="#d35f5f"><input type="text" data-color-hex="red" value="#d35f5f" spellcheck="false" autocomplete="off"></span></label>
<label>Yellow<span class="color-row"><input type="color" data-color-key="yellow" value="#b91c1c"><input type="text" data-color-hex="yellow" value="#b91c1c" spellcheck="false" autocomplete="off"></span></label>
<label>Green<span class="color-row"><input type="color" data-color-key="green" value="#ffc107"><input type="text" data-color-hex="green" value="#ffc107" spellcheck="false" autocomplete="off"></span></label>
<label>Blue<span class="color-row"><input type="color" data-color-key="blue" value="#e68e0d"><input type="text" data-color-hex="blue" value="#e68e0d" spellcheck="false" autocomplete="off"></span></label>
</div><div class="inline-actions"><button id="resetColors">Reset to defaults</button><span class="hint" style="margin:0">Changes apply to WhatsApp immediately.</span></div></section>
<section class="card"><h2>Behavior</h2><label class="check"><input id="drawerCollapsed" type="checkbox"> Start the chat drawer collapsed</label><div class="hint">This takes effect the next time the app opens.</div><label class="check" style="margin-top:14px"><input id="signOutOnQuit" type="checkbox"> Sign out of WhatsApp when PrettyZap quits</label><div class="hint">Wipes the saved session (cookies, local and indexed storage) on exit so nothing recoverable remains on disk. You will need to scan the WhatsApp QR code again after each quit.</div></section>
<section class="card"><h2>Media permissions</h2>
<label class="check"><input id="microphoneEnabled" type="checkbox"> Allow microphone access</label><div class="hint">Used for voice messages and voice/video calls.</div>
<label class="check" style="margin-top:14px"><input id="cameraEnabled" type="checkbox"> Allow camera access</label><div class="hint">Used for video calls and camera capture.</div>
<div class="hint">Changes apply to future media requests. Active calls keep their current devices until restarted.</div></section>
<section class="card"><h2>Shortcuts</h2><div class="grid">
<label>Toggle drawer<input type="text" data-key="toggleDrawer" autocomplete="off"></label><label>Focus chat search<input type="text" data-key="search" autocomplete="off"></label>
<label>Open Archived<input type="text" data-key="openArchived" autocomplete="off"></label><label>Focus composer<input type="text" data-key="focusComposer" autocomplete="off"></label>
<label>Scroll down<input type="text" data-key="scrollDown" autocomplete="off"></label><label>Scroll up<input type="text" data-key="scrollUp" autocomplete="off"></label>
<label>Next chat<input type="text" data-key="cycleForward" autocomplete="off"></label><label>Previous chat<input type="text" data-key="cycleBackward" autocomplete="off"></label>
<label>Tab 1<input type="text" data-key="navigation.1" autocomplete="off"></label><label>Tab 2<input type="text" data-key="navigation.2" autocomplete="off"></label>
<label>Tab 3<input type="text" data-key="navigation.3" autocomplete="off"></label><label>Tab 4<input type="text" data-key="navigation.4" autocomplete="off"></label>
<label>Tab 5<input type="text" data-key="navigation.5" autocomplete="off"></label><label>Tab 6<input type="text" data-key="navigation.6" autocomplete="off"></label>
<label>Tab 7<input type="text" data-key="navigation.7" autocomplete="off"></label><label>Tab 8<input type="text" data-key="navigation.8" autocomplete="off"></label>
</div><div class="hint">Click a shortcut field, then press the desired combination. For example: Ctrl+Shift+A, Ctrl+1, or Cmd+K.</div></section>
</main><footer class="actions"><div id="status" role="status" aria-live="polite"></div><div class="buttons"><button id="cancel">Close</button><button class="primary" id="save">Save settings</button></div></footer>
<script>const api=window.prettyZapSettings;const fields=[...document.querySelectorAll('[data-key]')];const read=(shortcuts,key)=>key.split('.').reduce((value,part)=>value?.[part],shortcuts);const setStatus=(message,type)=>{status.textContent=message;status.className=type};const collect=()=>{const shortcuts={};fields.forEach(e=>{const parts=e.dataset.key.split('.');if(parts.length===1)shortcuts[parts[0]]=e.value.trim();else{shortcuts[parts[0]]??={};shortcuts[parts[0]][parts[1]]=e.value.trim()}});return shortcuts};const prettyKey=e=>{if(e.key===' ')return 'Space';if(e.key==='Escape')return 'Escape';if(e.key==='Enter')return 'Enter';if(e.key.length===1)return e.key.toUpperCase();return e.key};fields.forEach(field=>field.addEventListener('keydown',e=>{if(['Tab','Shift','Control','Alt','Meta'].includes(e.key))return;e.preventDefault();const parts=[];if(e.ctrlKey)parts.push('Ctrl');if(e.metaKey)parts.push('Cmd');if(e.altKey)parts.push('Alt');if(e.shiftKey)parts.push('Shift');parts.push(prettyKey(e));field.value=parts.join('+')}));api.get().then(s=>{fields.forEach(e=>e.value=read(s.shortcuts,e.dataset.key)||'');systemTheme.checked=s.whatsappTheme==='system';drawerCollapsed.checked=s.drawerCollapsed;signOutOnQuit.checked=s.signOutOnQuit===true}).catch(()=>setStatus('Unable to load settings','error'));save.onclick=async()=>{save.disabled=true;save.textContent='Saving…';setStatus('Applying changes…','success');try{const saved=await api.update({shortcuts:collect(),whatsappTheme:systemTheme.checked?'system':'whatsapp',drawerCollapsed:drawerCollapsed.checked,signOutOnQuit:signOutOnQuit.checked});fields.forEach(e=>e.value=read(saved.shortcuts,e.dataset.key)||'');setStatus('✓ Settings saved and applied','success')}catch(error){setStatus('Could not save settings','error')}finally{save.disabled=false;save.textContent='Save settings'}};cancel.onclick=()=>api.close();
const colorFields=[...document.querySelectorAll('[data-color-key]')];
const hexFields=[...document.querySelectorAll('[data-color-hex]')];
const modeSelect=document.getElementById('paletteMode');
const colorsNote=document.getElementById('colorsNote');
const colorsPin=document.getElementById('colorsPin');
const colorsPinWrap=document.getElementById('colorsPinWrap');
const resetColors=document.getElementById('resetColors');
let colorsEditable=true;let paletteModeValue='dark';let paletteColors={};let paletteSaveTimer;
const setColorsEditable=(editable)=>{colorsEditable=editable;modeSelect.disabled=!editable;colorFields.forEach(f=>f.disabled=!editable);hexFields.forEach(f=>f.disabled=!editable);resetColors.disabled=!editable};
const applyPalette=(p)=>{paletteModeValue=p.mode;paletteColors={...p.colors};modeSelect.value=p.mode;colorsPinWrap.style.display=p.omarchy?'':'none';colorsPin.checked=p.pinned===true;colorsNote.textContent=p.omarchy?(p.pinned?'Your custom colors override the Omarchy theme — theme changes no longer affect WhatsApp.':'Following your active Omarchy theme. Enable “Keep these colors…” to take control.'):'Custom colors for this device, used by the System theme.';colorFields.forEach(f=>{const v=paletteColors[f.dataset.colorKey]||'#000000';f.value=v;const hex=hexFields.find(h=>h.dataset.colorHex===f.dataset.colorKey);if(hex)hex.value=v.toLowerCase()});setColorsEditable(p.kind==='custom')};
const refreshAppearanceCheckbox=()=>api.get().then(s=>{systemTheme.checked=s.whatsappTheme==='system'}).catch(()=>{});
const pushPalette=()=>{clearTimeout(paletteSaveTimer);paletteSaveTimer=setTimeout(()=>{api.setPalette({mode:paletteModeValue,colors:paletteColors}).then(p=>{applyPalette(p);setStatus('Colors saved and applied','success');return refreshAppearanceCheckbox()}).catch(()=>setStatus('Could not save colors','error'))},300)};
colorFields.forEach(f=>f.addEventListener('input',()=>{const v=f.value.toLowerCase();paletteColors[f.dataset.colorKey]=v;const hex=hexFields.find(h=>h.dataset.colorHex===f.dataset.colorKey);if(hex)hex.value=v;pushPalette()}));
hexFields.forEach(h=>h.addEventListener('change',()=>{const v=h.value.trim().toLowerCase();if(!/^#[0-9a-f]{6}$/.test(v)){h.value=(paletteColors[h.dataset.colorHex]||'').toLowerCase();setStatus('Enter a color like #1a1b26','error');return}paletteColors[h.dataset.colorHex]=v;const cf=colorFields.find(f=>f.dataset.colorKey===h.dataset.colorHex);if(cf)cf.value=v;pushPalette()}));
modeSelect.addEventListener('change',()=>{paletteModeValue=modeSelect.value;pushPalette()});
colorsPin.addEventListener('change',()=>{api.setPalettePinned(colorsPin.checked).then(p=>{applyPalette(p);setStatus(colorsPin.checked?'Colors pinned: theme changes are ignored':'Now following the Omarchy theme','success');return refreshAppearanceCheckbox()}).catch(()=>{colorsPin.checked=!colorsPin.checked;setStatus('Could not change color pinning','error')})});
resetColors.addEventListener('click',()=>{resetColors.disabled=true;api.resetPalette().then(p=>{applyPalette(p);setStatus('Colors reset','success');return refreshAppearanceCheckbox()}).catch(()=>setStatus('Could not reset colors','error')).finally(()=>{resetColors.disabled=!colorsEditable})});
api.getPalette().then(applyPalette).catch(()=>{colorsNote.textContent='Unable to load colors.';setColorsEditable(false)});
const microphoneToggle=document.getElementById('microphoneEnabled');
const cameraToggle=document.getElementById('cameraEnabled');
const applyMediaPermissions=(s)=>{microphoneToggle.checked=s.microphoneEnabled!==false;cameraToggle.checked=s.cameraEnabled!==false};
const saveMediaPermissions=()=>{
  microphoneToggle.disabled=true;cameraToggle.disabled=true;
  api.update({microphoneEnabled:microphoneToggle.checked,cameraEnabled:cameraToggle.checked})
    .then(s=>{applyMediaPermissions(s);setStatus('Media permissions saved','success')})
    .catch(()=>{setStatus('Could not save media permissions','error');return api.get().then(applyMediaPermissions)})
    .finally(()=>{microphoneToggle.disabled=false;cameraToggle.disabled=false});
};
microphoneToggle.addEventListener('change',saveMediaPermissions);
cameraToggle.addEventListener('change',saveMediaPermissions);
api.get().then(applyMediaPermissions).catch(()=>{
  microphoneToggle.disabled=true;cameraToggle.disabled=true;
  setStatus('Unable to load media permissions','error');
});</script></body></html>`;
}

function openSettings(focus?: "colors"): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 840,
    height: 700,
    minWidth: 560,
    minHeight: 480,
    title: "PrettyZap Settings",
    parent: prettyZapWindow,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "../preload/settings.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  settingsWindow.on("closed", () => { settingsWindow = undefined; });
  const loaded = settingsWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(settingsPage())}`);
  if (focus === "colors") {
    void loaded.then(() => {
      const window = settingsWindow;
      if (!window || window.isDestroyed()) return;
      void window.webContents.executeJavaScript(
        `document.getElementById("colors-card")?.scrollIntoView({ block: "start" })`,
      ).catch((error: unknown) => {
        console.warn("Unable to focus PrettyZap colors section", error);
      });
    });
  }
}

function createTray(): void {
  if (isRunningUnderOmarchy()) return;
  try {
    tray = new Tray(TRAY_ICON);
    tray.setToolTip("PrettyZap");
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: "Show PrettyZap", click: showWindow },
      { label: "Settings", click: () => openSettings() },
      { label: "Colors…", click: () => openSettings("colors") },
      { type: "separator" },
      {
        label: "Restart PrettyZap",
        click: () => {
          isQuitting = true;
          persistShellState();
          app.relaunch();
          app.exit(0);
        },
      },
      {
        label: "Quit PrettyZap",
        click: quitPrettyZap,
      },
    ]));
    tray.on("click", showWindow);
  } catch (error: unknown) {
    tray = undefined;
    console.warn("PrettyZap tray is unavailable on this desktop", error);
  }
}

function restoreAndFocusPrettyZapWindow(): void {
  const window = prettyZapWindow;
  if (!window || window.isDestroyed()) {
    pendingFocus = true;
    return;
  }

  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  publishStatus();
}

function togglePrettyZapWindow(): void {
  const window = prettyZapWindow;
  if (!window || window.isDestroyed()) {
    pendingToggle = true;
    return;
  }

  if (isWindowPresented(window)) {
    window.hide();
    publishStatus();
    return;
  }

  restoreAndFocusPrettyZapWindow();
  const webContents = whatsappWebContents;
  if (webContents) void focusActiveComposer(webContents);
}

function hidePrettyZapWindow(): void {
  const window = prettyZapWindow;
  if (window && !window.isDestroyed()) {
    window.hide();
    publishStatus();
  }
}

function updateUnreadCount(nextCount: number): void {
  const normalized = Number.isFinite(nextCount) && nextCount > 0
    ? Math.min(Math.trunc(nextCount), 999_999)
    : 0;
  if (normalized === unreadCount) return;
  unreadCount = normalized;
  publishStatus();
}

function applyNotificationPolicy(): void {
  const webContents = whatsappWebContents;
  if (!webContents || webContents.isDestroyed()) return;
  void webContents.executeJavaScript(
    notificationPolicyScript(shellState.notificationsEnabled),
    true,
  ).catch((error: unknown) => {
    console.warn("Unable to apply PrettyZap notification policy", error);
  });
}

function setNotificationsEnabled(enabled: boolean): void {
  if (!appReady) {
    console.warn("PrettyZap notification setting ignored: app is not ready");
    return;
  }
  if (shellState.notificationsEnabled === enabled) {
    applyNotificationPolicy();
    publishStatus();
    return;
  }
  shellState.notificationsEnabled = enabled;
  scheduleShellStateSave();
  applyNotificationPolicy();
  publishStatus();
}

function toggleNotifications(): void {
  setNotificationsEnabled(!shellState.notificationsEnabled);
}

// Apply the widget's fire-and-forget driver flags. Order is deliberate:
// theme and settings run first so they work even when the window action that
// follows (re)shows the app; hide beats toggle/show; an explicit toggle wins
// over show; settings/theme without a window flag imply "show the app".
function applyCliAction(action: CliAction, existingInstance = true): void {
  if (action.quit) {
    quitPrettyZap();
    return;
  }

  if (action.theme) {
    const mode: PrettyZapTheme =
      action.theme === "toggle"
        ? whatsappThemeController?.getMode() === "system"
          ? "whatsapp"
          : "system"
        : action.theme;
    whatsappThemeController?.setMode(mode);
  }

  // Notification preference changes are commands for an existing instance,
  // never a reason to launch PrettyZap solely to mutate a setting.
  if (action.notifications && existingInstance) {
    const enabled = action.notifications === "toggle"
      ? !shellState.notificationsEnabled
      : action.notifications === "on";
    setNotificationsEnabled(enabled);
  }

  if (action.settings) {
    const window = prettyZapWindow;
    if (window && !window.isDestroyed() && !isWindowPresented(window)) {
      restoreAndFocusPrettyZapWindow();
    }
    openSettings();
  }

  if (action.hide) {
    hidePrettyZapWindow();
  } else if (action.toggle) {
    const toggleAction = resolveToggleAction(existingInstance);
    if (toggleAction === "show") restoreAndFocusPrettyZapWindow();
    else togglePrettyZapWindow();
  } else if (action.show) {
    restoreAndFocusPrettyZapWindow();
  } else if (action.settings || action.theme) {
    restoreAndFocusPrettyZapWindow();
  }
}

function updateWhatsAppThemeMenu(): void {
  const mode = whatsappThemeController?.getMode();
  if (!mode) return;
  if (whatsappThemeMenuItems.whatsapp) whatsappThemeMenuItems.whatsapp.checked = mode === "whatsapp";
  if (whatsappThemeMenuItems.system) whatsappThemeMenuItems.system.checked = mode === "system";
}

async function reportWhatsAppMemory(label: string): Promise<void> {
  const appMetrics = app.getAppMetrics().map((metric) => ({
    pid: metric.pid,
    type: metric.type,
    memory: metric.memory,
  }));
  const whatsappPid = whatsappWebContents && !whatsappWebContents.isDestroyed()
    ? whatsappWebContents.getProcessId()
    : undefined;
  const whatsappMemory = appMetrics.find((metric) => metric.pid === whatsappPid) ?? null;
  console.info("PrettyZap memory", { label, appMetrics, whatsappMemory });
}

async function recoverWhatsAppMemory(): Promise<void> {
  if (recoveringMemory || !whatsappWebContents || whatsappWebContents.isDestroyed()) return;

  recoveringMemory = true;
  if (recoverMemoryMenuItem) recoverMemoryMenuItem.enabled = false;
  try {
    await reportWhatsAppMemory("before-recovery");
    const webContents = whatsappWebContents;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        webContents.removeListener("did-finish-load", onFinishedLoad);
        reject(new Error("WhatsApp reload timed out"));
      }, MEMORY_RECOVERY_TIMEOUT_MS);
      const onFinishedLoad = (): void => {
        clearTimeout(timeout);
        resolve();
      };
      webContents.once("did-finish-load", onFinishedLoad);
      try {
        webContents.reload();
      } catch (error: unknown) {
        clearTimeout(timeout);
        webContents.removeListener("did-finish-load", onFinishedLoad);
        reject(error);
      }
    });
    await reportWhatsAppMemory("after-recovery");
  } catch (error: unknown) {
    console.error("Unable to recover PrettyZap memory", error);
  } finally {
    recoveringMemory = false;
    if (recoverMemoryMenuItem) recoverMemoryMenuItem.enabled = true;
  }
}

function installApplicationMenu(): void {
  whatsappThemeMenuItems = {};
  const menu = Menu.buildFromTemplate([
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { type: "separator" },
        {
          id: "prettyzap-recover-memory",
          label: "Recover Memory",
          click: () => {
            void recoverWhatsAppMemory();
          },
        },
        { type: "separator" },
        {
          label: "Log out of WhatsApp",
          click: () => {
            void (async () => {
              await clearWhatsAppSession();
              if (whatsappWebContents && !whatsappWebContents.isDestroyed()) {
                whatsappWebContents.reload();
              }
            })();
          },
        },
        { type: "separator" },
        {
          label: "Use WhatsApp appearance",
          type: "radio",
          click: () => whatsappThemeController?.setMode("whatsapp"),
          registerAccelerator: false,
        },
        {
          label: "Use System palette",
          type: "radio",
          click: () => whatsappThemeController?.setMode("system"),
          registerAccelerator: false,
        },
      ],
    },
  ]);
  const view = menu.items[0]?.submenu;
  if (view) {
    recoverMemoryMenuItem = view.getMenuItemById("prettyzap-recover-memory") ?? undefined;
    whatsappThemeMenuItems.whatsapp = view.items.find(
      (item) => item.label === "Use WhatsApp appearance",
    );
    whatsappThemeMenuItems.system = view.items.find(
      (item) => item.label === "Use System palette",
    );
  }
  Menu.setApplicationMenu(menu);
  updateWhatsAppThemeMenu();
}

function layoutWhatsAppView(
  window: BrowserWindow,
  whatsappView: WebContentsView,
): void {
  const [contentWidth, contentHeight] = window.getContentSize();

  whatsappView.setBounds({
    x: 0,
    y: 0,
    width: contentWidth,
    height: contentHeight,
  });
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: shellState.width,
    height: shellState.height,
    minWidth: 720,
    minHeight: 520,
    title: "PrettyZap",
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  const whatsappView = new WebContentsView({
    webPreferences: {
      session: session.fromPartition(WHATSAPP_PARTITION),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, "../preload/whatsapp.js"),
    },
  });

  prettyZapWindow = window;
  whatsappWebContents = whatsappView.webContents;
  const whatsappSession = session.fromPartition(WHATSAPP_PARTITION);
  // WhatsApp Web is remote, untrusted content. Grant only the permissions its
  // actual features need (notifications are user-gated); deny everything else
  // so a compromised page cannot reach geolocation, USB/HID/serial, MIDI,
  // screen capture, or the system clipboard reader.
  const grantedPermissions = new Set<string>([
    "fullscreen", // video playback
    "clipboard-sanitized-write", // native paste button
  ]);
  const allowedPermission = (permission: string): boolean =>
    permission === "notifications"
      ? shellState.notificationsEnabled
      : grantedPermissions.has(permission);
  whatsappSession.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    const mediaTypes = (details as { mediaTypes?: string[] }).mediaTypes ?? [];
    const allowed = permission === "media"
      ? isMediaAccessAllowed(shellState, mediaTypes)
      : allowedPermission(permission);
    if (!allowed) {
      console.warn("PrettyZap denied WhatsApp Web permission request", permission);
    }
    callback(allowed);
  });
  whatsappSession.setPermissionCheckHandler((_webContents, permission, _requestingOrigin, details) => {
    if (permission === "media") {
      const mediaType = (details as { mediaType?: string }).mediaType;
      return isMediaAccessAllowed(shellState, mediaType ? [mediaType] : []);
    }
    return allowedPermission(permission);
  });
  let rendererRecoveryAttempts = 0;
  let rendererRecoveryResetTimer: ReturnType<typeof setTimeout> | undefined;

  whatsappView.webContents.setUserAgent(WHATSAPP_USER_AGENT);
  whatsappView.webContents.on("will-navigate", (event, url) => {
    if (isWhatsAppUrl(url)) return;

    event.preventDefault();
    openExternalUrl(url);
  });
  whatsappView.webContents.setWindowOpenHandler(({ url }) => {
    if (!isWhatsAppUrl(url)) openExternalUrl(url);
    return { action: "deny" };
  });
  whatsappView.webContents.on("did-fail-load", (_event, errorCode, errorDescription) => {
    console.error("Unable to load WhatsApp Web", errorCode, errorDescription);
  });
  whatsappView.webContents.on("page-title-updated", (_event, title) => {
    updateUnreadCount(parseUnreadCount(title));
  });
  whatsappView.webContents.on("did-finish-load", () => {
    updateUnreadCount(parseUnreadCount(whatsappView.webContents.getTitle()));
    applyNotificationPolicy();
    if (rendererRecoveryResetTimer) clearTimeout(rendererRecoveryResetTimer);
    rendererRecoveryResetTimer = setTimeout(() => {
      rendererRecoveryResetTimer = undefined;
      rendererRecoveryAttempts = 0;
    }, 60_000);
  });
  whatsappView.webContents.on("render-process-gone", (_event, details) => {
    console.error("WhatsApp renderer process exited", details);
    if (details.reason === "clean-exit" || rendererRecoveryAttempts >= 2) return;
    rendererRecoveryAttempts += 1;
    setTimeout(() => {
      if (whatsappView.webContents.isDestroyed()) return;
      try {
        whatsappView.webContents.reload();
      } catch (error: unknown) {
        console.error("Unable to reload WhatsApp after renderer failure", error);
      }
    }, 1_000);
  });

  window.contentView.addChildView(whatsappView);
  layoutWhatsAppView(window, whatsappView);

  removeDrawerFeature =
    process.env.PRETTYZAP_DISABLE_DRAWER === "1"
      ? () => undefined
      : installWhatsAppDrawer(whatsappView.webContents, shellState.drawerCollapsed, shellState.shortcuts);

  const themeController = installWhatsAppTheme(
    whatsappView.webContents,
    shellState.whatsappTheme,
    (mode) => {
      shellState.whatsappTheme = mode;
      scheduleShellStateSave();
      updateWhatsAppThemeMenu();
      publishStatus();
    },
    // On Omarchy the saved palette only applies while pinned; elsewhere the
    // custom palette is always active.
    () => shellState.colorsPinned || !isRunningUnderOmarchy(),
  );
  whatsappThemeController = themeController;

  if (shellState.maximized) window.maximize();

  void whatsappView.webContents.loadURL(WHATSAPP_URL).catch((error: unknown) => {
    console.error("Unable to load WhatsApp Web", error);
  });
  window.on("resize", () => {
    layoutWhatsAppView(window, whatsappView);
    updateWindowState(window);
  });
  window.on("maximize", () => updateWindowState(window));
  window.on("unmaximize", () => updateWindowState(window));
  window.on("show", () => publishStatus());
  window.on("hide", () => publishStatus());
  window.on("minimize", () => publishStatus());
  window.on("restore", () => publishStatus());
  window.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      window.hide();
      publishStatus();
      return;
    }
    persistShellState();
  });
  window.on("closed", () => {
    if (rendererRecoveryResetTimer) clearTimeout(rendererRecoveryResetTimer);
    removeDrawerFeature?.();
    removeDrawerFeature = undefined;
    themeController?.dispose();
    if (whatsappThemeController === themeController) whatsappThemeController = undefined;
    if (prettyZapWindow === window) prettyZapWindow = undefined;
    if (whatsappWebContents === whatsappView.webContents) {
      whatsappWebContents = undefined;
      updateUnreadCount(0);
    }
    if (!whatsappView.webContents.isDestroyed()) {
      whatsappView.webContents.close();
    }
  });
  window.on("ready-to-show", () => {
    appReady = true;
    publishStatus();
  });
}

ipcMain.on(DRAWER_STATE_CHANNEL, (event, value: unknown) => {
  if (!whatsappWebContents || event.sender.id !== whatsappWebContents.id) return;
  if (!value || typeof value !== "object" || typeof (value as { collapsed?: unknown }).collapsed !== "boolean") return;
  shellState.drawerCollapsed = (value as { collapsed: boolean }).collapsed;
  scheduleShellStateSave();
});

ipcMain.on(WHATSAPP_UNREAD_CHANNEL, (event, value: unknown) => {
  if (!whatsappWebContents || event.sender.id !== whatsappWebContents.id) return;
  if (typeof value !== "number" || !Number.isFinite(value)) return;
  updateUnreadCount(value);
});

ipcMain.handle(SETTINGS_GET_CHANNEL, (event) => {
  if (!isSettingsSender(event)) return null;
  return settingsSnapshot();
});
ipcMain.handle(SETTINGS_UPDATE_CHANNEL, (event, value: unknown) => {
  if (!isSettingsSender(event)) return null;
  if (!value || typeof value !== "object") return settingsSnapshot();
  const candidate = value as Partial<ShellState>;
  if (typeof candidate.drawerCollapsed === "boolean") shellState.drawerCollapsed = candidate.drawerCollapsed;
  if (candidate.whatsappTheme === "system" || candidate.whatsappTheme === "whatsapp") {
    shellState.whatsappTheme = candidate.whatsappTheme;
    whatsappThemeController?.setMode(candidate.whatsappTheme);
  }
  if (typeof candidate.notificationsEnabled === "boolean") {
    setNotificationsEnabled(candidate.notificationsEnabled);
  }
  if (typeof candidate.microphoneEnabled === "boolean") {
    shellState.microphoneEnabled = candidate.microphoneEnabled;
  }
  if (typeof candidate.cameraEnabled === "boolean") {
    shellState.cameraEnabled = candidate.cameraEnabled;
  }
  if (typeof candidate.signOutOnQuit === "boolean") {
    shellState.signOutOnQuit = candidate.signOutOnQuit;
  }
  if (candidate.shortcuts && typeof candidate.shortcuts === "object") {
    Object.assign(shellState.shortcuts, normalizeShortcutPreferences(candidate.shortcuts));
  }
  scheduleShellStateSave();
  return settingsSnapshot();
});

ipcMain.on(SETTINGS_CLOSE_CHANNEL, (event) => {
  if (settingsWindow && !settingsWindow.isDestroyed() && event.sender.id === settingsWindow.webContents.id) {
    settingsWindow.close();
  }
});

ipcMain.handle(PALETTE_GET_CHANNEL, (event) => {
  if (!isSettingsSender(event)) return null;
  return paletteSnapshot();
});

ipcMain.handle(PALETTE_SET_CHANNEL, (event, value: unknown) => {
  if (!isSettingsSender(event)) return null;
  const palette = recordToPalette(value);
  if (!palette) return paletteSnapshot();
  writePrettyZapPalette(palette);
  shellState.colorsPinned = true;
  scheduleShellStateSave();
  whatsappThemeController?.refreshPalette();
  // Saving/pinning colors implies the user wants to see them: switch the
  // System theme on when it was left on WhatsApp's own appearance.
  if (whatsappThemeController?.getMode() !== "system") {
    whatsappThemeController?.setMode("system");
  }
  return paletteSnapshot();
});

ipcMain.handle(PALETTE_PIN_CHANNEL, (event, value: unknown) => {
  if (!isSettingsSender(event)) return null;
  const pinned = value === true;
  if (pinned) {
    // "Keep these colors even when the theme changes": always replace any
    // previous custom snapshot with the palette currently applied to
    // WhatsApp. Reusing an old colors.toml here can restore a stale/default
    // palette after the user has changed the Omarchy theme or unpinned once.
    const currentPalette = whatsappThemeController?.getCurrentPalette();
    const paletteToPin = currentPalette ?? readOmarchyPalette() ?? readPrettyZapPalette() ?? DEFAULT_CUSTOM_PALETTE;
    writePrettyZapPalette(paletteToPin);
    const underOmarchy = isRunningUnderOmarchy();
    if (underOmarchy && whatsappThemeController?.getMode() !== "system") {
      whatsappThemeController?.setMode("system");
    }
    shellState.colorsPinned = true;
    scheduleShellStateSave();
  } else {
    shellState.colorsPinned = false;
    scheduleShellStateSave();
  }
  whatsappThemeController?.refreshPalette();
  return paletteSnapshot();
});

ipcMain.handle(PALETTE_RESET_CHANNEL, (event) => {
  if (!isSettingsSender(event)) return null;
  removePrettyZapPalette();
  shellState.colorsPinned = false;
  scheduleShellStateSave();
  whatsappThemeController?.refreshPalette();
  return paletteSnapshot();
});

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, commandLine) => {
    applyCliAction(parseCliArgs(commandLine), true);
  });

  app.whenReady().then(() => {
    console.info("PrettyZap GPU status", app.getGPUFeatureStatus());
    createWindow();
    installApplicationMenu();
    createTray();
    publishStatus();
    void startDesktopControl({
      show: showWindow,
      hide: hidePrettyZapWindow,
      toggle: togglePrettyZapWindow,
      openSettings,
      setTheme: (theme) => applyCliAction({ theme }),
      toggleNotifications,
      quit: quitPrettyZap,
      getStatus: publishStatus,
    }).then((control) => {
      desktopControl = control;
      if (control) publishStatus();
    });

    if (pendingToggle) {
      pendingToggle = false;
      togglePrettyZapWindow();
    }
    if (pendingFocus) {
      pendingFocus = false;
      restoreAndFocusPrettyZapWindow();
    }

    // Driver flags passed to the first instance (e.g. `prettyzap --settings`
    // or `prettyzap --theme system` when nothing is running yet).
    applyCliAction(parseCliArgs(process.argv.slice(1)), false);

    const registered = globalShortcut.register(SHOW_HIDE_ACCELERATOR, () => {
      togglePrettyZapWindow();
    });
    if (!registered) {
      console.warn(
        `Unable to register PrettyZap global shortcut: ${SHOW_HIDE_ACCELERATOR}`,
      );
    }

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      } else {
        restoreAndFocusPrettyZapWindow();
      }
    });
  });

  app.on("will-quit", () => {
    isQuitting = true;
    persistShellState();
    clearStatus();
    desktopControl?.close();
    desktopControl = undefined;
    tray?.destroy();
    tray = undefined;
    globalShortcut.unregister(SHOW_HIDE_ACCELERATOR);
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });
}
