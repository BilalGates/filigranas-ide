import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { invoke, isTauri } from '@tauri-apps/api/core';
import './styles.css';
import './trama/fonts.css';
import './trama/trama.css';
import './trama/artifact.css';
import './trama/shell.css';
import App from './App';
import WindowControls from './WindowControls';
import { restoreLayout } from './Splitter';

// La barra de título y los márgenes cambian entre macOS y Windows.
const ua = navigator.userAgent;
const html = document.documentElement;
html.dataset.platform = ua.includes('Mac') ? 'mac' : ua.includes('Windows') ? 'win' : 'other';
restoreLayout();

async function start() {
  // Monaco y xterm miden el ancho de los caracteres al crearse. Los lienzos de
  // Trama dibujan texto con JetBrains Mono y necesitan la fuente ya cargada.
  await Promise.all(['12px Iosevka', '12px "JetBrains Mono"', '500 12px "JetBrains Mono"'].map((font) => document.fonts.load(font)));
  // En el navegador (sin Tauri) se usa el núcleo simulado.
  const native = isTauri();
  if (native) html.dataset.native = 'true';
  // Windows 11 con Mica: la barra lateral deja ver el material, como en macOS.
  if (native && html.dataset.platform === 'win' && (await invoke<boolean>('window_backdrop').catch(() => false))) {
    html.dataset.backdrop = 'true';
  }
  if (import.meta.env.DEV && !isTauri()) {
    html.dataset.browser = 'true';
    await import('./mock');
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
      {native && html.dataset.platform === 'win' && <WindowControls />}
    </StrictMode>,
  );
}

void start();
