"""Regresiones post-Trama con proyectos de ejemplo en el núcleo simulado."""

import argparse
import re

from playwright.sync_api import expect, sync_playwright
from trama_browser import destination, start


def check_home_team(browser, url):
    page, errors = start(browser, url)
    page.get_by_role("button", name="Ver el equipo").click()
    expect(page.get_by_role("main", name="Flow").locator("h2")).to_have_text("bitacola")
    page.get_by_role("button", name=re.compile("Buscar o ejecutar")).click()
    palette = page.get_by_role("dialog", name="Órdenes")
    palette.get_by_role("textbox").fill("Studio")
    expect(palette.get_by_role("option", name=re.compile("^Studio"))).to_have_count(1)
    assert not errors, errors


def check_workspace_recovery(browser, url):
    page = browser.new_page()
    page.add_init_script("""
        let invoke;
        window.__TAURI_INTERNALS__ = {
            get invoke() { return invoke; },
            set invoke(base) {
                invoke = (command, args, options) =>
                    command === 'get_workspace' && !window.fixtureRootAvailable
                        ? Promise.reject('No se puede leer la carpeta de proyectos de prueba')
                        : base(command, args, options);
            }
        };
    """)
    page.goto(url)
    expect(page.get_by_role("alert")).to_contain_text("No se puede leer la carpeta")
    page.evaluate("window.fixtureRootAvailable = true")
    page.get_by_role("button", name="Reintentar carpeta actual").click()
    expect(page.get_by_role("button", name="Reintentar carpeta actual")).to_have_count(0)
    page.get_by_role("button", name="continuar", exact=True).click()
    expect(page.get_by_role("navigation", name="Destinos")).to_be_visible()


def check_create_dependent_task(browser, url):
    page, errors = start(browser, url)
    page.evaluate("""() => {
        const base = window.__TAURI_INTERNALS__.invoke;
        window.__TAURI_INTERNALS__.invoke = (command, args, options) => {
            if (command !== 'task_save') return base(command, args, options);
            window.auditTaskDraft = args;
            return Promise.resolve(42);
        };
    }""")
    page.get_by_role("button", name="Abrir calaix", exact=True).click()
    destination(page, "Flow")
    page.get_by_role("button", name="Tarea", exact=True).click()
    # Desde bd7b47a la tarea se crea en el diálogo de Flow.
    work = page.get_by_role("dialog", name="Nueva tarea")
    work.get_by_label("Título", exact=True).fill("Tarea dependiente de auditoría")
    work.get_by_label("Objetivo", exact=True).fill("Verificar el alta directa desde Flow.")
    work.get_by_label("Criterios de aceptación").fill("La dependencia aparece en la ficha.")
    dependency = work.get_by_role("group", name="Depende de").get_by_role("checkbox").first
    dependency.check()
    work.get_by_role("button", name="Guardar", exact=True).click()
    page.wait_for_function("window.auditTaskDraft != null")
    draft = page.evaluate("window.auditTaskDraft")
    assert draft["project"].endswith("/calaix")
    assert draft["input"]["id"] is None
    assert draft["input"]["title"] == "Tarea dependiente de auditoría"
    assert len(draft["input"]["dependencies"]) == 1
    assert not errors, errors


def check_flow_unknown_route(browser, url):
    page, errors = start(browser, url)
    page.evaluate("""() => {
        const base = window.__TAURI_INTERNALS__.invoke;
        window.__TAURI_INTERNALS__.invoke = async (command, args, options) => {
            const result = await base(command, args, options);
            if (command !== 'task_flow') return result;
            return { ...result, runs: Object.fromEntries(Object.entries(result.runs).map(
                ([id, runs]) => [id, runs.map(run => ({ ...run, routing: null }))])) };
        };
    }""")
    page.get_by_role("button", name="Abrir calaix", exact=True).click()
    page.set_viewport_size({"width": 960, "height": 600})
    destination(page, "Flow")
    view = page.get_by_role("group", name="Vista", exact=True)
    view.get_by_role("button", name="Lista", exact=True).focus()
    page.keyboard.press("Enter")
    marker = page.locator(".rt").first
    expect(marker.locator("title")).to_have_text("Origen sin registrar", use_inner_text=False)
    marker.focus()
    page.keyboard.press("Enter")
    inspector = page.get_by_role("complementary", name="Inspector")
    expect(inspector.get_by_text("Sin registrar", exact=True)).to_be_visible()
    assert not errors, errors


def check_appearance(browser, url):
    page, errors = start(browser, url)
    destination(page, "Ajustes")
    page.get_by_role("button", name="Movimiento y apariencia", exact=True).click()
    intensity = page.get_by_role("slider", name="Intensidad del campo")
    intensity.press("Home")
    expect(intensity).to_have_value("0")
    page.get_by_role("radio", name="Claro", exact=True).click()
    page.keyboard.press("Meta+Shift+L")
    expect(page.get_by_role("radio", name="Oscuro", exact=True)).to_have_attribute("aria-checked", "true")
    page.get_by_role("radio", name="Claro", exact=True).click()
    page.reload()
    page.get_by_role("button", name="continuar", exact=True).click()
    page.get_by_role("button", name=re.compile("Movimiento y apariencia")).click()
    expect(intensity).to_have_value("0")
    expect(page.get_by_role("radio", name="Claro", exact=True)).to_have_attribute("aria-checked", "true")
    for label, value in (("Sin ambiente", "sin-ambiente"), ("Reducido", "reducido"), ("Completo", "completo")):
        page.get_by_role("radio", name=label, exact=True).click()
        expect(page.locator("html")).to_have_attribute("data-motion", value)
        halo = page.locator(".mdemo .st-working").evaluate(
            "(el) => parseFloat(getComputedStyle(el, '::before').animationDuration)"
        )
        assert (halo > 0.01) == (value != "reducido"), (value, halo)
        page.reload()
        page.get_by_role("button", name="continuar", exact=True).click()
        page.get_by_role("button", name="Movimiento y apariencia", exact=True).click()
        expect(page.get_by_role("radio", name=label, exact=True)).to_have_attribute("aria-checked", "true")
        expect(page.locator("html")).to_have_attribute("data-motion", value)
    page.emulate_media(reduced_motion="reduce")
    expect(page.locator("html")).to_have_attribute("data-motion", "reducido")
    expect(intensity).to_be_disabled()
    page.emulate_media(reduced_motion="no-preference")
    expect(page.locator("html")).to_have_attribute("data-motion", "completo")
    assert not errors, errors


def check_brain_keyboard_and_source(browser, url):
    page, errors = start(browser, url)
    destination(page, "Brain")
    page.get_by_role("button", name="Recuerdo", exact=True).click()
    dialog = page.get_by_role("dialog", name="Nuevo recuerdo")
    title = dialog.get_by_label("Enunciado")
    title.press_sequentially("Decisión de teclado")
    expect(title).to_be_focused()
    expect(title).to_have_value("Decisión de teclado")
    dialog.get_by_label("Por qué existe").fill("Prueba local del teclado.")
    dialog.get_by_label("Fuente", exact=True).fill("Fuente sintética de la auditoría")
    dialog.get_by_label("He revisado el contenido y su procedencia").check()
    dialog.get_by_role("button", name="Guardar", exact=True).click()
    panel = page.get_by_role("complementary", name="Ficha del recuerdo")
    expect(panel.get_by_text("Fuente sintética de la auditoría", exact=True)).to_be_visible()
    expect(panel.get_by_role("button", name=re.compile("Fuente sintética de la auditoría"))).to_have_count(0)
    assert not errors, errors


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", default="http://127.0.0.1:1420")
    parser.add_argument("--channel", default=None)
    args = parser.parse_args()
    checks = (check_home_team, check_workspace_recovery, check_create_dependent_task,
              check_flow_unknown_route, check_appearance, check_brain_keyboard_and_source)
    failures = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(channel=args.channel)
        for check in checks:
            try:
                check(browser, args.app)
                print(f"{check.__name__}: correcto", flush=True)
            except Exception as error:
                failures.append(check.__name__)
                print(f"{check.__name__}: {error}", flush=True)
            finally:
                for context in browser.contexts:
                    context.close()
        browser.close()
    if failures:
        raise SystemExit(f"Fallaron {len(failures)} recorridos.")


if __name__ == "__main__":
    main()
