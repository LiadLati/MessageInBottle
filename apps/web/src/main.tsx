import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Self-hosted OFL faces (FONTS.md): interface + display are eager, letter faces load with the
// letter surfaces they are used on.
import '@fontsource/instrument-sans/400.css';
import '@fontsource/instrument-sans/500.css';
import '@fontsource/instrument-sans/600.css';
import '@fontsource/eb-garamond/400.css';
import '@fontsource/eb-garamond/400-italic.css';
import '@fontsource/eb-garamond/500.css';
import 'maplibre-gl/dist/maplibre-gl.css';
import './design/tokens.css';
import './styles.css';
import { App } from './App.js';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
