"""Medición y regresión de Markdown activo sobre pnpm dev; requiere Playwright y Edge."""
import json
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(channel='msedge', headless=True)
    page = browser.new_page()
    page.goto('http://127.0.0.1:1421/tests/streaming_fixture.html')
    result = page.evaluate('''async () => {
      const unit = '## Sección\\n\\nTexto **negrita** y `código` con [enlace](https://example.com).\\n\\n';
      const base = unit.repeat(500);
      const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
      async function run(streaming) {
        window.durations.length = 0;
        window.showMessage(base, streaming); await sleep(800);
        window.durations.length = 0;
        for (let i = 1; i <= 10; i++) { window.showMessage(base + unit.repeat(i), streaming); await sleep(80); }
        await sleep(1300);
        return [...window.durations];
      }
      const before = await run(false);
      const after = await run(true);
      const final = base + ' FINAL &amp;copy;';
      window.showMessage(final, false); await sleep(250);
      return { before, after, finalVisible: document.querySelector('#root').textContent.endsWith('FINAL &copy;') };
    }''')
    assert result['finalVisible'], 'El mensaje final debe mostrarse completo inmediatamente'
    assert sum(ms > 10 for ms in result['after']) < sum(ms > 10 for ms in result['before']), result
    print(json.dumps(result))
    page.evaluate('window.showLog()')
    page.locator('.co-acts summary').click()
    assert 'Investigar &amp;copy;' in page.locator('.co-actlist').inner_text()
    assert page.get_by_role('group', name='Petición de permiso').get_by_text('Permiso pendiente').is_visible()
    print('Título literal y permiso en conversación: correctos')
    page.evaluate('''() => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
        writeText: async text => { window.copiedText = text; }
      }});
      window.showStreamingLog('  Respuesta con espacios\\n\\n', false);
    }''')
    page.get_by_role('button', name='Copiar respuesta').click()
    assert page.evaluate('window.copiedText') == '  Respuesta con espacios\n\n'
    scroll = page.locator('.co-log')
    page.evaluate('''() => {
      window.longText = ('Párrafo inicial de prueba.\\n\\n').repeat(400);
      window.showStreamingLog(window.longText, true);
    }''')
    page.wait_for_timeout(400)
    page.evaluate('window.showStreamingLog(window.longText + ("Más contenido.\\n\\n".repeat(200)), true)')
    page.wait_for_timeout(1400)
    assert scroll.evaluate('(el) => el.scrollHeight > el.clientHeight + 100'), 'El escenario debe tener desplazamiento'
    assert 'Más contenido.' in scroll.inner_text(), 'El contenido diferido debe haberse mostrado'
    assert scroll.evaluate('(el) => el.scrollHeight - el.clientHeight - el.scrollTop') < 3, 'Debe seguir el render diferido'
    scroll.evaluate('(el) => { el.scrollTop = 0; el.dispatchEvent(new Event("scroll", { bubbles: true })); }')
    page.evaluate('window.showStreamingLog(window.longText + ("Más contenido.\\n\\n".repeat(400)), true)')
    page.wait_for_timeout(1400)
    assert scroll.evaluate('(el) => el.scrollTop') == 0, 'No debe mover al usuario que ha subido'
    print('Copia exacta y seguimiento diferido respetando desplazamiento: correctos')
    browser.close()
