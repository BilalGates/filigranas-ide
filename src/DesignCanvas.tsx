import { useEffect, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from 'react';
import { Icon } from './GitPanel';
import { CANVAS_ENGINES, canvasRuns, generateCanvas } from './designCanvasAgent';
import type { ChatEngine } from './ipc';
import { CANVAS_CONSTRAINT, loadCanvas, saveCanvas, starterFrames, type CanvasFrame, type CanvasPair, type CanvasRow } from './designCanvasModel';
import { shortcut } from './ui';
import './designCanvas.css';

type Props = { project: string; reference: CanvasFrame; archived: number; navigation: ReactNode; conversation: ReactNode };

export default function DesignCanvas({ project, reference, archived, navigation, conversation }: Props) {
  const [saved, setSaved] = useState(() => loadCanvas(project));
  const [selected, setSelected] = useState(1);
  const [rowId, setRowId] = useState<string | null>(null);
  const [zoom, setZoom] = useState<number | null>(null);
  const [fit, setFit] = useState(1);
  const [pan, setPan] = useState(false);
  const [run, setRun] = useState(() => canvasRuns.get(project));
  const [engine, setEngine] = useState<ChatEngine>(() => canvasRuns.get(project)?.engine ?? 'claude');
  const [showPrompt, setShowPrompt] = useState(false);
  const [request, setRequest] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const viewport = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const variants = saved ?? starterFrames(reference);
  const frames = [reference, ...variants];
  const frame = frames[selected];
  const groupIndex = frame.groups.findIndex((group) => group.rows.some((row) => row.id === rowId));
  const group = frame.groups[groupIndex];
  const rowIndex = group?.rows.findIndex((row) => row.id === rowId) ?? -1;
  const row = group?.rows[rowIndex];
  const frameWidth = frames.reduce((width, item) => width + item.width, 0) + 88;
  const frameHeight = Math.max(...frames.map((item) => item.height)) + 34;

  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const observer = new ResizeObserver(([{ contentRect }]) => {
      if (!contentRect.width || !contentRect.height) return;
      setFit(Math.max(0.55, Math.min(1, (contentRect.width - 44) / frameWidth, (contentRect.height - 86) / frameHeight)));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [frameWidth, frameHeight]);

  useEffect(() => {
    if (!run) return;
    let active = true;
    run.result.then((pair) => {
      if (!active) return;
      setSaved(pair);
      setSelected(1);
      setRowId(null);
      setNotice('Dos variantes generadas y guardadas.');
    }, (failure) => {
      if (active) setError(String(failure).replace(/^Error: /, ''));
    }).finally(() => {
      if (active) setRun(undefined);
    });
    return () => { active = false; };
  }, [run]);

  const select = (index: number, id: string | null = null) => {
    setSelected(index);
    setRowId(id);
  };

  const edit = (change: Partial<CanvasFrame>) => {
    if (!selected || run) return;
    const next: CanvasPair = [...variants];
    next[selected - 1] = { ...frame, ...change };
    try {
      saveCanvas(project, next);
      setSaved(next);
      setError('');
    } catch {
      setError('No se pudo guardar el cambio en este dispositivo.');
    }
  };

  const editRow = (change: Partial<CanvasRow>) => {
    edit({ groups: frame.groups.map((item, index) => index === groupIndex
      ? { ...item, rows: item.rows.map((entry) => entry.id === rowId ? { ...entry, ...change } : entry) }
      : item) });
  };

  const moveRow = (offset: number) => {
    const rows = [...group.rows];
    const [entry] = rows.splice(rowIndex, 1);
    rows.splice(rowIndex + offset, 0, entry);
    edit({ groups: frame.groups.map((item, index) => index === groupIndex ? { ...item, rows } : item) });
  };

  const moveRowToGroup = (target: number) => {
    if (!row || target === groupIndex) return;
    edit({ groups: frame.groups.map((item, index) => {
      if (index === target) return { ...item, rows: [...item.rows, row] };
      if (index === groupIndex) return { ...item, rows: item.rows.filter((entry) => entry.id !== row.id) };
      return item;
    }).filter((item) => item.rows.length) });
  };

  const startPan = (event: PointerEvent<HTMLDivElement>) => {
    if (!pan || event.button !== 0) return;
    event.preventDefault();
    const el = event.currentTarget;
    drag.current = { x: event.clientX, y: event.clientY, left: el.scrollLeft, top: el.scrollTop };
    el.setPointerCapture(event.pointerId);
  };

  const movePan = ({ currentTarget, clientX, clientY }: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    currentTarget.scrollLeft = drag.current.left + drag.current.x - clientX;
    currentTarget.scrollTop = drag.current.top + drag.current.y - clientY;
  };

  return <div className="design-board">
    <div className="design-board-tools">
      {navigation}
      <span className="design-board-document"><Icon name="sidebar" />Barra lateral</span>
      <span className="grow" />
      <div className="design-tool-group" role="group" aria-label="Herramientas del lienzo">
        <button type="button" className="co-btn" aria-pressed={!pan} onClick={() => setPan(false)}>Seleccionar</button>
        <button type="button" className="co-btn" aria-pressed={pan} onClick={() => setPan(true)}>Mover vista</button>
      </div>
      <button type="button" className="co-btn is-primary" disabled={!!run} aria-expanded={showPrompt}
        onClick={() => setShowPrompt(!showPrompt)}><Icon name="wand" />{run ? 'Generando…' : 'Generar variantes'}</button>
      {conversation}
    </div>
    {showPrompt && <form className="design-board-prompt task-form" onSubmit={(event) => {
      event.preventDefault();
      setError('');
      setNotice('');
      setShowPrompt(false);
      setRun(generateCanvas(project, reference, request.trim(), engine));
    }}>
      <label>Agente
        <select aria-label="Agente" value={engine} onChange={(event) => setEngine(event.target.value as ChatEngine)}>
          <option value="claude">{CANVAS_ENGINES.claude}</option>
          <option value="codex">{CANVAS_ENGINES.codex}</option>
        </select>
      </label>
      <label>Indicaciones para las variantes
        <textarea value={request} maxLength={600} placeholder="Por ejemplo, destaca el proyecto activo y compacta la lista."
          onChange={(event) => setRequest(event.target.value)} />
      </label>
      <p>{CANVAS_ENGINES[engine]} recibe los nombres visibles de proyectos y sesiones. Las variantes nuevas sustituirán las dos del lienzo.</p>
      <div className="design-tool-group">
        <button className="co-btn is-primary" type="submit">Enviar a {CANVAS_ENGINES[engine]}</button>
        <button className="co-btn" type="button" onClick={() => setShowPrompt(false)}>Cancelar</button>
      </div>
    </form>}
    {(run || notice || error) && <p className={error ? 'co-error design-board-status' : 'design-board-status'} role={error ? 'alert' : 'status'}>
      {error || (run ? `${CANVAS_ENGINES[run.engine]} está generando dos variantes editables.` : notice)}
    </p>}
    <div className="design-board-body">
      <div className="design-board-stage">
        <div ref={viewport} className={`design-board-viewport${pan ? ' is-panning' : ''}`} tabIndex={0}
          aria-label="Lienzo de variantes de la barra lateral" onPointerDownCapture={startPan} onPointerMove={movePan}
          onLostPointerCapture={() => { drag.current = null; }}>
          <div className="design-board-frames" style={{ zoom: zoom ?? fit }}>
            {frames.map((item, index) => <SidebarFrame key={index} frame={item} index={index} archived={archived}
              selected={index === selected} rowId={rowId} onSelect={(id) => select(index, id)} />)}
          </div>
        </div>
        <div className="design-board-zoom" role="group" aria-label="Zoom">
          <button type="button" className="co-btn" aria-label="Alejar" disabled={(zoom ?? fit) <= 0.45}
            onClick={() => setZoom(Math.max(0.45, (zoom ?? fit) - 0.1))}>−</button>
          <button type="button" className="co-btn" title="Ajustar el lienzo" aria-label="Ajustar el lienzo" onClick={() => setZoom(null)}>
            {Math.round((zoom ?? fit) * 100)} %
          </button>
          <button type="button" className="co-btn" aria-label="Acercar" disabled={(zoom ?? fit) >= 1.5}
            onClick={() => setZoom(Math.min(1.5, (zoom ?? fit) + 0.1))}>+</button>
        </div>
      </div>
      <aside className="design-board-inspector task-form" aria-label="Propiedades">
        <h3>Propiedades</h3>
        <label>Marco
          <select value={selected} onChange={(event) => select(Number(event.target.value))}>
            {frames.map((item, index) => <option key={index} value={index}>{frameName(item, index)}</option>)}
          </select>
        </label>
        {selected === 0 ? <p>Referencia de la barra lateral del espacio de trabajo.</p> : <fieldset disabled={!!run}>
          <label>Nombre<input value={frame.title} maxLength={64} onChange={(event) => edit({ title: event.target.value })} /></label>
          <div className="design-frame-dimensions">
            <Dimension label="Ancho" value={frame.width} minimum={200} maximum={340} onChange={(width) => edit({ width })} />
            <Dimension label="Alto" value={frame.height} minimum={360} maximum={840} onChange={(height) => edit({ height })} />
          </div>
          <label>Altura de fila
            <input type="range" min={20} max={34} value={frame.spacing} onChange={(event) => edit({ spacing: event.target.valueAsNumber })} />
          </label>
          {row && <div className="design-row-properties">
            <label>Sección<input value={group.title} maxLength={64} onChange={(event) => {
              edit({ groups: frame.groups.map((item, index) => index === groupIndex ? { ...item, title: event.target.value } : item) });
            }} /></label>
            <label>Texto de la fila<input value={row.label} maxLength={120} onChange={(event) => editRow({ label: event.target.value })} /></label>
            {frame.groups.length > 1 && <label>Mover a sección
              <select value={groupIndex} onChange={(event) => moveRowToGroup(Number(event.target.value))}>
                {frame.groups.map((item, index) => <option key={index} value={index}>{item.title || 'Sin título'}</option>)}
              </select>
            </label>}
            <label>Sangría
              <select value={row.indent} onChange={(event) => editRow({ indent: Number(event.target.value) })}>
                <option value={0}>Ninguna</option><option value={1}>Un nivel</option><option value={2}>Dos niveles</option>
              </select>
            </label>
            <div className="design-tool-group" aria-label="Orden de la fila">
              <button className="co-btn" type="button" disabled={rowIndex === 0} onClick={() => moveRow(-1)}>Subir</button>
              <button className="co-btn" type="button" disabled={rowIndex === group.rows.length - 1} onClick={() => moveRow(1)}>Bajar</button>
            </div>
          </div>}
        </fieldset>}
        <h4>Restricciones</h4>
        <p><Icon name="design" />{CANVAS_CONSTRAINT}</p>
      </aside>
    </div>
  </div>;
}

function frameName(frame: CanvasFrame, index: number) {
  return index === 0 ? 'Actual' : `${index === 1 ? 'A' : 'B'} · ${frame.title.trim() || 'Sin nombre'}`;
}

function Dimension({ label, value, minimum, maximum, onChange }: {
  label: string; value: number; minimum: number; maximum: number; onChange: (value: number) => void;
}) {
  return <label>{label}
    <input key={value} type="number" min={minimum} max={maximum} defaultValue={value}
      onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }}
      onBlur={(event) => {
        const proposed = event.currentTarget.valueAsNumber;
        const bounded = Number.isFinite(proposed) ? Math.max(minimum, Math.min(maximum, Math.round(proposed))) : value;
        event.currentTarget.value = String(bounded);
        if (bounded !== value) onChange(bounded);
      }} />
  </label>;
}

function SidebarFrame({ frame, index, archived, selected, rowId, onSelect }: {
  frame: CanvasFrame; index: number; archived: number; selected: boolean; rowId: string | null; onSelect: (id: string | null) => void;
}) {
  return <article className="design-frame" style={{ width: frame.width, '--design-row-height': `${frame.spacing}px` } as CSSProperties}>
    <button type="button" className="design-frame-title" aria-pressed={selected} onClick={() => onSelect(null)}>{frameName(frame, index)}</button>
    <div className={`design-frame-card${selected ? ' is-selected' : ''}`} style={{ height: frame.height }}>
      {selected && <span className="design-frame-handles" aria-hidden="true"><i /><i /><i /><i /></span>}
      <div className="design-frame-chrome" aria-hidden="true"><span /><span /><span /><Icon name="sidebar" size={14} /></div>
      <div className="design-frame-new" aria-hidden="true"><Icon name="plus" />Nueva sesión <kbd>{shortcut('⌘').replace('+', '')} T</kbd></div>
      {index === 0 && <div className="design-frame-search">Proyectos<span><Icon name="search" size={11} />buscar</span></div>}
      <div className="design-frame-scroll">
        {frame.groups.map((group, groupIndex) => <section key={groupIndex}
          className={`design-frame-group${index !== 0 && group.rows.some((entry) => entry.kind === 'folder' && entry.active) &&
            group.rows.some((entry) => entry.indent > 0) ? ' is-current-project' : ''}`}>
          {group.title && <h4>{group.title}</h4>}
          {group.rows.map((row) => {
            const content = <>
              {row.kind === 'session' ? <span className="design-frame-dot" /> : <Icon name={row.kind} size={13} />}
              <span className="design-frame-row-label">{row.label || 'Sin texto'}</span>
            </>;
            const className = `design-frame-row${row.active ? ' is-active' : ''}${selected && row.id === rowId ? ' is-selected' : ''}`;
            const style = { '--design-indent': `${row.indent * 12}px`, marginInlineStart: 'var(--design-indent)' } as CSSProperties;
            return index === 0
              ? <div key={row.id} className={className} style={style} title={row.label}>{content}</div>
              : <button key={row.id} type="button" className={className} style={style} title={row.label} aria-pressed={selected && row.id === rowId}
                onClick={() => onSelect(row.id)}>{content}</button>;
          })}
        </section>)}
      </div>
      <div className="design-frame-footer"><Icon name="box" size={13} /><span>Archivados</span><span>{archived}</span></div>
    </div>
  </article>;
}
