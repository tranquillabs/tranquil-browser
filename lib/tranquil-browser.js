const { CompositeDisposable } = require("atom");
const TranquilBrowserModel = require("./tranquil-browser-model");
const { notify } = require("./notify.js");
require("JSON2");
const uuid = require("node-uuid");
const path = require("path");
const fs = require("fs");
const { ipcRenderer } = require('electron');

const TranquilBrowser = {
  tranquilBrowserView: null,
  subscriptions: null,
  addToTreeView(url) {
    let defaultName = (this.model && this.model.title) ? this.model.title : '';
    if (!defaultName) {
      try {
        const u = new URL(url);
        defaultName = u.hostname;
      } catch {
        defaultName = 'link';
      }
    }
    defaultName = defaultName.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').trim().slice(0, 64);

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
  // opt+cmd+w (Ctrl+Alt+W on Win/Linux) on a browser tab: close the tab and move
  // its source .url bookmark to the system Trash (recoverable). No confirmation; a
  // toast names the trashed file. A tab with no .url just closes; a non-browser
  // active item is a no-op. Two callers: the atom-workspace command (chrome/tab
  // focus) and the webview keyHandler (a focused guest page swallows the keys).
  closeTabAndTrashUrl(item) {
    // Fall back to the CENTER's active item, not getActivePaneItem() — when focus
    // is in the tree-view (a dock pane item) the latter returns the tree-view,
    // not the browser tab the user means to close.
    item = item || atom.workspace.getCenter().getActivePaneItem();
    if (!(item instanceof TranquilBrowserModel)) return;
    const filePath = item.getPath();
    atom.workspace.paneForItem(item)?.destroyItem(item);
    if (filePath && filePath.endsWith('.url') && fs.existsSync(filePath)) {
      require('electron').shell.trashItem(filePath).then(
        () => notify('addInfo', `Trashed ${path.basename(filePath)}`),
        (err) => notify('addError', `Couldn't trash ${path.basename(filePath)}: ${err.message}`)
      );
    }
  },
  // opt+cmd+click (Ctrl+Alt+click on Win/Linux) on a page link: save it as a
  // numbered `.url` Internet Shortcut in the tree view's currently-selected
  // folder, no dialog. Files are prefixed `001-`, `002-`, … (zero-padded so they
  // alpha-sort) continuing from the highest number already present in the folder.
  saveNumberedLink(link, text) {
    // Resolve the target directory from the tree-view selection, mirroring
    // tree-view's own file-vs-folder rule (a selected file → its parent dir).
    const sel = this.treeView?.selectedPaths?.()[0];
    let dir = sel && fs.existsSync(sel) && fs.statSync(sel).isFile()
      ? path.dirname(sel)
      : sel;
    if (!dir) dir = atom.project.getPaths()[0];
    if (!dir) {
      notify("addInfo", "Select a folder in the tree view (or open a project) to save links.");
      return;
    }

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

    // Filename from the link text; fall back to the URL hostname, then 'link'.
    let base = (text || "").trim();
    if (!base) {
      try { base = new URL(link).hostname; } catch { base = "link"; }
    }
    base = base.replace(/[<>:"/\\|?*\x00-\x1f]/g, "-").trim().slice(0, 64);

    const name = `${prefix}-${base}.url`;
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
    if (!window.bp.js.get('bp.history')) {
      window.bp.js.set('bp.history', []);
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
                  const historyURL = (
                    "file://" +
                    path.resolve(`${__dirname}/../resources/`) +
                    "/home.html"
                  ).replace(/\\/g, "/");
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
    this.subscriptions.add(
      atom.workspace.onDidChangeActivePaneItem((item) => {
        if (item instanceof TranquilBrowserModel) {
          item.view?.htmlv?.[0]?.focus();
        }
      })
    );
    this.subscriptions.add(
      atom.commands.add('atom-workspace', {
        'tranquil-browser:open': (function (_this) {
          return function () {
            return _this.open();
          };
        })(this),
      })
    );
    this.subscriptions.add(
      atom.commands.add('atom-workspace', {
        'tranquil-browser:focus-url': function () {
          const urlInput = atom.workspace.getActivePaneItem()?.view?.urlbar[0]?.querySelector('#url');
          urlInput?.focus();
          urlInput?.select();
        },
        'tranquil-browser:refresh': function () {
          const item = atom.workspace.getActivePaneItem();
          if (!(item instanceof TranquilBrowserModel)) return;
          item.view?.refreshPage();
        },
        'tranquil-browser:hard-refresh': function () {
          const item = atom.workspace.getActivePaneItem();
          if (!(item instanceof TranquilBrowserModel)) return;
          item.view?.refreshPage(void 0, true);
        },
        'tranquil-browser:save-har': (function (_this) {
          return function () {
            _this.saveHar();
          };
        })(this),
        'tranquil-browser:close-tab-and-delete-url': function () {
          TranquilBrowser.closeTabAndTrashUrl();
        },
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
        'tranquil-browser:open-all-urls-in-folder': function (event) {
          const entry = event.target.closest('.entry');
          const dirPath = entry && entry.getPath();
          if (!dirPath) return;
          const fs = require('fs');
          const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.url'));
          for (const file of files) {
            atom.workspace.open(path.join(dirPath, file));
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
            atom.workspace.open(path.join(dirPath, file.name));
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
        'tranquil-browser:deleteHistory': (function (_this) {
          return function () {
            return _this['delete'](true);
          };
        })(this),
      })
    );
    // Intercept cmd-k + arrow in the host renderer so splits always target the
    // correct pane regardless of focus state or theme switches. We use capture
    // phase so this fires before Pulsar's keymap listener, then stop propagation
    // on the second key to prevent a duplicate split from Pulsar's body binding.
    let splitChordPending = false;
    let splitChordTimer = null;
    const isMac = process.platform === 'darwin';
    const splitDirs = { ArrowUp: 'splitUp', ArrowDown: 'splitDown', ArrowLeft: 'splitLeft', ArrowRight: 'splitRight' };

    const splitKeymapInterceptor = (e) => {
      if ((isMac ? e.metaKey : e.ctrlKey) && e.key === 'k') {
        splitChordPending = true;
        clearTimeout(splitChordTimer);
        splitChordTimer = setTimeout(() => { splitChordPending = false; }, 1000);
        return;
      }
      if (splitChordPending) {
        const method = splitDirs[e.key];
        if (method) {
          splitChordPending = false;
          clearTimeout(splitChordTimer);
          e.stopImmediatePropagation();
          const activeItem = atom.workspace.getActivePaneItem();
          const pane = atom.workspace.paneForItem(activeItem);
          if (pane) pane[method]({ copyActiveItem: true });
        }
      }
    };

    document.addEventListener('keydown', splitKeymapInterceptor, true);
    const { Disposable } = require('atom');
    return this.subscriptions.add(new Disposable(() => {
      document.removeEventListener('keydown', splitKeymapInterceptor, true);
      clearTimeout(splitChordTimer);
    }));
  },
  favr: function () {
    var favList;
    favList = require('./fav-view');
    return new favList(window.bp.js.get('bp.fav'));
  },
  delete: function () {
    return window.bp.js.set('bp.history', []);
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
    if (!opt.split) {
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
  getTranquilBrowserUrl: function (url) {
    if (url.startsWith('tranquil-browser://history')) {
      return (url = this.resources + '/history.html');
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
