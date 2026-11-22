import { useEffect, useRef, useState } from 'react';
import { git, type Workspace } from '../ipc';
import { Icon } from './icons';
import { Sigil } from './kit';

// Barra de título: proyecto y rama como dos botones separados, como en el
// Artifact. Cambiar de rama usa git_switch, que se niega si hay cambios que
// se perderían (el error se muestra tal cual).
export default function TitleSwitch({ ws, project, branch, onProject, onBranched, onManage, onBranchTools, onError }: {
  ws: Workspace;
  project: string | null;
  branch: { label: string; ahead: number; behind: number; upstream: string | null } | null;
  onProject: (path: string) => void;
  onBranched: () => void;
  onManage: () => void;
  onBranchTools: () => void;
  onError: (e: string) => void;
}) {
  const [menu, setMenu] = useState<'project' | 'branch' | null>(null);
  const [branches, setBranches] = useState<string[] | null>(null);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const current = ws.projects.find((p) => p.path === project);
  useEffect(() => {
    if (!menu) return;
    const out = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setMenu(null); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null); };
    document.addEventListener('pointerdown', out); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('pointerdown', out); document.removeEventListener('keydown', esc); };
  }, [menu]);
  useEffect(() => {
    setQ('');
    if (menu !== 'branch' || !project) return;
    let active = true;
    setBranches(null);
    void git.branches(project).then((list) => { if (active) setBranches(list); }, (error) => {
      if (active) { onError(String(error)); setBranches([]); }
    });
    return () => { active = false; };
  }, [menu, project, onError]);
  const projects = ws.projects.filter((p) => !p.archived && p.name.toLowerCase().includes(q.toLowerCase()));
  const groups = [...ws.groups.map((g) => ({ name: g.name, items: projects.filter((p) => p.groupId === g.id) })), { name: 'Sin grupo', items: projects.filter((p) => p.groupId == null || !ws.groups.some((g) => g.id === p.groupId)) }].filter((g) => g.items.length);
  const shown = (branches ?? []).filter((b) => b.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="tb-switch" ref={root}>
      <button className={`tb-proj${menu === 'project' ? ' is-on' : ''}`} onClick={() => setMenu(menu === 'project' ? null : 'project')} aria-haspopup="menu" aria-expanded={menu === 'project'} aria-label={current ? `Proyectos · ${current.name}` : 'Proyectos'} title="Cambiar de proyecto">
        {current ? <span className="tb-sig"><Sigil name={current.name} /></span> : <Icon name="folder" size={13} />}
        <span className="tb-name">{current?.name ?? 'Elige un proyecto'}</span>
        <Icon name="down" size={11} />
      </button>
      {current && <>
        <span className="tb-sep">/</span>
        <button className={`tb-branch${menu === 'branch' ? ' is-on' : ''}`} onClick={() => setMenu(menu === 'branch' ? null : 'branch')} aria-haspopup="menu" aria-expanded={menu === 'branch'} aria-label={`Rama del proyecto: ${branch?.label ?? 'Leyendo rama'}`} title="Cambiar de rama">
          <Icon name="branch" size={12} /><span className="mono">{branch?.label ?? '…'}</span>
          {branch?.upstream && <span className="tb-branch-sync" title={branch.upstream}>↑{branch.ahead} ↓{branch.behind}</span>}<Icon name="down" size={11} />
        </button>
      </>}
      {menu && (
        <div className={`tb-menu ${menu}`} role="menu">
          <input autoFocus className="tb-q" placeholder={menu === 'project' ? 'Buscar proyecto' : 'Buscar rama'} value={q} onChange={(e) => setQ(e.currentTarget.value)} aria-label={menu === 'project' ? 'Buscar proyecto' : 'Buscar rama'}
            onKeyDown={(e) => { if (e.key === 'Enter') { if (menu === 'project' && projects[0]) { onProject(projects[0].path); setMenu(null); } } }} />
          <div className="tb-list">
            {menu === 'project' ? groups.map((g) => (
              <div key={g.name}>
                {ws.groups.length > 0 && <div className="tb-group">{g.name}</div>}
                {g.items.map((p) => (
                  <button key={p.path} role="menuitem" className={p.path === project ? 'on' : ''} onClick={() => { onProject(p.path); setMenu(null); }}>
                    <span className="tb-sig"><Sigil name={p.name} /></span><span className="grow">{p.name}</span>{p.path === project && <Icon name="check" size={12} />}
                  </button>
                ))}
              </div>
            )) : branches === null ? <div className="tb-empty">Leyendo ramas…</div> : !shown.length ? <div className="tb-empty">Sin ramas que coincidan.</div> : shown.map((b) => (
              <button key={b} role="menuitem" disabled={busy} className={b === branch?.label ? 'on' : ''} onClick={async () => {
                if (!project || b === branch?.label) { setMenu(null); return; }
                setBusy(true);
                try { await git.switch(project, b); onBranched(); setMenu(null); } catch (e) { onError(String(e)); } finally { setBusy(false); }
              }}>
                <Icon name="branch" size={12} /><span className="grow mono">{b}</span>{b === branch?.label && <Icon name="check" size={12} />}
              </button>
            ))}
          </div>
          <div className="tb-foot"><button role="menuitem" onClick={() => {
            setMenu(null);
            if (menu === 'project') onManage(); else onBranchTools();
          }}>{menu === 'project' ? 'Gestionar proyectos' : 'Operaciones de rama'}</button></div>
        </div>
      )}
    </div>
  );
}
