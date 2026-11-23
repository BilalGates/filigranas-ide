import type { TaskEdit } from '../ipc';

/** Nombres de estado, prioridad, riesgo y pruebas de las tareas del núcleo. */
export const STATUS: Record<string, string> = {
  backlog: 'pendiente', ready: 'lista', running: 'en marcha', waiting_approval: 'espera permiso',
  verifying: 'verificación', review: 'revisión', ready_to_merge: 'lista para integrar', done: 'completada',
  blocked: 'bloqueada', paused_quota: 'pausada por cuota', failed: 'fallida', cancelled: 'cancelada',
};
/** Estados que el usuario puede fijar a mano; los demás los pone el núcleo. */
export const MANUAL = ['backlog', 'ready', 'blocked', 'verifying', 'review', 'ready_to_merge', 'done', 'failed', 'cancelled'];
export const PRIORITY = { urgent: 'urgente', high: 'alta', normal: 'normal', low: 'baja' };
export const RISK = { low: 'bajo', normal: 'normal', high: 'alto', critical: 'crítico' };
export const TESTS = { passed: 'correctas', failed: 'fallidas', not_applicable: 'no aplican' };
export const EMPTY_TASK: TaskEdit = {
  id: null, parentId: null, title: '', goal: '', criteria: '', priority: 'normal', risk: 'normal',
  status: 'backlog', verification: '', tests: null, dependencies: [],
};
