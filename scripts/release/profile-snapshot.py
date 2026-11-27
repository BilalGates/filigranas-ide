"""Respaldo SQLite coherente e inventario privado para validar una actualización."""
import argparse
import hashlib
import json
import os
import sqlite3
from pathlib import Path


def inventory(connection):
    result = {}
    tables = connection.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    for (name,) in tables:
        quoted = '"' + name.replace('"', '""') + '"'
        columns = list(connection.execute(f'PRAGMA table_info({quoted})'))
        primary = [index for index, column in enumerate(columns) if column[5]]
        rows = list(connection.execute(f'SELECT * FROM {quoted}'))
        # Solo se guardan hashes y cantidades en el inventario, nunca conversaciones.
        hashes = []
        identities = []
        for row in rows:
            payload = json.dumps(row, default=lambda value: value.hex(), ensure_ascii=False, separators=(',', ':'))
            hashes.append(hashlib.sha256(payload.encode()).hexdigest())
            if primary:
                identity = json.dumps([row[index] for index in primary], default=lambda value: value.hex())
                identities.append(hashlib.sha256(identity.encode()).hexdigest())
        result[name] = {'rows': len(rows), 'hashes': sorted(hashes), 'identities': sorted(identities)}
    return result


def snapshot(database, output):
    if output.exists():
        raise SystemExit('El destino ya existe. Usa otra carpeta para conservar la evidencia anterior.')
    output.mkdir(parents=True, mode=0o700)
    os.chmod(output, 0o700)
    with sqlite3.connect(database.resolve().as_uri() + '?mode=ro', uri=True) as source:
        backup = output / 'filigranas.db'
        with sqlite3.connect(backup) as copy:
            source.backup(copy)
            integrity = copy.execute('PRAGMA integrity_check').fetchone()[0]
            if integrity != 'ok':
                raise SystemExit('SQLite requiere revisión. No continúes con la instalación.')
            data = inventory(copy)
        os.chmod(backup, 0o600)
    manifest = output / 'inventory.json'
    manifest.write_text(json.dumps(data, indent=2))
    os.chmod(manifest, 0o600)
    print(json.dumps({'integrity': integrity, 'tables': len(data), 'rows': sum(table['rows'] for table in data.values()), 'directory': str(output)}))


def compare(before, after):
    old = json.loads((before / 'inventory.json').read_text())
    new = json.loads((after / 'inventory.json').read_text())
    for name, table in old.items():
        current = new.get(name, {'rows': 0, 'hashes': [], 'identities': []})
        print(json.dumps({'table': name, 'before': table['rows'], 'after': current['rows'],
                          'missing_identities': len(set(table['identities']) - set(current['identities'])),
                          'changed_or_missing_rows': len(set(table['hashes']) - set(current['hashes']))}))
    # Los metadatos de turnos y sesiones pueden cambiar al cerrar o reabrir.
    # La comparación informa diferencias para revisión y no declara aceptación automática.


parser = argparse.ArgumentParser(description=__doc__)
commands = parser.add_subparsers(dest='action', required=True)
backup = commands.add_parser('snapshot')
backup.add_argument('--database', type=Path, required=True)
backup.add_argument('--output', type=Path, required=True)
comparison = commands.add_parser('compare')
comparison.add_argument('before', type=Path)
comparison.add_argument('after', type=Path)
args = parser.parse_args()
if args.action == 'snapshot':
    snapshot(args.database, args.output)
else:
    compare(args.before, args.after)
