"""Regresiones de Trama sobre pnpm dev y su núcleo simulado."""

import argparse
import re

from playwright.sync_api import expect, sync_playwright


def destination(page, name):
    page.get_by_role("navigation", name="Destinos").get_by_role(
        "button", name=re.compile(rf"^{name} \(")
    ).click()


def start(browser, url, resume=False):
    page = browser.new_page(viewport={"width": 1440, "height": 900})
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    if resume:
        page.add_init_script("""
            localStorage.setItem('filigranas.retomar', JSON.stringify({
                project: '/Users/demo/repositorios/calaix',
                view: 900, dest: 'workspace', at: Date.now()
            }));
        """)
    page.goto(url)
    page.locator("button.primary[type=submit]").click()
    expect(page.get_by_role("navigation", name="Destinos")).to_be_visible()
    return page, errors


def check_resume(browser, url):
    page, errors = start(browser, url, resume=True)
    page.get_by_role("button", name=re.compile("Retomar sesión")).click()
    expect(page.locator(".center-head .ch-name")).to_have_text("diseño")
    assert not errors, errors
    page.close()


def check_brain(browser, url):
    page, errors = start(browser, url)
    destination(page, "Brain")
    expect(page.get_by_role("button", name="Todos", exact=True)).to_have_attribute("aria-pressed", "true")
    page.get_by_role("button", name="Recuerdo", exact=True).click()
    dialog = page.get_by_role("dialog", name="Nuevo recuerdo")
    expect(dialog.get_by_label("Ámbito")).to_have_value("global")
    expect(dialog.get_by_label("Compartir con los agentes")).not_to_be_checked()
    dialog.get_by_label("Enunciado").fill("Decisión QA de Trama")
    dialog.get_by_label("Por qué existe").fill("Verifica la memoria global sin seleccionar un proyecto.")
    dialog.get_by_label("Fuente", exact=True).fill("Recorrido sintético")
    confirm = dialog.get_by_label("He revisado el contenido y su procedencia")
    confirm.check()
    dialog.get_by_label("Fuente", exact=True).fill("Recorrido local sintético")
    expect(dialog.get_by_role("button", name="Guardar", exact=True)).to_be_disabled()
    confirm.check()
    dialog.get_by_role("button", name="Guardar", exact=True).click()
    expect(dialog).to_have_count(0)
    panel = page.get_by_role("complementary", name="Ficha del recuerdo")
    expect(panel).to_contain_text("Decisión QA de Trama")
    expect(panel).to_contain_text("privado")
    panel.get_by_role("button", name="Corregir").click()
    dialog = page.get_by_role("dialog", name="Corregir recuerdo")
    dialog.get_by_label("Enunciado").fill("Decisión QA revisada")
    dialog.get_by_label("He revisado el contenido y su procedencia").check()
    dialog.get_by_role("button", name="Guardar", exact=True).click()
    expect(panel).to_contain_text("Decisión QA revisada")
    expect(panel).to_contain_text("versión 2")
    scope = page.get_by_role("combobox", name="Proyecto de Brain")
    scope.select_option(label="calaix")
    expect(scope).to_have_value("/Users/demo/repositorios/calaix")
    expect(page.get_by_role("button", name="Contexto", exact=True)).to_be_enabled()
    page.locator("summary").filter(has_text=re.compile("^Fechas$")).click()
    page.get_by_label("Desde").fill("2099-01-01")
    expect(page.get_by_text("Sin recuerdos en estas fechas.")).to_be_visible()
    page.get_by_label("Hasta").fill("2098-01-01")
    expect(page.get_by_role("status")).to_have_text("Elige una fecha final igual o posterior al inicio.")
    page.get_by_role("button", name="Quitar fechas").click()
    expect(page.get_by_role("status")).to_have_count(0)
    assert not errors, errors
    page.close()


def check_delivery(browser, url):
    page, errors = start(browser, url)
    page.get_by_role("button", name="Abrir bitacola", exact=True).click()
    destination(page, "Entrega")
    explorer = page.get_by_role("complementary", name="Archivos y commits")
    expect(explorer.get_by_text("autonomy.ts", exact=True)).to_be_visible()
    expect(explorer.get_by_role("textbox", name="Mensaje de commit")).to_have_count(0)
    expect(page.locator(".monaco.is-unified .monaco-editor")).to_be_visible()
    expect(page.get_by_role("button", name="Tests: correcto")).to_be_visible()
    expect(page.get_by_role("complementary", name="Auditoría")).to_contain_text("Espacios al final")
    explorer.get_by_role("button", name="Historial y operaciones de rama").click()
    controls = page.get_by_role("region", name="Operaciones de rama")
    expect(controls.get_by_role("button", name="Push", exact=True)).to_be_visible()
    controls.get_by_role("button", name="Push", exact=True).click()
    expect(page.get_by_text("Revisión de la operación de ejemplo")).to_be_visible()
    assert not errors, errors
    page.close()


def check_delivery_worktree(browser, url):
    page, errors = start(browser, url)
    page.get_by_role("button", name="Abrir calaix", exact=True).click()
    destination(page, "Entrega")
    page.get_by_role("combobox", name="Alcance").select_option("900")
    diff = page.locator(".monaco.is-unified .monaco-editor")
    expect(diff).to_contain_text("obligatoria")
    page.get_by_role("button", name=re.compile("^Tests:")).click()
    page.get_by_role("button", name=re.compile("^Cambios:")).click()
    expect(diff).to_contain_text("obligatoria")
    assert not errors, errors
    page.close()


def check_frame(browser, url):
    page, errors = start(browser, url)
    page.get_by_role("button", name="Abrir bitacola", exact=True).click()
    footer = page.get_by_role("contentinfo", name="Estado del proyecto")
    branch = footer.get_by_role("button", name="Rama del proyecto: main")
    expect(branch).to_contain_text("↑1 ↓0")
    expect(footer).to_contain_text("0 trabajando")
    expect(footer.get_by_role("button", name="Uso de los modelos")).to_contain_text("Codex")
    jev = footer.get_by_role("button", name=re.compile(r"Jev local"))
    expect(jev).to_contain_text("0/100")
    jev.click()
    expect(page.get_by_role("heading", name="Herramientas y Jev")).to_be_visible()
    page.get_by_role("button", name="Cerrar uso").click()
    controls = page.locator(".tb-right")
    expect(controls.get_by_role("button", name="Necesita tu atención", exact=True)).to_be_visible()
    assert controls.locator("button").last.get_attribute("aria-label") == "Necesita tu atención"
    controls.get_by_role("button", name="Agentes de este proyecto").click()
    expect(page.get_by_role("main", name="Flow")).to_be_visible()
    assert not errors, errors
    page.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", default="http://127.0.0.1:1420")
    parser.add_argument("--channel", default=None)
    args = parser.parse_args()
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(channel=args.channel)
        for check in (check_resume, check_brain, check_delivery, check_delivery_worktree, check_frame):
            check(browser, args.app)
            print(f"{check.__name__}: correcto")
        browser.close()


if __name__ == "__main__":
    main()
