const { ipcRenderer } = require('electron');

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

  registerGlobalIpcEvents(atom, TranquilBrowser);
};

// These ipcRenderer channels are handled ONCE per renderer (window), not per
// tab. Every handler below resolves the *active* pane item at dispatch time, so
// a single registration serves every tab. Registering them per tab (as this
// once did) leaked listeners on the shared IpcRenderer — the
// MaxListenersExceededWarning after ~20 open tabs — and also delivered each
// event once per open tab (the reason the old handlers carried prevId de-dup
// guards, now unnecessary with one listener per channel).
let globalIpcEventsRegistered = false;
const registerGlobalIpcEvents = (atom, TranquilBrowser) => {
  if (globalIpcEventsRegistered) return;
  globalIpcEventsRegistered = true;

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
    const activePane = atom.workspace.getActivePane();
    const previousItem = activePane.getActiveItem();
    const linkToOpen = args?.link ? args.link : args?.text;
    // Plain click sends `foreground: true` → open and switch to the new tab.
    // cmd-click (no flag) opens a BACKGROUND tab: activateItem/activatePane false
    // so the new webview is never activated or focused — activating it and then
    // restoring the source as active strands keyboard focus inside the now-hidden
    // new guest webview, which stops forwarding keydowns (ctrl+tab etc.). A
    // foreground open has no such restore, so focus simply lands on the new tab.
    const foreground = !!(args && args.foreground);
    if (linkToOpen) {
      atom.workspace
        .open(linkToOpen, { activateItem: foreground, activatePane: foreground })
        .then((newItem) => {
          // Place the new tab at the END of the source tab's "stack": the
          // contiguous run of tabs opened from `previousItem` that sits right
          // after it. Links opened from the same tab stay grouped in open order;
          // switching to a different tab and cmd-clicking starts a fresh stack to
          // that tab's right (none of the other tabs are its children).
          //
          // `atom.workspace.open` inserts the new item at activeItemIndex+1 —
          // i.e. immediately after the source, BEFORE siblings opened earlier
          // from it. So we can't just insert there; we scan past the existing
          // stack (ignoring wherever the new item currently sits) to find the
          // anchor it should follow, then move it after that anchor.
          const items = activePane.getItems();
          const sourceIndex = previousItem ? items.indexOf(previousItem) : -1;
          if (sourceIndex === -1) {
            activePane.moveItem(newItem, items.length - 1);
            return;
          }
          // Anchor = last tab already in the source's stack, or the source
          // itself if it has none yet. The stack is the contiguous children of
          // `previousItem`; skip the new tab's current position while scanning.
          let anchorIndex = sourceIndex;
          for (let i = sourceIndex + 1; i < items.length; i++) {
            if (items[i] === newItem) continue;
            if (linkOpenerMap.get(items[i]) === previousItem) anchorIndex = i;
            else break;
          }
          // `moveItem` removes the item first, then inserts at the given index in
          // the reduced array — so when the new tab currently sits before the
          // anchor, the anchor shifts down one after removal.
          const newItemIndex = items.indexOf(newItem);
          const targetIndex =
            newItemIndex < anchorIndex ? anchorIndex : anchorIndex + 1;
          activePane.moveItem(newItem, targetIndex);
          linkOpenerMap.set(newItem, previousItem);
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
    const linkToOpen = args?.link ? args.link : args?.text;
    if (linkToOpen) require('shell').openExternal(linkToOpen);
  });

  ipcRenderer.on('open-link-in-new-window', async (event, args) => {
    const linkToOpen = args?.link ? args.link : args?.text;
    ipcRenderer.send('application:new-window-open-url', { url: linkToOpen });
  });

  ipcRenderer.on('zoom', function (event, obj) {
    // Zoom the active tab's webview. (Previously gated on a per-tab
    // `webviewId === obj.webViewId` closure, but obj.webViewId is always the
    // last-created tab's id, so that gate merely required such a tab to exist
    // while still zooming whatever was active — the same effect this has, now
    // from one renderer-wide listener.)
    const getActivePaneItem = atom.workspace.getActivePaneItem();
    const webView = getActivePaneItem?.view?.htmlv?.[0];

    if (webView) {
      if (obj.type === 'in') {
        webView.setZoomFactor(webView.getZoomFactor() + 0.1);
      } else if (obj.type === 'out') {
        webView.setZoomFactor(webView.getZoomFactor() - 0.1);
      }
    }
  });
  // 'webview-key-events' is handled by a single window-level listener registered
  // in tranquil-browser.js activate() (resolves the source view by webContentsId),
  // not per tab — see browserViewForWcId / handleGlobalGuestKey there.
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

// A clean, stock-browser User-Agent: the host app's default UA with the Electron
// and Tranquil app tokens stripped, so browser <webview> guests present as plain
// Chrome. Derived at load from the live UA so it tracks the bundled Chromium across
// upgrades — no version string to go stale.
const CLEAN_USER_AGENT = navigator.userAgent.replace(/ (?:Tranquil|Electron)\/\S+/g, "");

// The User-Agent browser tabs should send: the user's `tranquil.browserUserAgent`
// override when set (from the Tranquil settings tab), otherwise the clean default.
// A blank override falls back to the default too.
const resolveUserAgent = () => {
  const override = (atom.config.get("tranquil.browserUserAgent") || "").trim();
  return override || CLEAN_USER_AGENT;
};

module.exports = {
  addIpcInstanceEvents,
  addUrlChangeInstanceEvent,
  isUrlBlocked,
  sanitizeFilename,
  sameAsUrl,
  tabDisplayTitle,
  windowHistoryKey,
  resolveUserAgent,
  CLEAN_USER_AGENT,
};
