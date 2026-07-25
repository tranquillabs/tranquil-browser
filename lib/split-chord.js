// Single owner of the cmd-k / ctrl-k + arrow "split the pane" chord.
//
// The chord reaches us three ways depending on focus: the host-renderer capture
// interceptor (editor/host DOM focused), the guest keyHandler (browser webview
// focused, forwarded), and the stuck-focus branch (a guest holds focus while a
// non-browser item is active). Only ONE of those sees any given sequence — a
// chord can't be half-typed in two focus domains — so a single module-level
// pending flag is safe and replaces the three separate 1s timers.
//
// handle(evt, resolvePane) returns:
//   'armed'  – this was the cmd/ctrl-k prefix; chord is now pending
//   'split'  – this was the arrow; the split was performed
//   null     – not part of a chord (caller should handle the key normally)
// resolvePane() supplies the pane to split (callers differ: the focused view's
// pane vs the active pane item's pane).

const SPLIT = {
  ArrowUp: "splitUp",
  ArrowDown: "splitDown",
  ArrowLeft: "splitLeft",
  ArrowRight: "splitRight",
};

let pending = false;
let timer = null;

function isMac() {
  return process.platform === "darwin";
}

function disarm() {
  pending = false;
  clearTimeout(timer);
  timer = null;
}

function handle(evt, resolvePane) {
  // Arm on cmd-k (mac) / ctrl-k. Match lowercase 'k' only, as before, so
  // cmd-shift-k and other chords aren't captured.
  if ((isMac() ? evt.metaKey : evt.ctrlKey) && evt.key === "k") {
    pending = true;
    clearTimeout(timer);
    timer = setTimeout(() => {
      pending = false;
    }, 1000);
    return "armed";
  }
  if (pending) {
    const method = SPLIT[evt.key];
    if (method) {
      disarm();
      const pane = resolvePane();
      if (pane) pane[method]({ copyActiveItem: true });
      return "split";
    }
  }
  return null;
}

module.exports = { handle };
