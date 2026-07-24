const { CompositeDisposable, Disposable } = require("atom");
const ref = require("atom-space-pen-views");
const jQ = require("jquery");
require("jquery-ui/autocomplete");
const path = require("path");
require("JSON2");
const fs = require("fs");
require("jstorage");
const { addIpcInstanceEvents, addUrlChangeInstanceEvent, windowHistoryKey, tabDisplayTitle } = require("./utils");
const TranquilBrowser = require("./tranquil-browser");
const { notify } = require("./notify.js");

const View = ref.View;
const $ = ref.$;

const _iconDir = path.join(__dirname, '..', 'resources', 'icons');
const _icon = name => `file://${_iconDir}/${name}.svg`;
window.bp = {};
window.bp.js = $.extend({}, window.$.jStorage);

RegExp.escape = function (s) {
  return s.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&");
};
const crypto = require("crypto");

const decodePassword = (password, ivCipher) => {
  const rawPassword = Buffer.from(password, "base64");
  const rawKey = Buffer.from("5dBJWAPezu6p7eq7vImQiw==", "base64");
  const iv = Buffer.from(ivCipher, "base64");

  const decipher = crypto.createDecipheriv("aes-128-cbc", rawKey, iv);
  let decrypted = decipher.update(rawPassword);
  decrypted += decipher.final("utf8");
  return decrypted.toString();
};
const extend = function (child, parent) {
  Object.keys(parent).forEach((key) => {
    child[key] = parent[key];
  });

  function ctor() {
    this.constructor = child;
  }
  ctor.prototype = parent.prototype;
  child.prototype = new ctor();
  child.__super__ = parent.prototype;
  return child;
};

const TranquilBrowserView = (function (superClass) {
  extend(TranquilBrowserView, superClass);

  function TranquilBrowserView(model) {
    this.model = model;
    this.subscriptions = new CompositeDisposable();
    this.model.view = this;
    this.model.onDidDestroy(() => {
      this.subscriptions.dispose();
      if (typeof jQ(this.url).autocomplete === "function") {
        jQ(this.url).autocomplete("destroy");
      }
    });
    // this.subscriptions.add(
    //   atom.commands.add('atom-workspace', {
    //     'tranquil-browser:add-to-tree-view': (function (_this) {
    //       return function () {
    //         console.log({ hehe: _this });
    //         console.log({ hehe2: _this.model });
    //         console.log({ hehe3: _this.model.view });
    //         console.log({ hehe4: _this.model.url });
    //       };
    //     })(this),
    //   })
    // );
    TranquilBrowserView.__super__.constructor.apply(this, arguments);
  }
  TranquilBrowserView.content = function (params) {
    let url = params.url;
    let spinnerClass = "fa fa-spinner";
    let hideURLBar = "";
    if (params.opt && params.opt.hideURLBar) {
      hideURLBar = "hideURLBar";
    }
    if (params.opt && params.opt.src) {
      params.src = TranquilBrowserView.checkBase(params.opt.src, params.url);
      params.src = params.src.replace(/"/g, "'");
      if (!params.src.startsWith("data:text/html,")) {
        params.src = "data:text/html," + params.src;
      }
      url = params.src;
    }
    if (params.url && params.url.startsWith("tranquil-browser://")) {
      url =
        params.tranquilBrowser &&
        params.tranquilBrowser.getTranquilBrowserUrl(url);
      spinnerClass += " fa-custom";
    }

    // The blank start page shows an EMPTY address bar (it has its own search box);
    // its internal identity stays "tranquil-browser://blank" on the model. Detect
    // it from either the friendly URI or the mapped home.html file URL.
    const isBlankPage =
      (params.url && params.url.startsWith("tranquil-browser://blank")) ||
      (typeof url === "string" && url.includes("/resources/home.html"));
    const displayUrl = isBlankPage ? "" : `${params.url}`;

    this.div({ class: "tranquil-browser" }, () => {
      this.div(
        { class: `url-bc native-key-bindings ${hideURLBar}`, outlet: "urlbar" },
        () => {
          this.div({ class: "nav-btns-left-bc" }, () => {
            this.span(
              { id: "back", class: "apm-browser-icon-wrapper", outlet: "back" },
              () => { this.img({ class: "apm-browser-icon", src: _icon("arrow-left") }); }
            );
            this.span(
              { id: "forward", class: "apm-browser-icon-wrapper", outlet: "forward" },
              () => { this.img({ class: "apm-browser-icon", src: _icon("arrow-right") }); }
            );
            this.span({ class: "apm-browser-icon-divider" }, "");
            this.span(
              { id: "refresh", class: "apm-browser-icon-wrapper", outlet: "refresh" },
              () => { this.img({ class: "apm-browser-icon", src: _icon("arrow-clockwise") }); }
            );
            this.a({ class: spinnerClass, outlet: "spinner" });
          });

          this.div({ class: "nav-btns-bc" }, () => {
            this.div({ class: "nav-btns-right-bc" }, () => {
              this.span(
                { id: "newTab", class: "apm-browser-icon-wrapper", outlet: "newTab" },
                () => { this.img({ class: "apm-browser-icon", src: _icon("plus") }); }
              );
              this.span({ class: "apm-browser-icon-divider" }, "");
              this.span(
                { id: "save", class: "apm-browser-icon-wrapper", outlet: "save" },
                () => { this.img({ class: "apm-browser-icon", src: _icon("floppy-disk") }); }
              );
              this.span({ class: "apm-browser-icon-divider" }, "");
              this.span(
                { id: "history", class: "apm-browser-icon-wrapper", outlet: "history" },
                () => { this.img({ class: "apm-browser-icon", src: _icon("clock-counter-clockwise") }); }
              );
              this.span({ class: "apm-browser-icon-divider" }, "");
              this.span(
                { id: "print", class: "apm-browser-icon-wrapper", outlet: "print" },
                () => { this.img({ class: "apm-browser-icon", src: _icon("printer") }); }
              );
              this.span({ class: "apm-browser-icon-divider" }, "");
              this.span(
                { id: "devtool", class: "apm-browser-icon-wrapper", outlet: "devtool" },
                () => { this.img({ class: "apm-browser-icon", src: _icon("code") }); }
              );
            });

            this.div({ class: "input-url-bc" }, () => {
              this.input({
                class: "native-key-bindings-removed", // changing class native-key-bindings-->native-key-bindings-removed since it imapacts native key bindings
                type: "text",
                id: "url",
                outlet: "url",
                placeholder: "Search or enter address",
                value: `${displayUrl}`,
              });
            });
          });
        }
      );
      const webviewAttrs = {
        class: "native-key-bindings",
        outlet: "htmlv",
        preload: `file:///${path.resolve(__dirname, '../resources')}/bp-client.js`,
        plugins: "on",
        src: `${url}`,
        // disablewebsecurity: "on",
        allowfileaccessfromfiles: "on",
        allowPointerLock: "on",
        nodeIntegration: "on",
        contextIsolation: "on",
        // partition: "persist:partitionName",
      };
      // Session partition, in priority order:
      //   1. An explicit per-tab partition (HAR-replay tabs run in a dedicated
      //      session whose http/https/file requests are served from the archive
      //      — see main-process har.js).
      //   2. The per-window session — every Tranquil window carries a durable
      //      windowSessionId (main-process atom-window.js), so each window is its
      //      own cookie/login jar. This lets the same domain be logged in under
      //      different credentials in different windows, persisted across restart.
      //   3. Nothing (Electron default session) as a safety fallback.
      const windowSessionId = atom.getLoadSettings().windowSessionId;
      if (params.opt && params.opt.partition) {
        webviewAttrs.partition = params.opt.partition;
      } else if (windowSessionId) {
        webviewAttrs.partition = 'persist:tb-window-' + windowSessionId;
      }
      this.tag("webview", webviewAttrs);
    });
  };

  TranquilBrowserView.prototype.toggleURLBar = function () {
    return this.urlbar.toggle();
  };

  TranquilBrowserView.prototype.initialize = function () {
    var base1,
      ref1,
      ref2,
      ref3,
      ref4,
      ref5,
      ref6,
      ref7,
      ref8,
      ref9,
      select,
      src;
    src = (function (_this) {
      return function (req, res) {
        var fav, pattern, searchUrl, urls;
        pattern = RegExp("" + RegExp.escape(req.term), "i");
        fav = (window.bp.js.get("bp.fav") || []).filter(function (fav) {
          return fav.url.match(pattern) || fav.title.match(pattern);
        });
        urls = fav.map(function (fav) { return fav.url; });
        res(urls);
        searchUrl = "http://api.bing.com/osjson.aspx";
        return (function () {
          return jQ.ajax({
            url: searchUrl,
            dataType: "json",
            data: {
              query: req.term,
              "web.count": 10,
            },
            success: (function (_this) {
              return function (data) {
                var dat, i, len, ref1, search;
                urls = urls.slice(0, 11);
                search = "https://duckduckgo.com/?q=";
                ref1 = data[1].slice(0, 11);
                for (i = 0, len = ref1.length; i < len; i++) {
                  dat = ref1[i];
                  urls.push({
                    label: dat,
                    value: search + dat,
                  });
                }
                return res(urls);
              };
            })(this),
          });
        })();
      };
    })(this);
    select = (function (_this) {
      return function (event, ui) {
        return _this.goToUrl(ui.item.value);
      };
    })(this);
    if (typeof (base1 = jQ(this.url)).autocomplete === "function") {
      base1.autocomplete({
        source: src,
        minLength: 2,
        select: select,
      });
    }

    this.subscriptions.add(
      atom.tooltips.add(this.back, {
        title: "Back",
      })
    );
    this.subscriptions.add(
      atom.tooltips.add(this.forward, {
        title: "Forward",
      })
    );
    this.subscriptions.add(
      atom.tooltips.add(this.refresh, {
        title: "Refresh ⌘R · Hard refresh ⌘Click",
      })
    );
    this.subscriptions.add(
      atom.tooltips.add(this.print, {
        title: "Print",
      })
    );
    this.subscriptions.add(
      atom.tooltips.add(this.history, {
        title: "History",
      })
    );
    // this.subscriptions.add(
    //   atom.tooltips.add(this.favList, {
    //     title: 'View Favorites',
    //   })
    // );
    this.subscriptions.add(
      atom.tooltips.add(this.newTab, {
        title: "New Tab",
      })
    );
    this.subscriptions.add(
      atom.tooltips.add(this.save, {
        title: "Save to Tree View",
      })
    );
    this.subscriptions.add(
      atom.tooltips.add(this.devtool, {
        title: "Dev Tools-f12",
      })
    );
    // tranquil-browser:go-back, :go-forward and :toggle-url-bar are registered at
    // atom-workspace scope in tranquil-browser.js so they always appear in the
    // command palette. Per-view `.tranquil-browser webview` registrations only
    // showed while the webview was focused.
    addIpcInstanceEvents(this, atom, TranquilBrowser);
    // Keep an open start page in sync with the app theme live. The page is an
    // isolated file:// webview, so a theme switch can't reach it via CSS — push
    // the new mode in on each active-theme change (only the blank start page
    // reads data-theme; real sites are left untouched).
    this.subscriptions.add(
      atom.themes.onDidChangeActiveThemes((function (_this) {
        return function () {
          return _this.applyStartPageTheme();
        };
      })(this))
    );
    // this.element.onkeydown = (function (_this) {
    //   return function () {
    //     return _this.keyHandler(arguments);
    //   };
    // })(this);
    if (this.model.url.indexOf("file:///") >= 0) {
      this.checkFav();
    }
    if ((ref1 = this.htmlv[0]) != null) {
      ref1.addEventListener("permissionrequest", function (e) {
        return e.request.allow();
      });
    }
    if ((ref2 = this.htmlv[0]) != null) {
      ref2.addEventListener(
        "console-message",
        (function (_this) {
          return function (e) {
            var base2,
              base3,
              base4,
              base5,
              base6,
              css,
              csss,
              data,
              i,
              indx,
              init,
              inits,
              j,
              js,
              jss,
              k,
              l,
              left,
              len,
              len1,
              len2,
              len3,
              menu,
              menus,
              ref10,
              ref11,
              ref12,
              ref13,
              ref14,
              ref15,
              ref16,
              ref17,
              ref18,
              ref19,
              ref3,
              ref4,
              ref5,
              ref6,
              ref7,
              ref8,
              ref9,
              top;
            if (
              e.message.includes("~tranquil-browser-jquery~") ||
              e.message.includes("~tranquil-browser-menu~")
            ) {
              if (e.message.includes("~tranquil-browser-jquery~")) {
                if ((base2 = _this.model.tranquilBrowser).jQueryJS == null) {
                  base2.jQueryJS = TranquilBrowserView.getJQuery.call(_this);
                }
                if ((ref3 = _this.htmlv[0]) != null) {
                  // ref3.executeJavaScript(_this.model.tranquilBrowser.jQueryJS);
                }
              }
              if ((base3 = _this.model.tranquilBrowser).jStorageJS == null) {
                base3.jStorageJS = TranquilBrowserView.getJStorage.call(_this);
              }
              if ((ref6 = _this.htmlv[0]) != null) {
                // ref6.executeJavaScript(_this.model.tranquilBrowser.jStorageJS);
              }
              if ((base4 = _this.model.tranquilBrowser).watchjs == null) {
                base4.watchjs = TranquilBrowserView.getWatchjs.call(_this);
              }
              if ((ref7 = _this.htmlv[0]) != null) {
                // ref7.executeJavaScript(_this.model.tranquilBrowser.watchjs);
              }
              if ((base5 = _this.model.tranquilBrowser).hotKeys == null) {
                base5.hotKeys = TranquilBrowserView.getHotKeys.call(_this);
              }
              if ((ref8 = _this.htmlv[0]) != null) {
                // ref8.executeJavaScript(_this.model.tranquilBrowser.hotKeys);
              }
              if ((base6 = _this.model.tranquilBrowser).notifyBar == null) {
                base6.notifyBar = TranquilBrowserView.getNotifyBar.call(_this);
              }
              if ((ref9 = _this.htmlv[0]) != null) {
                // ref9.executeJavaScript(_this.model.tranquilBrowser.notifyBar);
              }
              if (
                (inits =
                  (ref10 = _this.model.tranquilBrowser.plugins) != null
                    ? ref10.onInit
                    : void 0)
              ) {
                for (i = 0, len = inits.length; i < len; i++) {
                  init = inits[i];
                  if ((ref11 = _this.htmlv[0]) != null) {
                    ref11.executeJavaScript(init);
                  }
                }
              }
              if (
                (jss =
                  (ref12 = _this.model.tranquilBrowser.plugins) != null
                    ? ref12.jss
                    : void 0)
              ) {
                for (j = 0, len1 = jss.length; j < len1; j++) {
                  js = jss[j];
                  if ((ref13 = _this.htmlv[0]) != null) {
                    // ref13.executeJavaScript(TranquilBrowserView.loadJS.call(_this, js, true));
                  }
                }
              }
              if (
                (csss =
                  (ref14 = _this.model.tranquilBrowser.plugins) != null
                    ? ref14.csss
                    : void 0)
              ) {
                for (k = 0, len2 = csss.length; k < len2; k++) {
                  css = csss[k];
                  if ((ref15 = _this.htmlv[0]) != null) {
                    // ref15.executeJavaScript(TranquilBrowserView.loadCSS.call(_this, css, true));
                  }
                }
              }
              if (
                (menus =
                  (ref16 = _this.model.tranquilBrowser.plugins) != null
                    ? ref16.menus
                    : void 0)
              ) {
                for (l = 0, len3 = menus.length; l < len3; l++) {
                  menu = menus[l];
                  if (menu.fn) {
                    menu.fn = menu.fn.toString();
                  }
                  if (menu.selectorFilter) {
                    menu.selectorFilter = menu.selectorFilter.toString();
                  }
                  if ((ref17 = _this.htmlv[0]) != null) {
                    ref17.executeJavaScript(
                      "tranquilBrowser.menu(" + JSON.stringify(menu) + ")"
                    );
                  }
                }
              }

              // if ((ref18 = _this.htmlv[0]) != null) {
              //   console.log(_this, _this.htmlv);
              //   try {

              //     ref18.executeJavaScript(TranquilBrowserView.loadCSS.call(_this, '/bp-style.css'));
              //   } catch (e) {
              //     console.log(e)
              //   }
              // }
              // return (ref19 = _this.htmlv[0]) != null
              //   ? ref19.executeJavaScript(TranquilBrowserView.loadCSS.call(_this, '/jquery.notifyBar.css'))
              //   : void 0;
            }
          };
        })(this)
      );
    }
    if ((ref3 = this.htmlv[0]) != null) {
      ref3.addEventListener(
        "page-favicon-updated",
        (function (_this) {
          return function (e) {
            var _, fav, favIcon, favr, style, uri;
            _ = require("lodash");
            favr = window.bp.js.get("bp.fav");
            if (
              (fav = _.find(favr, {
                url: _this.model.url,
              }))
            ) {
              fav.favIcon = e.favicons[0];
              window.bp.js.set("bp.fav", favr);
            }
            _this.model.iconName = Math.floor(Math.random() * 10000).toString();
            _this.model.favIcon = e.favicons[0];
            _this.model.updateIcon(e.favicons[0]);
            favIcon = window.bp.js.get("bp.favIcon");
            uri = _this.htmlv[0].getURL();
            if (!uri) {
              return;
            }
            favIcon[uri] = e.favicons[0];
            window.bp.js.set("bp.favIcon", favIcon);
            // Pass the favicon (not undefined) — a bare updateIcon() would reset
            // model.favIcon back to undefined, blanking consumers like the
            // vertical tab list that read it.
            _this.model.updateIcon(e.favicons[0]);
            style = document.createElement("style");
            style.type = "text/css";
            style.innerHTML =
              ".title.icon.icon-" +
              _this.model.iconName +
              " {\n  background-size: 16px 16px;\n  background-repeat: no-repeat;\n  padding-left: 20px;\n  background-image: url('" +
              e.favicons[0] +
              "');\n  background-position-y: 50%;\n}";
            return document.getElementsByTagName("head")[0].appendChild(style);
          };
        })(this)
      );
    }
    if ((ref4 = this.htmlv[0]) != null) {
      ref4.addEventListener(
        "did-navigate-in-page",
        (function (_this) {
          return function (evt) {
            if (evt.isMainFrame) return _this.updatePageUrl(evt);
          };
        })(this)
      );
    }
    if ((ref5 = this.htmlv[0]) != null) {
      ref5.addEventListener(
        "did-navigate",
        (function (_this) {
          return function (evt) {
            return _this.updatePageUrl(evt);
          };
        })(this)
      );
    }
    if ((ref6 = this.htmlv[0]) != null) {
      ref6.addEventListener(
        "page-title-set",
        (function (_this) {
          return function (e) {
            var _, fav, favr, title, uri;
            _ = require("lodash");
            favr = window.bp.js.get("bp.fav");
            title = window.bp.js.get("bp.title");
            uri = _this.htmlv[0].getURL();
            if (!uri) {
              return;
            }
            title[uri] = e.title;
            window.bp.js.set("bp.title", title);
            if (
              (fav = _.find(favr, {
                url: _this.model.url,
              }))
            ) {
              fav.title = e.title;
              window.bp.js.set("bp.fav", favr);
            }
            return _this.model.setTitle(e.title);
          };
        })(this)
      );
    }
    this.devtool.on(
      "click",
      (function (_this) {
        return function (evt) {
          return _this.toggleDevTool();
        };
      })(this)
    );
    this.spinner.on(
      "click",
      (function (_this) {
        return function (evt) {
          var ref7;
          return (ref7 = _this.htmlv[0]) != null ? ref7.stop() : void 0;
        };
      })(this)
    );
    this.print.on(
      "click",
      (function (_this) {
        return function (evt) {
          var ref7;
          return (ref7 = _this.htmlv[0]) != null ? ref7.print() : void 0;
        };
      })(this)
    );
    this.newTab.on(
      "click",
      (function (_this) {
        return function (evt) {
          _this.model.terminatePendingState();
          atom.workspace.open("tranquil-browser://blank");
          return _this.spinner.removeClass("fa-custom");
        };
      })(this)
    );
    this.save.on(
      "click",
      (function (_this) {
        return function (evt) {
          var url = _this.model != null ? _this.model.getURL() : null;
          if (url) {
            // Save as `<title>.url` (no numbered prefix, no dialog), named after
            // the tab's full display title (same source as the Tabs pane), not the
            // model's destructively-truncated title.
            TranquilBrowser.saveLinkToTree(url, tabDisplayTitle(url));
          }
        };
      })(this)
    );
    this.history.on(
      "click",
      (function (_this) {
        return function (evt) {
          return atom.workspace.open("tranquil-browser://history", {
            split: "left",
            searchAllPanes: true,
          });
        };
      })(this)
    );
    if ((ref7 = this.htmlv[0]) != null) {
      ref7.addEventListener("new-window", async function (e) {
        console.log("new window triggered ", e.url);
        return atom.workspace.open(e.url, {
          split: "left",
          searchAllPanes: true,
          openInSameWindow: false,
        });
      });
    }
    if ((ref8 = this.htmlv[0]) != null) {
      ref8.addEventListener(
        "did-start-loading",
        (function (_this) {
          return function () {
            var ref9;
            _this.spinner.removeClass("fa-custom");
            return (ref9 = _this.htmlv[0]) != null
              ? (ref9.shadowRoot.firstChild.style.height = "95%")
              : void 0;
          };
        })(this)
      );
    }
    if ((ref9 = this.htmlv[0]) != null) {
      ref9.addEventListener(
        "did-stop-loading",
        (function (_this) {
          return function () {
            return _this.spinner.addClass("fa-custom");
          };
        })(this)
      );
    }
    // The history page (history.html) lives in this window's isolated webview
    // partition, so it can't read the host renderer's history/title/favIcon
    // store. Push this window's data into the page each time it finishes
    // loading; setting bp.history triggers the page's re-render (and we call
    // histTag.update() directly as a belt-and-braces refresh).
    if (this.htmlv[0] != null) {
      this.htmlv[0].addEventListener(
        "did-stop-loading",
        (function (_this) {
          return function () {
            var wv, u;
            wv = _this.htmlv[0];
            if (!wv) return;
            try { u = wv.getURL() || ""; } catch (e) { return; }
            // Only our own internal history page — not a third-party page that
            // happens to have "history.html" in its path.
            if (u.indexOf("resources/history.html") < 0 || u.indexOf("file://") !== 0) return;
            var payload = {
              history: window.bp.js.get(windowHistoryKey(atom)) || [],
              title: window.bp.js.get("bp.title") || {},
              favIcon: window.bp.js.get("bp.favIcon") || {},
            };
            wv.executeJavaScript(
              "(function(){try{" +
              "$.jStorage.set('bp.title'," + JSON.stringify(payload.title) + ");" +
              "$.jStorage.set('bp.favIcon'," + JSON.stringify(payload.favIcon) + ");" +
              "$.jStorage.set('bp.history'," + JSON.stringify(payload.history) + ");" +
              "if(window.histTag)histTag.update();" +
              "}catch(e){console.error('history inject failed',e)}})()"
            ).catch(function () {});
          };
        })(this)
      );
    }
    this.back.on(
      "click",
      (function (_this) {
        return function (evt) {
          var ref10, ref11;
          if (
            ((ref10 = _this.htmlv[0]) != null ? ref10.canGoBack() : void 0) &&
            $(this).hasClass("active")
          ) {
            return (ref11 = _this.htmlv[0]) != null ? ref11.goBack() : void 0;
          }
        };
      })(this)
    );
    // this.favList.on(
    //   'click',
    //   (function (_this) {
    //     return function (evt) {
    //       var favList;
    //       favList = require('./fav-view');
    //       return new favList(window.bp.js.get('bp.fav'));
    //     };
    //   })(this)
    // );
    this.forward.on(
      "click",
      (function (_this) {
        return function (evt) {
          var ref10, ref11;
          if (
            ((ref10 = _this.htmlv[0]) != null
              ? ref10.canGoForward()
              : void 0) &&
            $(this).hasClass("active")
          ) {
            return (ref11 = _this.htmlv[0]) != null
              ? ref11.goForward()
              : void 0;
          }
        };
      })(this)
    );
    this.url.on("keydown", function (evt) {
      evt.stopImmediatePropagation();
    });
    this.url.on(
      "keypress",
      (function (_this) {
        return function (evt) {
          var URL, localhostPattern, ref10, url, urls;
          URL = require("url");
          if (evt.which === 13) {
            _this.url.blur();
            urls = URL.parse(this.value.trim());
            url = this.value.trim();
            if (!url.startsWith("tranquil-browser://")) {
              if (url.indexOf(" ") >= 0) {
                url = "https://duckduckgo.com/?q=" + url;
              } else {
                localhostPattern = /^(http:\/\/)?localhost/i;
                if (url.search(localhostPattern) < 0 && url.indexOf(".") < 0) {
                  url = "https://duckduckgo.com/?q=" + url;
                } else {
                  if (
                    (ref10 = urls.protocol) === "http" ||
                    ref10 === "https" ||
                    ref10 === "file:"
                  ) {
                    if (urls.protocol === "file:") {
                      url = url.replace(/\\/g, "/");
                    } else {
                      url = URL.format(urls);
                    }
                  } else {
                    urls.protocol = "http";
                    url = URL.format(urls);
                  }
                }
              }
            }
            return _this.goToUrl(url);
          }
        };
      })(this)
    );
    this.refresh.on(
      "click",
      (function (_this) {
        return function (evt) {
          return _this.refreshPage(void 0, evt.metaKey);
        };
      })(this)
    );

    // Drag events don't bubble to document/window in this Electron context,
    // so detect tab drags via the 'is-dragging' class that tab-bar-view.js
    // adds on dragstart and removes on dragend/drop. Hiding webviews during
    // drag removes the OOPIF compositor layer so elementFromPoint (called by
    // layout.js) can reach pane DOM elements for split-zone detection, and so
    // the tabs layout overlay is visible above the webview content.
    const dragObserver = new MutationObserver((mutations) => {
      const tabChanged = mutations.some(m => m.target.classList?.contains('tab'));
      if (!tabChanged) return;
      const dragging = !!document.querySelector('.tab.is-dragging');
      document.querySelectorAll('webview').forEach(wv => {
        wv.style.visibility = dragging ? 'hidden' : '';
        wv.style.pointerEvents = dragging ? 'none' : '';
      });
    });
    dragObserver.observe(document.body, {
      subtree: true,
      attributes: true,
      attributeFilter: ['class'],
    });
    this.subscriptions.add(new Disposable(() => dragObserver.disconnect()));
  };

  // Push the app's current theme into an open start page. No-op for real sites
  // (only the blank page reads data-theme) and when there's no webview yet.
  TranquilBrowserView.prototype.applyStartPageTheme = function () {
    const webview = this.htmlv && this.htmlv[0];
    if (!webview) return;
    if (this.model.url !== "tranquil-browser://blank") return;
    const mode = this.model.tranquilBrowser.activeThemeMode();
    try {
      webview.executeJavaScript(
        "document.documentElement.setAttribute('data-theme', '" + mode + "')"
      );
    } catch (e) {}
  };

  TranquilBrowserView.prototype.updatePageUrl = function (evt) {
    const TranquilBrowserModel = require("./tranquil-browser-model");
    const url = evt.url;
    addUrlChangeInstanceEvent(this, url);
    if (!TranquilBrowserModel.checkUrl(url)) {
      const homepage =
        atom.config.get("tranquil-browser.homepage") ||
        "https://duckduckgo.com";
      notify("addSuccess", "Redirecting to " + homepage);
      this.htmlv[0]?.executeJavaScript("location.href = '" + homepage + "'");
      return;
    }

    // The blank start page's real document is resources/home.html (file://).
    // Surface it in the address bar as the friendly "tranquil-browser://blank"
    // (and store that as model.url so getURI() dedup + serialize keep working),
    // rather than the internal file path. Every other navigation reflects its
    // real URL. Deriving this from the DESTINATION url (not what the bar shows)
    // is what lets a search from the start page — and Back to it — update the bar
    // correctly; the old check keyed off this.url.val() and got stuck once the
    // bar read "tranquil-browser://blank".
    const isBlankPage =
      url.startsWith("tranquil-browser://blank") ||
      (url.startsWith("file://") && url.includes("/resources/home.html"));
    if (isBlankPage) {
      // Internal identity stays the friendly URI (getURI() dedup + serialize +
      // restore rely on it), but the bar shows nothing — the start page has its
      // own search box, and the placeholder invites input.
      this.model.url = "tranquil-browser://blank";
      this.url.val("");
    } else if (url && url !== this.model.url) {
      this.url.val(url);
      this.model.url = url;
    }

    // The blank start page's document <title> is an internal string; show a
    // friendly "Tranquil Browser" on its tab instead. Every other page keeps its
    // real <title>.
    const title = isBlankPage
      ? "Tranquil Browser"
      : this.htmlv[0]?.getTitle() || url;
    if (title !== this.model.getTitle()) {
      this.model.setTitle(title);
    }



    this.checkNav();
    this.checkFav();
    return this.addHistory();
  };

  TranquilBrowserView.prototype.refreshPage = function (url, ignorecache) {
    try {
      if (this.model.orgURI && atom.packages.getActivePackage("pp")) {
        return atom.packages
          .getActivePackage("pp")
          .mainModule.compilePath(this.model.orgURI, this.model._id);
      } else {
        if (url) {
          this.model.url = url;
          this.url.val(url);
          if (this.htmlv[0]) {
            this.htmlv[0].src = url;
          }
        } else {
          if (this.ultraLiveOn && this.model.src && this.htmlv[0]) {
            this.htmlv[0].src = this.model.src;
          }

          if (ignorecache) {
            if (this.htmlv[0]) {
              this.htmlv[0].reloadIgnoringCache();
            }
          } else {
            try {
              if (this.htmlv[0]) {
                this.htmlv[0].reload();
              }
            } catch (e) {
              console.log(e);
            }
          }
        }
      }
    } catch (e) {
      console.log(e);
    }
  };

  TranquilBrowserView.prototype.goToUrl = function (url) {
    var TranquilBrowserModel, base1, base2, ref1;
    TranquilBrowserModel = require("./tranquil-browser-model");
    addUrlChangeInstanceEvent(this, url);
    if (!TranquilBrowserModel.checkUrl(url)) {
      return;
    }
    if (typeof (base1 = jQ(this.url)).autocomplete === "function") {
      base1.autocomplete("close");
    }
    this.url.val(url);
    this.model.url = url;
    delete this.model.title;
    delete this.model.iconName;
    delete this.model.favIcon;
    this.model.setTitle(null);
    this.model.updateIcon(null);
    if (url.startsWith("tranquil-browser://")) {
      url =
        typeof (base2 = this.model.tranquilBrowser).getTranquilBrowserUrl ===
        "function"
          ? base2.getTranquilBrowserUrl(url)
          : void 0;
    }
    return this.htmlv.attr("src", url);
  };

  TranquilBrowserView.prototype.keyHandler = function (evt) {
    const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0;
    if ((isMac ? evt.metaKey : evt.ctrlKey) && evt.key === 'k') {
      this._cmdKPending = true;
      clearTimeout(this._cmdKTimer);
      this._cmdKTimer = setTimeout(() => { this._cmdKPending = false; }, 1000);
      return;
    }
    if (this._cmdKPending) {
      const dir = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' }[evt.key];
      if (dir) {
        this._cmdKPending = false;
        clearTimeout(this._cmdKTimer);
        const pane = atom.workspace.paneForItem(this.model);
        if (pane) {
          const splits = { up: 'splitUp', down: 'splitDown', left: 'splitLeft', right: 'splitRight' };
          pane[splits[dir]]({ copyActiveItem: true });
        }
        return;
      }
    }
    switch (evt.key) {
      case "f":
        // cmd/ctrl+f → open the browser find-in-page panel. Handled here because
        // a focused guest webview swallows the keystroke before Atom's keymap.
        if ((isMac ? evt.metaKey : evt.ctrlKey) && !evt.shiftKey) {
          return TranquilBrowser.showFind();
        }
        break;
      case "F12":
        return this.toggleDevTool();
      case "F5":
        if (evt.ctrlKey || (isMac && evt.metaKey)) {
          return this.refreshPage(void 0, true);
        } else {
          return this.refreshPage();
        }
        break;
      case "r":
        if (isMac ? evt.metaKey : evt.ctrlKey) {
          return this.refreshPage(void 0, evt.shiftKey);
        }
        break;
      case "F10":
        return this.toggleURLBar();
      case "t":
        // cmd/ctrl+t → new browser tab. Exclude shift so cmd-shift-t
        // (reopen-closed-item) doesn't also spawn a blank browser tab.
        if ((evt.ctrlKey || (isMac && evt.metaKey)) && !evt.shiftKey) {
          return TranquilBrowser.open();
        }
        break;
      case "l":
        if (evt.ctrlKey || (isMac && evt.metaKey)) {
          this?.urlbar[0]?.querySelector("#url")?.focus();
          return this?.urlbar[0]?.querySelector("#url")?.select();
        }
        break;
      case "a":
      case "A":
        // cmd/ctrl+shift+a → add current page to tree view. Handled here because
        // when a webview is focused the keystroke never reaches Atom's keymap.
        if ((evt.ctrlKey || (isMac && evt.metaKey)) && evt.shiftKey) {
          const url = this.model?.getURL();
          if (url) TranquilBrowser.addToTreeView(url);
          return;
        }
        break;
      case "p":
        if ((evt.ctrlKey || (isMac && evt.metaKey)) && !evt.shiftKey) {
          try {
            return this?.htmlv[0]?.print();
          } catch (e) {
            console.log(e);
          }
        }
        break;
      case "d":
        if (evt.altKey) {
          this?.urlbar[0]?.querySelector("#url")?.focus();
          return this?.urlbar[0]?.querySelector("#url")?.select();
        }
        break;
      // Ctrl+Tab / Ctrl+Shift+Tab tab-cycling is handled in utils.js's
      // webview-key-events handler, before its active-item guard — see the note
      // there. Handling it here too would be dead code (utils.js intercepts and
      // returns first) and would reintroduce the active-item gating we avoid.
      case "ArrowLeft":
        if (evt.altKey) {
          return this.goBack();
        }
        break;
      case "ArrowRight":
        if (evt.altKey) {
          return this.goForward();
        }
    }
  };

  TranquilBrowserView.prototype.removeFav = function (favorite) {
    var favr, favrs, i, idx, len;
    favrs = window.bp.js.get("bp.fav");
    for (idx = i = 0, len = favrs.length; i < len; idx = ++i) {
      favr = favrs[idx];
      if (favr.url === favorite.url) {
        favrs.splice(idx, 1);
        window.bp.js.set("bp.fav", favrs);
        return;
      }
    }
  };

  TranquilBrowserView.prototype.setSrc = function (text) {
    var ref1, url;
    url = this.model.orgURI || this.model.url;
    text = TranquilBrowserView.checkBase(text, url);
    this.model.src = "data:text/html," + text;
    return (ref1 = this.htmlv[0]) != null
      ? (ref1.src = this.model.src)
      : void 0;
  };

  TranquilBrowserView.checkBase = function (text, url) {
    var $html, base, basePath, cheerio;
    cheerio = require("cheerio");
    $html = cheerio.load(text);
    basePath = path.dirname(url) + "/";
    if ($html("base").length) {
      return text;
    } else {
      if ($html("head").length) {
        base = "<base href='" + basePath + "' target='_blank'>";
        $html("head").prepend(base);
      } else {
        base = "<head><base href='" + basePath + "' target='_blank'></head>";
        $html("html").prepend(base);
      }
      return $html.html();
    }
  };

  TranquilBrowserView.prototype.checkFav = function () {
    var favr, favrs, i, len, results;
    if (!this.fav) return;
    this.fav.removeClass("active");
    favrs = window.bp.js.get("bp.fav");
    results = [];
    for (i = 0, len = favrs.length; i < len; i++) {
      favr = favrs[i];
      if (favr.url === this.model.url) {
        results.push(this.fav.addClass("active"));
      } else {
        results.push(void 0);
      }
    }
    return results;
  };

  TranquilBrowserView.prototype.toggleDevTool = function () {
    var open, ref1, ref2, ref3;
    open = (ref1 = this.htmlv[0]) != null ? ref1.isDevToolsOpened() : void 0;
    if (open) {
      if ((ref2 = this.htmlv[0]) != null) {
        ref2.closeDevTools();
      }
    } else {
      if ((ref3 = this.htmlv[0]) != null) {
        ref3.openDevTools();
      }
    }
    return $(this.devtool).toggleClass("active", !open);
  };

  TranquilBrowserView.prototype.checkNav = function () {
    var ref1, ref2, ref3;
    $(this.forward).toggleClass(
      "active",
      (ref1 = this.htmlv[0]) != null ? ref1.canGoForward() : void 0
    );
    $(this.back).toggleClass(
      "active",
      (ref2 = this.htmlv[0]) != null ? ref2.canGoBack() : void 0
    );
    if ((ref3 = this.htmlv[0]) != null ? ref3.canGoForward() : void 0) {
      if (this.clearForward) {
        $(this.forward).toggleClass("active", false);
        return (this.clearForward = false);
      } else {
        return $(this.forward).toggleClass("active", true);
      }
    }
  };

  TranquilBrowserView.prototype.goBack = function () {
    return this.back.click();
  };

  TranquilBrowserView.prototype.goForward = function () {
    return this.forward.click();
  };

  TranquilBrowserView.prototype.addHistory = function () {
    var histToday, history, historyURL, obj, today, todayObj, url, yyyymmdd;
    url = this.htmlv[0].getURL().replace(/\\/g, "/");
    if (!url) {
      return;
    }
    if (!this.model.tranquilBrowser) {
      return;
    }
    historyURL = (
      "file://" +
      this.model.tranquilBrowser.resources +
      "/history.html"
    ).replace(/\\/g, "/");
    if (
      url.startsWith("tranquil-browser://") ||
      url.startsWith("data:text/html,") ||
      url.startsWith(historyURL)
    ) {
      return;
    }
    yyyymmdd = function () {
      var date, dd, mm, yyyy;
      date = new Date();
      yyyy = date.getFullYear().toString();
      mm = (date.getMonth() + 1).toString();
      dd = date.getDate().toString();
      return yyyy + (mm[1] ? mm : "0" + mm[0]) + (dd[1] ? dd : "0" + dd[0]);
    };
    today = yyyymmdd();
    history = window.bp.js.get(windowHistoryKey(atom)) || [];
    todayObj = history.find(function (ele, idx, arr) {
      if (ele[today]) {
        return true;
      }
    });
    if (!todayObj) {
      obj = {};
      histToday = [];
      obj[today] = histToday;
      history.unshift(obj);
    } else {
      histToday = todayObj[today];
    }
    histToday.unshift({
      date: new Date().toString(),
      uri: url,
    });
    return window.bp.js.set(windowHistoryKey(atom), history);
  };

  TranquilBrowserView.prototype.getTitle = function () {
    return this;
  };

  TranquilBrowserView.prototype.getUrl = function () {
    return this.model.url();
  };

  TranquilBrowserView.prototype.serialize = function () {};

  TranquilBrowserView.prototype.destroy = function () {
    var base1;
    if (typeof (base1 = jQ(this.url)).autocomplete === "function") {
      base1.autocomplete("destroy");
    }
    return this.subscriptions.dispose();
  };

  TranquilBrowserView.getJQuery = function () {
    return fs.readFileSync(
      this.model.tranquilBrowser.resources + "/jquery-2.1.4.min.js",
      "utf-8"
    );
  };

  TranquilBrowserView.getEval = function () {
    return fs.readFileSync(
      this.model.tranquilBrowser.resources + "/eval.js",
      "utf-8"
    );
  };

  TranquilBrowserView.getJStorage = function () {
    return fs.readFileSync(
      this.model.tranquilBrowser.resources + "/jstorage.min.js",
      "utf-8"
    );
  };

  TranquilBrowserView.getWatchjs = function () {
    return fs.readFileSync(
      this.model.tranquilBrowser.resources + "/watch.js",
      "utf-8"
    );
  };

  TranquilBrowserView.getNotifyBar = function () {
    return fs.readFileSync(
      this.model.tranquilBrowser.resources + "/jquery.notifyBar.js",
      "utf-8"
    );
  };

  TranquilBrowserView.getHotKeys = function () {
    return fs.readFileSync(
      this.model.tranquilBrowser.resources + "/jquery.hotkeys.min.js",
      "utf-8"
    );
  };

  TranquilBrowserView.loadCSS = function (filename, fullpath) {
    var fpath;
    if (fullpath == null) {
      fullpath = false;
    }
    if (!fullpath) {
      fpath =
        "file:///" + this.model.tranquilBrowser.resources.replace(/\\/g, "/");
      filename = "" + fpath + filename;
    }
    return (
      'jQuery(\'head\').append(jQuery(\'<link type="text/css" rel="stylesheet" href="' +
      filename +
      "\">'))"
    );
  };

  TranquilBrowserView.loadJS = function (filename, fullpath) {
    var fpath;
    if (fullpath == null) {
      fullpath = false;
    }
    if (!fullpath) {
      fpath =
        "file:///" + this.model.tranquilBrowser.resources.replace(/\\/g, "/");
      filename = "" + fpath + filename;
    }
    return (
      "jQuery('head').append(jQuery('<script type=\"text/javascript\" src=\"" +
      filename +
      "\">'))"
    );
  };

  return TranquilBrowserView;
})(View);
module.exports = TranquilBrowserView;
