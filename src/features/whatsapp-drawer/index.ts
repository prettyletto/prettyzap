import type { WebContents } from "electron";
import { focusActiveComposer, recoverFocusAfterEscape } from "../whatsapp-focus";
import { waitForWhatsAppShell } from "../whatsapp-readiness";
import { whatsappDrawerSelectors } from "./selectors";
import type { ShortcutPreferences } from "../../main/shell-state";

const TOGGLE_ID = "prettyzap-whatsapp-drawer-toggle";
const DRAWER_STATE_EVENT = "prettyzap-drawer-state";
const STYLE_ID = "prettyzap-whatsapp-drawer-style";
const CHAT_CYCLE_IDLE_MS = 700;
// Below this viewport width the chat list and conversation no longer fit
// side by side (e.g. a half-screen tile), so the drawer collapses on its own.
const AUTO_COLLAPSE_WIDTH = 1000;
const NAVIGATION_SHORTCUTS = {
  "1": "chats",
  "2": "calls",
  "3": "status",
  "4": "channels",
  "5": "communities",
  "6": "metaAi",
  "7": "media",
  "8": "you",
} as const;

function matchesShortcut(input: Electron.Input, shortcut: string): boolean {
  if (input.type !== "keyDown") return false;
  const parts = shortcut.toLowerCase().split("+").map((part) => part.trim()).filter(Boolean);
  const key = parts.pop();
  if (!key) return false;
  const hasModifier = (name: string): boolean => parts.includes(name);
  const usesCommand = input.control || input.meta;

  if (hasModifier("ctrl") || hasModifier("cmd")) {
    if (!usesCommand) return false;
  } else if (usesCommand) {
    return false;
  }
  if (input.alt !== hasModifier("alt") || input.shift !== hasModifier("shift")) return false;
  if (key === "enter") return input.key === "Enter";
  if (key === "space") return input.key === " " || input.key === "Spacebar";
  if (key === "/") return input.key === "/" || input.code === "Slash";
  if (/^\d$/.test(key)) return input.key === key || input.code === `Digit${key}`;
  return input.key.toLowerCase() === key;
}

const toggleDrawerScript = `(() => {
  const button = document.getElementById(${JSON.stringify(TOGGLE_ID)});
  if (!(button instanceof HTMLButtonElement)) return false;
  button.click();
  return true;
})()`;

const resetArchivedChatCycleScript = `(() => {
  window.__prettyzapChatCycleIndex = -1;
  window.__prettyzapChatCycleView = "archived";
})()`;

function createFocusSearchScript(): string {
  const selectors = JSON.stringify(whatsappDrawerSelectors);

  return `(() => {
    const selectors = ${selectors};
    const root = document.querySelector(selectors.applicationRoot);
    const search = document.querySelector(selectors.chatListSearch);
    const toggle = document.getElementById(${JSON.stringify(TOGGLE_ID)});

    if (!(search instanceof HTMLInputElement)) return false;

    if (
      root?.getAttribute("data-prettyzap-drawer-collapsed") === "true" &&
      toggle instanceof HTMLButtonElement
    ) {
      toggle.click();
    }

    window.requestAnimationFrame(() => {
      search.focus({ preventScroll: true });
      search.select();
    });
    return true;
  })()`;
}

function createNavigationScript(navigationKey: string): string {
  const selectors = JSON.stringify(whatsappDrawerSelectors);

  return `(() => {
    const selectors = ${selectors};
    const root = document.querySelector(selectors.applicationRoot);
    const toggle = document.getElementById(${JSON.stringify(TOGGLE_ID)});
    const targetSelector = selectors.navigationButtons[${JSON.stringify(navigationKey)}];
    const target = targetSelector ? document.querySelector(targetSelector) : null;

    if (!(target instanceof HTMLButtonElement)) return false;

    if (
      root?.getAttribute("data-prettyzap-drawer-collapsed") === "true" &&
      toggle instanceof HTMLButtonElement
    ) {
      toggle.click();
    }

    target.click();
    return true;
  })()`;
}

function createScrollConversationScript(direction: "up" | "down"): string {
  const selectors = JSON.stringify(whatsappDrawerSelectors);
  const multiplier = direction === "down" ? 1 : -1;

  return `(() => {
    const selectors = ${selectors};
    const messages = document.querySelector(selectors.conversationMessages);
    if (!(messages instanceof HTMLElement)) return false;

    const distance = Math.max(240, messages.clientHeight * 0.75);
    messages.scrollBy({ top: distance * ${multiplier}, behavior: "smooth" });
    return true;
  })()`;
}

function createOpenArchivedScript(): string {
  const selectors = JSON.stringify(whatsappDrawerSelectors);

  return `(() => {
    const selectors = ${selectors};
    const root = document.querySelector(selectors.applicationRoot);
    const toggle = document.getElementById(${JSON.stringify(TOGGLE_ID)});
    const chatsButton = document.querySelector(selectors.navigationButtons.chats);

    const isVisible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" &&
        style.visibility !== "hidden" &&
        rect.width > 0 &&
        rect.height > 0;
    };

    const findArchivedEntry = () => {
      const candidates = [...document.querySelectorAll("*")].filter((element) => {
        const label = element.textContent?.replace(/\\s+/g, " ").trim() ?? "";
        if (label !== "Archived" && !/^Archived[0-9]+$/.test(label)) return false;
        return isVisible(element);
      });

      return candidates.sort((left, right) => {
        const leftRect = left.getBoundingClientRect();
        const rightRect = right.getBoundingClientRect();
        return leftRect.width * leftRect.height - rightRect.width * rightRect.height;
      })[0];
    };

    const archivedListIsVisible = () => isVisible(document.querySelector(selectors.archivedChatList));
    if (archivedListIsVisible()) return false;

    // Always return to WhatsApp's root Chats list first. This makes the
    // shortcut independent of the current Calls/Status/Channels/etc. tab and
    // avoids measuring coordinates while the drawer is still resizing.
    if (
      root?.getAttribute("data-prettyzap-drawer-collapsed") === "true" &&
      toggle instanceof HTMLButtonElement
    ) {
      toggle.click();
    }
    // This is deliberately the same root action as Ctrl+1: always activate
    // the Chats tab, even when WhatsApp's selected-state attributes are stale
    // during a tab or drawer transition.
    if (chatsButton instanceof HTMLButtonElement) chatsButton.click();

    return new Promise((resolve) => {
      const deadline = Date.now() + 900;
      let settled = false;
      let observer;
      let retryId;
      let timeoutId;

      const finish = (entry) => {
        if (settled) return;
        settled = true;
        observer?.disconnect();
        window.cancelAnimationFrame(retryId);
        window.clearTimeout(timeoutId);
        if (!(entry instanceof HTMLElement)) {
          resolve(null);
          return;
        }
        const rect = entry.getBoundingClientRect();
        resolve({
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
          archivedLabel: entry.textContent?.trim(),
          archivedHtml: entry.outerHTML.slice(0, 200),
        });
      };

      const inspect = () => {
        const collapsed = root?.getAttribute("data-prettyzap-drawer-collapsed") === "true";
        const entry = !collapsed && !archivedListIsVisible() ? findArchivedEntry() : null;
        if (entry) {
          finish(entry);
          return;
        }
        if (Date.now() >= deadline) finish(findArchivedEntry());
        else retryId = window.requestAnimationFrame(inspect);
      };

      observer = new MutationObserver(inspect);
      if (document.documentElement) {
        observer.observe(document.documentElement, {
          childList: true,
          subtree: true,
          attributes: true,
        });
      }
      timeoutId = window.setTimeout(() => finish(findArchivedEntry()), 950);
      inspect();
    });
  })()`;
}

function createCycleChatsScript(direction: "forward" | "backward"): string {
  const selectors = JSON.stringify(whatsappDrawerSelectors);
  const step = direction === "forward" ? 1 : -1;

  return `(() => {
    const selectors = ${selectors};
    const root = document.querySelector(selectors.applicationRoot);
    const toggle = document.getElementById(${JSON.stringify(TOGGLE_ID)});
    const wasCollapsed = root?.getAttribute("data-prettyzap-drawer-collapsed") === "true";

    // Restore WhatsApp's own layout before measuring the target. The main
    // process will send a real mouse event at this coordinate, rather than
    // relying on a synthetic DOM click that WhatsApp may ignore.
    if (wasCollapsed && toggle instanceof HTMLButtonElement) {
      toggle.click();
    }

    return new Promise((resolve) => {
      window.requestAnimationFrame(() => {
        const archivedList = document.querySelector(selectors.archivedChatList);
        const isArchivedView = archivedList instanceof HTMLElement;
        const rowSelector = isArchivedView
          ? selectors.archivedChatListRows
          : selectors.chatListRows;
        const rowContainer = (row) => isArchivedView ? row : row.closest('[role="row"]');
        const isVisibleConversationRow = (row) => {
          const container = rowContainer(row);
          const label = container?.textContent?.trim() ?? "";
          const rect = container?.getBoundingClientRect();
          const elementAtCenter = rect
            ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
            : null;
          return Boolean(
            label &&
            (isArchivedView || !label.startsWith("Archived")) &&
            rect &&
            rect.width > 0 &&
            rect.height > 0 &&
            elementAtCenter &&
            container?.contains(elementAtCenter),
          );
        };
        const getRows = () => [...document.querySelectorAll(rowSelector)]
          .filter(isVisibleConversationRow)
          .map((element) => {
            const item = element.closest('[data-testid^="list-item-"]');
            const match = item?.getAttribute("data-testid")?.match(/list-item-(\\d+)$/);
            return { element, index: match ? Number(match[1]) : -1 };
          })
          .filter((row) => row.index >= 0)
          .sort((left, right) => left.index - right.index);
        const findScrollContainer = (element) => {
          let current = element.parentElement;
          while (current && current !== document.body) {
            if (current.scrollHeight > current.clientHeight + 1) return current;
            current = current.parentElement;
          }
          return null;
        };

        const stateKey = "__prettyzapChatCycleIndex";
        const viewKey = "__prettyzapChatCycleView";
        const currentView = isArchivedView ? "archived" : "chats";
        if (window[viewKey] !== currentView) {
          window[viewKey] = currentView;
          window[stateKey] = -1;
        }

        const currentIndex = Number.isInteger(window[stateKey]) ? window[stateKey] : -1;
        const chooseTarget = (rows) => {
          if (currentIndex < 0) return rows[0];
          return ${step} > 0
            ? rows.find((row) => row.index > currentIndex)
            : [...rows].reverse().find((row) => row.index < currentIndex);
        };
        const resolveTarget = (target) => {
          if (!target?.element || !(target.element instanceof HTMLElement)) {
            resolve(null);
            return;
          }

          window[stateKey] = target.index;
          target.element.scrollIntoView({ block: "nearest" });
          const rect = target.element.getBoundingClientRect();
          resolve({
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
            wasCollapsed,
          });
        };

        const rows = getRows();
        const target = chooseTarget(rows);
        if (target) {
          resolveTarget(target);
          return;
        }

        // WhatsApp virtualizes both chat lists. At the rendered edge, move its
        // own scroll container first, then choose a newly rendered neighbor.
        const edgeRow = ${step} > 0 ? rows.at(-1) : rows[0];
        const scrollContainer = edgeRow ? findScrollContainer(edgeRow.element) : null;
        if (!(scrollContainer instanceof HTMLElement)) {
          resolve(null);
          return;
        }

        scrollContainer.scrollTop += ${step} * Math.max(160, scrollContainer.clientHeight * 0.75);
        window.setTimeout(() => resolveTarget(chooseTarget(getRows())), 80);
      });
    });
  })()`;
}

const drawerRoot = '[data-testid="wa-web-main-screen"][data-prettyzap-drawer-collapsed="true"]';
const drawerStyle = `
  /* WhatsApp's fixed min-width on the pane row makes the page scroll
     sideways in narrow windows, cropping the conversation's right edge. */
  ${whatsappDrawerSelectors.layoutRow} {
    min-width: 0 !important;
  }

  /* Resize the actual sidebar flex pane; do not hide its descendants. */
  ${drawerRoot} ${whatsappDrawerSelectors.chatListShell} {
    flex: 0 0 0 !important;
    width: 0 !important;
    min-width: 0 !important;
    max-width: 0 !important;
    padding: 0 !important;
    border: 0 !important;
    overflow: hidden !important;
  }

  ${drawerRoot} ${whatsappDrawerSelectors.chatListShell} #side,
  ${drawerRoot} ${whatsappDrawerSelectors.chatListShell} #side * {
    overflow: hidden !important;
  }

  ${drawerRoot} [data-testid="drawer-left"],
  ${drawerRoot} [data-testid="drawer-middle"] {
    border-inline-start-width: 0 !important;
    border-inline-end-width: 0 !important;
  }

  ${drawerRoot} [data-testid="drawer-middle"],
  ${drawerRoot} [data-testid="conversation-panel-wrapper"] {
    flex: 1 1 auto !important;
    width: auto !important;
    min-width: 0 !important;
  }

  ${whatsappDrawerSelectors.navigationRail} {
    position: relative !important;
    z-index: 2147483640 !important;
    box-sizing: border-box !important;
    overflow: visible !important;
    border-right: 1px solid rgba(255, 255, 255, 0.1) !important;
  }

  #${TOGGLE_ID} {
    position: fixed !important;
    top: 50% !important;
    right: auto !important;
    left: 50px !important;
    z-index: 2147483647 !important;
    display: grid !important;
    width: 28px !important;
    height: 28px !important;
    padding: 0 !important;
    place-items: center !important;
    transform: translateY(-50%) !important;
    border: 1px solid rgba(202, 204, 204, 0.2) !important;
    border-radius: 50% !important;
    color: rgba(202, 204, 204, 0.84) !important;
    background: rgba(16, 19, 21, 0.92) !important;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.24) !important;
    cursor: pointer !important;
  }

  #${TOGGLE_ID}:hover {
    border-color: rgba(121, 129, 134, 0.9) !important;
    color: #ffffff !important;
    background: rgba(52, 61, 65, 0.96) !important;
  }

  #${TOGGLE_ID}:focus-visible {
    outline: 2px solid #53bdeb !important;
    outline-offset: 2px !important;
  }

  #${TOGGLE_ID} svg {
    width: 15px !important;
    height: 15px !important;
    fill: none !important;
    stroke: currentColor !important;
    stroke-linecap: round !important;
    stroke-linejoin: round !important;
    stroke-width: 1.7 !important;
  }
`;

function createDrawerScript(initialCollapsed: boolean): string {
  const selectors = JSON.stringify(whatsappDrawerSelectors);

  return `(() => {
    const selectors = ${selectors};
    const toggleId = ${JSON.stringify(TOGGLE_ID)};
    const styleId = ${JSON.stringify(STYLE_ID)};
    const root = document.querySelector(selectors.applicationRoot);
    const rail = document.querySelector(selectors.navigationRail);

    if (!root || !rail) {
      return {
        installed: false,
        hasRoot: Boolean(root),
        hasRail: Boolean(rail),
        hasChatList: Boolean(document.querySelector(selectors.chatListColumn)),
      };
    }

    if (!document.getElementById(styleId)) {
      const style = document.createElement("style");
      style.id = styleId;
      style.textContent = ${JSON.stringify(drawerStyle)};
      document.head.appendChild(style);
    }

    if (!window.__prettyzapArchivedCycleResetInstalled) {
      document.addEventListener("click", (event) => {
        const clickedArchivedEntry = event.composedPath().some((entry) => {
          if (!(entry instanceof Element)) return false;
          const label = entry.textContent?.replace(/\s+/g, " ").trim() ?? "";
          return label === "Archived" || /^Archived[0-9]+$/.test(label);
        });
        if (!clickedArchivedEntry) return;

        // WhatsApp reuses list-item indexes in the Archived view. Reset
        // before its click handler swaps the visible chat list.
        window.__prettyzapChatCycleIndex = -1;
        window.__prettyzapChatCycleView = "archived";
      }, true);
      window.__prettyzapArchivedCycleResetInstalled = true;
    }

    const autoCollapseWidth = ${JSON.stringify(AUTO_COLLAPSE_WIDTH)};
    const isNarrow = () => window.innerWidth < autoCollapseWidth;

    const setCollapsed = (collapsed, notify = true) => {
      root.setAttribute("data-prettyzap-drawer-collapsed", String(collapsed));
      if (notify) {
        window.__prettyzapDrawerPreferred = collapsed;
        document.dispatchEvent(new CustomEvent(${JSON.stringify(DRAWER_STATE_EVENT)}, {
          detail: { collapsed },
        }));
      }
      const button = document.getElementById(toggleId);
      if (!button) return;

      button.setAttribute("aria-expanded", String(!collapsed));
      button.setAttribute(
        "aria-label",
        collapsed ? "Expand WhatsApp chat list" : "Collapse WhatsApp chat list",
      );
      button.innerHTML = collapsed
        ? '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3 5 5-5 5" /></svg>'
        : '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m10 3-5 5 5 5" /></svg>';
    };

    if (!window.__prettyzapPickerDrawerAssistInstalled) {
      let pickerObserver;
      let pickerCheckFrame;
      let pickerMissingTimer;

      const stopWatchingPicker = () => {
        pickerObserver?.disconnect();
        pickerObserver = undefined;
        window.cancelAnimationFrame(pickerCheckFrame);
        window.clearTimeout(pickerMissingTimer);
        pickerMissingTimer = undefined;
      };

      const restoreTemporaryCollapse = () => {
        stopWatchingPicker();
        if (root.getAttribute("data-prettyzap-picker-drawer-assisted") !== "true") return;
        root.removeAttribute("data-prettyzap-picker-drawer-assisted");
        setCollapsed(true, false);
      };

      const isVisible = (element) => {
        if (!(element instanceof HTMLElement) || !element.isConnected) return false;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" &&
          rect.width > 0 && rect.height > 0;
      };

      const watchForPickerClose = () => {
        let attempts = 0;
        let activePanel;

        const locatePickerPanel = () => {
          const candidates = [...document.querySelectorAll(
            '[role="menu"], [role="dialog"], [role="listbox"], [aria-modal="true"]',
          )].filter((element) => {
            if (!isVisible(element)) return false;
            const rect = element.getBoundingClientRect();
            return rect.width >= 120 && rect.height >= 80;
          });
          return candidates
            .sort((left, right) => {
              const leftRect = left.getBoundingClientRect();
              const rightRect = right.getBoundingClientRect();
              return rightRect.width * rightRect.height - leftRect.width * leftRect.height;
            })[0];
        };

        const findPickerPanel = () => {
          if (root.getAttribute("data-prettyzap-picker-drawer-assisted") !== "true") return;

          activePanel = locatePickerPanel();
          if (!(activePanel instanceof HTMLElement)) {
            attempts += 1;
            if (attempts < 20) window.setTimeout(findPickerPanel, 50);
            return;
          }

          const checkPicker = () => {
            if (pickerCheckFrame) return;
            pickerCheckFrame = window.requestAnimationFrame(() => {
              pickerCheckFrame = undefined;
              if (root.getAttribute("data-prettyzap-picker-drawer-assisted") !== "true") {
                stopWatchingPicker();
                return;
              }
              if (isVisible(activePanel)) {
                window.clearTimeout(pickerMissingTimer);
                pickerMissingTimer = undefined;
                return;
              }
              if (pickerMissingTimer) return;

              // Picker/menu animations can replace short-lived wrappers.
              // Briefly wait for a semantic successor before treating this
              // as a close, then return to the user's collapsed state.
              pickerMissingTimer = window.setTimeout(() => {
                pickerMissingTimer = undefined;
                const replacement = locatePickerPanel();
                if (replacement instanceof HTMLElement) {
                  activePanel = replacement;
                  return;
                }
                restoreTemporaryCollapse();
              }, 500);
            });
          };
          pickerObserver = new MutationObserver(checkPicker);
          pickerObserver.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ["class", "style", "hidden", "aria-hidden"],
          });
        };
        window.setTimeout(findPickerPanel, 50);
      };

      document.addEventListener("click", (event) => {
        if (root.getAttribute("data-prettyzap-drawer-collapsed") !== "true") return;

        const composer = document.querySelector(selectors.messageComposer);
        const composerRect = composer instanceof HTMLElement
          ? composer.getBoundingClientRect()
          : null;
        let attachmentTrigger = false;
        const trigger = event.composedPath().find((entry) => {
          if (!(entry instanceof HTMLElement) || !entry.matches('button, [role="button"]')) {
            return false;
          }
          const icon = entry.querySelector("[data-icon]")?.getAttribute("data-icon") ?? "";
          const description = [
            entry.getAttribute("aria-label"),
            entry.getAttribute("title"),
            entry.getAttribute("data-testid"),
            entry.getAttribute("data-icon"),
            icon,
          ].filter(Boolean).join(" ");
          const describedPicker = /(emoji|sticker|gif|smiley|emoticon)/i.test(description);
          if (describedPicker) return true;
          const describedAttachment = /(^|[-_\s])(attach|attachment|plus)([-_\s]|$)/i.test(description) ||
            /add\s+(file|media|photo|video|document)/i.test(description);
          if (describedAttachment) {
            attachmentTrigger = true;
            return true;
          }

          // WhatsApp sometimes strips useful labels from the + button. Fall
          // back to its stable visual relationship with the native composer:
          // accessory buttons sit immediately to the input's left.
          if (!composerRect) return false;
          const triggerRect = entry.getBoundingClientRect();
          const verticallyAligned = triggerRect.top < composerRect.bottom &&
            triggerRect.bottom > composerRect.top;
          const leftOfComposer = triggerRect.right <= composerRect.left + 12 &&
            composerRect.left - triggerRect.left <= 180;
          if (verticallyAligned && leftOfComposer) {
            attachmentTrigger = composerRect.left - triggerRect.right > 20;
          }
          return verticallyAligned && leftOfComposer;
        });
        if (!trigger) return;

        if (attachmentTrigger) {
          // Expanding moves the + button while its original pointer event is
          // still propagating. WhatsApp can then treat that same event as an
          // outside click and immediately dismiss the menu. Replay it only
          // after the expanded layout has settled.
          event.preventDefault();
          event.stopImmediatePropagation();
        }

        // WhatsApp positions its native picker and attachment popovers
        // correctly only with the chat list present. Expand synchronously
        // during the trigger's capture phase, but do not persist this state.
        root.setAttribute("data-prettyzap-picker-drawer-assisted", "true");
        setCollapsed(false, false);
        watchForPickerClose();
        if (attachmentTrigger) {
          window.requestAnimationFrame(() => {
            window.requestAnimationFrame(() => trigger.click());
          });
        }
      }, true);

      document.addEventListener("keydown", (event) => {
        if (event.key !== "Escape" ||
            root.getAttribute("data-prettyzap-picker-drawer-assisted") !== "true") return;
        window.setTimeout(restoreTemporaryCollapse, 0);
      }, true);
      window.__prettyzapPickerDrawerAssistInstalled = true;
    }

    let button = document.getElementById(toggleId);
    if (!button) {
      button = document.createElement("button");
      button.id = toggleId;
      button.type = "button";
      button.addEventListener("click", () => {
        root.removeAttribute("data-prettyzap-picker-drawer-assisted");
        const collapsed = root.getAttribute("data-prettyzap-drawer-collapsed") === "true";
        // In a narrow window, opening the list is a temporary peek; keep the
        // saved preference for when the window is wide again.
        setCollapsed(!collapsed, !isNarrow());
      });
      rail.appendChild(button);
    }

    const existingCollapsed = root.getAttribute("data-prettyzap-drawer-collapsed");
    if (typeof window.__prettyzapDrawerPreferred !== "boolean") {
      window.__prettyzapDrawerPreferred = existingCollapsed === null
        ? ${JSON.stringify(initialCollapsed)}
        : existingCollapsed === "true";
    }
    setCollapsed(isNarrow() || window.__prettyzapDrawerPreferred, false);

    if (!window.__prettyzapAutoCollapseInstalled) {
      let wasNarrow = isNarrow();
      let resizeFrame;
      window.addEventListener("resize", () => {
        window.cancelAnimationFrame(resizeFrame);
        resizeFrame = window.requestAnimationFrame(() => {
          const narrow = isNarrow();
          if (narrow === wasNarrow) return;
          wasNarrow = narrow;
          root.removeAttribute("data-prettyzap-picker-drawer-assisted");
          setCollapsed(narrow || window.__prettyzapDrawerPreferred, false);
        });
      });
      window.__prettyzapAutoCollapseInstalled = true;
    }
    return {
      installed: true,
      collapsed: root.getAttribute("data-prettyzap-drawer-collapsed"),
    };
  })()`;
}

export function installWhatsAppDrawer(
  webContents: WebContents,
  initialCollapsed = true,
  shortcuts: ShortcutPreferences,
): () => void {
  let cycleHideTimer: ReturnType<typeof setTimeout> | undefined;
  let escapeFocusRecoveryTimer: ReturnType<typeof setTimeout> | undefined;
  let cycleOpenedDrawer = false;
  let disposed = false;
  let loadGeneration = 0;
  const focusSearchScript = createFocusSearchScript();
  const scrollUpScript = createScrollConversationScript("up");
  const scrollDownScript = createScrollConversationScript("down");
  const openArchivedScript = createOpenArchivedScript();
  const cycleChatsForwardScript = createCycleChatsScript("forward");
  const cycleChatsBackwardScript = createCycleChatsScript("backward");
  const navigationScripts = Object.fromEntries(
    Object.entries(NAVIGATION_SHORTCUTS).map(([key, navigationKey]) => [
      key,
      createNavigationScript(navigationKey),
    ]),
  );
  const onBeforeInput = (event: Electron.Event, input: Electron.Input): void => {
    const isPlainEscape =
      input.type === "keyDown" &&
      !input.control &&
      !input.meta &&
      !input.alt &&
      !input.shift &&
      input.key === "Escape";

    if (isPlainEscape) {
      if (escapeFocusRecoveryTimer) clearTimeout(escapeFocusRecoveryTimer);
      escapeFocusRecoveryTimer = setTimeout(() => {
        escapeFocusRecoveryTimer = undefined;
        void recoverFocusAfterEscape(webContents);
      }, 0);
      return;
    }

    const isToggleShortcut = matchesShortcut(input, shortcuts.toggleDrawer);
    const isSearchShortcut = matchesShortcut(input, shortcuts.search);
    const isScrollDownShortcut = matchesShortcut(input, shortcuts.scrollDown);
    const isScrollUpShortcut = matchesShortcut(input, shortcuts.scrollUp);
    const isFocusComposerShortcut = matchesShortcut(input, shortcuts.focusComposer) ||
      (input.type === "keyDown" && (input.control || input.meta) && !input.alt && !input.shift && input.key === "Enter");
    const isOpenArchivedShortcut = matchesShortcut(input, shortcuts.openArchived);
    const isCycleChatsForwardShortcut = matchesShortcut(input, shortcuts.cycleForward);
    const isCycleChatsBackwardShortcut = matchesShortcut(input, shortcuts.cycleBackward);
    const navigationKey = Object.entries(shortcuts.navigation).find(([, shortcut]) =>
      matchesShortcut(input, shortcut),
    )?.[0];
    const navigationScript = navigationKey ? navigationScripts[navigationKey] : undefined;

    if (
      !isToggleShortcut &&
      !isSearchShortcut &&
      !navigationScript &&
      !isScrollDownShortcut &&
      !isScrollUpShortcut &&
      !isFocusComposerShortcut &&
      !isOpenArchivedShortcut &&
      !isCycleChatsForwardShortcut &&
      !isCycleChatsBackwardShortcut
    ) {
      return;
    }

    event.preventDefault();
    const script = isToggleShortcut
      ? toggleDrawerScript
      : isSearchShortcut
        ? focusSearchScript
        : navigationScript
          ? navigationScript
          : isScrollDownShortcut
            ? scrollDownScript
            : isScrollUpShortcut
              ? scrollUpScript
              : isFocusComposerShortcut
                ? undefined
                : isOpenArchivedShortcut
                  ? openArchivedScript
                  : isCycleChatsForwardShortcut
                  ? cycleChatsForwardScript
                  : cycleChatsBackwardScript;
    if (!script) {
      if (isFocusComposerShortcut) void focusActiveComposer(webContents);
      return;
    }

    const isCycleShortcut = isCycleChatsForwardShortcut || isCycleChatsBackwardShortcut;
    void webContents.executeJavaScript(script).then((result) => {
      if (!result || typeof result !== "object") return;

      const target = result as {
        x?: unknown;
        y?: unknown;
        wasCollapsed?: unknown;
      };
      if (typeof target.x !== "number" || typeof target.y !== "number") return;

      if (isOpenArchivedShortcut) {
        void webContents.executeJavaScript(resetArchivedChatCycleScript).catch((error: unknown) => {
          console.warn("Unable to reset PrettyZap Archived chat cycle", error);
        });
        webContents.sendInputEvent({
          type: "mouseMove",
          x: target.x,
          y: target.y,
          movementX: 0,
          movementY: 0,
        });
        webContents.sendInputEvent({
          type: "mouseDown",
          x: target.x,
          y: target.y,
          button: "left",
          clickCount: 1,
        });
        webContents.sendInputEvent({
          type: "mouseUp",
          x: target.x,
          y: target.y,
          button: "left",
          clickCount: 1,
        });
        return;
      }

      if (!isCycleShortcut) return;

      webContents.sendInputEvent({
        type: "mouseMove",
        x: target.x,
        y: target.y,
        movementX: 0,
        movementY: 0,
      });
      webContents.sendInputEvent({
        type: "mouseDown",
        x: target.x,
        y: target.y,
        button: "left",
        clickCount: 1,
      });
      webContents.sendInputEvent({
        type: "mouseUp",
        x: target.x,
        y: target.y,
        button: "left",
        clickCount: 1,
      });

      if (target.wasCollapsed === true) {
        cycleOpenedDrawer = true;
      }

      if (cycleOpenedDrawer) {
        if (cycleHideTimer) clearTimeout(cycleHideTimer);
        cycleHideTimer = setTimeout(() => {
          cycleHideTimer = undefined;
          cycleOpenedDrawer = false;
          void webContents.executeJavaScript(toggleDrawerScript).catch((error: unknown) => {
            console.warn("Unable to restore PrettyZap chat drawer", error);
          });
        }, CHAT_CYCLE_IDLE_MS);
      }
    }).catch((error: unknown) => {
      console.warn("Unable to handle PrettyZap keyboard shortcut", error);
    });
  };

  const apply = (): void => {
    const generation = ++loadGeneration;
    // Same retry policy as the theme installer: after a fresh login or slow
    // reconnect the chat shell can appear minutes after the last page load
    // and usually without a new did-finish-load, so keep checking instead of
    // giving up after a fixed budget. Each waitForWhatsAppShell pass is cheap
    // and short, so this loop costs almost nothing while the QR/login screen
    // or the boot spinner is showing.
    const attempt = (): void => {
      void waitForWhatsAppShell(webContents).then((state) => {
        if (disposed || generation !== loadGeneration || webContents.isDestroyed()) return;
        if (!state.ready) {
          setTimeout(attempt, 1_000);
          return;
        }
        return webContents.executeJavaScript(createDrawerScript(initialCollapsed)).catch((error: unknown) => {
          console.warn("Unable to install PrettyZap WhatsApp drawer", error);
        });
      }).catch((error: unknown) => {
        // A navigation can tear down the JS context mid-wait; that is a
        // property of the current pass, not the feature.
        if (disposed || generation !== loadGeneration || webContents.isDestroyed()) return;
        console.warn("PrettyZap drawer readiness check interrupted, retrying", error);
        setTimeout(attempt, 1_000);
      });
    };
    attempt();
  };

  webContents.on("did-finish-load", apply);
  webContents.on("before-input-event", onBeforeInput);

  return () => {
    disposed = true;
    loadGeneration += 1;
    if (cycleHideTimer) clearTimeout(cycleHideTimer);
    if (escapeFocusRecoveryTimer) clearTimeout(escapeFocusRecoveryTimer);
    webContents.removeListener("did-finish-load", apply);
    webContents.removeListener("before-input-event", onBeforeInput);
  };
}
