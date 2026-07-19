const { ipcRenderer } = require('electron');

/**
 * to prevent get-selected-content-link event from being called multiple times at once.
 * prevId2 is to use inside open-link-in-default-window handler.
 * needed to use 2 separate variables.
 */
let prevId, prevId2, prevId3;

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
      atom.workspace.open(linkToOpen).then((newItem) => {
        // Open the new tab at the end of the stack rather than immediately
        // to the right of the current tab.
        activePane.moveItem(newItem, activePane.getItems().length - 1);
        activePane.activate();
        if (previousItem) activePane.setActiveItem(previousItem);
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
        tabEvt.shiftKey ? 'pane:show-previous-item' : 'pane:show-next-item'
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

module.exports = {
  addIpcInstanceEvents,
  addUrlChangeInstanceEvent,
  isUrlBlocked,
};
