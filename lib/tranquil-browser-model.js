const { Disposable, Emitter } = require('atom');
const { Model } = require('theorist');
const { blockedUrlList } = require('./constants');
const path = require('path');
const { isUrlBlocked } = require('./utils');
const { notify } = require('./notify.js');

class HTMLEditor extends Model {
  constructor({ tranquilBrowser, url, opt, filePath }) {
    super();
    this.tranquilBrowser =
      typeof tranquilBrowser === 'string'
        ? JSON.parse(tranquilBrowser)
        : tranquilBrowser;
    this.url = url;
    this.filePath = filePath || null;
    this.opt = opt || {};
    this.disposable = new Disposable();
    this.emitter = new Emitter();
    this.src = this.opt.src;
    this.orgURI = this.opt.orgURI;
    this._id = this.opt._id;
    // Per-instance location overrides. Defaults keep every browser item
    // center-only (see getAllowedLocations below); a caller that wants an item
    // in a dock passes { allowedLocations, defaultLocation } through opt.
    this.allowedLocations = this.opt.allowedLocations || null;
    this.defaultLocation = this.opt.defaultLocation || null;

    if (this.tranquilBrowser && !this.tranquilBrowser.setContextMenu) {
      this.tranquilBrowser.setContextMenu = true;
      atom.contextMenu.itemSets.forEach((menu) => {
        if (menu.selector === 'atom-pane') {
          menu.items.forEach((item) => {
            item.shouldDisplay = (evt) =>
              !(evt.target?.constructor?.name === 'webview');
          });
        }
      });
    }
  }

  getViewClass() {
    return require('./tranquil-browser-view');
  }

  setText(src) {
    this.src = src;
    if (this.src) {
      this.view.setSrc(this.src);
    }
  }

  refresh(url) {
    return this.view.refreshPage(url);
  }

  destroyed() {
    return this.emitter.emit('did-destroy');
  }

  onDidDestroy(cb) {
    return this.emitter.on('did-destroy', cb);
  }

  getTitle() {
    if (this.title?.length > 20) {
      this.title = this.title.slice(0, 20) + '...';
    }
    return this.title || path.basename(this.url);
  }

  getIconName() {
    return this.iconName;
  }

  getPath() {
    return this.filePath;
  }

  getURI() {
    // Return the URL so closed browser tabs are tracked in the workspace's
    // destroyedItemURIs and can be reopened with cmd-shift-t. Skip the blank
    // homepage so new blank tabs aren't deduplicated against each other.
    if (this.url !== 'tranquil-browser://blank') {
      return this.url;
    }
  }

  getURL() {
        return this.url;
  }

  // The browser is a center-workspace editor; it must not be draggable into the
  // docks (e.g. the tree-view's left dock). Restricting its allowed locations
  // stops the tabs package from splitting a dock pane and moving the browser
  // there on drop, so dragging a browser tab onto the tree-view saves it as a
  // .url instead (handled by tranquil-drag-drop).
  getAllowedLocations() {
    return this.allowedLocations || ['center'];
  }

  getDefaultLocation() {
    return this.defaultLocation || 'center';
  }

  getGrammar() {}

  terminatePendingState() {
    const pane = atom.workspace.paneForItem(this);
    if (pane && pane.getPendingItem() === this) {
      pane.clearPendingItem();
    }
  }

  setTitle(title) {
    this.title = title;
    return this.emit('title-changed');
  }

  updateIcon(favIcon) {
    this.favIcon = favIcon;
    return this.emit('icon-changed');
  }

  serialize() {
    return {
      data: {
        // tranquilBrowser: this.tranquilBrowser
        //   ? JSON.stringify(this.tranquilBrowser)
        //   : null,
        tranquilBrowser: null,
        url: this.url,
        opt: {
          src: this.src,
          iconName: this.iconName,
          title: this.title,
          // Persist location overrides so a dock-placed item (e.g. the
          // properties mockup in the right dock) is still allowed there after
          // a window reload/deserialize, instead of reverting to center-only.
          allowedLocations: this.allowedLocations,
          defaultLocation: this.defaultLocation,
          // Keep the url bar hidden across reloads for chrome-less items.
          hideURLBar: this.opt.hideURLBar,
        },
      },
      deserializer: 'HTMLEditor',
    };
  }

  copy() {
    return new HTMLEditor({
      tranquilBrowser: this.tranquilBrowser,
      url: this.url,
      opt: {
        src: this.src,
        iconName: this.iconName,
        title: this.title,
        allowedLocations: this.allowedLocations,
        defaultLocation: this.defaultLocation,
        hideURLBar: this.opt.hideURLBar,
      },
    });
  }

  static deserialize(state) {
    // serialize() drops tranquilBrowser (it can't be JSON-serialized), so
    // restore it from the package main module — it carries `resources` and the
    // helper methods the view relies on. Without it, addHistory() and the
    // resource injectors dereference null on the first page load after restart.
    const pkg =
      atom.packages.getActivePackage('tranquil-browser') ||
      atom.packages.getLoadedPackage('tranquil-browser');
    return new HTMLEditor({
      ...state.data,
      tranquilBrowser: pkg ? pkg.mainModule : null,
    });
  }

  static checkUrl(url) {
    if (isUrlBlocked(url, blockedUrlList)) {
      notify(
        "addSuccess",
        `${url} is not supported in Tranquil, so it has been opened in your default browser.`
      );
      require('shell').openExternal(url);
      return false;
    }
    return true;
  }

  static getEditorForURI(url, sameWindow) {
    const a = document.createElement('a');
    a.href = url;
    if (
      !url.startsWith('file:///') &&
      !sameWindow &&
      atom.config
        .get('tranquil-browser.openInSameWindow')
        .some((h) => h === a.hostname)
    ) {
      for (const paneItem of atom.workspace.getPaneItems()) {
        const i = document.createElement('a');
        i.href = paneItem.getURI();
        if (i.hostname === a.hostname) {
          return paneItem;
        }
      }
    }
    return false;
  }
}

module.exports = HTMLEditor;
