const { contextBridge, ipcRenderer, webFrame, clipboard } = require('electron');
const https = require('https');

// Polyfill newer URL statics that this Electron's Chromium (30.5.1 → Chromium
// 124) predates. `URL.parse`/`URL.canParse` landed in Chromium 126, and sites
// (e.g. openai.com) call them in their bundles, which throws
// "URL.parse is not a function" and blocks the whole page from loading.
// The preload runs in the isolated world, so inject into the page's main world
// via webFrame.executeJavaScript — this runs before any page script executes.
webFrame.executeJavaScript(`
  (function () {
    if (typeof URL.parse !== 'function') {
      URL.parse = function (url, base) {
        try {
          return base === undefined ? new URL(url) : new URL(url, base);
        } catch (e) {
          return null;
        }
      };
    }
    if (typeof URL.canParse !== 'function') {
      URL.canParse = function (url, base) {
        try {
          base === undefined ? new URL(url) : new URL(url, base);
          return true;
        } catch (e) {
          return false;
        }
      };
    }
  })();
`);

contextBridge.exposeInMainWorld('electron', {
  send: (channel, data) => {
    ipcRenderer.send(channel, data);
  },
  sendToHost: (channel, data) => {
    ipcRenderer.sendToHost(channel, data);
  },
  sendSync: (channel, data) => {
    ipcRenderer.sendSync(channel, data);
  },
  receive: (channel, func) => {
    ipcRenderer.on(channel, (event, ...args) => func(...args));
  },
  invoke: async (channel, data) => {
    try {
      const result = await ipcRenderer.invoke(channel, data);
      return result;
    } catch (error) {
      console.error(`Error invoking ${channel}:`, error);
      throw error; // Rethrow the error for the caller to handle
    }
  },
  // Search-suggestion autocomplete for pages that need it (the blank start
  // page's search box). The page is a file:// webview, so it can't fetch the
  // suggestion endpoint cross-origin (no CORS headers) — do it here in the
  // preload's Node context and hand back a plain string[]. DuckDuckGo's
  // `type=list` endpoint returns OpenSearch `[term, [suggestions]]`, matching
  // the engine used everywhere else in the browser. Always resolves (never
  // rejects) so the caller can treat failure as "no suggestions".
  suggest: (term) =>
    new Promise((resolve) => {
      try {
        const req = https.get(
          {
            hostname: 'ac.duckduckgo.com',
            path: '/ac/?type=list&q=' + encodeURIComponent(term),
            headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
          },
          (res) => {
            let body = '';
            res.on('data', (c) => (body += c));
            res.on('end', () => {
              try {
                const data = JSON.parse(body);
                resolve(Array.isArray(data && data[1]) ? data[1] : []);
              } catch (e) {
                resolve([]);
              }
            });
          }
        );
        req.on('error', () => resolve([]));
        req.setTimeout(4000, () => {
          req.destroy();
          resolve([]);
        });
      } catch (e) {
        resolve([]);
      }
    }),
});

document.addEventListener('contextmenu', function (e) {
  window.rightClickedElement = e.target;
});

document.addEventListener('DOMContentLoaded', function () {
  window.tranquilBrowser = {};
  window.tranquilBrowser.menu = function (menu) {
    if (!window.tranquilBrowser.contextMenu) {
      window.tranquilBrowser.contextMenu = jQuery("<ul id='bp-menu'></ul>");
      jQuery('body').append(window.tranquilBrowser.contextMenu);
      window.tranquilBrowser.contextMenu.hide();
      jQuery('body').on('contextmenu', function (e) {
        if (!window.tranquilBrowser.contextMenu.has('li').length) {
          return false;
        }
        window.tranquilBrowser.contextMenu.css({
          top: 'auto',
          left: 'auto',
          bottom: 'auto',
          right: 'auto',
        });
        window.tranquilBrowser.contextMenu.css({ left: e.pageX, top: e.pageY });
        let maxHeight =
          e.clientY + window.tranquilBrowser.contextMenu.outerHeight();
        let positionY =
          maxHeight > jQuery(window).height()
            ? e.pageY - window.tranquilBrowser.contextMenu.outerHeight() - 10
            : e.pageY + 10;
        let maxWidth =
          e.clientX + window.tranquilBrowser.contextMenu.outerWidth();
        let positionX =
          maxWidth > jQuery(window).width() + 10
            ? e.pageX - window.tranquilBrowser.contextMenu.outerWidth() - 10
            : e.pageX;
        window.tranquilBrowser.contextMenu.css({
          top: positionY,
          left: positionX,
        });
        window.tranquilBrowser.contextMenu.show();
        jQuery('body').one('click', function () {
          let children =
            window.tranquilBrowser.contextMenu.children('.bp-selector');
          children.off('click');
          children.remove();
        });
        return false;
      });
    }
    if (menu.name) {
      if (menu.selector) {
        jQuery('body').on('contextmenu', menu.selector, function (e) {
          if (jQuery('#bp-menu').is(':visible')) {
            return true;
          }
          if (
            window.tranquilBrowser.contextMenu.children(
              `[data-bpid='${menu._id}']`
            ).length
          ) {
            return true;
          }
          if (
            menu.selectorFilter &&
            !eval(`(${menu.selectorFilter}).bind(this)()`)
          ) {
            return true;
          }
          let submenu = jQuery(
            `<li class='bp-selector' data-bpid = '${menu._id}'> ${menu.name} </li>`
          );
          submenu.on('click', eval('(' + menu.fn + ').bind(this)'));
          window.tranquilBrowser.contextMenu.append(submenu);
        });
      } else {
        let submenu = jQuery('<li>' + menu.name + '</li>');
        submenu.on('click', eval('(' + menu.fn + ').bind(this)'));
        window.tranquilBrowser.contextMenu.append(submenu);
      }
    }
    if (menu.event) {
      jQuery('body').on(menu.event, menu.selector, eval('(' + menu.fn + ')'));
    } else if (menu.ctrlkey) {
      menu.keytype = menu.keytype || 'keyup';
      jQuery('body').on(
        menu.keytype,
        menu.selector,
        menu.ctrlkey,
        eval('(' + menu.fn + ')')
      );
    }
  };
});

function getSelectionLink() {
  // Prefer the element the context menu was opened on: right-clicking an anchor
  // does not focus it, so document.activeElement usually isn't the link. The
  // contextmenu listener above records it as window.rightClickedElement.
  const clicked = window.rightClickedElement;
  const anchor =
    clicked && typeof clicked.closest === 'function'
      ? clicked.closest('a')
      : null;
  if (anchor) {
    if (anchor.dataset.linkType === 'history') {
      return anchor.dataset.link;
    }
    if (anchor.href) {
      return anchor.href;
    }
  }
  const activeEl = document.activeElement;
  const activeElTagName = activeEl ? activeEl.tagName.toLowerCase() : null;
  if (activeElTagName === 'a') {
    const linkType = activeEl.dataset.linkType;
    if (linkType === 'history') {
      return activeEl.dataset.link;
    }
    return activeEl.href;
  }
  return null;
}

function getSelectionText() {
  var text = '';
  var activeEl = document.activeElement;
  var activeElTagName = activeEl ? activeEl.tagName.toLowerCase() : null;
  if (
    activeElTagName == 'textarea' ||
    (activeElTagName == 'input' &&
      /^(?:text|search|password|tel|url)$/i.test(activeEl.type) &&
      typeof activeEl.selectionStart == 'number')
  ) {
    text = activeEl.value.slice(activeEl.selectionStart, activeEl.selectionEnd);
  } else if (window.getSelection) {
    text = window.getSelection().toString();
  }
  return text?.trim();
}
function isValidHttpUrl(string) {
  let url;

  try {
    url = new URL(string);
  } catch (_) {
    return false;
  }

  return url.protocol === 'http:' || url.protocol === 'https:';
}

ipcRenderer.on('get-selected-content-link', (event, args) => {
  const link = getSelectionLink();
  const text = getSelectionText();
  let textLink;
  if (isValidHttpUrl(text)) {
    textLink = text;
  } else if (text) {
    textLink = 'https://duckduckgo.com/?q=' + text;
  }
  if (args?.action === 'open-in-new-tab') {
    ipcRenderer.send('open-link-in-new-tab', {
      link,
      id: args.id,
      text: textLink,
    });
  } else if (args?.action === 'open-in-default-window') {
    ipcRenderer.send('open-link-in-default-window', {
      link,
      id: args.id,
      text: textLink,
    });
  } else if (args?.action === 'open-in-new-window') {
    ipcRenderer.send('open-link-in-new-window', {
      link,
      id: args.id,
      text: textLink,
    });
  } else if (args?.action === 'copy-link-address') {
    // Electron's clipboard, not navigator.clipboard: the async clipboard API
    // rejects ("Document is not focused") because the native context menu had
    // focus until a moment ago, and it would stringify a null link as "null".
    // Fall back to selected text only when it's itself a URL — wrapping it in
    // a search URL (textLink) makes sense for the open-* actions, not for copy.
    const address = link || (isValidHttpUrl(text) ? text : null);
    if (address) clipboard.writeText(address);
  } else if (args?.action === 'add-link-to-treeview') {
    ipcRenderer.send('add-link-to-treeview', {
      link,
      id: args.id,
      text: textLink,
    });
  }
});

function isImage(link) {
  const imageExtensions = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'pdf'];
  const ext = link.split('.').pop();
  return imageExtensions.includes(ext);
}

ipcRenderer.on('get-selected-image-link', () => {
  if (window.rightClickedElement.tagName.toLowerCase() === 'img') {
    ipcRenderer.send('add-link-to-treeview', {
      link: window.rightClickedElement.src,
    });
  }

  const activeEl = document.activeElement;
  if (activeEl && activeEl.tagName.toLowerCase() === 'a') {
    if (isImage(activeEl.href)) {
      ipcRenderer.send('add-link-to-treeview', {
        link: activeEl.href,
      });
    } else {
      const imgTag = activeEl.querySelector('img');
      if (imgTag) {
        ipcRenderer.send('add-link-to-treeview', {
          link: imgTag.src,
        });
      }
    }
  }
});

// Add an event listener to the keydown event for the document or specific elements
document.addEventListener('click', function (event) {
  const activeEl = document.activeElement;
  const activeElTagName = activeEl ? activeEl.tagName.toLowerCase() : null;

  if ((event.ctrlKey || event.metaKey) && activeElTagName === 'a') {
    event.preventDefault();
    const link = getSelectionLink();
    ipcRenderer.send('open-link-in-new-tab', { link, id: Date.now() });
    // opt/alt held → also save the link as a numbered .url in the tree view.
    // `event.altKey` covers opt (mac) and Alt (Win/Linux). Guard AltGr
    // (Ctrl+Alt on some non-US layouts) so it isn't mistaken for the save modifier.
    if (event.altKey && !event.getModifierState('AltGraph')) {
      const text = (activeEl.textContent || activeEl.title || '').trim();
      ipcRenderer.sendToHost('tranquil-browser:save-link', { link, text });
    }
    return;
  }

  // Plain click. Resolve the clicked anchor via the event target (more reliable
  // than document.activeElement, which isn't always the link).
  const anchor =
    event.target && event.target.closest ? event.target.closest('a') : null;
  if (!anchor) return;

  if (anchor.dataset && anchor.dataset.linkType === 'history') {
    event.preventDefault();
    window.location.href = anchor.dataset.link;
    return;
  }

  // A link that opens in a new window/tab (target="_blank", commonly used by
  // cross-domain/external links) is otherwise swallowed by the <webview> popup
  // policy and appears to do nothing. Route it to a new browser tab instead —
  // same flow as cmd-click. Plain same-window links fall through and navigate
  // this tab natively.
  if (anchor.target === '_blank' && anchor.href) {
    event.preventDefault();
    // Plain click → new FOREGROUND tab (switch to it), matching a normal
    // browser. cmd-click (above) opens a BACKGROUND tab and keeps you put.
    ipcRenderer.send('open-link-in-new-tab', {
      link: anchor.href,
      id: Date.now(),
      foreground: true,
    });
  }
  // Capture phase: heavy SPAs (GitHub, etc.) attach their own click handlers and
  // may stopPropagation before a bubble-phase document listener ever runs, so we
  // listen on the way DOWN to reliably see the click first.
}, true);

window.addEventListener('keydown',(e)=>{
  const {keyIdentifier,ctrlKey,altKey,metaKey,shiftKey,key,code,keyCode,charCode}=e
  ipcRenderer.send('webview-key-events', { w_event : {keyIdentifier,ctrlKey,altKey,metaKey,shiftKey,key,code,keyCode,charCode} });
})
