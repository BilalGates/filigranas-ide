"""Regresiones de las acciones de la cabecera del Workspace sobre pnpm dev.

python tests/workspace_acciones_browser.py [--app URL] [--channel msedge] [--engine webkit]
"""

import argparse
import re
import sys

from playwright.sync_api import expect, sync_playwright


def start(browser, url):
    page = browser.new_page(viewport={"width": 1440, "height": 900})
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(url)
    page.locator("button.primary[type=submit]").click()
    page.get_by_role("button", name="Retomar diseño en calaix").or_(page.locator("button.rs-item")).filter(visible=True).first.click()
    expect(page.locator(".center-head .ch-name")).to_be_visible()
    return page, errors


def panel_button(page, name):
    return page.get_by_role("group", name="Paneles del proyecto").filter(visible=True).get_by_role("button", name=name)


def layout_button(page, name):
    return page.get_by_role("group", name="Disposición").get_by_role("button", name=name, exact=True)


def unreachable(page):
    """Botones visibles de las cabeceras que quedan recortados o tapados."""
    return page.evaluate("""() => [...document.querySelectorAll('.center-head button, .panel-head button')]
        .filter((button) => {
            const box = button.getBoundingClientRect();
            if (!box.width || getComputedStyle(button).visibility === 'hidden') return false;
            return [box.left + 3, box.right - 3].some((x) => !button.contains(document.elementFromPoint(x, box.top + box.height / 2)));
        })
        .map((button) => button.getAttribute('aria-label') || button.title || button.textContent.trim())""")


def check_panels(browser, url):
    page, errors = start(browser, url)
    panel = page.locator("#workspace-right-panel")
    for name in ("Cambios", "Archivos"):
        button = panel_button(page, name)
        button.click()
        expect(button).to_have_attribute("aria-pressed", "true")
        expect(panel).to_be_in_viewport(ratio=0.99)
        expect(button).not_to_be_focused()
        button.click()
        expect(button).to_have_attribute("aria-pressed", "false")
        expect(panel).to_be_hidden()
    assert not errors, errors
    page.close()


def check_disposition(browser, url):
    page, errors = start(browser, url)
    panel = page.locator("#workspace-right-panel")
    for name in ("Dividida", "Código"):
        layout_button(page, name).click()
        expect(panel).to_be_in_viewport(ratio=0.99)
        files = panel_button(page, "Archivos")
        expect(files).to_have_attribute("aria-pressed", "true")
        files.click()
        # Sin panel solo queda la conversación: es lo que debe marcar el selector.
        expect(layout_button(page, "Conversación")).to_have_attribute("aria-pressed", "true")
        expect(layout_button(page, name)).to_have_attribute("aria-pressed", "false")
    assert not errors, errors
    page.close()


def check_keyboard(browser, url):
    page, errors = start(browser, url)
    layout_button(page, "Código").press("Enter")
    back = page.get_by_role("button", name="Conversación").filter(has_text="Conversación")
    expect(back).to_be_focused()
    back.press("Enter")
    expect(layout_button(page, "Conversación")).to_be_focused()
    layout_button(page, "Código").press("Enter")
    panel_button(page, "Archivos").press("Enter")
    expect(layout_button(page, "Conversación")).to_be_focused()
    assert not errors, errors
    page.close()


def check_widths(browser, url):
    page, errors = start(browser, url)
    layout_button(page, "Código").click()
    page.locator("#workspace-right-panel").get_by_text("README.md").first.click()
    expect(page.get_by_role("button", name="Cerrar README.md")).to_be_visible()
    for width in (1440, 960):
        page.set_viewport_size({"width": width, "height": 700})
        for shortcut in ("Control+Alt+3", "Control+Alt+2", "Control+Alt+1"):
            page.keyboard.press(shortcut)
            page.evaluate("() => { document.querySelector('.center-head .ch-name').textContent = 'Un título de sesión muy largo '.repeat(4); }")
            page.wait_for_timeout(400)
            assert not unreachable(page), (width, shortcut, unreachable(page))
        panel_button(page, re.compile("^Archivos$")).click()
        expect(page.locator("#workspace-right-panel")).to_be_in_viewport(ratio=0.99)
        assert not unreachable(page), (width, "Archivos", unreachable(page))
    assert not errors, errors
    page.close()


def check_right_chat_drawer_and_dock(browser, url):
    page = browser.new_page(viewport={"width": 1440, "height": 900})
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(url)
    page.locator("button.primary[type=submit]").click()
    expect(page.locator(".ws-shell")).to_have_attribute("data-active-tool", "inicio")

    # El chat está a la derecha de Inicio.
    tool_box = page.locator(".tool-pane").bounding_box()
    ws_box = page.locator(".ws-pane").bounding_box()
    assert tool_box and ws_box and tool_box["x"] < ws_box["x"], (tool_box, ws_box)

    # El botón Explorador abre el cajón y el segundo clic lo cierra.
    explorer_btn = page.locator(".ws-side-toggle")
    expect(explorer_btn).to_have_attribute("aria-expanded", "false")
    expect(explorer_btn).to_have_attribute("aria-label", "Mostrar explorador")
    explorer_btn.click()
    expect(page.locator(".ws-inner.has-side-drawer")).to_have_count(1)
    expect(explorer_btn).to_have_attribute("aria-expanded", "true")
    expect(explorer_btn).to_have_attribute("aria-label", "Ocultar explorador")
    assert not unreachable(page), unreachable(page)
    explorer_btn.click()
    expect(page.locator(".ws-inner.has-side-drawer")).to_have_count(0)
    expect(explorer_btn).to_have_attribute("aria-expanded", "false")

    # Ctrl+B / ⌘B abre y cierra el mismo cajón cuando el ancho fuerza el colapso.
    page.keyboard.press("Control+b")
    expect(page.locator(".ws-inner.has-side-drawer")).to_have_count(1)
    page.keyboard.press("Control+b")
    expect(page.locator(".ws-inner.has-side-drawer")).to_have_count(0)

    # Ocultar chat con teclado traslada el foco a la lengüeta, y recuperar lo devuelve a Ocultar chat.
    hide_btn = page.get_by_role("button", name="Ocultar chat")
    hide_btn.focus()
    page.keyboard.press("Enter")
    expect(page.locator(".ws-shell")).to_have_attribute("data-shell-mode", "compact")
    dock = page.locator(".ws-dock-tab")
    expect(dock).to_be_visible()
    expect(dock).to_be_focused()
    dock_box = dock.bounding_box()
    shell_box = page.locator(".ws-shell").bounding_box()
    assert dock_box and shell_box and abs((dock_box["x"] + dock_box["width"]) - (shell_box["x"] + shell_box["width"])) <= 2

    # Recuperar con Enter desde la lengüeta restaura la vista dividida y devuelve el foco a Ocultar chat.
    page.keyboard.press("Enter")
    expect(page.locator(".ws-shell")).to_have_attribute("data-shell-mode", "split")
    expect(page.locator(".ws-pane")).to_be_visible()
    expect(hide_btn).to_be_focused()

    # En modo maximized también aparece la lengüeta y recupera la vista dividida.
    page.keyboard.press("Control+Shift+F")
    expect(page.locator(".ws-shell")).to_have_attribute("data-shell-mode", "maximized")
    expect(dock).to_be_visible()
    dock.click()
    expect(page.locator(".ws-shell")).to_have_attribute("data-shell-mode", "split")

    # En ventana estrecha (< 788 px disponibles), recuperar desde la lengüeta cierra la herramienta y enfoca el chat.
    page.set_viewport_size({"width": 780, "height": 720})
    expect(page.locator(".ws-shell")).to_have_attribute("data-shell-mode", "compact")
    dock.focus()
    page.keyboard.press("Enter")
    expect(page.locator(".ws-shell")).to_have_attribute("data-shell-mode", "workspace")
    expect(page.locator(".ws-shell")).to_have_attribute("data-active-tool", "")
    focused_in_ws = page.evaluate("() => !!document.querySelector('.ws-pane')?.contains(document.activeElement)")
    assert focused_in_ws, "El foco debe entrar en Workspace al cerrar herramienta desde ventana estrecha"

    # En ventana ancha (Workspace completo), ⌘B oculta barra -> Explorador abre cajón -> ⌘B cierra el cajón sin reabrir barra fija.
    page.set_viewport_size({"width": 1440, "height": 900})
    page.keyboard.press("Control+b")
    expect(page.locator(".ws-inner.no-side")).to_have_count(1)
    explorer_btn.click()
    expect(page.locator(".ws-inner.has-side-drawer")).to_have_count(1)
    page.keyboard.press("Control+b")
    expect(page.locator(".ws-inner.has-side-drawer")).to_have_count(0)
    expect(page.locator(".ws-inner.no-side")).to_have_count(1)
    page.keyboard.press("Control+b")
    expect(page.locator(".ws-inner.no-side")).to_have_count(0)

    assert not errors, errors
    page.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", default="http://127.0.0.1:1420")
    parser.add_argument("--channel", default=None)
    parser.add_argument("--engine", choices=("chromium", "webkit"), default="chromium")
    args = parser.parse_args()
    # La consola de Windows no siempre admite los símbolos de los mensajes de Playwright.
    sys.stdout.reconfigure(errors="replace")
    failed = []
    with sync_playwright() as playwright:
        browser = getattr(playwright, args.engine).launch(channel=args.channel)
        for check in (check_panels, check_disposition, check_keyboard, check_widths, check_right_chat_drawer_and_dock):
            try:
                check(browser, args.app)
                print(f"{check.__name__}: correcto")
            except AssertionError as error:
                failed.append(check.__name__)
                print(f"{check.__name__}: FALLA\n{str(error)[:600]}")
        browser.close()
    if failed:
        raise SystemExit(f"Fallan: {', '.join(failed)}")


if __name__ == "__main__":
    main()
