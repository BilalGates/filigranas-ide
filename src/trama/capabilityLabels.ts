import type { CapabilityPolicy, CapabilityUsage, SkillRole } from '../ipc';

export const ROLE_NAMES: Record<SkillRole, string> = {
  pm: 'PM', researcher: 'Investigador', architect: 'Arquitecto', designer: 'Diseñador UI/UX', graphic: 'Diseñador gráfico',
  senior: 'Senior', junior: 'Junior', security: 'Seguridad', auditor: 'Calidad', auditor2: 'Revisor independiente',
  verifier: 'Verificador', data: 'Datos',
};
export const ROLE_ORDER: SkillRole[] = ['pm', 'researcher', 'architect', 'designer', 'graphic', 'senior', 'junior', 'security', 'auditor', 'auditor2', 'verifier', 'data'];

export const POLICY_NAMES: Record<CapabilityPolicy, string> = {
  mandatory: 'Obligatoria', automatic: 'Automática', manual: 'Manual', disabled: 'Desactivada',
};
export const POLICY_SHORT: Record<CapabilityPolicy, string> = { mandatory: 'Obl', automatic: 'Aut', manual: 'Man', disabled: '—' };

export const KIND_NAMES: Record<string, string> = {
  implementacion: 'Implementación', correccion: 'Corrección', refactorizacion: 'Refactorización', revision: 'Revisión',
  threat_model: 'Modelado de amenazas', arquitectura: 'Arquitectura', planificacion: 'Planificación compleja',
  revision_independiente: 'Revisión independiente', diseno: 'Diseño inicial', frontend: 'Implementación frontend',
  auditoria_visual: 'Auditoría visual', logo: 'Logotipo', efectos: 'Efectos gráficos', investigacion: 'Investigación',
  config_repo: 'Configuración del repositorio', estadistica: 'Estadística', verificacion: 'Verificación',
};

export const ORIGIN_NAMES: Record<string, string> = {
  politica: 'obligatoria por política', automatica: 'asignada automáticamente', usuario: 'solicitada por el usuario',
  pm: 'solicitada por el PM', 'sesión padre': 'solicitada por la sesión padre',
};

export const STATE_NAMES: Record<CapabilityUsage['state'], string> = {
  selected: 'Seleccionada', blocked: 'Bloqueada', skipped: 'Descartada', failed: 'Error de carga',
  loaded: 'Cargada', evidenced: 'Aplicación evidenciada', verified: 'Verificada',
};
export const STATE_TONE: Record<CapabilityUsage['state'], string> = {
  selected: '', blocked: 'coral', skipped: 'dash', failed: 'coral', loaded: 'sky', evidenced: 'amber', verified: 'mint',
};

export const PROVIDER_NAMES: Record<string, string> = { claude: 'Claude', codex: 'Codex', agy: 'Antigravity' };
export const COMPAT_NAMES: Record<string, string> = { direct: 'directa', adapted: 'adaptada', partial: 'parcial', none: 'incompatible' };

export const EXT_KIND_NAMES: Record<string, string> = {
  skill: 'Skill', plugin: 'Plugin', mcp: 'MCP', tool: 'Herramienta', hook: 'Hook', flow: 'Flujo', resources: 'Recursos',
};

export const shortSha = (sha: string | null | undefined) => (sha ?? '').slice(0, 7);
