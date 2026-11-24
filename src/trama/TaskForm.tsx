import { useState, type FormEvent } from 'react';
import { tasks as taskApi, type Task, type TaskEdit } from '../ipc';
import { EMPTY_TASK, MANUAL, PRIORITY, RISK, STATUS, TESTS } from './taskMeta';
import { Modal } from './ui';

/** Alta y edición de una tarea del proyecto (antes vivía en la vista Trabajo). */
export default function TaskForm({ project, task, all, onClose, onSaved }: {
  project: string;
  task: TaskEdit | null;
  all: Task[];
  onClose: () => void;
  onSaved: (id: number) => void;
}) {
  const [edit, setEdit] = useState<TaskEdit>(() => task ? { ...task } : { ...EMPTY_TASK });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const field = <K extends keyof TaskEdit>(key: K, value: TaskEdit[K]) => setEdit((draft) => ({ ...draft, [key]: value }));
  const others = all.filter((item) => item.id !== edit.id);

  const save = (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    taskApi.save(project, edit).then(onSaved, (e) => { setError(String(e)); setBusy(false); });
  };

  return (
    <Modal title={edit.id == null ? 'Nueva tarea' : `Editar tarea #${edit.id}`} onClose={onClose} wide>
      <form className="task-form2" onSubmit={save}>
        {error && <div className="flow-err" role="alert">{error}</div>}
        <label><span className="lab">Título</span><input className="in" value={edit.title} required autoFocus onChange={(e) => field('title', e.target.value)} /></label>
        <label><span className="lab">Objetivo</span><textarea className="in" rows={3} value={edit.goal} required onChange={(e) => field('goal', e.target.value)} /></label>
        <label><span className="lab">Criterios de aceptación</span><textarea className="in" rows={3} value={edit.criteria} required onChange={(e) => field('criteria', e.target.value)} /></label>
        <div className="tf-grid">
          <label><span className="lab">Prioridad</span><select className="in" value={edit.priority} onChange={(e) => field('priority', e.target.value)}>
            {Object.entries(PRIORITY).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select></label>
          <label><span className="lab">Riesgo</span><select className="in" value={edit.risk} onChange={(e) => field('risk', e.target.value)}>
            {Object.entries(RISK).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select></label>
          <label><span className="lab">Estado</span><select className="in" value={edit.status} onChange={(e) => field('status', e.target.value)}>
            {[...new Set([edit.status, ...MANUAL])].map((status) => <option key={status} value={status}>{STATUS[status]}</option>)}
          </select></label>
          {others.length > 0 && <label><span className="lab">Tarea padre</span><select className="in" value={edit.parentId ?? ''} onChange={(e) => field('parentId', e.target.value ? Number(e.target.value) : null)}>
            <option value="">ninguna</option>
            {others.map((item) => <option key={item.id} value={item.id}>#{item.id} {item.title}</option>)}
          </select></label>}
        </div>
        {others.length > 0 && (
          <fieldset className="tf-deps"><legend className="lab">Depende de</legend>
            {others.map((item) => (
              <label key={item.id}><input type="checkbox" checked={edit.dependencies.includes(item.id)} onChange={(e) =>
                field('dependencies', e.target.checked ? [...edit.dependencies, item.id] : edit.dependencies.filter((id) => id !== item.id))
              } /> #{item.id} {item.title}</label>
            ))}
          </fieldset>
        )}
        {edit.id != null && <div className="tf-grid">
          <label><span className="lab">Pruebas</span><select className="in" value={edit.tests ?? ''} onChange={(e) => field('tests', e.target.value || null)}>
            <option value="">desconocido</option>
            {Object.entries(TESTS).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select></label>
          <label className="span2"><span className="lab">Evidencia de pruebas, integración o aceptación</span>
            <textarea className="in" rows={2} value={edit.verification} onChange={(e) => field('verification', e.target.value)} />
          </label>
        </div>}
        <div className="acts">
          <button type="button" className="tr-btn" disabled={busy} onClick={onClose}>Cancelar</button>
          <button className="tr-btn pearl" disabled={busy}>{busy ? 'Guardando…' : 'Guardar'}</button>
        </div>
      </form>
    </Modal>
  );
}
