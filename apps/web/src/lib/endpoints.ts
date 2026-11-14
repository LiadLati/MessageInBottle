import { Capacitor } from '@capacitor/core';

// Where the SeaYou server is, for every request and every link to a server-rendered page
// (support, legal documents, account deletion).
//
// In the browser during development the client and the API share one origin (Vite proxies
// /api, /legal and /support), so the origin is empty and every path stays relative.
//
// In the Android app the interface is bundled inside the APK and served from the WebView's
// own origin (https://localhost). A relative "/api/…" there would silently ask the phone
// itself, so the packaged app must be built with VITE_MIB_API_ORIGIN, the public HTTPS origin
// of the API (scripts/android-web-build.mjs enforces this for a release). An app built without
// one refuses to start instead of guessing.

export const isNativeApp: boolean = Capacitor.isNativePlatform();

function normaliseOrigin(raw: string | undefined): string {
  const value = (raw ?? '').trim().replace(/\/+$/, '');
  if (!value) return '';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`VITE_MIB_API_ORIGIN is not a URL: ${value}`);
  }
  if (url.pathname !== '/' || url.search || url.hash)
    throw new Error('VITE_MIB_API_ORIGIN must be an origin only, such as https://api.example.com');
  return url.origin;
}

export const API_ORIGIN: string = normaliseOrigin(import.meta.env.VITE_MIB_API_ORIGIN);

/** Why this build cannot talk to its server, or null when it can. */
export function endpointProblem(native = isNativeApp, origin = API_ORIGIN): string | null {
  if (native && !origin)
    return 'This copy of SeaYou was built without a server address, so it cannot connect.';
  return null;
}

/** The URL of an API route, such as apiUrl('/auth/me'). */
export function apiUrl(path: string): string {
  return `${API_ORIGIN}/api${path}`;
}

/** The URL of a public server-rendered page, such as publicPageUrl('/support'). */
export function publicPageUrl(path: string): string {
  return `${API_ORIGIN}${path}`;
}
