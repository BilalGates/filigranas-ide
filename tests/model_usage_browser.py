"""Paneles de cuota con IPC simulado; no consume tokens ni abre cuentas reales.

Arrancar pnpm dev -- --port 1432 y ejecutar python tests/model_usage_browser.py.
MODEL_USAGE_URL y MODEL_USAGE_ARTIFACTS permiten cambiar URL y capturas.
"""
import json
import os
import time
from pathlib import Path

from playwright.sync_api import sync_playwright, expect

URL = os.environ.get('MODEL_USAGE_URL', 'http://localhost:1432')
OUT = Path(os.environ.get('MODEL_USAGE_ARTIFACTS', 'artifacts/model-usage'))
OUT.mkdir(parents=True, exist_ok=True)

with sync_playwright() as p:
    browser = p.chromium.launch(channel='msedge', headless=True)
    page = browser.new_page(viewport={'width': 1440, 'height': 900})
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    now = time.time()
    saved = {'observedAt': now - 600, 'windows': [
        {'label': '5 h', 'percent': 92, 'resetsAt': now + 7200},
        {'label': 'semana', 'percent': 40, 'resetsAt': now + 172800},
        {'label': 'Opus', 'percent': 70, 'resetsAt': now + 172800},
    ], 'blockedUntil': None, 'warningUntil': None}
    page.add_init_script(f"localStorage.setItem('filigranas.claude-quota', {json.dumps(json.dumps(saved))})")
    page.goto(URL)
    page.locator('button.primary[type=submit]').click()
    codex = page.get_by_role('button', name='Uso de Codex', exact=True)
    codex.click()
    panel = page.get_by_role('dialog', name='Uso de Codex', exact=True)
    expect(panel.get_by_role('meter', name='Ventana de 5 horas')).to_have_attribute('aria-valuenow', '22')
    expect(panel.get_by_text('Fecha de renovación no informada', exact=True)).to_be_visible()
    expect(panel.locator('time')).to_have_count(1)
    page.screenshot(animations='disabled', path=str(OUT / 'codex.png'))

    # Intercepta únicamente las acciones bajo prueba conservando el resto del núcleo simulado.
    page.evaluate("""() => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      window.usageCalls = [];
      window.__TAURI_INTERNALS__.invoke = async (cmd, args, options) => {
        if (cmd === 'provider_usage_open') {
          window.usageCalls.push(args.provider);
          if (window.failUsageOpen) throw new Error('offline');
          return null;
        }
        if (cmd === 'codex_rate_limits' && window.failQuotaRead) throw new Error('offline');
        return invoke(cmd, args, options);
      };
    }""")
    panel.get_by_role('button', name='Gestionar créditos y restablecimientos').click()
    assert page.evaluate('window.usageCalls') == ['codex']
    page.evaluate('window.failQuotaRead = true')
    panel.get_by_role('button', name='Actualizar', exact=True).click()
    expect(panel.get_by_role('alert')).to_contain_text('No se pudo actualizar')
    expect(panel.get_by_role('meter', name='Ventana de 5 horas')).to_have_attribute('aria-valuenow', '22')
    page.evaluate('window.failQuotaRead = false')
    panel.get_by_role('button', name='Actualizar', exact=True).click()
    expect(panel.get_by_role('alert')).to_have_count(0)
    page.keyboard.press('Escape')
    expect(panel).to_have_count(0)
    expect(codex).to_be_focused()

    claude = page.get_by_role('button', name='Uso de Claude', exact=True)
    claude.click()
    panel = page.get_by_role('dialog', name='Uso de Claude', exact=True)
    expect(panel.get_by_role('meter')).to_have_count(3)
    expect(panel.get_by_role('meter', name='Opus', exact=True)).to_have_attribute('aria-valuenow', '70')
    expect(panel.get_by_text('Se renueva en 2 d 0 h', exact=True)).to_have_count(2)
    expect(panel.locator('.eng-observation')).to_contain_text('Datos desactualizados')
    page.screenshot(animations='disabled', path=str(OUT / 'claude.png'))
    panel.get_by_role('button', name='Gestionar uso adicional').click()
    assert page.evaluate('window.usageCalls')[-1] == 'claude'
    page.set_viewport_size({'width': 960, 'height': 720})
    page.screenshot(animations='disabled', path=str(OUT / 'claude-compact.png'))
    rect = panel.bounding_box()
    assert rect['x'] >= 0 and rect['y'] >= 48 and rect['x'] + rect['width'] <= 960
    assert panel.evaluate('(e) => e.scrollWidth <= e.clientWidth')
    panel.get_by_role('button', name='Cerrar', exact=True).click()
    expect(claude).to_be_focused()

    page.get_by_role('button', name='Uso de Antigravity', exact=True).click()
    panel = page.get_by_role('dialog', name='Uso de Antigravity', exact=True)
    expect(panel.get_by_text('Cuota todavía no disponible', exact=True)).to_be_visible()
    expect(panel.get_by_role('meter')).to_have_count(0)
    page.evaluate('window.failUsageOpen = true')
    panel.get_by_role('button', name='Ver opciones de cuota y créditos').click()
    expect(panel.get_by_role('alert')).to_contain_text('No se pudo abrir')
    page.screenshot(animations='disabled', path=str(OUT / 'antigravity.png'))
    page.keyboard.press('Escape')

    page.get_by_role('button', name='Jev local', exact=False).click()
    panel = page.get_by_role('dialog', name='Consumo de Jev', exact=True)
    expect(panel.get_by_role('meter', name='Intentos de Jev')).to_have_attribute('aria-valuenow', '0')
    expect(panel.get_by_text('Tokens registrados', exact=True)).to_be_visible()
    page.screenshot(animations='disabled', path=str(OUT / 'jev.png'))
    page.keyboard.press('Escape')

    # Los límites vencidos dejan de presentarse como vigentes; no se inventa un 0 %.
    page.evaluate("""async () => {
      await window.__TAURI_INTERNALS__.invoke('plugin:event|emit', { event: 'coordinator', payload: {
        method: 'account/rateLimits/updated', params: { rateLimits: {
          primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: Date.now()/1000-5 }, secondary: null, rateLimitReachedType: null,
        } },
      } });
    }""")
    codex.click()
    panel = page.get_by_role('dialog', name='Uso de Codex', exact=True)
    expect(panel.get_by_role('meter')).to_have_count(0)
    expect(panel.get_by_text('Cuota todavía no disponible', exact=True)).to_be_visible()
    page.locator('h1').first.click()
    expect(panel).to_have_count(0)
    page.get_by_role('button', name='Abrir bitacola', exact=True).click()
    codex.click()
    panel = page.get_by_role('dialog', name='Uso de Codex', exact=True)
    expect(panel.get_by_text('Trabajo registrado · 7 días', exact=True)).to_have_count(1)
    page.keyboard.press('Escape')
    page.evaluate("""() => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      window.__TAURI_INTERNALS__.invoke = (cmd, args, options) => cmd === 'tasks_list'
        ? Promise.reject(new Error('offline')) : invoke(cmd, args, options);
    }""")
    codex.click()
    expect(panel.get_by_text('No se pudo confirmar la actividad del proyecto.', exact=True)).to_have_count(1)
    page.keyboard.press('Escape')
    assert not errors, errors
    browser.close()
    print('Cuotas, renovación, modelos Claude, errores, gestión, teclado, cierre y ancho reducido: correctos')
