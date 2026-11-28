"""Varias conversaciones a la vez en el Workspace, sobre pnpm dev (núcleo simulado).

python tests/multisesion_browser.py [--app URL] [--channel msedge] [--engine webkit] [--capturas DIR]
"""

import argparse
import re
import sys
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

CELLS = ".main-view .ws-cell:not([hidden])"
SHOTS = None


def start(browser, url, size=(1440, 900)):
    page = browser.new_page(viewport={"width": size[0], "height": size[1]})
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(url)
    page.locator("button.primary[type=submit]").click()
    page.get_by_role("button", name="Retomar diseño en calaix").or_(page.locator("button.rs-item")).filter(visible=True).first.click()
    expect(page.locator(".center-head .ch-name")).to_have_text("diseño")
    return page, errors


def shot(page, name):
    if SHOTS:
        page.wait_for_timeout(300)
        page.screenshot(path=str(SHOTS / name))


def add_new_session(page):
    page.get_by_role("button", name="Añadir panel").click()
    page.get_by_role("menuitemradio", name=re.compile("Nueva sesión")).click()


def cells(page):
    return page.locator(CELLS)


def cell(page, name):
    return cells(page).filter(has=page.locator(".ws-pane-name", has_text=re.compile(f"^{re.escape(name)}$")))


def active_name(page):
    return page.locator(".ws-cell.is-active .ws-pane-name")


def mode(page):
    return page.locator(".main-view").get_attribute("data-pane-mode")


def check_add_grid(browser, url):
    page, errors = start(browser, url)
    # Con una conversación, la vista es la de siempre: sin cabeceras de panel ni rejilla.
    expect(page.locator(".main-view.is-panes")).to_have_count(0)
    expect(page.locator(".ws-pane-head")).to_have_count(0)
    shot(page, "1-panel.png")
    for count, expected in ((2, "columns"), (3, "grid"), (4, "grid")):
        add_new_session(page)
        expect(cells(page)).to_have_count(count)
        expect(active_name(page)).to_have_text(f"sesión {count - 1}")
        assert mode(page) == expected, (count, mode(page))
        if count == 2:
            expect(page.locator(".center-head .ch-meta")).to_have_text("2 paneles")
            shot(page, "2-paneles.png")
        if count == 3:
            # El tercero ocupa toda la fila inferior.
            grid = page.locator(".main-view").bounding_box()
            third = cell(page, "sesión 2").bounding_box()
            assert third["width"] > grid["width"] * 0.9, (third, grid)
    shot(page, "4-paneles.png")
    # Con cuatro no se añaden más, ni desde la cabecera ni desde el explorador.
    expect(page.get_by_role("button", name="Añadir panel")).to_be_disabled()
    page.get_by_role("button", name="Desplegar bitacola").click()
    expect(page.get_by_role("button", name="Abrir Project manager en un panel nuevo")).to_be_disabled()
    assert not errors, errors
    page.close()


def check_focus_streaming(browser, url):
    page, errors = start(browser, url)
    add_new_session(page)
    expect(cells(page)).to_have_count(2)
    design, other = cell(page, "diseño"), cell(page, "sesión 1")
    # Pulsar dentro de un panel lo activa y la cabecera de la ventana lo sigue.
    design.locator(".co-compose textarea").click()
    expect(design).to_have_class(re.compile(r"\bis-active\b"))
    expect(page.locator(".tb-left")).to_contain_text("diseño")
    design.locator(".co-compose textarea").fill("Añade el caso de política deshabilitada")
    design.locator(".co-compose textarea").press("Enter")
    expect(design.get_by_role("group", name="Petición de permiso")).to_be_visible()
    expect(design.locator(".ws-pane-head .ch-state")).to_have_text("espera tu permiso")
    # El otro panel sigue a lo suyo: ni el texto ni el permiso aparecen en él.
    expect(other.get_by_role("group", name="Petición de permiso")).to_have_count(0)
    expect(other.locator(".co-log")).not_to_contain_text("Voy a añadir")
    # ⌘Y/Ctrl+Y solo actúa en el panel activo.
    other.locator(".co-compose textarea").click()
    expect(other).to_have_class(re.compile(r"\bis-active\b"))
    page.keyboard.press("ControlOrMeta+y")
    page.wait_for_timeout(300)
    expect(design.get_by_role("group", name="Petición de permiso")).to_be_visible()
    # Dos envíos simultáneos: streaming y decisiones permanecen en su sesión.
    other.locator(".co-compose textarea").fill("Otro encargo independiente")
    other.locator(".co-compose textarea").press("Enter")
    expect(other.get_by_role("group", name="Petición de permiso")).to_be_visible()
    expect(other.locator(".co-log")).to_contain_text("Miro primero los tests")
    expect(design.locator(".co-log")).not_to_contain_text("Otro encargo independiente")
    other.get_by_role("button", name="Ahora no").click()
    expect(other.locator(".co-log")).to_contain_text("Sin los tests no sigo.")
    expect(design.get_by_role("group", name="Petición de permiso")).to_be_visible()
    design.locator(".co-log").click()
    expect(design).to_have_class(re.compile(r"\bis-active\b"))
    page.keyboard.press("ControlOrMeta+y")
    expect(design.locator(".co-log")).to_contain_text("Hecho: la validación rechaza clientes sin política.")
    expect(other.locator(".co-log")).not_to_contain_text("Hecho:")
    assert not errors, errors
    page.close()


def check_resize(browser, url):
    page, errors = start(browser, url)
    add_new_session(page)
    divider = page.get_by_role("separator", name="Ancho de las columnas de conversación")
    left, right = cell(page, "diseño"), cell(page, "sesión 1")
    box = divider.bounding_box()
    y = box["y"] + box["height"] / 2
    page.mouse.move(box["x"] + 3, y)
    page.mouse.down()
    page.mouse.move(box["x"] + 203, y, steps=8)
    page.mouse.up()
    wide, narrow = left.bounding_box()["width"], right.bounding_box()["width"]
    assert wide - narrow > 300, (wide, narrow)
    # Hasta el extremo: cada panel conserva su ancho mínimo.
    box = divider.bounding_box()
    page.mouse.move(box["x"] + 3, y)
    page.mouse.down()
    page.mouse.move(2000, y, steps=8)
    page.mouse.up()
    assert right.bounding_box()["width"] >= 318, right.bounding_box()
    # Doble clic iguala.
    divider.dblclick()
    page.wait_for_timeout(100)
    assert abs(left.bounding_box()["width"] - right.bounding_box()["width"]) < 3
    expect(divider).to_have_attribute("aria-valuenow", "50")
    # Teclado: flechas de 5 en 5 e Intro iguala.
    divider.focus()
    page.keyboard.press("ArrowLeft")
    expect(divider).to_have_attribute("aria-valuenow", "45")
    page.keyboard.press("Enter")
    expect(divider).to_have_attribute("aria-valuenow", "50")
    assert not errors, errors
    page.close()


def check_close_maximize(browser, url):
    page, errors = start(browser, url)
    add_new_session(page)
    add_new_session(page)
    expect(cells(page)).to_have_count(3)
    page.get_by_role("button", name="Maximizar diseño").click()
    expect(cells(page)).to_have_count(1)
    expect(active_name(page)).to_have_text("diseño")
    assert mode(page) == "maximized"
    shot(page, "maximizado.png")
    page.get_by_role("button", name="Restaurar los paneles (diseño)").click()
    expect(cells(page)).to_have_count(3)
    # Quitar solo saca el panel: la conversación sigue en el explorador.
    page.get_by_role("button", name="Quitar sesión 1 de la pantalla").click()
    expect(cells(page)).to_have_count(2)
    expect(page.locator(".explorer-side .thread", has_text="sesión 1")).to_be_visible()
    # ⌘W/Ctrl+W quita el panel activo, sin cerrar la sesión.
    cell(page, "sesión 2").locator(".co-log").click()
    page.keyboard.press("ControlOrMeta+w")
    expect(cells(page)).to_have_count(1)
    expect(page.locator(".ws-pane-head")).to_have_count(0)
    expect(page.locator(".explorer-side .thread", has_text="sesión 2")).to_be_visible()
    expect(page.locator(".center-head .ch-name")).to_have_text("diseño")
    assert not errors, errors
    page.close()


def check_explorer(browser, url):
    page, errors = start(browser, url)
    add_new_session(page)
    page.get_by_role("button", name="Quitar diseño de la pantalla").click()
    expect(cells(page)).to_have_count(1)
    # Arrastrar una conversación del explorador la abre en un panel nuevo.
    row = page.locator(".explorer-side .thread", has_text="diseño")
    box = row.bounding_box()
    target = page.locator(".main-view").bounding_box()
    page.mouse.move(box["x"] + 40, box["y"] + box["height"] / 2)
    page.mouse.down()
    page.mouse.move(box["x"] + 60, box["y"] + box["height"] / 2, steps=3)
    page.mouse.move(target["x"] + target["width"] / 2, target["y"] + target["height"] / 2, steps=10)
    expect(page.locator(".ws-pane-drop")).to_contain_text("Suelta para abrir en un panel nuevo")
    page.mouse.up()
    expect(page.locator(".ws-pane-drop")).to_have_count(0)
    expect(cells(page)).to_have_count(2)
    expect(active_name(page)).to_have_text("diseño")
    # El botón del explorador abre en un panel nuevo; ya en pantalla, no se ofrece.
    expect(page.get_by_role("button", name="Abrir diseño en un panel nuevo")).to_have_count(0)
    # Una sesión nueva ocupa el panel activo, como al elegir otra conversación.
    page.get_by_role("button", name="Nueva sesión en calaix").click()
    expect(cells(page)).to_have_count(2)
    expect(active_name(page)).to_have_text("sesión 2")
    page.locator(".explorer-side .thread", has_text="diseño").hover()
    page.get_by_role("button", name="Abrir diseño en un panel nuevo").click()
    expect(cells(page)).to_have_count(3)
    expect(active_name(page)).to_have_text("diseño")
    # ⌘clic/Ctrl+clic también abre en un panel nuevo.
    page.get_by_role("button", name="Nueva sesión en el proyecto activo").click()
    expect(active_name(page)).to_have_text("sesión 3")
    expect(cells(page)).to_have_count(3)
    page.locator(".explorer-side .thread", has_text="diseño").click(modifiers=["ControlOrMeta"])
    expect(cells(page)).to_have_count(4)
    expect(active_name(page)).to_have_text("diseño")
    assert not errors, errors
    page.close()


def check_degrade(browser, url):
    page, errors = start(browser, url)
    for _ in range(3):
        add_new_session(page)
    expect(cells(page)).to_have_count(4)
    page.set_viewport_size({"width": 820, "height": 560})
    expect(page.locator(".main-view")).to_have_attribute("data-pane-mode", "tabs")
    tabs = page.get_by_role("group", name="Conversaciones en pantalla").get_by_role("button")
    expect(tabs).to_have_count(4)
    expect(cells(page)).to_have_count(1)
    shot(page, "pestanas.png")
    tabs.filter(has_text="diseño").click()
    expect(active_name(page)).to_have_text("diseño")
    expect(cells(page)).to_have_count(1)
    page.set_viewport_size({"width": 1440, "height": 900})
    expect(page.locator(".main-view")).to_have_attribute("data-pane-mode", "grid")
    expect(cells(page)).to_have_count(4)
    assert not errors, errors
    page.close()


def check_persistence(browser, url):
    page, errors = start(browser, url)
    # Conversaciones que el núcleo simulado conserva al recargar: diseño y el PM de bitacola.
    page.get_by_role("button", name="Añadir panel").click()
    page.get_by_role("menuitemradio", name=re.compile("Project manager.*bitacola")).click()
    expect(cells(page)).to_have_count(2)
    divider = page.get_by_role("separator", name="Ancho de las columnas de conversación")
    divider.focus()
    page.keyboard.press("ArrowRight")
    page.keyboard.press("ArrowRight")
    expect(divider).to_have_attribute("aria-valuenow", "60")
    cell(page, "diseño").locator(".co-log").click()
    expect(active_name(page)).to_have_text("diseño")
    page.reload()
    page.locator("button.primary[type=submit]").click()
    expect(cells(page)).to_have_count(2)
    expect(page.locator('.ws-cell[data-slot="0"] .ws-pane-name')).to_have_text("diseño")
    expect(page.locator('.ws-cell[data-slot="1"] .ws-pane-name')).to_have_text("Project manager")
    expect(active_name(page)).to_have_text("diseño")
    expect(page.get_by_role("separator", name="Ancho de las columnas de conversación")).to_have_attribute("aria-valuenow", "60")
    # Con proyectos distintos, cada panel dice de cuál es.
    expect(cell(page, "Project manager").locator(".ws-pane-meta")).to_contain_text("bitacola")
    assert not errors, errors
    page.close()



def check_regressions(browser, url):
    page, errors = start(browser, url)
    page.get_by_role("button", name="Añadir panel").click()
    page.get_by_role("menuitemradio", name=re.compile("Project manager.*bitacola")).click()
    cell(page, "diseño").locator(".co-compose textarea").click()
    page.get_by_role("button", name="Archivos", exact=True).click()
    page.get_by_role("treeitem", name="README.md", exact=True).click()
    editor = page.locator(".viewer")
    expect(editor.locator(".view-lines")).to_contain_text("Calaix")
    editor.locator("textarea").first.wait_for(state="attached")
    editor.locator(".view-lines").click(position={"x": 25, "y": 8})
    page.keyboard.press("End")
    page.keyboard.type(" borrador multisesión")
    expect(editor.locator(".dirty")).to_be_visible()
    page.locator(".explorer-side .thread", has_text="Project manager").first.click()
    expect(page.locator(".center-head .ch-name")).to_have_text("bitacola")
    expect(editor.locator(".dirty")).to_be_visible()
    expect(page.locator("#right-panel-title")).to_contain_text("calaix")
    page.get_by_role("group", name="Cambios del editor").get_by_role("button", name="Entrega").click()
    expect(page.locator(".ent-root")).to_contain_text("calaix")
    expect(page.locator(".ent-root")).not_to_contain_text("TypeError")
    page.keyboard.press("ControlOrMeta+Shift+w")
    expect(page.locator(".center-head .ch-name")).to_have_text("bitacola")
    expect(editor.locator(".dirty")).to_be_visible()
    editor.locator(".view-lines").click(position={"x": 25, "y": 8})
    page.keyboard.press("ControlOrMeta+s")
    expect(editor.locator(".dirty")).to_have_count(0)
    page.get_by_role("button", name="Cerrar README.md").click()
    expect(editor).to_have_count(0)
    page.get_by_role("button", name=re.compile(r"^Entrega ")).first.click()
    expect(page.locator(".ent-root")).to_contain_text("bitacola")
    page.keyboard.press("ControlOrMeta+Shift+w")
    assert not errors, errors
    page.close()

    # El diff de una copia aislada conserva proyecto y avisa del alcance real.
    page, errors = start(browser, url)
    page.get_by_role("button", name="Añadir panel").click()
    page.get_by_role("menuitemradio", name=re.compile("Project manager.*bitacola")).click()
    cell(page, "diseño").locator(".co-compose textarea").click()
    page.get_by_role("button", name="1 cambio").click()
    page.locator("button", has_text="src/lib/autonomy.ts").click()
    expect(page.get_by_role("group", name="Cambios del editor")).to_contain_text("Cambios de la sesión")
    page.locator(".explorer-side .thread", has_text="Project manager").first.click()
    page.get_by_role("group", name="Cambios del editor").get_by_role("button", name="Entrega").click()
    expect(page.locator(".ent-root")).to_contain_text("calaix")
    expect(page.get_by_role("status")).to_contain_text("los cambios de la sesión aislada no están disponibles")
    page.keyboard.press("ControlOrMeta+Shift+w")
    expect(page.locator(".center-head .ch-name")).to_have_text("bitacola")
    expect(page.get_by_role("group", name="Cambios del editor")).to_contain_text("Cambios de la sesión")
    assert not errors, errors
    page.close()

    page, errors = start(browser, url)
    add_new_session(page)
    add_new_session(page)
    page.get_by_role("button", name="Maximizar diseño").click()
    page.locator(".explorer-side .thread", has_text="sesión 1").click()
    expect(active_name(page)).to_have_text("sesión 1")
    expect(cells(page)).to_have_count(3)
    close = page.get_by_role("button", name="Quitar sesión 1 de la pantalla")
    close.focus()
    page.keyboard.press("Enter")
    expect(cells(page)).to_have_count(2)
    expect(page.locator(".ws-cell.is-active :focus")).to_have_count(1)
    row = page.locator(".explorer-side .thread", has_text="sesión 1")
    box = row.bounding_box()
    page.mouse.move(box["x"] + 30, box["y"] + box["height"] / 2)
    page.mouse.down()
    page.mouse.move(box["x"] + 50, box["y"] + box["height"] / 2)
    expect(page.locator(".pane-drag-ghost")).to_have_count(1)
    page.evaluate("window.dispatchEvent(new Event('blur'))")
    expect(page.locator(".pane-drag-ghost")).to_have_count(0)
    assert page.locator("html").get_attribute("data-pane-drag") is None
    page.mouse.up()
    assert not errors, errors
    page.close()

def main():
    global SHOTS
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", default="http://127.0.0.1:1420")
    parser.add_argument("--channel", default=None)
    parser.add_argument("--engine", choices=("chromium", "webkit"), default="chromium")
    parser.add_argument("--capturas", default=None, help="carpeta donde guardar capturas con 1, 2 y 4 paneles")
    args = parser.parse_args()
    if args.capturas:
        SHOTS = Path(args.capturas)
        SHOTS.mkdir(parents=True, exist_ok=True)
    # La consola de Windows no siempre admite los símbolos de los mensajes de Playwright.
    sys.stdout.reconfigure(errors="replace")
    failed = []
    with sync_playwright() as playwright:
        browser = getattr(playwright, args.engine).launch(channel=args.channel)
        for check in (check_add_grid, check_focus_streaming, check_resize, check_close_maximize, check_explorer, check_degrade, check_persistence, check_regressions):
            try:
                check(browser, args.app)
                print(f"{check.__name__}: correcto")
            except AssertionError as error:
                failed.append(check.__name__)
                print(f"{check.__name__}: FALLA\n{str(error)[:900]}")
        browser.close()
    if failed:
        raise SystemExit(f"Fallan: {', '.join(failed)}")


if __name__ == "__main__":
    main()
