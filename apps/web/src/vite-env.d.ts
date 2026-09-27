/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_MIB_MAP_TILES_URL?: string;
  readonly VITE_MIB_MAP_SOURCE_LAYER?: string;
  readonly VITE_MIB_MAP_ATTRIBUTION?: string;
  /** Public origin of the SeaYou API; required for the Android app, empty in browser dev. */
  readonly VITE_MIB_API_ORIGIN?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
