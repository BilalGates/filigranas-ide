import { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';

// Windows: la ventana no tiene marco nativo. Botones de minimizar,
// maximizar y cerrar con los glifos y medidas de Windows 11, en la
// esquina superior derecha de la franja de 48 px.
const GLYPH = { min: '', max: '', restore: '', close: '' };

export default function WindowControls() {
  const [maximized, setMaximized] = useState(false);
  const [focused, setFocused] = useState(true);

  useEffect(() => {
    const win = getCurrentWindow();
    const sync = () => void win.isMaximized().then(setMaximized);
    sync();
    const off = [win.onResized(sync), win.onFocusChanged(({ payload }) => setFocused(payload))];
    return () => off.forEach((p) => void p.then((f) => f()));
  }, []);

  const win = getCurrentWindow();
  return (
    <div className={`win-caption${focused ? '' : ' is-blur'}`}>
      <button aria-label="Minimizar" title="Minimizar" onClick={() => void win.minimize()}>
        {GLYPH.min}
      </button>
      <button aria-label={maximized ? 'Restaurar' : 'Maximizar'} title={maximized ? 'Restaurar' : 'Maximizar'} onClick={() => void win.toggleMaximize()}>
        {maximized ? GLYPH.restore : GLYPH.max}
      </button>
      <button className="is-close" aria-label="Cerrar" title="Cerrar" onClick={() => void win.close()}>
        {GLYPH.close}
      </button>
    </div>
  );
}
