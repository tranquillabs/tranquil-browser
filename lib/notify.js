"use babel";

// Tranquil-style corner-notification toasts. The core notifications package
// can't give us both things we want at once: a close (×) so a toast can be
// dismissed immediately, AND an auto-hide. Core only renders the × for
// `dismissable` notifications, and dismissable notifications skip core's
// auto-hide timer entirely. So we opt into `dismissable` (to surface the ×)
// and run the auto-hide ourselves.
//
// Usage: notify("addError", "message"[, options]) — mirrors
// atom.notifications.add*(). Returns the Notification.

// The base auto-hide delay for transient success/info toasts comes from the
// `tranquil.toastDuration` setting (Settings → Tranquil), falling back to this
// default if the schema isn't registered yet. Errors and warnings stay up long
// enough to actually read (and copy) before auto-hiding — never shorter than
// LONG_TIMEOUT. The × still lets any toast be dismissed sooner, and callers can
// override with `options.timeout`.
const DEFAULT_TOAST_TIMEOUT = 3000;
const LONG_TIMEOUT = 6000;

function baseTimeout() {
  const configured = atom.config.get('tranquil.toastDuration');
  return typeof configured === 'number' ? configured : DEFAULT_TOAST_TIMEOUT;
}

function timeoutFor(kind, options) {
  if (typeof options.timeout === 'number') return options.timeout;
  return kind === 'addError' || kind === 'addWarning'
    ? Math.max(LONG_TIMEOUT, baseTimeout())
    : baseTimeout();
}

function notify(kind, message, options = {}) {
  const { timeout, ...rest } = options;
  const notification = atom.notifications[kind](message, {
    dismissable: true,
    ...rest,
  });
  setTimeout(() => notification.dismiss(), timeoutFor(kind, options));
  return notification;
}

module.exports = { notify, LONG_TIMEOUT };
