import { useEffect, useState, type ReactNode } from 'react';
import Tools from '../Tools';
import UsagePanel from '../Usage';
import { skills as skillsApi, tasks as taskApi, type CliUpdate, type SkillInfo, type Tool } from '../ipc';
import { shortcut } from '../ui';
import { Icon } from './icons';
import { setFieldIntensity, setMotion, useMotion, type Motion } from './motion';
import { ErrorNote, Seg } from './ui';

// Ajustes: solo controles conectados a configuración real. Lo que vive en
// otro sitio (modelo de cada sesión, aprobaciones por acción) se explica y
// se enlaza en vez de duplicarse con selectores decorativos.
type Section = 'visual' | 'herramientas' | 'uso' | 'proyecto' | 'skills' | 'permisos' | 'atajos';
const SECTIONS: { id: Section; label: string; icon: string }[] = [
  { id: 'visual', label: 'Visual y movimiento', icon: 'sun' },
  { id: 'herramientas', label: 'Herramientas y Jev', icon: 'route' },
  { id: 'uso', label: 'Uso y presupuesto', icon: 'gauge' },
  { id: 'proyecto', label: 'Proyecto', icon: 'folder' },
  { id: 'skills', label: 'Skills e instrucciones', icon: 'spark' },
  { id: 'permisos', label: 'Permisos', icon: 'shield' },
  { id: 'atajos', label: 'Atajos', icon: 'grid' },
];

export default function Settings({ project, projectName, tools, checking, autoUpdates, onRefreshTools, onLogin, usage, commands }: {
  project: string | null;
  projectName: string | null;
  tools: Tool[] | null;
  checking: boolean;
  autoUpdates: CliUpdate[] | null;
  onRefreshTools: () => void;
  onLogin: ((command: string) => void) | null;
  usage: Parameters<typeof UsagePanel>[0];
  commands: { id: string; label: string; keys?: string }[];
}) {
  const [section, setSection] = useState<Section>('visual');
  return (
    <section className="tr-dest tr-settings" aria-label="Ajustes">
      <header className="tr-head"><div><h1>Ajustes</h1><div className="sub">Globales y de {projectName ?? 'ningún proyecto abierto'}</div></div></header>
      <div className="settings-grid">
        <nav className="settings-nav" aria-label="Secciones de ajustes">
          {SECTIONS.map((s) => (
            <button key={s.id} className="tr-li" aria-current={section === s.id ? 'page' : undefined} aria-selected={section === s.id} onClick={() => setSection(s.id)}>
              <Icon name={s.icon} size={14} /><span className="t">{s.label}</span>
            </button>
          ))}
        </nav>
        <div className="settings-body">
          {section === 'visual' && <Visual />}
          {section === 'herramientas' && (
            <Block title="Herramientas, cuentas y Jev" note="Estado real de las CLI, inicio de sesión y enrutado de Jev. Los cambios se guardan en el núcleo.">
              <div className="settings-embed legacy"><Tools tools={tools} checking={checking} hidden={false} onRefresh={onRefreshTools} autoUpdates={autoUpdates} onLogin={onLogin} /></div>
            </Block>
          )}
          {section === 'uso' && (
            <Block title="Uso y presupuesto" note="Cuotas y consumo que informan los proveedores y Jev. Filigranas no inventa límites que el proveedor no publica.">
              <div className="settings-embed legacy"><UsagePanel {...usage} /></div>
            </Block>
          )}
          {section === 'proyecto' && <ProjectSettings project={project} projectName={projectName} />}
          {section === 'skills' && <Skills />}
          {section === 'permisos' && (
            <Block title="Permisos" note="Filigranas pide aprobación en cada acción sensible; no existe un interruptor que los desactive en bloque.">
              <ul className="settings-facts">
                <li><Icon name="shield" size={14} /><span><b>Comandos y archivos de los agentes</b>: cada petición aparece en la conversación con Permitir o Rechazar (⌘↩ / ⌘⌫).</span></li>
                <li><Icon name="push" size={14} /><span><b>Push</b>: se revisa el destino y los commits antes de publicar.</span></li>
                <li><Icon name="pr" size={14} /><span><b>PR y merge</b>: borrador, revisión y prueba explícita antes de abrir o fusionar.</span></li>
                <li><Icon name="studio" size={14} /><span><b>Studio y Brain</b>: los encargos de diseño y los recuerdos se envían o guardan solo con confirmación.</span></li>
              </ul>
            </Block>
          )}
          {section === 'atajos' && (
            <Block title="Atajos de teclado">
              <table className="flow-table settings-keys"><tbody>
                {commands.filter((c) => c.keys).map((c) => <tr key={c.id}><td>{c.label}</td><td className="mono">{shortcut(c.keys!)}</td></tr>)}
              </tbody></table>
            </Block>
          )}
        </div>
      </div>
    </section>
  );
}

function Block({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return <section className="settings-block"><h2>{title}</h2>{note && <p className="mut">{note}</p>}{children}</section>;
}

function Visual() {
  const m = useMotion();
  const [light, setLight] = useState(document.documentElement.classList.contains('is-light'));
  return (
    <Block title="Visual y movimiento" note="El movimiento acompaña estados reales (agentes trabajando, permisos, transiciones). La preferencia del sistema «Reducir movimiento» siempre manda.">
      <div className="settings-row">
        <div><b>Movimiento</b><p className="mut">Completo anima estados y el campo ambiental. Sin ambiente deja el fondo quieto. Reducido elimina animaciones.</p></div>
        <Seg label="Movimiento" value={m.motion} onChange={(v: Motion) => setMotion(v)} items={[{ id: 'completo', label: 'Completo' }, { id: 'sin-ambiente', label: 'Sin ambiente' }, { id: 'reducido', label: 'Reducido' }]} />
      </div>
      {m.systemReduced && <div className="tr-note"><Icon name="info" size={14} />El sistema tiene activado «Reducir movimiento»: se aplica el modo reducido.</div>}
      <div className="settings-row">
        <div><b>Intensidad del campo</b><p className="mut">Luz del fondo de puntos.</p></div>
        <input type="range" min={0} max={1.6} step={0.1} value={m.intensity} onChange={(e) => setFieldIntensity(Number(e.currentTarget.value))} aria-label="Intensidad del campo" disabled={m.motion !== 'completo' || m.systemReduced} />
      </div>
      <div className="settings-row">
        <div><b>Tema</b><p className="mut">Oscuro o claro ({shortcut('⌘⇧L')}).</p></div>
        <Seg label="Tema" value={light ? 'claro' : 'oscuro'} onChange={(v) => { document.documentElement.classList.toggle('is-light', v === 'claro'); setLight(v === 'claro'); }} items={[{ id: 'oscuro', label: 'Oscuro' }, { id: 'claro', label: 'Claro' }]} />
      </div>
      <div className="settings-row">
        <div><b>Tipografía</b><p className="mut">SF Pro en la interfaz e Iosevka en el código.</p></div>
        <span className="mono mut">SF Pro · Iosevka</span>
      </div>
    </Block>
  );
}

function ProjectSettings({ project, projectName }: { project: string | null; projectName: string | null }) {
  const [limit, setLimit] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => { if (project) taskApi.parallelLimit(project).then(setLimit, (e) => setError(String(e))); }, [project]);
  if (!project) return <Block title="Proyecto" note="Abre un proyecto para ver sus ajustes."><span /></Block>;
  return (
    <Block title={`Proyecto · ${projectName}`} note="Ajustes guardados en el núcleo para este proyecto.">
      <div className="settings-row">
        <div><b>Tareas en paralelo</b><p className="mut">Cuántas tareas puede ejecutar el project manager a la vez.</p></div>
        <div className="tr-row">
          <input className="tr-input" type="number" min={1} max={8} value={limit ?? ''} style={{ width: 70 }} aria-label="Tareas en paralelo"
            onChange={(e) => { setSaved(false); setLimit(Number(e.currentTarget.value)); }} />
          <button className="tr-btn sm" disabled={limit == null || limit < 1} onClick={() => taskApi.parallelLimit(project, limit).then((v) => { setLimit(v); setSaved(true); }, (e) => setError(String(e)))}>Guardar</button>
          {saved && <span className="tr-chip mint">guardado</span>}
        </div>
      </div>
      <div className="settings-row">
        <div><b>Modelo de cada sesión</b><p className="mut">Se elige en el selector de la propia conversación (Codex, Claude) y en Studio para las sesiones de diseño.</p></div>
        <span className="mut">en cada sesión</span>
      </div>
      {error && <ErrorNote error={error} />}
    </Block>
  );
}

function Skills() {
  const [list, setList] = useState<SkillInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { skillsApi.list().then(setList, (e) => setError(String(e))); }, []);
  return (
    <Block title="Skills e instrucciones" note="Skills incluidas en Filigranas. Los agentes reciben el catálogo junto a las reglas del proyecto y leen cada skill solo cuando el encargo la necesita.">
      {error && <ErrorNote error={error} />}
      {list === null ? <div className="tr-skel" style={{ height: 60 }} /> : (
        <ul className="settings-facts">
          {list.map((s) => <li key={s.name}><Icon name="spark" size={14} /><span><b className="mono">${s.name}</b> — {s.description}</span></li>)}
        </ul>
      )}
    </Block>
  );
}
