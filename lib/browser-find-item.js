const { CompositeDisposable, Emitter } = require("atom");
const TranquilBrowserModel = require("./tranquil-browser-model");

// NB: must NOT start with "tranquil-browser:" — the browser's URL opener claims
// any such URI (tranquil-browser.js) and would turn this into a blank browser tab.
const FIND_URI = "tranquil-find://find";

// A draggable workspace pane item that finds text in the active browser tab's
// Electron <webview> via the native findInPage()/stopFindInPage()/found-in-page
// API (so matches highlight in the live page — Pulsar's find-and-replace can't,
// it's TextEditor-buffer bound). Opens in the bottom dock by default but can be
// dragged to any pane or dock.
class BrowserFindItem {
  constructor() {
    this.emitter = new Emitter();
    this.subscriptions = new CompositeDisposable();
    this._onFound = this.onFound.bind(this);
    this.boundWebview = null;

    // Remember the last browser that was active in the CENTER. We can't rely on
    // getCenter().getActivePaneItem() being a browser: when this item opens as a
    // tab in the center pane, IT becomes the active center item, so we'd lose the
    // target. (In the bottom dock the center's active item stays the browser.)
    const active = atom.workspace.getCenter().getActivePaneItem();
    this.lastBrowser = active instanceof TranquilBrowserModel ? active : null;

    this.buildElement();

    // Clearing a hidden tab's highlight is impossible (Pulsar sets inactive pane
    // items to display:none, and Electron then refuses findInPage/stopFindInPage
    // on them), and no event fires *before* Pulsar hides the outgoing tab. So to
    // avoid a flash of stale highlight when returning to a tab, clear the CURRENT
    // tab the instant a tab is pressed — while it's still visible. A capture-phase
    // mousedown on the tab bar fires before the pane switches the active item.
    this._onTabMousedown = (e) => {
      if (!e.target || !e.target.closest) return;
      if (!e.target.closest(".tab-bar .tab")) return;
      const wv = this.targetWebview();
      if (wv && wv.isConnected) {
        try {
          wv.stopFindInPage("clearSelection");
        } catch (err) {
          /* ignore */
        }
      }
    };
    document.addEventListener("mousedown", this._onTabMousedown, true);

    this.subscriptions.add(
      atom.workspace.getCenter().observeActivePaneItem((item) => {
        if (!(item instanceof TranquilBrowserModel)) return;
        this.lastBrowser = item;
        const wv = item.view?.htmlv?.[0];
        this.bindWebview(wv);
        // Fallback for non-click switches (e.g. ctrl-tab): the tab we left is
        // already hidden and can't be cleared, so clear the tab we're arriving at
        // now that it's visible. (Tab-click switches are handled flicker-free by
        // the mousedown pre-clear above.) The counter clears too.
        if (wv && wv.isConnected) {
          try {
            wv.stopFindInPage("clearSelection");
          } catch (e) {
            /* ignore */
          }
        }
        this.counter.textContent = "";
      })
    );
    this.bindWebview(this.targetWebview());
  }

  // --- Workspace pane-item interface ---
  getElement() {
    return this.element;
  }
  getTitle() {
    return "Find in Browser";
  }
  getURI() {
    return FIND_URI;
  }
  getIconName() {
    return "search";
  }
  getDefaultLocation() {
    return "right";
  }
  getAllowedLocations() {
    return ["bottom", "center", "left", "right"];
  }
  onDidDestroy(cb) {
    return this.emitter.on("did-destroy", cb);
  }

  buildElement() {
    const el = document.createElement("div");
    el.classList.add("tranquil-browser-find");

    const lead = document.createElement("span");
    lead.classList.add("tranquil-browser-find-lead");
    lead.setAttribute("title", "Find");
    // Inline SVG magnifier (the ⌕ glyph renders too small/thin). Uses
    // currentColor so it picks up the theme text color.
    lead.innerHTML =
      '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" ' +
      'stroke="currentColor" stroke-width="1.6" stroke-linecap="round">' +
      '<circle cx="6.75" cy="6.75" r="4.75"></circle>' +
      '<line x1="10.4" y1="10.4" x2="14" y2="14"></line></svg>';
    // Clicking the search icon runs the find, same as pressing Enter.
    lead.addEventListener("click", () => {
      this.findNext(true);
      this.input.focus();
    });

    this.input = document.createElement("input");
    this.input.type = "text";
    this.input.classList.add("tranquil-browser-find-input", "native-key-bindings");
    this.input.setAttribute("placeholder", "Find in page");

    this.counter = document.createElement("span");
    this.counter.classList.add("tranquil-browser-find-count");

    const prev = this.button("↑", "Previous match", () => this.findNext(false));
    const next = this.button("↓", "Next match", () => this.findNext(true));
    const close = this.button("✕", "Close", () => this.close());
    close.classList.add("tranquil-browser-find-close");

    el.append(lead, this.input, this.counter, prev, next, close);
    this.element = el;

    // Search on Enter (Shift+Enter → previous); Escape closes the tab. Handle
    // here (not the keymap) so it works regardless of the native-key-bindings
    // whitelist; stop propagation so Atom doesn't also act on the keystroke.
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        this.findNext(!e.shiftKey);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        this.close();
      }
    });
  }

  button(glyph, title, onClick) {
    const b = document.createElement("button");
    b.classList.add("tranquil-browser-find-btn");
    b.setAttribute("title", title);
    const g = document.createElement("span");
    g.classList.add("glyph");
    g.textContent = glyph;
    b.appendChild(g);
    b.addEventListener("click", () => {
      onClick();
      this.input.focus();
    });
    return b;
  }

  focusInput() {
    this.input.focus();
    this.input.select();
    // Make sure found-in-page events are routed to the current target.
    this.bindWebview(this.targetWebview());
  }

  // The <webview> to search: the current center browser, or the last one seen
  // (this item may itself be the active center tab).
  targetWebview() {
    const active = atom.workspace.getCenter().getActivePaneItem();
    const browser =
      active instanceof TranquilBrowserModel ? active : this.lastBrowser;
    return browser?.view?.htmlv?.[0] || null;
  }

  // Route found-in-page events to one webview at a time; clear the previously
  // bound tab's highlight when retargeting.
  bindWebview(wv) {
    if (this.boundWebview === wv) return;
    if (this.boundWebview) {
      this.boundWebview.removeEventListener("found-in-page", this._onFound);
      try {
        this.boundWebview.stopFindInPage("clearSelection");
      } catch (e) {
        /* webview may be detached */
      }
    }
    this.boundWebview = wv || null;
    if (this.boundWebview) {
      this.boundWebview.addEventListener("found-in-page", this._onFound);
    }
  }

  // forward: search direction. We always pass findNext:true (as the electron-find
  // reference does): it selects/advances the active match and reports the count
  // ("N of M"). findNext:false only highlights all matches without selecting one,
  // so the counter never updates. Electron treats a changed query as a new search
  // and an unchanged query as "advance", so findNext:true covers both the first
  // find and stepping through matches.
  findNext(forward) {
    const wv = this.targetWebview();
    // findInPage/stopFindInPage throw "The WebView must be attached to the DOM …"
    // when the browser tab is hidden (e.g. Find opened as a sibling tab in the
    // browser's own pane, so the <webview> is detached). isConnected gates that;
    // try/catch is the safety net. When hidden there's nothing to highlight anyway.
    if (!wv || !wv.isConnected) return;
    this.bindWebview(wv);
    const term = this.input.value;
    if (!term) {
      try {
        wv.stopFindInPage("clearSelection");
      } catch (e) {
        /* ignore */
      }
      this.counter.textContent = "";
      return;
    }
    try {
      wv.findInPage(term, { forward, findNext: true });
    } catch (e) {
      /* webview not ready */
    }
  }

  onFound(event) {
    const result = event.result || {};
    if (!result.matches) {
      this.counter.textContent = "No results";
    } else {
      this.counter.textContent = `${result.activeMatchOrdinal} of ${result.matches}`;
    }
  }

  close() {
    const pane = atom.workspace.paneForItem(this);
    if (pane) pane.destroyItem(this);
  }

  destroy() {
    document.removeEventListener("mousedown", this._onTabMousedown, true);
    this.bindWebview(null);
    this.subscriptions.dispose();
    this.emitter.emit("did-destroy");
    this.emitter.dispose();
  }
}

BrowserFindItem.URI = FIND_URI;
module.exports = BrowserFindItem;
