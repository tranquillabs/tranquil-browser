// Single source of truth for the routable browser shortcut commands.
//
// A focused <webview> guest swallows keystrokes before Pulsar's keymap, so each
// browser shortcut is delivered two ways: the atom-workspace command (host DOM
// focused) and the guest keyHandler (webview focused). Both resolve the target
// browser the same way (activeBrowser) and run the same action (SPECS), so the
// behaviour lives in exactly one place.
//
// This is a leaf module: it may require the model, and receives the main module
// (`TB`) as an argument, so tranquil-browser.js can require it without a cycle.

const TranquilBrowserModel = require('./tranquil-browser-model');

// The browser tab a shortcut should act on:
//   1. the workspace's active item if it's a browser — covers a focused tab,
//      including one dragged into a dock; else
//   2. the center's active item if THAT is a browser — covers a dock (Find,
//      tree-view) holding focus while a browser is active in the center.
// null when neither is a browser, so the caller can fall through to core.
function activeBrowser() {
  const active = atom.workspace.getActivePaneItem();
  if (active instanceof TranquilBrowserModel) return active;
  const center = atom.workspace.getCenter().getActivePaneItem();
  return center instanceof TranquilBrowserModel ? center : null;
}

// Action per command id (sans the `tranquil-browser:` prefix). Each receives the
// resolved browser model `b`; view methods are reached via `b.view`.
function specs(TB) {
  return {
    'focus-url': (b) => b.view.focusUrlBar(),
    'find': () => TB.showFind(),
    'save-url': (b) => TB.saveCurrentTabUrl(b),
    'toggle-url-bar': (b) => b.view.toggleURLBar(),
    'go-back': (b) => b.view.goBack(),
    'go-forward': (b) => b.view.goForward(),
    'refresh': (b) => b.view.refreshPage(),
    'hard-refresh': (b) => b.view.refreshPage(void 0, true),
    'print': (b) => {
      try {
        b.view.htmlv?.[0]?.print();
      } catch (e) {
        console.log(e);
      }
    },
  };
}

// Build the `atom.commands.add('atom-workspace', …)` handler map. Every handler
// runs its action on activeBrowser(); when there's no active browser it aborts
// the keybinding so the keystroke falls through to its core/editor binding
// (core shortcuts keep working on non-browser items).
function buildCommands(TB) {
  const handlers = {};
  for (const [id, run] of Object.entries(specs(TB))) {
    handlers['tranquil-browser:' + id] = function (event) {
      const b = activeBrowser();
      if (b && b.view) {
        run(b);
      } else if (event && typeof event.abortKeyBinding === 'function') {
        event.abortKeyBinding();
      }
    };
  }
  return handlers;
}

module.exports = { activeBrowser, buildCommands };
