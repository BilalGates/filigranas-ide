# Coordinador Codex

**Decisión (2026-11-16):** Codex es el motor coordinador principal de la primera versión y también puede ejecutar tareas. Si se agota su cuota, otro motor disponible puede asumir temporalmente la coordinación mediante un relevo. Hansi Flick, Pep Guardiola, Luis Enrique y Johan Cruyff son perfiles de instrucciones del coordinador activo. Claude Code, OpenCode, Antigravity y Devin siguen disponibles como agentes ejecutores.

**Alcance actual de V1.** Los relevos se aplican a sesiones ejecutoras. El coordinador conserva su hilo Codex y puede delegar con `delegar`, `estado_sesiones` y `esperar_sesion`. Esta política también describe objetivos de producto como el relevo del propio coordinador y la validación de dependencias entre tareas, pendientes de implementación. Véase el [inventario verificado](aceptacion-v1.md).

La app incorpora las [reglas de trabajo](../src-tauri/resources/reglas.md) y un [catálogo de skills](../src-tauri/resources/skills) para el coordinador y Claude. Se puede citar una skill como `$debug`. Abre su guía solo para el encargo pertinente y aplica las instrucciones propias del proyecto dentro de los permisos del entorno.

El coordinador recibe el objetivo y las instrucciones del proyecto, clasifica la tarea, propone una división con dependencias cuando corresponde, elige agentes disponibles y explica la elección. La aplicación valida el plan, controla cuotas observables, aísla los cambios en worktrees y conserva el contexto de cada relevo. No hay router Jev ni modelo local en la primera versión.

## Política de razonamiento y asignación

El objetivo del enrutamiento es gastar los tokens necesarios para mantener un desarrollo de calidad y continuo, sin repetir lecturas, planes o trabajo ya hecho. Codex coordina con esfuerzo medio por defecto. Usa esfuerzo bajo para una consulta o cambio trivial, alto para planificar una tarea con varias dependencias y máximo solo para arquitectura, seguridad, concurrencia, datos o decisiones difíciles de revertir. Antes de delegar comprueba las capacidades y la cuota observables del agente; el identificador concreto del modelo se resuelve en tiempo de ejecución a partir de la configuración de Filigranas y de los modelos disponibles. Una consulta breve que Codex puede resolver en la sesión actual no abre otro agente.

| Trabajo | Agente preferido | Nivel solicitado |
| --- | --- | --- |
| Buscar, localizar o cambio trivial | Codex en la sesión coordinadora | Bajo o medio |
| Edición acotada o bug con causa clara | OpenCode con modelo gratuito disponible, o Codex si aporta mejor resultado con menos coste total | Medio |
| Implementación compleja o refactor importante | Claude Code o Codex, según la tarea y la cuota | Alto; máximo para arquitectura o datos |
| Trabajo largo y autónomo en un repositorio | Devin | Objetivo y pruebas explícitos; nivel solo si su adaptador lo admite |
| Diseño visual o perspectiva alternativa | Antigravity con Gemini | Alto |
| Revisión crítica | Codex o Claude Code, distinto del autor | Alto; máximo para seguridad |
| Propuesta de commits con Larry | Codex, con revisión del usuario antes de crear commits | Medio |

Esta tabla es una preferencia, no una asignación obligatoria: el coordinador elige Codex para ejecutar cuando sea la mejor opción y explica cualquier elección por calidad esperada, disponibilidad, cuota, contexto y coste total de la tarea. No delega solo para ahorrar tokens si la lectura del contexto y la revisión del resultado costarán más, ni repite una tarea ya verificada. Si un agente falla o agota su cuota, conserva su worktree y prepara un relevo verificable. No usa los modelos de pago de OpenCode Zen como opción gratuita.

### Continuidad cuando Codex agota la cuota

Solo hay un coordinador activo por proyecto. Cuando Codex informa un límite, el IDE pausa su sesión y conserva el encargo padre, el plan, el estado de subtareas, los worktrees, las decisiones, los diffs y las pruebas. Ofrece continuar con Claude Code como primer relevo de coordinación si está disponible; si no, elige otro agente con capacidad comprobada para coordinar y muestra el motivo. El nuevo coordinador recibe un resumen verificable y el mismo perfil de instrucciones, sin suponer que puede abrir la sesión privada de Codex. La tarea ejecutora que estaba en curso puede continuar con otro motor en su mismo worktree. La UI muestra el cambio de motor y la cuota conocida; no presenta estimaciones como saldo confirmado. Cuando vuelva la cuota de Codex, puede retomarse mediante otro relevo. No se crean dos coordinadores simultáneos para el mismo proyecto.

## Un prompt con varias tareas

1. Codex registra un encargo padre y extrae objetivos, criterios de terminado, repositorios y restricciones de cada tarea. Mantiene juntas las acciones que forman una sola unidad funcional; no divide por dividir.
2. Expone al usuario un plan breve con subtareas, orden, dependencias, agente y esfuerzo. Marca las tareas que pueden avanzar a la vez y las que compiten por los mismos archivos o decisiones.
3. El IDE valida que los identificadores sean únicos, que todas las dependencias existan y que no haya ciclos. Crea una rama y un worktree aislado por tarea que escriba. Las tareas de solo lectura pueden compartir el repositorio sin editarlo.
4. Ejecuta en paralelo únicamente las tareas independientes. Las que dependen de otras esperan resultados comprobados; si dos cambios afectan a los mismos archivos o contratos, los ordena o los integra antes de continuar.
5. Codex sigue el estado del encargo padre, recoge resultados y pruebas, pide revisión independiente cuando corresponda y presenta los cambios para integración guiada. Un fallo detiene solo la rama afectada y deja visibles los pasos pendientes.
6. Larry propone commits locales por unidad funcional. Push, apertura de PR e integración siguen las acciones explícitas previstas en el plan del IDE.

El coordinador no trata la salida textual de un agente como prueba de que una tarea terminó: contrasta diff, comandos y resultados de pruebas con los criterios de terminado.

## Prompt de preparación solicitado para Codex

Se entrega una sola vez al preparar el entorno del coordinador, no en cada turno de cada proyecto. Codex es «another agent» en este texto, por lo que corresponde únicamente el método `npx`; no se ejecuta el método de Claude Code.

> Install the TypeSafe skill. If you're in Claude Code, run `claude plugin marketplace add typesafe-ai/skills`, then `claude plugin install typesafe@typesafe-ai`. If you're in another agent, run `npx skills add typesafe-ai/skills --skill typesafe-ai` and select your agent. Use one installation method. You can read the skill directly at https://github.com/typesafe-ai/skills/blob/main/skills/typesafe-ai/SKILL.md (raw: https://raw.githubusercontent.com/typesafe-ai/skills/main/skills/typesafe-ai/SKILL.md). Then use the TypeSafe skill when working on this project.

La skill documenta patrones para integrar la API de TypeSafe. Su uso en este proyecto se limita a consultar esos patrones cuando sean pertinentes. La aplicación no configura credenciales de TypeSafe ni llama a Jev sin una decisión posterior del usuario. La instalación tampoco debe escribir archivos en repositorios de proyectos abiertos por el IDE.
