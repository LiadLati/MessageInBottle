import { App as NativeApp } from '@capacitor/app';
import { isNativeApp } from './endpoints.js';
import { backOutOfTopModal } from './modal.js';

// What the Android app adds around the same interface the browser runs. Nothing here exists
// in a browser build: every entry point returns at once when not inside the app.
//
//   • Back closes the topmost dialog first, exactly as Escape does (a dialog that must be
//     answered stays). Otherwise it steps back through the screens this session visited (the
//     app keeps them in history, audit FE-015), and from the first screen it sends SeaYou to
//     the background, as Back does in any Android app, instead of closing it and losing the
//     unsent letter.
//   • Returning to the app re-runs what a browser tab does when it becomes visible again: the
//     time zone is re-read and reported, polling catches up and the map resumes. Android's
//     WebView does not always report visibility on its own when the app is resumed.
export function installNativeShell(): void {
  if (!isNativeApp) return;
  void NativeApp.addListener('backButton', ({ canGoBack }) => {
    if (backOutOfTopModal()) return;
    if (canGoBack) window.history.back();
    else void NativeApp.minimizeApp();
  });
  void NativeApp.addListener('resume', () => {
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));
  });
}
