"""Regresiones de Trama sobre pnpm dev y su núcleo simulado."""

import argparse
import base64
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
    panel.get_by_text("Vigencia y contexto", exact=True).click()
    expect(panel.get_by_text(re.compile("privado", re.IGNORECASE))).to_be_visible()
    expect(page.locator('.brg [data-gid="P"]')).to_be_visible()
    page.get_by_role("button", name="Agrupar", exact=True).click()
    expect(page.locator('.brg [data-gid="K-decision"]')).to_be_visible()
    page.get_by_role("button", name="Agrupar", exact=True).click()
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


def check_workspace_plan(browser, url):
    page, errors = start(browser, url)
    page.get_by_role("button", name="Abrir bitacola", exact=True).click()
    page.get_by_role("button", name=re.compile("^Project manager")).first.click()
    plan = page.get_by_role("region", name="Plan de trabajo")
    expect(plan.get_by_role("button", name="Abrir en Flow")).to_be_visible()
    plan.get_by_role("button", name="Worker de reintentos con backoff", exact=True).press("Enter")
    expect(page.get_by_role("main", name="Flow")).to_be_visible()
    expect(page.locator(".flowg .gn.sel")).to_have_attribute("aria-label", re.compile("Worker de reintentos con backoff"))
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
    expect(page.locator(".diff-finding")).to_contain_text("L11 · Espacios al final")
    audit = page.get_by_role("complementary", name="Auditoría")
    finding = audit.get_by_role("button", name=re.compile("Espacios al final"))
    finding.click()
    expect(finding).to_have_class(re.compile(r"\bon\b"))
    expect(page.get_by_role("main", name="Entrega")).to_be_visible()
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
    branch = page.get_by_role("banner").get_by_role("button", name="Rama del proyecto: main")
    expect(branch).to_contain_text("↑1 ↓0")
    branch.click()
    page.get_by_role("menuitem", name="ide/tests-e27").click()
    expect(page.get_by_text("tus cambios locales se sobrescribirían al cambiar de rama")).to_be_visible()
    page.keyboard.press("Escape")
    expect(branch).to_be_visible()
    page.get_by_role("button", name="Proyectos · bitacola").click()
    expect(page.get_by_role("menuitem", name="Gestionar proyectos")).to_be_visible()
    page.keyboard.press("Escape")
    nav = page.get_by_role("navigation", name="Destinos")
    expect(nav.get_by_role("button", name="Navegador")).to_be_visible()
    expect(nav.get_by_role("button", name=re.compile("GitHub"))).to_be_visible()
    expect(footer).to_contain_text("0 trabajando")
    for engine in ("Codex", "Claude"):
        usage = footer.get_by_role("button", name=f"Uso de {engine}")
        usage.click()
        panel = page.get_by_role("dialog", name=f"Uso de {engine}")
        expect(panel.get_by_text("Cuota restante")).to_be_visible()
        expect(panel.get_by_text("Trabajo registrado · 7 días")).to_be_visible()
        page.keyboard.press("Escape")
        expect(usage).to_be_focused()
        expect(panel).not_to_be_visible()
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



def check_workspace_inspector(browser, url):
    page, errors = start(browser, url)
    page.get_by_role("button", name="Abrir bitacola", exact=True).click()
    new_session = page.get_by_role("button", name="Nueva conversación")
    new_session.click()
    expect(page.get_by_role("menuitem", name="Sesión con Codex")).to_be_visible()
    expect(page.get_by_role("menuitem", name="Sesión con Claude")).to_be_visible()
    page.keyboard.press("Escape")
    expect(page.get_by_role("menuitem", name="Sesión con Codex")).not_to_be_visible()
    page.keyboard.press("Meta+Alt+2")
    page.get_by_role("treeitem", name=re.compile(r"README")).first.click()
    expect(page.get_by_role("heading", name="bitacola/README.md")).to_be_visible()
    dock = page.get_by_role("group", name="Cambios del editor")
    expect(dock).to_contain_text("autonomy.ts")
    expect(page.locator(".monaco-editor")).to_be_visible()
    dock.get_by_role("button", name="Entrega").click()
    expect(page.get_by_role("main", name="Entrega")).to_be_visible()
    assert not errors, errors
    page.close()


def check_studio_surfaces(browser, url):
    page, errors = start(browser, url)
    page.get_by_role("button", name="Abrir calaix", exact=True).click()
    destination(page, "Studio")
    expect(page.get_by_label("Ancho de captura")).to_have_value("1440")
    page.get_by_text("Coordenadas de la región", exact=True).click()
    page.get_by_label("Ancho %", exact=True).fill("55")
    page.get_by_text("Comparar esta región", exact=True).click()
    expect(page.get_by_role("slider", name="Divisor de la región")).to_be_visible()
    approve = page.get_by_role("button", name="Aprobar como referencia")
    expect(approve).to_be_disabled()
    page.get_by_label("Revisé la captura y sus restricciones").check()
    expect(approve).to_be_enabled()
    page.get_by_role("button", name="Diseñar barra lateral").click()
    expect(page.get_by_role("region", name="Diseño de barra lateral")).to_be_visible()
    page.get_by_role("button", name="Pantallas y versiones").click()
    expect(page.get_by_role("complementary", name="Pantallas y versiones")).to_be_visible()
    assert not errors, errors
    page.close()


def check_settings_and_network(browser, url):
    page, errors = start(browser, url)
    page.get_by_role("button", name="Abrir bitacola", exact=True).click()
    destination(page, "Ajustes")
    page.get_by_role("button", name="Modelos y herramientas", exact=True).click()
    expect(page.get_by_role("region", name="Herramientas", exact=True)).to_contain_text("Codex")
    page.get_by_role("button", name="Presupuestos", exact=True).click()
    expect(page.get_by_role("region", name="Uso restante y consumo de Jev")).to_be_visible()
    destination(page, "Brain")
    page.get_by_role("button", name="Red del proyecto").click()
    page.get_by_label("Tipo de nodo").select_option("task")
    node = page.get_by_role("button", name="Tarea: Revisar la cola")
    expect(node).to_be_visible()
    node.click()
    inspector = page.get_by_role("complementary", name="Ficha del recuerdo")
    expect(inspector.get_by_role("button", name="Abrir tarea")).to_be_visible()
    inspector.get_by_role("button", name=re.compile("Integrar mejoras de la cola")).click()
    expect(inspector.get_by_role("button", name="Abrir pull request")).to_be_visible()
    assert not errors, errors
    page.close()


def check_studio_references_and_components(browser, url):
    page, errors = start(browser, url, resume=True)
    page.get_by_role("button", name=re.compile("Retomar sesión")).click()
    destination(page, "Studio")
    inspector = page.get_by_role("complementary", name="Inspector de diseño")
    picker = inspector.get_by_role("combobox", name="Componente", exact=True)
    expect(picker).to_be_visible()
    page.get_by_role("toolbar", name="Herramientas").get_by_role("button", name="Seleccionar").click()
    frame = page.locator(".artboard-real .frame").bounding_box()
    assert frame is not None
    page.mouse.click(frame["x"] + frame["width"] * 0.5, frame["y"] + frame["height"] * 0.58)
    expect(picker).to_have_value("#acceder")
    expect(inspector.get_by_text("#acceder", exact=True)).to_be_visible()
    inspector.get_by_role("button", name="Proteger componente").click()
    expect(inspector.get_by_role("button", name="Desproteger componente")).to_be_visible()
    png = page.locator(".artboard-real .frame > img").get_attribute("src")
    inspector.locator("input[type=file][aria-label='Archivo de referencia']").set_input_files({
        "name": "referencia-qa.png", "mimeType": "image/png", "buffer": base64.b64decode(png.split(",", 1)[1]),
    })
    references = inspector.get_by_role("region", name="Referencias visuales")
    references.get_by_role("checkbox", name="Adjuntar referencia-qa.png").check()
    references.get_by_role("button", name="Ver referencia referencia-qa.png").click()
    dialog = page.get_by_role("dialog", name="referencia-qa.png")
    expect(dialog.get_by_role("img", name="referencia-qa.png")).to_be_visible()
    dialog.get_by_role("button", name="Cerrar", exact=True).click()
    destination(page, "Ajustes")
    destination(page, "Studio")
    expect(page.get_by_role("button", name="Ver referencia referencia-qa.png")).to_be_visible()
    expect(page.get_by_role("checkbox", name="Adjuntar referencia-qa.png")).not_to_be_checked()
    expect(inspector.get_by_role("button", name="Acceder", exact=True)).to_be_visible()
    assert not errors, errors
    page.close()


def check_skill_roles(browser, url):
    page, errors = start(browser, url)
    page.get_by_role("button", name="Abrir bitacola", exact=True).click()
    destination(page, "Ajustes")
    page.get_by_role("button", name="Skills y reglas").click()
    table = page.get_by_role("table", name="Asignación de skills por rol")
    designer = table.get_by_role("button", name="design-loop para Diseñador", exact=True)
    senior = table.get_by_role("button", name="design-loop para Senior", exact=True)
    expect(designer).to_have_attribute("aria-pressed", "true")
    designer.click()
    expect(designer).to_have_attribute("aria-pressed", "false")
    expect(senior).to_have_attribute("aria-pressed", "true")
    expect(table.get_by_role("button", name="implement para Investigador", exact=True)).to_have_attribute("aria-pressed", "false")
    expect(page.get_by_role("region", name="Duplicidades")).to_contain_text("enlaza la norma del semáforo macOS")
    catalog = page.get_by_role("region", name="Catálogo efectivo")
    catalog.get_by_role("combobox", name="Rol del catálogo").select_option("researcher")
    expect(catalog.get_by_text("research", exact=True)).to_be_visible()
    expect(catalog.get_by_text("implement", exact=True)).to_have_count(0)
    scope = page.get_by_role("group", name="Ámbito de las skills")
    scope.get_by_role("button", name="bitacola").click()
    expect(designer).to_have_attribute("aria-pressed", "false")
    designer.click()
    expect(designer).to_have_attribute("aria-pressed", "true")
    table.get_by_role("button", name="Heredar design-loop para Diseñador").click()
    expect(designer).to_have_attribute("aria-pressed", "false")
    scope.get_by_role("button", name="Global").click()
    expect(designer).to_have_attribute("aria-pressed", "false")
    assert not errors, errors
    page.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", default="http://127.0.0.1:1420")
    parser.add_argument("--channel", default=None)
    args = parser.parse_args()
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(channel=args.channel)
        for check in (check_resume, check_brain, check_delivery, check_delivery_worktree, check_frame, check_workspace_inspector, check_studio_surfaces, check_settings_and_network, check_studio_references_and_components, check_skill_roles, check_workspace_plan):
            check(browser, args.app)
            print(f"{check.__name__}: correcto")
        browser.close()


if __name__ == "__main__":
    main()
