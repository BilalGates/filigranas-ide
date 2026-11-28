"""Permiso con herramienta maximizada y recuperación estrecha, con IPC simulado."""
import re
from playwright.sync_api import sync_playwright, expect

URL = 'http://127.0.0.1:1421'

def destination(page, name):
    page.keyboard.press({'Flow': 'Control+Shift+2', 'Entrega': 'Control+Shift+4'}[name])

def start(browser):
    page = browser.new_page(viewport={'width': 1440, 'height': 900})
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(URL)
    page.locator('button.primary[type=submit]').click()
    page.get_by_role('button', name='Abrir bitacola', exact=True).click()
    page.get_by_role('button', name=re.compile('^Project manager')).first.click()
    return page, errors

with sync_playwright() as p:
    browser = p.chromium.launch(channel='msedge', headless=True)
    page, errors = start(browser)
    page.locator('.co-compose textarea').fill('Prueba sintética de permiso')
    page.get_by_role('button', name='Enviar', exact=True).click()
    approval = page.get_by_role('group', name='Petición de permiso')
    expect(approval).to_be_visible(timeout=15000)
    destination(page, 'Flow')
    page.keyboard.press('Control+Shift+f')
    expect(page.locator('.ws-shell')).to_have_attribute('data-shell-mode', 'maximized')
    dock = page.locator('.ws-dock-tab')
    expect(dock).to_have_attribute('aria-label', re.compile('permiso.*pendiente'))
    dock.click()
    expect(approval).to_be_visible()
    approval.get_by_role('button', name='Ahora no').click()
    expect(approval).to_have_count(0)
    assert not errors, errors
    page.close()
    print('Permiso simulado conservado y recuperado desde herramienta maximizada: correcto')

    page, errors = start(browser)
    plan = page.get_by_role('region', name='Plan de trabajo')
    plan.get_by_role('button', name='Worker de reintentos con backoff', exact=True).click()
    expect(page.locator('.flowg .gn.sel')).to_have_attribute('aria-label', re.compile('Worker de reintentos'))
    page.set_viewport_size({'width': 780, 'height': 720})
    expect(page.locator('.ws-shell')).to_have_attribute('data-shell-mode', 'compact')
    page.locator('.ws-dock-tab').click()
    expect(page.locator('.ws-shell')).to_have_attribute('data-active-tool', '')
    page.set_viewport_size({'width': 1440, 'height': 900})
    destination(page, 'Flow')
    expect(page.get_by_role('region', name='Flow', exact=True)).to_be_visible()
    expect(page.locator('.flowg .gn.sel')).to_have_count(0)
    page.keyboard.press('Control+Shift+g')
    delivery = page.get_by_role('region', name='Herramienta Entrega')
    expect(delivery).to_be_visible()
    # El atajo abre la etapa Commit; se elige otra para comprobar que se conserva.
    commit = delivery.get_by_role('button', name=re.compile('^Commit:'))
    expect(commit).to_have_attribute('aria-pressed', 'true')
    tests = delivery.get_by_role('button', name=re.compile('^Tests:'))
    tests.click()
    expect(tests).to_have_attribute('aria-pressed', 'true')
    page.set_viewport_size({'width': 780, 'height': 720})
    page.locator('.ws-dock-tab').click()
    expect(page.locator('.ws-shell')).to_have_attribute('data-active-tool', '')
    page.set_viewport_size({'width': 1440, 'height': 900})
    destination(page, 'Entrega')
    expect(delivery).to_be_visible()
    expect(tests).to_have_attribute('aria-pressed', 'true')
    assert not errors, errors
    page.close()
    print('Recuperación estrecha de Flow y Entrega: correcto')
    browser.close()
