import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { invoke, isTauri } from '@tauri-apps/api/core';
import './styles.css';
import App from './App';
import WindowControls from './WindowControls';
import { restoreLayout } from './Splitter';

// La barra de título y los márgenes cambian entre macOS y Windows.
const ua = navigator.userAgent;
const html = document.documentElement;
html.dataset.platform = ua.includes('Mac') ? 'mac' : ua.includes('Windows') ? 'win' : 'other';
restoreLayout();

async function start() {
  // Monaco y xterm miden el ancho de los caracteres al crearse.
  await document.fonts.load('12px Iosevka');
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
