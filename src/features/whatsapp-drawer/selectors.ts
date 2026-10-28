/**
 * Anchors observed in the authenticated WhatsApp Web shell.
 * Keep WhatsApp-specific DOM knowledge inside this feature.
 */
export const whatsappDrawerSelectors = {
  applicationRoot: '[data-testid="wa-web-main-screen"]',
  // The flex row holding the chat list and conversation. WhatsApp gives it a
  // fixed min-width (748px at the time of writing) sized for both panes.
  layoutRow: '[data-testid="wa-web-main-screen"] > div.two',
  navigationRail: 'header[data-testid="chatlist-header"]',
  chatListHeader: 'header[data-testid="chatlist-header"]',
  // WhatsApp keeps #side inside a flex pane without a dedicated test id.
  // The structural selector is the same stable relationship used by mature
  // Web WhatsApp sidebar styles; the data-testid fallback covers revisions
  // that expose the pane directly.
  chatListShell: ':is([data-testid="drawer-left"], div.two > div:has(#side))',
  chatListColumn: '#side',
  chatListSearch: 'input[placeholder="Search or start a new chat"]',
  // WhatsApp renders its two lists differently. The standard list is a grid,
  // while Archived is a separate list with a stable container marker.
  chatListRows: '[role="row"][data-testid^="list-item-"] > [role="gridcell"]',
  archivedChatList: '[data-testid="archived-chatlist"]',
  archivedChatListRows:
    '[data-testid="archived-chatlist"] [role="listitem"][data-testid^="list-item-"]',
  conversationMessages: '[data-testid="conversation-panel-messages"]',
  messageComposer: '[data-testid="conversation-compose-box-input"]',
  navigationButtons: {
    chats: 'button[aria-label="Chats"]',
    calls: 'button[aria-label="Calls"]',
    status: 'button[aria-label="Status"]',
    channels: 'button[aria-label="Channels"]',
    communities: 'button[aria-label="Communities"]',
    metaAi: 'button[aria-label="Meta AI"]',
    media: 'button[aria-label="Media"]',
    you: 'button[aria-label="You"]',
  },
} as const;
