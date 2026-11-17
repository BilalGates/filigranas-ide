import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { isTauri } from '@tauri-apps/api/core';
import './styles.css';
import App from './App';
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
  if (isTauri()) html.dataset.native = 'true';
  if (import.meta.env.DEV && !isTauri()) {
    html.dataset.browser = 'true';
    await import('./mock');
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void start();
