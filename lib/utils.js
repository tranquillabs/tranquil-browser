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
      default: {
        // code block
      }
    }
  });
  webViewItem.htmlv[0].addEventListener('dom-ready', (event) => {
    // [FIX] Input cursor invisible after navigation in webview
    webViewItem.htmlv[0].blur();
    webViewItem.htmlv[0].focus();
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
    const linkToOpen = args?.link ? args.link : args?.text;
    if (linkToOpen) {
      atom.workspace.open(linkToOpen).then(() => {
        // this makes open tab in background, and loads as well
        activePane.activatePreviousItem();
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
  ipcRenderer.on('on-find', function (event, obj) {
    const getActivePaneItem = atom.workspace.getActivePaneItem();
    const webView = getActivePaneItem?.view?.htmlv?.[0];
    webView?.send('on-find', obj);
  });
  ipcRenderer.on('close-find', function (event, obj) {
    const getActivePaneItem = atom.workspace.getActivePaneItem();
    const webView = getActivePaneItem?.view?.htmlv?.[0];
    webView?.send('close-find', obj);
  });
  ipcRenderer.on("webview-key-events", (event, args) => {
    const w_event = args?.w_event;
    const getActivePaneItem = atom.workspace.getActivePaneItem();
    // const webView = getActivePaneItem?.view?.htmlv?.[0];
    getActivePaneItem?.view?.keyHandler(w_event)
    // webViewItem.keyHandler(w_event)
  });
  ipcRenderer.on('tab-focus', function (event, obj) {
    const getActivePaneItem = atom.workspace.getActivePaneItem();
    const urlInput = getActivePaneItem?.view?.urlbar[0]?.querySelector('#url');
    urlInput.select();
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
