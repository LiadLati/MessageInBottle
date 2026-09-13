/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_MIB_MAP_TILES_URL?: string;
  readonly VITE_MIB_MAP_SOURCE_LAYER?: string;
  readonly VITE_MIB_MAP_ATTRIBUTION?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
