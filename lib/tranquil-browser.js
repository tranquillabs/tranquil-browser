const { CompositeDisposable } = require("atom");
const TranquilBrowserModel = require("./tranquil-browser-model");
require("JSON2");
const uuid = require("node-uuid");
const path = require("path");
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
        if (err) atom.notifications.addError(`Could not save URL file: ${err.message}`);
      });
    }).catch(err => {
      atom.notifications.addError(`Could not open save dialog: ${err.message}`);
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
              // to avoid multiple tab open              
              if (window.prevId && (Date.now()-window.prevId)< 50 ) return;
              window.prevId = Date.now();
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
      })
    );
    this.subscriptions.add(
      atom.commands.add('atom-workspace', {
        'tranquil-browser:open-url-file': function (event) {
          const entry = event.target.closest('.entry');
          const filePath = entry && entry.getPath();
          if (filePath) atom.workspace.open(filePath);
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
      })
    );
    this.subscriptions.add(
      atom.commands.add('atom-workspace', {
        'tranquil-browser:add-to-tree-view': (function (_this) {
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
    this.subscriptions.add(
      atom.commands.add('atom-workspace', {
        'tranquil-browser:fav': (function (_this) {
          return function () {
            console.log('fav click');
            return _this.favr();
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
  consumeTreeView() {},
  handleURI(parsedUri) {
    atom.workspace.open(parsedUri.path.slice(1));
  },
};

module.exports = TranquilBrowser;
