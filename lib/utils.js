const { ipcRenderer } = require('electron');

/**
 * to prevent get-selected-content-link event from being called multiple times at once.
 * prevId2 is to use inside open-link-in-default-window handler.
 * needed to use 2 separate variables.
 */
let prevId, prevId2, prevId3;

// Records which tab a cmd-click-opened tab came from (newItem → source tab), so
// links opened from the same tab stay grouped next to it in open order rather
// than scattering to the end. Mirrors Chrome's opener grouping. A WeakMap so
// entries drop when a tab is closed.
const linkOpenerMap = new WeakMap();

// Browser history is per-window. Each Electron window owns a durable
// windowSessionId (see main-process atom-window.js); its history lives under a
// key namespaced by that id, so windows don't share history even though the
// host renderer's localStorage is shared across windows. The history page
// (history.html) runs in the per-window webview partition and can't read this
// store directly — the host view injects it on load and the page reports edits
// back via the `tranquil-browser:history-changed` ipc-message below.
const windowHistoryKey = (atom) => {
  const wsid =
    atom && atom.getLoadSettings ? atom.getLoadSettings().windowSessionId : null;
  return wsid ? "bp.history." + wsid : "bp.history";
};

const addIpcInstanceEvents = (webViewItem, atom, TranquilBrowser) => {
  const webviewId = webViewItem?.model.id;
  webViewItem.htmlv[0].addEventListener("ipc-message", (event) => {
    switch (event?.channel) {
      case "tranquil-browser:pong": {
        console.log('tranquil-browser:pong')
        window.pingState = false;
        window.pongState = true;
        break;
      }
      case "tranquil-browser:save-link": {
        const { link, text } = event.args?.[0] || {};
        if (link) TranquilBrowser.saveNumberedLink(link, text);
        break;
      }
      case "tranquil-browser:history-changed": {
        // The history page (a webview in the per-window partition) mutated its
        // local copy (clear / delete an entry). Persist it back into this
        // window's history store so it survives reloads and restarts.
        const hist = event.args?.[0];
        if (Array.isArray(hist)) {
          window.bp.js.set(windowHistoryKey(atom), hist);
        }
        break;
      }
      default: {
        // code block
      }
    }
  });
  webViewItem.htmlv[0].addEventListener('did-navigate-in-page', () => {
    // [FIX] Input cursor invisible after in-page navigation (SPA route changes, anchor links)
    if (atom.workspace.getActivePaneItem() === webViewItem.model) {
      webViewItem.htmlv[0].blur();
      webViewItem.htmlv[0].focus();
    }
  });
  ipcRenderer.send("add-instance-events", { webViewId: webviewId });
  
  ipcRenderer.on("get-selected-content-link", (event, args) => {
    const getActivePaneItem = atom.workspace.getActivePaneItem();
    const webView = getActivePaneItem?.view?.htmlv?.[0];
    webView?.send('get-selected-content-link', args);
  });

  ipcRenderer.on('get-selected-image-link', (event, args) => {
    const getActivePaneItem = atom.workspace.getActivePaneItem();
    const webView = getActivePaneItem?.view?.htmlv?.[0];
    webView?.send('get-selected-image-link', args);
  });

  ipcRenderer.on('open-link-in-new-tab', (event, args) => {
    // this two lines are to prevent opening multiple tabs at once
    if (prevId && prevId === args.id) return;
    prevId = args.id;

    const activePane = atom.workspace.getActivePane();
    const previousItem = activePane.getActiveItem();
    const linkToOpen = args?.link ? args.link : args?.text;
    if (linkToOpen) {
      // Open as a true background tab: activateItem/activatePane false so the new
      // webview is never activated or focused. Activating it (then restoring the
      // source as active) strands keyboard focus inside the now-hidden new guest
      // webview, which stops forwarding keydowns — so ctrl+tab (and other keys
      // routed through webview-key-events) silently die after a cmd-click.
      atom.workspace
        .open(linkToOpen, { activateItem: false, activatePane: false })
        .then((newItem) => {
          // Insert the new tab right after the source tab so links opened from the
          // same tab stay grouped with it. Skip past siblings already opened from
          // that same source so the group preserves open order, then record this
          // tab's opener so the next sibling lands after it.
          const items = activePane.getItems();
          const sourceIndex = previousItem ? items.indexOf(previousItem) : -1;
          if (sourceIndex !== -1) {
            let insertIndex = sourceIndex + 1;
            while (
              insertIndex < items.length &&
              items[insertIndex] !== newItem &&
              linkOpenerMap.get(items[insertIndex]) === previousItem
            ) {
              insertIndex++;
            }
            activePane.moveItem(newItem, insertIndex);
            linkOpenerMap.set(newItem, previousItem);
          } else {
            activePane.moveItem(newItem, items.length - 1);
          }
        });
    }
  });
  ipcRenderer.on('add-link-to-treeview', (event, args) => {
    const linkToOpen = args?.link ? args.link : args?.text;
    if (linkToOpen) {
      TranquilBrowser.addToTreeView(linkToOpen);
    }
  });
  ipcRenderer.on('open-link-in-default-window', (event, args) => {
    if (prevId2 && prevId2 === args.id) return;
    prevId2 = args.id;
    const linkToOpen = args?.link ? args.link : args?.text;
    if (linkToOpen) require('shell').openExternal(linkToOpen);
  });

  ipcRenderer.on('open-link-in-new-window', async (event, args) => {
    if (prevId3 && prevId3 === args.id) return;
    prevId3 = args.id;
    const linkToOpen = args?.link ? args.link : args?.text;
    ipcRenderer.send('application:new-window-open-url', { url: linkToOpen });
  });

  ipcRenderer.on('zoom', function (event, obj) {
    const getActivePaneItem = atom.workspace.getActivePaneItem();
    const webView = getActivePaneItem?.view?.htmlv?.[0];

    if (webView && webviewId === obj?.webViewId) {
      if (obj.type === 'in') {
        webView.setZoomFactor(webView.getZoomFactor() + 0.1);
      } else if (obj.type === 'out') {
        webView.setZoomFactor(webView.getZoomFactor() - 0.1);
      }
    }
  });
  ipcRenderer.on("webview-key-events", (event, args) => {
    let wcId;
    try { wcId = webViewItem.htmlv[0].getWebContentsId(); } catch (_) { return; }
    if (wcId !== args?.webContentsId) return;

    // On window teardown a stray forwarded key event can still arrive after the
    // workspace is gone; bail rather than deref null (atom.workspace).
    if (!atom.workspace) return;

    // Ctrl+Tab / Ctrl+Shift+Tab cycle tabs. Handle this BEFORE the active-item
    // guard below: after a switch, keyboard focus can stay in the webview that
    // forwarded the key even though a different item is now active, so gating on
    // `activeItem === model` would swallow every press after the first — the tab
    // would move once in each direction and then stop. Only the focused webview
    // forwards each event (the wcId gate above), so exactly one dispatch happens
    // per press.
    const tabEvt = args?.w_event;
    if (tabEvt && tabEvt.ctrlKey && tabEvt.key === 'Tab') {
      const workspaceEl = atom.views.getView(atom.workspace);
      atom.commands.dispatch(
        workspaceEl,
        tabEvt.shiftKey
          ? 'tranquil:show-previous-item-in-center'
          : 'tranquil:show-next-item-in-center'
      );
      return;
    }

    // Command palette (cmd-shift-p / ctrl-shift-p). Handle it here, before the
    // active-item guard, for the same reason as Ctrl+Tab: after a tab switch the
    // webview can keep keyboard focus, so Pulsar's keymap never sees the
    // keystroke and the palette would silently fail to open.
    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
    const paletteEvt = args?.w_event;
    if (
      paletteEvt &&
      paletteEvt.shiftKey &&
      (paletteEvt.key === 'p' || paletteEvt.key === 'P') &&
      (isMac ? paletteEvt.metaKey : paletteEvt.ctrlKey)
    ) {
      atom.commands.dispatch(
        atom.views.getView(atom.workspace),
        'command-palette:toggle'
      );
      return;
    }

    // Close active item (cmd-w / ctrl-w). Handle it here, before the active-item
    // guard, for the same reason as Ctrl+Tab: after a tab switch keyboard focus
    // can land inside the active browser tab's guest webview, which swallows the
    // keystroke before Pulsar's keymap and has no keyHandler case — so cmd+w
    // would silently do nothing. Exclude shift so cmd-shift-w keeps its binding.
    const closeEvt = args?.w_event;
    if (
      closeEvt &&
      !closeEvt.shiftKey &&
      (closeEvt.key === 'w' || closeEvt.key === 'W') &&
      (isMac ? closeEvt.metaKey : closeEvt.ctrlKey)
    ) {
      atom.commands.dispatch(atom.views.getView(atom.workspace), 'core:close');
      return;
    }

    const activeItem = atom.workspace.getActivePaneItem();
    if (activeItem === webViewItem.model) {
      webViewItem.keyHandler(args?.w_event);
    } else {
      // Webview has stolen keyboard focus while a non-browser item is active
      // (e.g. after a theme switch). Intercept the split chord and target the
      // correct pane directly, since Pulsar's keymap can't see these keys.
      const evt = args?.w_event;
      if (!evt) return;
      const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
      if ((isMac ? evt.metaKey : evt.ctrlKey) && evt.key === 'k') {
        webViewItem._stuckCmdKPending = true;
        clearTimeout(webViewItem._stuckCmdKTimer);
        webViewItem._stuckCmdKTimer = setTimeout(() => { webViewItem._stuckCmdKPending = false; }, 1000);
      } else if (webViewItem._stuckCmdKPending) {
        const splitMethod = { ArrowUp: 'splitUp', ArrowDown: 'splitDown', ArrowLeft: 'splitLeft', ArrowRight: 'splitRight' }[evt.key];
        if (splitMethod) {
          webViewItem._stuckCmdKPending = false;
          clearTimeout(webViewItem._stuckCmdKTimer);
          const pane = atom.workspace.paneForItem(activeItem);
          if (pane) pane[splitMethod]({ copyActiveItem: true });
        }
      }
    }
  });
  ipcRenderer.on('tab-focus', function (event, obj) {
    const getActivePaneItem = atom.workspace.getActivePaneItem();
    const urlInput = getActivePaneItem?.view?.urlbar?.[0]?.querySelector('#url');
    urlInput?.select();
  });
};

const addUrlChangeInstanceEvent = (webViewItem, url) => {
  const webviewId = webViewItem?.model.id;
  ipcRenderer.send('webview-url-change', { webViewId: webviewId, url });
};

const isUrlBlocked = (url, blockedUrlList) => {
  return blockedUrlList.some((listItem) => url.includes(listItem));
};

// Make an arbitrary string (e.g. a page <title>) safe as a file name: replace
// OS-reserved / path / control chars, collapse whitespace and dash runs, strip
// leading/trailing dots, spaces and dashes (Windows rejects trailing dots/spaces;
// also avoids names like "....url"), and cap length. Returns '' if nothing usable
// survives, so callers can fall back.
const sanitizeFilename = (name, maxLength = 64) => {
  if (!name) return '';
  return String(name)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-') // OS-reserved + control chars
    .replace(/\s+/g, ' ') // collapse whitespace runs
    .replace(/-+/g, '-') // collapse dash runs
    .slice(0, maxLength) // cap first, so the strip below cleans the cut edge
    .replace(/^[.\-\s]+|[.\-\s]+$/g, ''); // strip leading/trailing . - space
};

// A webview's getTitle() returns the page URL — sans scheme and trailing slash —
// while the page is mid-load or has no <title>. Detect that so we don't mistake
// it for a real title. Kept in sync with the copy in tranquil-automations'
// vertical-tabs-view.js (sameAsUrl there).
const sameAsUrl = (candidate, url) => {
  if (!candidate || !url) return false;
  const norm = (value) =>
    String(value)
      .trim()
      .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
      .replace(/\/+$/, '')
      .toLowerCase();
  return norm(candidate) === norm(url);
};

// Mirrors VerticalTabsView.labelFor()'s primary path so the .url save-dialog
// default matches the Tabs-pane label. Returns the live page <title> for the
// open tab at `url`, or null (mid-load / no matching tab) so the caller falls back.
const tabDisplayTitle = (url) => {
  if (!url) return null;
  const item = atom.workspace
    .getPaneItems()
    .find((i) => typeof i.getURL === 'function' && i.getURL() === url);
  const webview = item && item.view && item.view.htmlv && item.view.htmlv[0];
  if (webview && typeof webview.getTitle === 'function') {
    try {
      const title = webview.getTitle();
      if (title && title.trim() && !sameAsUrl(title, url)) return title;
    } catch (e) {
      /* webview not attached yet */
    }
  }
  return null;
};

module.exports = {
  addIpcInstanceEvents,
  addUrlChangeInstanceEvent,
  isUrlBlocked,
  sanitizeFilename,
  sameAsUrl,
  tabDisplayTitle,
  windowHistoryKey,
};
