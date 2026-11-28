export async function copyToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); return; } catch { /* Try the fallback. */ }
  }
  const el = document.createElement('textarea');
  el.value = text;
  el.style.position = 'fixed';
  el.style.opacity = '0';
  document.body.appendChild(el);
  try {
    el.select();
    if (!document.execCommand('copy')) throw new Error('No se pudo copiar');
  } finally {
    el.remove();
  }
}
