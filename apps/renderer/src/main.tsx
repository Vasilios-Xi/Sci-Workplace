import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { applyInterfacePreferences, InterfacePreferencesProvider, loadInterfacePreferences } from './lib/interface-preferences.js';
import './styles.css';
import './interface-themes.css';
import './chat-redesign.css';

const interfacePreferences = await loadInterfacePreferences();
applyInterfacePreferences(interfacePreferences);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <InterfacePreferencesProvider initial={interfacePreferences}>
      <App />
    </InterfacePreferencesProvider>
  </StrictMode>,
);
