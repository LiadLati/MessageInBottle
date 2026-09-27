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
import './design/tokens.css';
import './styles.css';
import { App } from './App.js';
import { AppCrashed, ErrorBoundary } from './components/ErrorBoundary.js';
import { endpointProblem } from './lib/endpoints.js';
import { installNativeShell } from './lib/nativeShell.js';

installNativeShell();

// A packaged app built without its server address would otherwise send every request to the
// phone itself and look merely broken; it says what is wrong instead.
const misconfigured = endpointProblem();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {misconfigured ? (
      <main className="deck-screen" role="alert">
        <div
          className="glass-panel stack"
          style={{ maxWidth: 480, margin: '15vh auto', padding: 24 }}
        >
          <h1 className="t-display">SeaYou cannot start</h1>
          <p className="secondary">{misconfigured}</p>
        </div>
      </main>
    ) : (
      <ErrorBoundary fallback={() => <AppCrashed />}>
        <App />
      </ErrorBoundary>
    )}
  </StrictMode>,
);
