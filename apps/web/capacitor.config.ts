import type { CapacitorConfig } from '@capacitor/cli';

// The Android app: the built interface (dist/) bundled inside the APK/AAB and served by the
// WebView from https://localhost. Nothing is loaded from a remote website: there is no
// server.url, and the API is reached at VITE_MIB_API_ORIGIN, fixed at build time
// (scripts/android-build.mjs, docs/ANDROID.md).
//
// SEAYOU_ANDROID_MODE is set by scripts/android-build.mjs when it syncs the project:
//   release (default) — HTTPS only, no mixed content;
//   dev              — the emulator may call a development API over plain http
//                      (http://10.0.2.2:3001), which the HTTPS WebView origin would otherwise
//                      block as mixed content. The release Gradle build refuses assets synced
//                      in this mode (android/app/build.gradle, verifySeaYouReleaseAssets).
const dev = process.env.SEAYOU_ANDROID_MODE === 'dev';

const config: CapacitorConfig = {
  // The Play Store identity of SeaYou. It can never change once the app is published.
  appId: 'io.github.liadlati.seayou',
  appName: 'SeaYou',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
  },
  android: {
    allowMixedContent: dev,
  },
  plugins: {
    // Edge-to-edge (required at target API 35+): Capacitor supplies correct
    // env(safe-area-inset-*) values, which the stylesheet already honours with
    // viewport-fit=cover. The hint avoids a layout jump on start.
    SystemBars: {
      insetsHandling: 'css',
      initialViewportFitValueHint: 'cover',
      style: 'DARK',
    },
  },
};

export default config;
