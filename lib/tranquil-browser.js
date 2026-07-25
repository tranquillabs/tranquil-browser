const { CompositeDisposable } = require("atom");
const TranquilBrowserModel = require("./tranquil-browser-model");
const BrowserFindItem = require("./browser-find-item");
const { buildCommands } = require("./browser-commands");
const SplitChord = require("./split-chord");
const { notify } = require("./notify.js");
const { windowHistoryKey, tabDisplayTitle, sanitizeFilename } = require("./utils");
require("JSON2");
const uuid = require("node-uuid");
const path = require("path");
const fs = require("fs");
const { ipcRenderer } = require('electron');

// Editor-find commands whose native menu accelerator (⌘F "Find in Buffer") leaks
// into browser tabs — see the onDidDispatch interception in activate().
const FNR_SHOW_COMMANDS = new Set([
  'find-and-replace:show',
  'find-and-replace:show-replace',
  'find-and-replace:toggle',
]);

// Find the browser view whose guest <webview> forwarded a key event, by matching
// the stamped webContentsId against each browser tab's guest. Small N.
function browserViewForWcId(wcId) {
  if (wcId == null) return null;
  for (const item of atom.workspace.getPaneItems()) {
    if (!(item instanceof TranquilBrowserModel)) continue;
    const wv = item.view && item.view.htmlv && item.view.htmlv[0];
    if (!wv) continue;
    try {
      if (wv.getWebContentsId() === wcId) return item.view;
    } catch (_) { /* webview not attached yet */ }
  }
  return null;
}

// Guest keys that must be handled BEFORE the active-item guard: a focus-stranded
// guest webview swallows them before Pulsar's keymap, and they're global actions
// (not tied to which browser is active). Returns true when consumed.
function handleGlobalGuestKey(evt) {
  const isMac = process.platform === 'darwin';
  const workspaceEl = atom.views.getView(atom.workspace);
  // Ctrl+Tab / Ctrl+Shift+Tab — cycle the center's tabs.
  if (evt.ctrlKey && evt.key === 'Tab') {
    atom.commands.dispatch(
      workspaceEl,
      evt.shiftKey
        ? 'tranquil:show-previous-item-in-center'
        : 'tranquil:show-next-item-in-center'
    );
    return true;
  }
  // Command palette (cmd/ctrl+shift+p).
  if (
    evt.shiftKey &&
    (evt.key === 'p' || evt.key === 'P') &&
    (isMac ? evt.metaKey : evt.ctrlKey)
  ) {
    atom.commands.dispatch(workspaceEl, 'command-palette:toggle');
    return true;
  }
  // NOTE: cmd-w / ctrl-w is deliberately NOT handled here. The "Close Tab"
  // menu item (core:close) carries an Electron accelerator that fires even when
  // a guest webview is focused, so it already closes the active tab. Dispatching
  // core:close here too would close TWO tabs per press (menu accelerator + this).
  return false;
}

const TranquilBrowser = {
  tranquilBrowserView: null,
  subscriptions: null,
  findItem: null,
  // Return the singleton find pane item, creating it if needed.
  getFindItem() {
    if (!this.findItem) {
      this.findItem = new BrowserFindItem();
      this.findItem.onDidDestroy(() => {
        this.findItem = null;
      });
    }
    return this.findItem;
  },
  // Open the browser find-in-page item. Called from the atom-workspace command
  // (palette / URL-bar focus) and from the webview keyHandler (a focused guest
  // page swallows cmd-f, so it's forwarded here).
  //
  // Find always opens in the right dock (opening it if closed). location:'right'
  // auto-shows the dock (Dock.onDidActivatePane → show). If Find is already open,
  // just focus it where it is.
  showFind() {
    const existing = this.findItem;
    if (existing) {
      const pane = atom.workspace.paneForItem(existing);
      if (pane) {
        pane.activateItem(existing);
        pane.activate();
        existing.focusInput();
        return;
      }
    }
    atom.workspace.open(BrowserFindItem.URI, { location: 'right' }).then((item) => {
      if (item && typeof item.focusInput === 'function') item.focusInput();
    });
  },
  // Hide Pulsar's find-and-replace bottom panel(s). Used to undo the ⌘F menu
  // accelerator that fires find-and-replace:show even on a browser tab.
  hideEditorFindPanels() {
    atom.workspace.getBottomPanels().forEach((panel) => {
      const item = panel.getItem();
      let el = item && item.element;
      if (!el) {
        try { el = atom.views.getView(item); } catch (e) { el = null; }
      }
      if (
        el && el.classList &&
        (el.classList.contains('find-and-replace') ||
          el.classList.contains('project-find'))
      ) {
        panel.hide();
      }
    });
  },
  addToTreeView(url) {
    // Default the save-dialog filename to the Tabs-pane label for this URL — the
    // full live page <title> (via tabDisplayTitle) — falling back to the hostname,
    // then 'link', all made filesystem-safe by bookmarkBaseName.
    const defaultName = this.bookmarkBaseName(url, tabDisplayTitle(url));

    const projectPaths = atom.project.getPaths();
    const defaultPath = projectPaths.length
      ? path.join(projectPaths[0], `${defaultName}.url`)
      : `${defaultName}.url`;

    ipcRenderer.invoke('show-save-url-dialog', { defaultPath }).then(result => {
      if (result.canceled || !result.filePath) return;
      const content = `[InternetShortcut]\nURL=${url}\n`;
      require('fs').writeFile(result.filePath, content, err => {
        if (err) notify("addError", `Could not save URL file: ${err.message}`);
      });
    }).catch(err => {
      notify("addError", `Could not open save dialog: ${err.message}`);
    });
  },
  // cmd-s on a browser tab: run the same save-to-`.url` action as the toolbar
  // save button — save the current page as `<title>.url` in the tree-view's
  // selected folder (no dialog, overwrites an existing file of the same name).
  // `browser` is the resolved active browser (from browser-commands); it falls
  // back to the center's active item for callers that pass nothing (e.g. the
  // guest keyHandler). Returns false when there's no browser to save, so the
  // command can fall through to core:save and editors keep their normal cmd-s.
  saveCurrentTabUrl(browser) {
    const item = browser || atom.workspace.getCenter().getActivePaneItem();
    if (!(item instanceof TranquilBrowserModel)) return false;
    const url = item.getURL();
    if (!url || url === 'tranquil-browser://blank') {
      notify('addInfo', 'Open a page first to save it.');
      return true;
    }
    this.saveLinkToTree(url, tabDisplayTitle(url));
    return true;
  },
  // Resolve the tree-view's target folder for saving a .url, mirroring tree-view's
  // own file-vs-folder rule (a selected file → its parent dir; else the selected
  // folder; else the first project path). Returns null and notifies when there's
  // nothing selected or open.
  treeSaveDir() {
    const sel = this.treeView?.selectedPaths?.()[0];
    let dir = sel && fs.existsSync(sel) && fs.statSync(sel).isFile()
      ? path.dirname(sel)
      : sel;
    if (!dir) dir = atom.project.getPaths()[0];
    if (!dir) {
      notify("addInfo", "Select a folder in the tree view (or open a project) to save.");
      return null;
    }
    return dir;
  },
  // Filename base for a bookmark: the provided text (a page title or a clicked
  // link's anchor text), else the URL hostname, else 'link'. sanitizeFilename
  // makes each candidate filesystem-safe.
  bookmarkBaseName(link, text) {
    let base = sanitizeFilename(text);
    if (!base) {
      try { base = sanitizeFilename(new URL(link).hostname); } catch { base = ""; }
    }
    return base || "link";
  },
  // Save a link as `<title>.url` in the tree-view's selected folder — no dialog,
  // no numbering. Overwrites an existing file of the same name (re-saving the same
  // page refreshes its bookmark). Used by the toolbar save button. opt+cmd+click
  // on a page link uses saveNumberedLink instead.
  saveLinkToTree(link, text) {
    const dir = this.treeSaveDir();
    if (!dir) return;
    const name = `${this.bookmarkBaseName(link, text)}.url`;
    const content = `[InternetShortcut]\nURL=${link}\n`;
    try {
      fs.writeFileSync(path.join(dir, name), content);
      notify("addSuccess", `Saved ${name}`);
    } catch (err) {
      notify("addError", `Could not save URL file: ${err.message}`);
    }
  },
  // opt+cmd+click (Ctrl+Alt+click on Win/Linux) on a page link: save it as a
  // numbered `.url` Internet Shortcut in the tree view's currently-selected
  // folder, no dialog. Files are prefixed `001-`, `002-`, … (zero-padded so they
  // alpha-sort) continuing from the highest number already present in the folder.
  saveNumberedLink(link, text) {
    const dir = this.treeSaveDir();
    if (!dir) return;

    // Next index = highest existing NNN- prefix in the folder, + 1.
    let max = 0;
    try {
      for (const name of fs.readdirSync(dir)) {
        const m = /^(\d{3})-.*\.url$/i.exec(name);
        if (m) max = Math.max(max, parseInt(m[1], 10));
      }
    } catch (err) {
      notify("addError", `Could not read folder: ${err.message}`);
      return;
    }
    const prefix = String(max + 1).padStart(3, "0");

    const name = `${prefix}-${this.bookmarkBaseName(link, text)}.url`;
    const content = `[InternetShortcut]\nURL=${link}\n`;
    try {
      fs.writeFileSync(path.join(dir, name), content);
      notify("addSuccess", `Saved ${name}`);
    } catch (err) {
      notify("addError", `Could not save URL file: ${err.message}`);
    }
  },
  // Records a HAR of the active browser tab (faithful capture via the DevTools
  // Protocol, in the main process — the tab reloads once) and writes it into the
  // tree view. The resulting .har reopens in the browser as an offline replay.
  saveHar() {
    const item = atom.workspace.getActivePaneItem();
    if (!(item instanceof TranquilBrowserModel)) {
      notify('addInfo', 'Open a browser tab first to save a HAR.');
      return;
    }
    const pageUrl = item.getURL();
    if (!pageUrl || pageUrl.startsWith('tranquil-browser:')) {
      notify('addInfo', 'This tab has no page to capture.');
      return;
    }

    let defaultName = (item.title || '').trim();
    if (!defaultName) {
      try {
        defaultName = new URL(pageUrl).hostname;
      } catch {
        defaultName = 'page';
      }
    }
    defaultName =
      defaultName.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').trim().slice(0, 64) ||
      'page';

    const projectPaths = atom.project.getPaths();
    const defaultPath = projectPaths.length
      ? path.join(projectPaths[0], `${defaultName}.har`)
      : `${defaultName}.har`;

    ipcRenderer
      .invoke('show-save-har-dialog', { defaultPath })
      .then((result) => {
        if (result.canceled || !result.filePath) return;
        notify('addInfo', 'Capturing page…');
        return ipcRenderer
          .invoke('capture-har', {
            url: pageUrl,
            partition: item.opt && item.opt.partition,
          })
          .then((har) => {
            require('fs').writeFile(
              result.filePath,
              JSON.stringify(har),
              (err) => {
                if (err) {
                  notify('addError', `Could not save HAR: ${err.message}`);
                } else {
                  notify('addSuccess', `Saved ${path.basename(result.filePath)}`);
                }
              }
            );
          });
      })
      .catch((err) => {
        notify('addError', `Could not capture HAR: ${err.message}`);
      });
  },
  model: null,
  config: {
    fav: {
      title: 'No of Favorites',
      type: 'number',
      default: 10,
    },
    homepage: {
      title: 'HomePage',
      type: 'string',
      default: 'tranquil-browser://blank',
    },
    live: {
      title: 'Live Refresh in ',
      type: 'number',
      default: 500,
    },
    currentFile: {
      title: 'Show Current File',
      type: 'boolean',
      default: true,
    },
    openInSameWindow: {
      title: 'Open URLs in Same Window',
      type: 'array',
      default: [
        'www.google.com',
        'www.stackoverflow.com',
        'google.com',
        'stackoverflow.com',
      ],
    },
  },
  activate: function (state) {
    atom.deserializers.add(TranquilBrowserModel);
    var $;
    if (!state.noReset) {
      state.favIcon = {};
      state.title = {};
      state.fav = [];
    }
    this.resources = path.resolve(`${__dirname}/../resources/`);
    require('jstorage');
    window.bp = {};
    $ = require('jquery');
    window.bp.js = $.extend({}, window.$.jStorage);
    if (!window.bp.js.get('bp.fav')) {
      window.bp.js.set('bp.fav', []);
    }
    if (!window.bp.js.get(windowHistoryKey(atom))) {
      window.bp.js.set(windowHistoryKey(atom), []);
    }
    if (!window.bp.js.get('bp.favIcon')) {
      window.bp.js.set('bp.favIcon', {});
    }
    if (!window.bp.js.get('bp.title')) {
      window.bp.js.set('bp.title', {});
    }
    // .har files replay an archived page offline (mirrors the .url opener).
    // register-har stands up a per-archive replay session that serves the
    // recorded responses by URL; we then open a browser item on the original
    // page URL, which loads entirely from the archive via that partition.
    atom.workspace.addOpener(
      (function (_this) {
        return function (filePath) {
          if (typeof filePath !== 'string' || !filePath.endsWith('.har')) return;
          return ipcRenderer
            .invoke('register-har', { harPath: filePath })
            .then(({ pageUrl, partition, archiveId }) => {
              const model = new TranquilBrowserModel({
                tranquilBrowser: _this,
                url: pageUrl,
                filePath: filePath,
                opt: { isHarReplay: true, partition, archiveId },
              });
              _this.model = model;
              return model;
            })
            .catch((err) => {
              notify('addError', `Could not open HAR: ${err.message}`);
              return null;
            });
        };
      })(this)
    );
    atom.workspace.addOpener(
      (function (_this) {
        return function (filePath) {
          if (typeof filePath === 'string' && filePath.endsWith('.url')) {
            try {
              var content = require('fs').readFileSync(filePath, 'utf8');
              var match = content.match(/^URL=(.+)$/im);
              if (match) {
                var url = match[1].trim().replace(/\/$/, '');
                var paneItems = atom.workspace.getPaneItems();
                for (var i = 0; i < paneItems.length; i++) {
                  var item = paneItems[i];
                  if (item instanceof TranquilBrowserModel &&
                      (item.getURL() || '').replace(/\/$/, '') === url) {
                    var existingPane = atom.workspace.paneForItem(item);
                    if (existingPane) {
                      existingPane.activateItem(item);
                      return item;
                    }
                  }
                }
                var model = new TranquilBrowserModel({
                  tranquilBrowser: _this,
                  url: url,
                  opt: {},
                  filePath: filePath,
                });
                _this.model = model;
                return model;
              }
            } catch (e) {
              console.error('[tranquil-browser] Failed to open .url file:', e);
            }
          }
        };
      })(this)
    );
    atom.workspace.addOpener(
      (function (_this) {
        return function (url, opt) {
          try{
              var editor, localhostPattern, pane, path;
              // to avoid multiple tab open — dedupe only the SAME url fired
              // twice in quick succession (e.g. a doubled event). Two different
              // urls opened back-to-back (e.g. auto-opening several mockups on
              // startup) must both go through, so key the guard on the url.
              if (window.prevUrl === url && window.prevId && (Date.now()-window.prevId)< 50 ) return;
              window.prevId = Date.now();
              window.prevUrl = url;
              if (opt == null) {
                opt = {};
              }
              path = require('path');
              if (
                url.indexOf('http:') === 0 ||
                url.indexOf('https:') === 0 ||
                url.indexOf('localhost') === 0 ||
                url.indexOf('file:') === 0 ||
                url.indexOf('blob:') === 0 ||
                url.indexOf('tranquil-browser:') === 0 ||
                url.indexOf('tranquil-browser~') === 0
              ) {
                localhostPattern = /^(http:\/\/)?localhost/i;
                if (!TranquilBrowserModel.checkUrl(url)) {
                  return false;
                }
                if (
                  !(
                    url === 'tranquil-browser://blank' ||
                    url.startsWith('file:///') ||
                    !opt.openInSameWindow
                  )
                ) {
                  editor = TranquilBrowserModel.getEditorForURI(
                    url,
                    opt.openInSameWindow
                  );
                  if (editor) {
                    editor.setText(opt.src);
                    if (!opt.src) {
                      editor.refresh(url);
                    }
                    pane = atom.workspace.paneForItem(editor);
                    pane.activateItem(editor);
                    return editor;
                  }
                }
                if( url === 'tranquil-browser://blank' ){
                  const historyURL = _this.blankPageUrl();
                  const model = new TranquilBrowserModel({
                    tranquilBrowser: _this,
                    url: historyURL,
                    opt: opt,
                  });
                  _this.model = model;
                  return model;
                }
                
                const model = new TranquilBrowserModel({
                  tranquilBrowser: _this,
                  url: url,
                  opt: opt,
                });
                _this.model = model;
                return model;
              }
              }catch(e){
                console.log(e)
              }
        };
      })(this)
    );
    this.subscriptions = new CompositeDisposable();

    // Opener for the find pane item (a draggable workspace item, bottom dock by
    // default). searchAllPanes in showFind reuses this single instance.
    this.subscriptions.add(
      atom.workspace.addOpener((uri) =>
        uri === BrowserFindItem.URI ? this.getFindItem() : undefined
      )
    );

    // Closing the active browser tab should focus the NEXT tab, not the previous
    // one. Core's Pane.removeItem activates the previous item by default (see
    // src/pane.js), which we can't change there. Instead, during will-remove-item
    // (before core's activation runs) pre-activate the next item: that makes the
    // closing tab no longer the active item, so core skips its previous-item
    // activation. Scoped to browser tabs — editors keep the default behavior.
    this.subscriptions.add(
      atom.workspace.observePanes((pane) => {
        this.subscriptions.add(
          pane.onWillRemoveItem(({ item, index, moved }) => {
            if (moved) return; // a drag between panes, not a close
            if (!(item instanceof TranquilBrowserModel)) return;
            if (item !== pane.getActiveItem()) return; // only the focused tab
            const next = pane.getItems()[index + 1];
            if (next) pane.setActiveItem(next); // no next → core keeps previous
          })
        );
      })
    );

    // find-and-replace is lazily activated (activationCommands), so the FIRST
    // cmd-f after a reload activates it asynchronously and its (inert, on a
    // browser) panel appears AFTER our synchronous suppression below has run.
    // Activate it up front so the first cmd-f behaves like the rest — panel show
    // and our hide happen in the same tick (no flash).
    if (atom.packages.activatePackage) {
      atom.packages.activatePackage('find-and-replace').catch(() => {});
    }

    // Electron menu accelerators fire even when a <webview> guest is focused and
    // bypass the keymap, so the "Find in Buffer" (⌘F) menu item still dispatches
    // find-and-replace:show on a browser tab — on top of our own find. Catch that
    // leak: on a browser tab, hide the editor find panel and show our find instead.
    this.subscriptions.add(
      atom.commands.onDidDispatch((event) => {
        if (!FNR_SHOW_COMMANDS.has(event.type)) return;
        const item = atom.workspace.getCenter().getActivePaneItem();
        if (!(item instanceof TranquilBrowserModel)) return;
        TranquilBrowser.hideEditorFindPanels();
        // Backstop for any async panel creation (first-time activation): hide
        // again on the next ticks so a late-appearing panel doesn't linger.
        setTimeout(() => TranquilBrowser.hideEditorFindPanels(), 0);
        setTimeout(() => TranquilBrowser.hideEditorFindPanels(), 60);
        TranquilBrowser.showFind();
      })
    );

    // Registered once per window (at package activation), independent of any open
    // browser tab: the main process (AtomApplication.openUrlInNewWindow) spins up
    // a fresh, session-isolated window for "Open link/tab in new window" and then
    // sends this so the new window opens the URL as a browser tab in its own
    // session. Must be global here — addIpcInstanceEvents runs per-view, so an
    // empty new window would never receive it.
    const openUrlInWindow = (event, url) => {
      if (url) atom.workspace.open(url);
    };
    ipcRenderer.on('open-url-in-window', openUrlInWindow);
    const { Disposable: IpcDisposable } = require('atom');
    this.subscriptions.add(
      new IpcDisposable(() =>
        ipcRenderer.removeListener('open-url-in-window', openUrlInWindow)
      )
    );

    // Single window-level handler for keys forwarded from a focused guest webview
    // (bp-client → main → cz-init stamps webContentsId → here). Replaces the old
    // per-tab listeners (N tabs → N listeners, never torn down). cz-init sends
    // only to the focused window and only the focused guest forwards, so this
    // fires exactly once per press.
    const onWebviewKeyEvents = (event, args) => {
      if (!atom.workspace) return;
      const evt = args && args.w_event;
      if (!evt) return;
      // Global actions first (before the active-item guard) — a focus-stranded
      // guest swallows these before Pulsar's keymap.
      if (handleGlobalGuestKey(evt)) return;
      const view = browserViewForWcId(args.webContentsId);
      if (!view) return;
      if (atom.workspace.getActivePaneItem() === view.model) {
        view.keyHandler(evt);
      } else {
        // Guest holds keyboard focus while a non-browser item is active (e.g.
        // after a theme switch); the keymap can't see these keys, so handle the
        // split chord against the active item's pane.
        SplitChord.handle(evt, () =>
          atom.workspace.paneForItem(atom.workspace.getActivePaneItem())
        );
      }
    };
    ipcRenderer.on('webview-key-events', onWebviewKeyEvents);
    this.subscriptions.add(
      new IpcDisposable(() =>
        ipcRenderer.removeListener('webview-key-events', onWebviewKeyEvents)
      )
    );
    // (Guest focus on activation is now handled by the view's focus() contract
    // in tranquil-browser-view.js initialize(), via core's pane-element
    // delegation — no onDidChangeActivePaneItem side-channel needed.)
    this.subscriptions.add(
      atom.commands.add('atom-workspace', {
        'tranquil-browser:open': (function (_this) {
          return function () {
            return _this.open();
          };
        })(this),
        // cmd-l from a non-browser tab: open a new browser tab in the active
        // pane instead of splitting off a new pane (tranquil-browser:open).
        'tranquil-browser:open-in-active-pane': (function (_this) {
          return function () {
            return _this.open(void 0, { noSplit: true });
          };
        })(this),
      })
    );
    // Routable browser shortcuts (focus-url, find, save-url, toggle-url-bar,
    // go-back, go-forward, refresh, hard-refresh, print) come from one
    // declarative table in browser-commands.js. Each resolves the active browser
    // the same way and falls through (abortKeyBinding) on non-browser items so
    // core shortcuts still work. The guest keyHandler dispatches these same ids.
    this.subscriptions.add(
      atom.commands.add('atom-workspace', buildCommands(TranquilBrowser))
    );
    this.subscriptions.add(
      atom.commands.add('atom-workspace', {
        // cmd-g / cmd-shift-g advance to the next / previous match. Bound (in the
        // keymap) to the find pane, so findItem exists when these fire.
        'tranquil-browser:find-next': function () {
          TranquilBrowser.findItem?.findNext(true);
        },
        'tranquil-browser:find-previous': function () {
          TranquilBrowser.findItem?.findNext(false);
        },
        'tranquil-browser:save-har': (function (_this) {
          return function () {
            _this.saveHar();
          };
        })(this),
      })
    );
    this.subscriptions.add(
      atom.commands.add('atom-workspace', {
        'tranquil-browser:open-url-file': function (event) {
          const entry = event.target.closest('.entry');
          const filePath = entry && entry.getPath();
          if (filePath) atom.workspace.open(filePath);
        },
        'tranquil-browser:open-har-file': function (event) {
          const entry = event.target.closest('.entry');
          const filePath = entry && entry.getPath();
          if (filePath) atom.workspace.open(filePath);
        },
        'tranquil-browser:open-html-file': function (event) {
          const entry = event.target.closest('.entry');
          const filePath = entry && entry.getPath();
          if (filePath) atom.workspace.open('file://' + filePath);
        },
        // Bulk-open as BACKGROUND tabs: { activateItem/activatePane: false } so no
        // tab is activated or focused as it opens. Activating each (the default)
        // focuses its guest webview, and the racy concurrent opens then strand
        // focus in one that's since been hidden — which stops forwarding keydowns
        // and leaves ctrl+tab dead. Background-opening keeps focus in the tree
        // view, where the ctrl-tab keymap works from any dock.
        'tranquil-browser:open-all-urls-in-folder': function (event) {
          const entry = event.target.closest('.entry');
          const dirPath = entry && entry.getPath();
          if (!dirPath) return;
          const fs = require('fs');
          const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.url'));
          for (const file of files) {
            atom.workspace.open(path.join(dirPath, file), {
              activateItem: false,
              activatePane: false,
            });
          }
        },
        'tranquil-browser:open-all-files-in-folder': function (event) {
          const entry = event.target.closest('.entry');
          const dirPath = entry && entry.getPath();
          if (!dirPath) return;
          const fs = require('fs');
          const files = fs.readdirSync(dirPath, { withFileTypes: true })
            .filter(d => d.isFile() && !d.name.startsWith('.'));
          for (const file of files) {
            atom.workspace.open(path.join(dirPath, file.name), {
              activateItem: false,
              activatePane: false,
            });
          }
        },
      })
    );
    this.subscriptions.add(
      atom.commands.add('atom-workspace', {
        'tranquil-browser:add-to-tree-view': {
          displayName: 'Tranquil Browser: Add URL to Treeview',
          didDispatch: (function (_this) {
            return function (event) {
              const target =
                event.target.tagName === 'LI'
                  ? event.target
                  : event.target.parentElement;
              if (target && target.item && target.item.url) {
                _this.addToTreeView(target.item.url);
              } else {
                const activeItem = atom.workspace.getActivePaneItem();
                const url = (activeItem && typeof activeItem.getURL === 'function')
                  ? activeItem.getURL()
                  : _this.model?.getURL();
                if (url) {
                  _this.addToTreeView(url);
                }
              }
            };
          })(this),
        },
      })
    );
    this.subscriptions.add(
      atom.commands.add("atom-workspace", {
        "tranquil-browser:open-link-in-new-window": (function (_this) {
          return function (event) {
            const target =
              event.target.tagName === "LI"
                ? event.target
                : event.target.parentElement;
            if (target && target.item) {
              _this.openLinkInNewWindow(target.item.url);
            } else {
              const url = _this.model?.getURL();
              if (url) {
                _this.openLinkInNewWindow(url);
              }
            }
          };
        })(this),
      })
    );
    this.subscriptions.add(
      atom.commands.add("atom-workspace", {
        "tranquil-browser:open-link-in-default-browser": (function (_this) {
          return function (event) {
            const target =
              event.target.tagName === "LI"
                ? event.target
                : event.target.parentElement;
            if (target && target.item) {
              _this.openLinkInDefaultBrowser(target.item.url);
            } else {
              const url = _this.model?.getURL();
              if (url) {
                _this.openLinkInDefaultBrowser(url);
              }
            }
          };
        })(this),
      })
    );

    this.subscriptions.add(
      atom.commands.add('atom-workspace', {
        'tranquil-browser:openCurrent': (function (_this) {
          return function () {
            return _this.open(true);
          };
        })(this),
      })
    );
    this.subscriptions.add(
      atom.commands.add('atom-workspace', {
        'tranquil-browser:history': (function (_this) {
          return function () {
            return _this.history(true);
          };
        })(this),
      })
    );
    this.subscriptions.add(
      atom.commands.add('atom-workspace', {
        'tranquil-browser:delete-history': (function (_this) {
          return function () {
            return _this['delete'](true);
          };
        })(this),
      })
    );
    // cmd-k + arrow split chord for the HOST-focused case (a focused browser
    // guest forwards these instead — handled via split-chord.js in the guest-key
    // listener). Capture phase fires before Pulsar's keymap. We only intervene
    // when the active item is a browser; otherwise we defer to Pulsar's own
    // cmd-k <arrow> binding, so core shortcuts keep working on editors. On the
    // actual split we stopImmediatePropagation to suppress core's duplicate.
    const splitKeymapInterceptor = (e) => {
      if (!(atom.workspace.getActivePaneItem() instanceof TranquilBrowserModel)) {
        return; // defer to core for non-browser items
      }
      const result = SplitChord.handle(e, () =>
        atom.workspace.paneForItem(atom.workspace.getActivePaneItem())
      );
      if (result === 'split') e.stopImmediatePropagation();
    };

    document.addEventListener('keydown', splitKeymapInterceptor, true);
    const { Disposable } = require('atom');
    return this.subscriptions.add(new Disposable(() => {
      document.removeEventListener('keydown', splitKeymapInterceptor, true);
    }));
  },
  favr: function () {
    var favList;
    favList = require('./fav-view');
    return new favList(window.bp.js.get('bp.fav'));
  },
  delete: function () {
    return window.bp.js.set(windowHistoryKey(atom), []);
  },
  history: function () {
    return atom.workspace.open('tranquil-browser://history', {
      split: 'left',
      searchAllPanes: true,
    });
  },
  open: function (url, opt) {
    var editor, ref;
    if (opt == null) {
      opt = {};
    }
    if (!url && atom.config.get('tranquil-browser.currentFile')) {
      editor = atom.workspace.getActiveTextEditor();
      if (
        (url =
          editor != null
            ? (ref = editor.buffer) != null
              ? ref.getUri()
              : void 0
            : void 0)
      ) {
        url = 'file:///' + url;
      }
    }
    if (!url) {
      url = atom.config.get('tranquil-browser.homepage');
    }
    // `noSplit` opens the browser as a new tab in the active pane (used by cmd-l
    // from a non-browser tab). Otherwise fall back to the historical behavior:
    // split off a new pane beside the active editor (cmd-t).
    if (opt.noSplit) {
      opt.split = void 0;
    } else if (!opt.split) {
      opt.split = this.getPosition();
    }
    return atom.workspace.open('tranquil-browser://blank', opt);
  },
  getPosition: function () {
    var activePane, orientation, paneAxis, paneIndex, ref;
    activePane = atom.workspace.paneForItem(
      atom.workspace.getActiveTextEditor()
    );
    if (!activePane) {
      return;
    }
    paneAxis = activePane.getParent();
    if (!paneAxis) {
      return;
    }
    paneIndex = paneAxis.getPanes().indexOf(activePane);
    orientation = (ref = paneAxis.orientation) != null ? ref : 'horizontal';
    if (orientation === 'horizontal') {
      if (paneIndex === 0) {
        return 'right';
      } else {
        return 'left';
      }
    } else {
      if (paneIndex === 0) {
        return 'down';
      } else {
        return 'up';
      }
    }
  },
  deactivate: function () {
    var ref;
    if ((ref = this.tranquilBrowserView) != null) {
      if (typeof ref.destroy === 'function') {
        ref.destroy();
      }
    }
    if (this.findItem != null) {
      this.findItem.destroy();
      this.findItem = null;
    }
    return this.subscriptions.dispose();
  },
  serialize: function () {
    return {
      noReset: true,
    };
  },
  deserializeHTMLEditor: function (state) {
    return new TranquilBrowserModel({
      ...state.data,
      tranquilBrowser: this,
    });
  },
  // 'light' or 'dark' for the app's active UI theme. Matches business-light /
  // theme-light and ignores syntax themes (one-light-syntax etc.).
  activeThemeMode: function () {
    const isLight = (atom.config.get('core.themes') || []).some(
      (t) => /light/i.test(t) && !/syntax/i.test(t)
    );
    return isLight ? 'light' : 'dark';
  },
  // Build the file:// URL for the blank start page, tagged with the app's active
  // theme (?theme=dark|light). The page is an isolated file:// webview that can't
  // read theme LESS, and the OS color scheme it would otherwise fall back to may
  // not match the active Tranquil theme — so pass it explicitly. Built from
  // __dirname (not this.resources — `this` binding isn't guaranteed at every call
  // site) so it resolves the same from every path.
  blankPageUrl: function () {
    const base = (
      'file://' +
      require('path').resolve(`${__dirname}/../resources/`) +
      '/home.html'
    ).replace(/\\/g, '/');
    return base + '?theme=' + this.activeThemeMode();
  },
  getTranquilBrowserUrl: function (url) {
    if (url.startsWith('tranquil-browser://history')) {
      return (url = this.resources + '/history.html');
    } else if (url.startsWith('tranquil-browser://blank')) {
      // A restored blank tab deserializes with url 'tranquil-browser://blank'
      // (model.url). Map it back to the start-page document so the webview has a
      // real src to load; without this it resolves to '' and renders nothing.
      return (url = this.blankPageUrl());
    } else {
      return (url = '');
    }
  },
  openLinkInNewWindow: function (url) {
    console.log("openLinkInNewWindow",url)
    return ipcRenderer.send('application:new-window-open-url', {url});
  },
  openLinkInDefaultBrowser: function (url) {
    console.log("openLinkInDefaultBrowser",url)
    if (url) {
      require('shell').openExternal(url);
    };
  },
  addPlugin: function (requires) {
    var error, key, menu, pkg, pkgPath, pkgs, results, script, val;
    if (this.plugins == null) {
      this.plugins = {};
    }
    results = [];
    for (key in requires) {
      val = requires[key];
      try {
        switch (key) {
          case 'onInit' || 'onExit':
            results.push(
              (this.plugins[key] = (this.plugins[key] || []).concat(
                '(' + val.toString() + ')()'
              ))
            );
            break;
          case 'js' || 'css':
            if (!pkgPath) {
              pkgs = Object.keys(atom.packages.activatingPackages).sort();
              pkg = pkgs[pkgs.length - 1];
              pkgPath = atom.packages.activatingPackages[pkg].path + '/';
            }
            if (Array.isArray(val)) {
              results.push(
                function () {
                  var i, len, results1;
                  results1 = [];
                  for (i = 0, len = val.length; i < len; i++) {
                    script = val[i];
                    if (!script.startsWith('http')) {
                      results1.push(
                        (this.plugins[key + 's'] = (
                          this.plugins[key] || []
                        ).concat(
                          'file:///' +
                            atom.packages.activatingPackages[pkg].path.replace(
                              /\\/g,
                              '/'
                            ) +
                            '/' +
                            script
                        ))
                      );
                    } else {
                      results1.push(void 0);
                    }
                  }
                  return results1;
                }.call(this)
              );
            } else {
              if (!val.startsWith('http')) {
                results.push(
                  (this.plugins[key + 's'] = (this.plugins[key] || []).concat(
                    'file:///' +
                      atom.packages.activatingPackages[pkg].path.replace(
                        /\\/g,
                        '/'
                      ) +
                      '/' +
                      val
                  ))
                );
              } else {
                results.push(void 0);
              }
            }
            break;
          case 'menus':
            if (Array.isArray(val)) {
              results.push(
                function () {
                  var i, len, results1;
                  results1 = [];
                  for (i = 0, len = val.length; i < len; i++) {
                    menu = val[i];
                    menu._id = uuid.v1();
                    results1.push(
                      (this.plugins[key] = (this.plugins[key] || []).concat(
                        menu
                      ))
                    );
                  }
                  return results1;
                }.call(this)
              );
            } else {
              val._id = uuid.v1();
              results.push(
                (this.plugins[key] = (this.plugins[key] || []).concat(val))
              );
            }
            break;
          default:
            results.push(void 0);
        }
      } catch (error1) {
        error = error1;
      }
    }
    return results;
  },
  provideService: function () {
    return {
      model: require('./tranquil-browser-model'),
      addPlugin: this.addPlugin.bind(this),
    };
  },
  consumeTreeView(treeView) {
    this.treeView = treeView;
  },
  handleURI(parsedUri) {
    atom.workspace.open(parsedUri.path.slice(1));
  },
};

module.exports = TranquilBrowser;
