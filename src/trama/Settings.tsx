import { useEffect, useState, type CSSProperties } from 'react';
import Tools from '../Tools';
import UsagePanel from '../Usage';
import { jev, skills as skillsApi, tasks as taskApi, type CliUpdate, type JevStatus, type SkillInfo, type Tool } from '../ipc';
import { shortcut } from '../ui';
import { useProviderQuota } from '../usageStore';
import { Icon } from './icons';
import { setFieldIntensity, setMotion, useMotion, type Motion } from './motion';
import { Root } from './kit';

// Ajustes de Trama v2 con configuración real: cada opción indica dónde está
// definida (global, proyecto o sesión). Lo que no existe en el núcleo no se
// presenta como un control: se explica dónde se gestiona.
type Section = 'modelos' | 'skills' | 'permisos' | 'presupuestos' | 'agentes' | 'apariencia' | 'atajos';
const SECS: [Section, string, string][] = [['modelos', 'cube', 'Modelos y herramientas'], ['skills', 'facets', 'Skills y reglas'], ['permisos', 'shield', 'Permisos'], ['presupuestos', 'coin', 'Presupuestos'], ['agentes', 'agent', 'Agentes'], ['apariencia', 'sun', 'Movimiento y apariencia'], ['atajos', 'grid', 'Atajos']];
const sc = (k: 'g' | 'p' | 's') => <span className={`scope ${k}`}>{{ g: 'global', p: 'proyecto', s: 'sesión' }[k]}</span>;

export default function Settings({ project, projectName, tools, checking, autoUpdates, onRefreshTools, onLogin, usage, commands }: {
  project: string | null; projectName: string | null; tools: Tool[] | null; checking: boolean; autoUpdates: CliUpdate[] | null;
  onRefreshTools: () => void; onLogin: ((command: string) => void) | null; usage: Parameters<typeof UsagePanel>[0]; commands: { id: string; label: string; keys?: string }[];
}) {
  const [sec, setSec] = useState<Section>(() => { try { return (localStorage.getItem('filigranas.ajustes') as Section) || 'modelos'; } catch { return 'modelos'; } });
  const pick = (s: Section) => { setSec(s); try { localStorage.setItem('filigranas.ajustes', s); } catch { /* */ } };
  return (
    <Root label="Ajustes">
      <div className="set">
        <nav className="snav" aria-label="Secciones de ajustes">
          {SECS.map(([id, ic, l]) => <button key={id} className={sec === id ? 'on' : ''} aria-current={sec === id ? 'page' : undefined} onClick={() => pick(id)}><Icon name={ic} size={15} /><span>{l}</span></button>)}
          <p className="sample" style={{ padding: '14px 10px' }}>Cada opción indica dónde está definida. {projectName ? `Proyecto abierto: ${projectName}.` : 'Sin proyecto abierto.'}</p>
        </nav>
        <div className="sbody scr">
          {sec === 'modelos' && <>
            <h2 className="vt">Modelos y herramientas</h2>
            <p className="lead">Filigranas usa las CLI con su sesión habitual; no guarda tokens. Solo Codex, Claude y Jev están activos. El modelo de cada conversación se elige en su propio selector.</p>
            <div className="settings-embed legacy"><Tools tools={tools} checking={checking} hidden={false} onRefresh={onRefreshTools} autoUpdates={autoUpdates} onLogin={onLogin} /></div>
          </>}
          {sec === 'skills' && <SkillsSec />}
          {sec === 'permisos' && <>
            <h2 className="vt">Permisos</h2>
            <p className="lead">Las operaciones críticas no se pueden relajar desde aquí: siempre piden autorización explícita en el momento.</p>
            {[['Push a remoto', 'Revisión del destino y los commits antes de publicar'], ['Publicar PR', 'Borrador revisable y prueba explícita'], ['Merge en main', 'Revisión y prueba explícita'], ['Comandos y archivos de los agentes', 'Cada petición aparece en la conversación con Permitir o Rechazar (⌘↩ / ⌘⌫)'], ['Encargos de diseño y recuerdos de Brain', 'Se envían o guardan solo con confirmación']].map(([t, d]) => (
              <div key={t} className="srow"><div><div className="t">{t} {sc('g')}</div><div className="d">{d}</div></div><span className="chip"><Icon name="lock" size={11} /> fijo</span></div>
            ))}
          </>}
          {sec === 'presupuestos' && <Budget usage={usage} />}
          {sec === 'agentes' && <Agents project={project} projectName={projectName} />}
          {sec === 'apariencia' && <Look />}
          {sec === 'atajos' && <>
            <h2 className="vt">Atajos de teclado</h2>
            <p className="lead">Todo se puede hacer con el teclado. ⌘K abre la paleta con todas las órdenes.</p>
            {commands.filter((c) => c.keys).map((c) => <div key={c.id} className="srow"><div><div className="t">{c.label}</div></div><span className="kbd">{shortcut(c.keys!)}</span></div>)}
          </>}
        </div>
      </div>
    </Root>
  );
}

function SkillsSec() {
  const [list, setList] = useState<SkillInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { skillsApi.list().then(setList, (e) => setError(String(e))); }, []);
  return <>
    <h2 className="vt">Skills y reglas</h2>
    <p className="lead">Skills incluidas en Filigranas. Todos los agentes reciben el catálogo junto a las reglas globales y las del proyecto (AGENTS.md), y leen cada skill solo cuando su encargo la necesita.</p>
    {error && <p className="mut2">{error}</p>}
    {(list ?? []).map((s) => <div key={s.name} className="srow"><div><div className="t"><span className="mono">${s.name}</span> {sc('g')}</div><div className="d">{s.description}</div></div><span className="chip">todos los roles</span></div>)}
    <div className="srow"><div><div className="t">Reglas del proyecto <span className="mono">AGENTS.md</span> {sc('p')}</div><div className="d">Se leen del repositorio en cada sesión</div></div><span className="chip">todos los roles</span></div>
    <div className="srow"><div><div className="t">Instrucciones globales <span className="mono">reglas.md</span> {sc('g')}</div><div className="d">Incluidas en la app</div></div><span className="chip">todos los roles</span></div>
  </>;
}

function Budget({ usage }: { usage: Parameters<typeof UsagePanel>[0] }) {
  const codex = useProviderQuota('codex', null), claude = useProviderQuota('claude', null);
  const [jv, setJv] = useState<JevStatus | null>(null);
  useEffect(() => { jev.status().then(setJv, () => setJv(null)); }, []);
  const q = (label: string, x: ReturnType<typeof useProviderQuota>) => x.windows.length ? x.windows.map((w) => (
    <div key={label + w.label} className="srow"><div><div className="t">Cuota de {label} · {w.label} {sc('g')}</div><div className="d">Informada por la CLI{w.resetsAt ? ` · se renueva ${new Date(w.resetsAt * 1000).toLocaleString('es-ES', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : ''}</div></div><span className="mono">{Math.round(w.percent)}% usado</span></div>
  )) : <div className="srow"><div><div className="t">Cuota de {label}</div><div className="d">La CLI no ha informado todavía</div></div><span className="chip dash">desconocida</span></div>;
  return <>
    <h2 className="vt">Presupuestos</h2>
    <p className="lead">Solo se muestran cifras que el sistema conoce. Lo desconocido se indica como tal.</p>
    {q('Codex', codex)}{q('Claude', claude)}
    <div className="srow"><div><div className="t">Jev {sc('g')}</div><div className="d">{jv ? `Modo ${jv.settings.mode === 'local' ? 'local' : jv.settings.mode === 'shadow' ? 'sombra' : 'activo'} · política ${jv.settings.policy === 'economy' ? 'económica' : jv.settings.policy === 'quality' ? 'calidad' : 'equilibrada'}` : 'Sin estado'}</div></div><span className="chip">en Modelos y herramientas</span></div>
    <div className="settings-embed legacy" style={{ marginTop: 14 }}><UsagePanel {...usage} /></div>
  </>;
}

function Agents({ project, projectName }: { project: string | null; projectName: string | null }) {
  const [limit, setLimit] = useState<number | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (project) taskApi.parallelLimit(project).then(setLimit, (e) => setError(String(e))); }, [project]);
  return <>
    <h2 className="vt">Agentes</h2>
    <p className="lead">El Project manager reparte tareas a sesiones de Codex o Claude, cada una con su rama y su worktree cuando trabaja aislada.</p>
    {project ? (
      <div className="srow"><div><div className="t">Tareas en paralelo {sc('p')}</div><div className="d">Cuántas tareas puede ejecutar a la vez el PM de {projectName}</div></div>
        <div className="row"><input className="in" type="number" min={1} max={8} value={limit ?? ''} style={{ width: 70 }} aria-label="Tareas en paralelo" onChange={(e) => { setSaved(false); setLimit(Number(e.currentTarget.value)); }} />
          <button className="btn sm" disabled={limit == null || limit < 1} onClick={() => taskApi.parallelLimit(project, limit).then((v) => { setLimit(v); setSaved(true); }, (e) => setError(String(e)))}>Guardar</button>{saved && <span className="chip mint">guardado</span>}</div></div>
    ) : <p className="mut2">Abre un proyecto para ajustar sus agentes.</p>}
    <div className="srow"><div><div className="t">Modelo y esfuerzo {sc('s')}</div><div className="d">Se eligen en el selector de cada conversación y en Studio para las sesiones de diseño</div></div><span className="chip">en cada sesión</span></div>
    {error && <p className="mut2">{error}</p>}
  </>;
}

function Look() {
  const m = useMotion();
  const [light, setLight] = useState(document.documentElement.classList.contains('is-light'));
  const ST: [string, string, string][] = [['idle', 'Reposo', 'Sin movimiento. El campo se queda quieto y el bucle se detiene.'], ['thinking', 'Razonamiento', 'Respiración profunda; la luz se difunde despacio.'], ['working', 'Ejecución', 'Halo que gira y energía que fluye hacia la tarea.'], ['waiting', 'Espera de permiso', 'Doble latido ámbar, focalizado en quien espera.'], ['blocked', 'Bloqueo', 'Quieto, contorno discontinuo.'], ['done', 'Finalización', 'Onda de resolución y reposo estable.']];
  return <>
    <h2 className="vt">Movimiento y apariencia</h2>
    <p className="lead">El movimiento siempre comunica un estado real. Puedes reducirlo sin perder información: el estado se sigue leyendo por forma y color.</p>
    <div className="srow"><div><div className="t">Movimiento {sc('g')}</div><div className="d">{m.systemReduced ? 'El sistema pide movimiento reducido: se respeta siempre.' : 'Completo, sin ambiente (estados animados, fondo quieto) o reducido.'}</div></div>
      <div className="seg" role="radiogroup" aria-label="Movimiento">{([['completo', 'Completo'], ['sin-ambiente', 'Sin ambiente'], ['reducido', 'Reducido']] as [Motion, string][]).map(([id, l]) => <button key={id} className={m.motion === id ? 'on' : ''} role="radio" aria-checked={m.motion === id} onClick={() => setMotion(id)}>{l}</button>)}</div></div>
    <div className="motiongrid">{ST.map(([st, t, d]) => (
      <div key={st} className="mstate"><div className="mdemo"><span className={`ag st-${st}`} style={{ '--h': '#b09cff', '--s': '26px' } as CSSProperties}><i /></span><svg width="70" height="26" aria-hidden="true"><path className={`ge ${st === 'working' ? 'e-exec' : st === 'blocked' ? 'e-block' : st === 'done' ? 'e-done' : st === 'waiting' ? 'e-wait' : 'e-dep'} lg`} d="M2 13H68" style={st === 'working' ? { stroke: '#b09cff' } : undefined} /></svg></div><b>{t}</b><p>{d}</p></div>
    ))}</div>
    <div className="srow"><div><div className="t">Intensidad del campo ambiental {sc('g')}</div><div className="d">Luz de actividad tras el vidrio</div></div><input type="range" min={0} max={1.6} step={0.1} value={m.intensity} onChange={(e) => setFieldIntensity(Number(e.currentTarget.value))} aria-label="Intensidad del campo" disabled={m.motion !== 'completo' || m.systemReduced} /></div>
    <div className="srow"><div><div className="t">Tema {sc('g')}</div><div className="d">Oscuro o claro ({shortcut('⌘⇧L')})</div></div>
      <div className="seg" role="radiogroup" aria-label="Tema">{[['oscuro', 'Oscuro'], ['claro', 'Claro']].map(([id, l]) => <button key={id} className={(light ? 'claro' : 'oscuro') === id ? 'on' : ''} role="radio" aria-checked={(light ? 'claro' : 'oscuro') === id} onClick={() => { document.documentElement.classList.toggle('is-light', id === 'claro'); setLight(id === 'claro'); }}>{l}</button>)}</div></div>
    <div className="srow"><div><div className="t">Tipografía</div><div className="d">SF Pro para la interfaz (13 px base, 14 px lectura) · Iosevka para código</div></div><span className="mono">Iosevka</span></div>
  </>;
}
