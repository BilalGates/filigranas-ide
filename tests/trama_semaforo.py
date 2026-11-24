"""Verifica los bordes del semáforo de la ventana macOS de desarrollo."""

import argparse
import json
from pathlib import Path
import subprocess

from PIL import Image


WINDOW = """
function run(argv) {
    const [pid, width, height, fullscreen] = argv.map(Number);
    ObjC.import('CoreGraphics');
    const se = Application('System Events');
    const app = se.applicationProcesses.whose({unixId: pid})[0];
    app.frontmost = true;
    const window = app.windows[0];
    window.size = [width, height];
    if (fullscreen) {
        const attribute = window.attributes.byName('AXFullScreen');
        attribute.value = true;
        delay(1.2);
        attribute.value = false;
        delay(1.2);
    }
    delay(0.5);
    const windows = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1, 0)));
    const main = windows.find(w => w.kCGWindowOwnerPID === pid && w.kCGWindowLayer === 0);
    if (!main) throw new Error('No se encontró la ventana de Filigranas');
    return JSON.stringify({id: main.kCGWindowNumber, size: window.size()});
}
"""


def capture(pid, width, height, fullscreen, output):
    window = json.loads(subprocess.check_output([
        "osascript", "-l", "JavaScript", "-", str(pid), str(width), str(height), str(int(fullscreen)),
    ], input=WINDOW, text=True))
    subprocess.run(["screencapture", "-x", "-o", "-l", str(window["id"]), str(output)], check=True)
    with Image.open(output) as screenshot:
        scale = screenshot.width / window["size"][0]
        pixels = screenshot.convert("RGB").load()
        bounds = []
        for left in (16, 39, 62):
            occupied = []
            for x in range(round((left - 4) * scale), round((left + 18) * scale)):
                for y in range(round(8 * scale), round(36 * scale)):
                    channels = pixels[x, y]
                    if max(channels) > 125 and max(channels) - min(channels) > 50:
                        occupied.append((x, y))
            assert occupied, (left, window, "semáforo inactivo o invisible")
            xs, ys = zip(*occupied)
            bounds.append([min(xs) / scale, min(ys) / scale, (max(xs) - min(xs) + 1) / scale])
    return {"window": window["size"], "scale": scale, "buttons": bounds, "fullScreenReturn": fullscreen}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pid", type=int, help="PID de la instancia aislada de desarrollo")
    parser.add_argument("output", type=Path, help="Carpeta de capturas de prueba")
    args = parser.parse_args()
    process = subprocess.check_output(["ps", "-p", str(args.pid), "-o", "comm="], text=True).strip()
    if not ("/target/debug/filigranas" in process or Path(process).name.startswith("trama-perfil-bin-")):
        parser.error("el PID debe corresponder al ejecutable de desarrollo o del perfil de pruebas")
    args.output.mkdir(parents=True, exist_ok=True)
    results = []
    for width, height, fullscreen in [(1440, 900, False), (960, 600, False), (1280, 800, True), (960, 600, False)]:
        path = args.output / f"{width}x{height}-{'tras-pantalla-completa' if fullscreen else len(results)}.png"
        results.append(capture(args.pid, width, height, fullscreen, path))
    output = json.dumps(results, indent=2) + "\n"
    (args.output / "semaforo.json").write_text(output, encoding="utf-8")
    print(output, end="")
    for result in results:
        for expected_x, (x, y, diameter) in zip((16, 39, 62), result["buttons"]):
            assert abs(x - expected_x) <= 0.5 and abs(y - 16) <= 0.5 and abs(diameter - 14) <= 0.5, result


if __name__ == "__main__":
    main()
