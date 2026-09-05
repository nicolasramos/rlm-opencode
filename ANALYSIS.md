# RLM — Análisis profundo y port a OpenCode (NRA-1069)

> Investigación del runtime RLM (Recursive Language Model) de Prime Agent y su
> port como plugin de OpenCode. Documento de análisis — el plugin funcional
> está en `plugin/rlm.ts` + `kernel/kernel.py`.

---

## 1. Qué es RLM (Prime Agent)

Prime Agent (PrimeIntellect-ai/prime-agent) está construido sobre un runtime de
**recursive language model**: el modelo trabaja dentro de un entorno de control
Python persistente (kernel IPython) y compone capacidades **como código**. El
host TypeScript mantiene las llamadas a providers, la persistencia de sesión,
los ciclos de vida de subagentes, el scheduling y la política de seguridad;
IPython es la superficie de programación que ve el modelo.

Fuentes primarias estudiadas (repo `PrimeIntellect-ai/prime-agent`, rama main):

- `packages/coding-agent/docs/rlm.md` — modelo de programación
- `packages/coding-agent/docs/rlm-runtime.md` — arquitectura del runtime
- `packages/coding-agent/docs/skills.md` — skills con respaldo Python
- `packages/coding-agent/docs/long-running-agents.md` — estado que sobrevive
- Código Python instalado localmente (`~/.prime/agent/kernel-venv/.../rlm/`):
  `__init__.py` (shim `rlm`, `host_request`, handles), `repl.py` (runtime
  stdio, 1166 líneas), `bash.py`, `harness.py`, `mcp_base.py`

### 1.1 Invariantes centrales

1. **Ejecución programática.** El runtime expone un único tool de modelo
   integrado, `ipython`. Leer/editar archivos, ejecutar comandos, transformar
   resultados, invocar skills y delegar arrancan desde ese kernel persistente.
   El estado de Python (variables, imports, funciones, resultados parseados,
   handles de tareas) sobrevive entre tool calls y compactaciones.

2. **Subagentes como llamadas RLM nativas.** El objeto `rlm` está precargado
   en el kernel; `handle = await rlm("...", name="...")` admite un hijo y
   devuelve un handle (`rlm_child_id`, `name`, `session_dir`, `model`) **sin
   esperar su respuesta**. Los resultados llegan solo vía `agent_message` o
   archivos. El registro de hijos del padre sobrevive a compactación, reinicio
   del kernel y restauración del padre.

3. **Skills con respaldo Python.** Formato Agent Skills (SKILL.md) extendido
   con paquetes Python que se instalan en el kernel y se exponen por nombre de
   importación; las skills Python pueden llamar a `rlm(...)` para delegación
   recursiva.

4. **Estado diseñado para durar más de un turno.** Compactación automática,
   workers daemon que mantienen sesiones activas tras desconectar el cliente,
   registros de hijos y artefactos de sesión recuperables, heartbeats y
   prompts programados, objetivos persistentes y modo autónomo con
   continuaciones acotadas.

### 1.2 Arquitectura del runtime (rlm-runtime.md)

```
AgentSession (TypeScript) ── ReplKernelManager ── REPL runtime (Python)
     │ owns                          │ stdio JSON-lines        │ rlm module
     │ child execution               │ execute/interrupt/      │ + skills
     │ persistence                   │ host_reply/snapshot     │ Python
     │ usage accounting              │ restore/list_names      │
```

- El kernel se crea **lazy** en el primer uso de `ipython`. Resolución de
  Python: `PRIME_AGENT_KERNEL_PYTHON` → `~/.prime/agent/kernel-venv/bin/python`
  (bootstrap con `uv`) → XDG data.
- Protocolo stdio: una línea JSON por objeto. Requests: `execute`, `interrupt`,
  `host_reply`, `snapshot`, `restore`, `list_names`, `shutdown`. Events:
  `ready`, `stdout`, `stderr`, `result`, `display`, `host_request`, `error`,
  `done`.
- `ReplKernelManager.execute()` está **serializado**: un kernel, un namespace,
  una celda a la vez. Los hijos RLM corren en paralelo porque cada delegación
  usa un host request y un runtime de hijo distinto.
- **Host Bridge**: las skills Python usan `rlm.host_request(type, payload)`
  para capacidades cuyo estado autoritativo vive fuera del kernel
  (credenciales, providers, transcripts, routing, scheduling). El host
  TypeScript valida y es dueño de la transición de estado.
- **Trust model**: el kernel ejecuta Python generado por el modelo con los
  permisos del SO del worker. Es un entorno de control duradero, NO un
  sandbox de seguridad.

### 1.3 Componentes clave (mapeo de código)

| Componente | Responsabilidad |
|---|---|
| `src/core/kernel/repl-manager.ts` | Proceso runtime, protocolo stdio, ejecución, dispatch host-request, interrupt, shutdown |
| `src/core/tools/ipython.ts` | Tool wrapper, provisioning lazy del kernel, bootstrap del namespace, shaping de salida |
| `src/core/agent-session.ts` | Política RLM, creación de hijos, registro, atribución de uso, cancelación, goal handlers |
| `src/core/rlm-runtime.ts` | Validación typed de `rlm.run`, discovery de modelos, list/delete |
| `prime-agent-runtime/src/rlm/` | Shim Python, tipos de handle, callable `rlm`, harness state |

### 1.4 Detalles de implementación verificados en el código local

- `rlm/__init__.py`: `host_request()` envía `{"type": request_type}` **al
  final** del payload para que un payload con clave `type` no pueda
  redirigir la petición. `_parse_host_reply` distingue `status: ok|error`.
- `rlm/repl.py`: celdas con `ast.PyCF_ALLOW_TOP_LEVEL_AWAIT`; la expresión
  final se compila aparte en modo eval. Captura de stdout/stderr con
  atribución por celda vía `contextvars` (las tareas asyncio heredan el id de
  la celda que las creó). Interrupt vía `signal.pthread_kill` al hilo main.
  Snapshot con `dill` (256MB máx, 16MB por variable).
- Profundidad de recursión por defecto: **2** (root → hijo → nieto).
- `RLMSpawnHandle` confirma solo la admisión; nunca contiene la respuesta.

---

## 2. Por qué portarlo a OpenCode

El objetivo de Nico: **no saturar al modelo LLM con texto**. En lugar de
re-leer archivos y re-enviar datos en cada turno, el modelo mantiene el estado
de trabajo en un kernel Python persistente y consulta solo lo que necesita.

OpenCode ya tiene `bash`, `read`, `write`, `edit`, `grep`, `glob`, `task`
(subagentes), `web`, etc. El valor añadido del RLM es:

1. **Kernel Python persistente** (`ipython`): estado entre tool calls.
2. **Subagentes con handle inmediato** (`rlm`): spawn en background, resultado
   después — el padre no bloquea ni infla su contexto.
3. **Snapshot/restore del kernel**: el estado sobrevive a compactación y a
   reinicios del servidor.
4. **Salida concisa por diseño**: caps de stdout y repr para que el modelo no
   reciba volcados gigantes.

## 3. Diseño del plugin

### 3.1 Arquitectura

```
OpenCode server (Bun)
  └─ plugin/rlm.ts  (Plugin)
       ├─ tool: ipython ──────► kernel/kernel.py (subproceso Python)
       │                          protocolo JSON-lines sobre stdio
       │                          namespace persistente, top-level await,
       │                          %%bash, %cd, snapshot/restore, interrupt
       ├─ tool: rlm ──────────► client.session.create + prompt fire-and-forget
       │                          → handle inmediato (rlm_child_id)
       ├─ tool: rlm_list / rlm_result / rlm_delete
       ├─ tool: rlm_snapshot / rlm_restore
       ├─ hook: experimental.session.compacting → snapshot + inyecta resumen
       ├─ hook: experimental.chat.system.transform → instrucciones RLM
       └─ hook: event (session.deleted → cleanup kernel)
```

Decisiones clave:

- **Kernel propio, sin dependencia de prime-agent.** `kernel/kernel.py` es un
  runtime REPL autocontenido (stdlib) que implementa el mismo protocolo
  JSON-lines. No requiere `prime-agent-runtime` instalado.
- **Un kernel por sesión OpenCode** (key = `sessionID`), lazy en el primer uso
  de `ipython`. Los hijos RLM tienen su propia sesión → su propio kernel,
  igual que en prime-agent (cada AgentSession tiene su kernel).
- **Subagente = sesión OpenCode hija** (`parentID`), no un proceso nuevo. El
  servidor OpenCode ya gestiona el loop del agente, providers, tools y
  persistencia — reutilizamos toda esa maquinaria.
- **`noReply: true` NO sirve** para spawn: añade el mensaje como contexto y la
  sesión hija nunca procesa. La llamada correcta es `session.prompt` sin
  `noReply`, **sin await** (fire-and-forget): el hijo procesa en background y
  el tool devuelve el handle al instante.
- **Caps de salida** (100KB stdout/celda, 4000 chars repr) — el objetivo
  "no saturar" es una propiedad del diseño, no un accidente.
- **Timeout por celda** (default 120s) vía SIGINT al hilo main del kernel +
  backstop JS de 300s.

### 3.2 Protocolo del kernel (kernel.py)

```
Request  {"id","type":"execute","code","timeout"} → result|error + done
         {"id","type":"interrupt"}                → error KeyboardInterrupt + done
         {"id","type":"snapshot","path"}          → result {ok,names,bytes} + done
         {"id","type":"restore","path"}           → result {ok,names} + done
         {"id","type":"list_names"}               → names [{name,type,repr}] + done
         {"id","type":"shutdown"}                 → done + exit 0
Events   ready | stdout | stderr | result | error | names | done
```

Magics: `%%bash` (subshell, captura salida), `%cd` (persistente). Top-level
await soportado. Snapshot: `dill` si está disponible, si no `pickle` con
filtro de objetos picklables; manifiesto JSON adjunto para el hook de
compactación.

### 3.3 Tools expuestos al modelo

| Tool | Descripción |
|---|---|
| `ipython` | Ejecuta Python en el kernel persistente. `code`, `timeout?` |
| `rlm` | Spawn de subagente. `prompt`, `name?`, `model?` → handle inmediato |
| `rlm_list` | Lista hijos de la sesión actual |
| `rlm_result` | Resultado de un hijo (`child` = id o nombre) → `{status, text}` |
| `rlm_delete` | Borra un hijo (cancela su sesión) |
| `rlm_snapshot` | Persiste el estado del kernel a disco |
| `rlm_restore` | Recupera el estado desde el último snapshot |

### 3.4 Hooks

- `experimental.session.compacting`: snapshot automático + inyección en el
  prompt de compactación de un resumen de variables del kernel (nombre, tipo,
  repr truncado) para que el agente nuevo sepa qué estado existe.
- `experimental.chat.system.transform`: instrucciones RLM en el system prompt
  (cómo usar el kernel, cuándo snapshot/restore, semántica de hijos).
- `event` (`session.deleted`): shutdown del kernel y limpieza del registro de
  hijos.
- `dispose`: shutdown de todos los kernels al cerrar el servidor.

---

## 4. Verificación (ejecución real)

### 4.1 Tests del kernel (20/20 PASS)

`tests/test_kernel.py` contra el protocolo stdio real: expresión final,
persistencia de estado, imports, captura stdout, errores, estado tras error,
top-level await, `%%bash`, `%cd` persistente, `list_names`, snapshot/restore,
timeout con interrupt, kernel vivo tras interrupt, caps de stdout y repr.

### 4.2 E2E en OpenCode (servidor real + SDK)

Modelo: `opencode-deepseek-v4-flash` vía LiteLLM (los providers cloud por
defecto estaban con límite de uso / token caducado; el modelo local LFM2.5-8B
es demasiado pequeño para tool-calling fiable).

1. **Persistencia del kernel** — dos llamadas `ipython` separadas:
   `secret_number = 12345` → `secret_number * 2` → **24690**. El estado
   sobrevivió entre tool calls.
2. **Subagente RLM** — `rlm` spawn `math-child` → handle inmediato
   (`ses_...`, `status: running`); `rlm_list` lo muestra; `rlm_result` →
   `{status: "completed", text: "42"}`. El hijo procesó en background.
3. **Snapshot/restore** — `primes = [2,3,5,7,11]` → `rlm_snapshot` →
   `del primes` → `rlm_restore` → `primes` → `[2, 3, 5, 7, 11]`.

### 4.3 Gotchas encontrados (importantes)

- **`noReply: true` no procesa la sesión hija** — el mensaje se añade como
  contexto y el hijo nunca corre. Fix: prompt sin `noReply`, sin await.
- **Node/undici no alcanza la LAN** desde el sandbox de tareas Multica
  (EHOSTUNREACH a .6/.8/.14/.22) aunque curl sí — para E2E hay que usar
  localhost o nube.
- **El modelo pequeño (LFM2.5-8B) planifica tool calls en texto** en vez de
  ejecutarlas — no es un bug del plugin; usar un modelo con tool-calling
  fiable para trabajo real.
- **Los hijos mueren con el servidor**: si el padre corre con `opencode run`
  (servidor efímero), el hijo no llega a procesar. En TUI o servidor
  persistente, los hijos sobreviven (equivalente a los daemon workers de
  prime-agent).
- **El terminal de Hermes enmascara secretos** (`***:...`) — al generar
  configs con claves hay que hacerlo programáticamente, no copiando la salida.

---

## 5. Instalación

```bash
# 1. Copiar el plugin
cp plugin/rlm.ts ~/.config/opencode/plugins/rlm.ts

# 2. Copiar el kernel
mkdir -p ~/.config/opencode/rlm-kernel
cp kernel/kernel.py ~/.config/opencode/rlm-kernel/kernel.py

# 3. Reiniciar OpenCode (los plugins se cargan al arrancar)
```

Variables de entorno opcionales:

- `RLM_KERNEL` — ruta alternativa a `kernel.py`
- `RLM_KERNEL_PYTHON` — intérprete Python (default: `python3` en PATH)

Estado: snapshots en `~/.config/opencode/rlm-state/<sessionID>/kernel-state.pkl`.

## 6. Limitaciones y siguiente paso (PI)

Limitaciones del port actual:

- El kernel captura stdout/stderr a nivel Python; escrituras C-level
  (extensiones) no se capturan (igual que en prime-agent, que usa pipes de fd).
- Un kernel por sesión, sin eviction LRU (v1). Con muchas sesiones abiertas,
  cada una tiene su proceso Python.
- El registro de hijos es en memoria del proceso servidor (sobrevive a
  compactación, no a reinicio del servidor).
- No hay skills Python-backed todavía (el formato Agent Skills de OpenCode
  cubre SKILL.md; el respaldo Python es el siguiente paso natural).

**PI (prime-agent)**: el port a PI es más directo de lo que parece — PI ya
tiene el runtime RLM completo. Lo que tendría sentido es el camino inverso:
un plugin de PI que exponga el kernel RLM como tools OpenAI-compatible para
OpenCode, o simplemente documentar que PI ya lo tiene nativo. Decisión
pendiente con Nico.

## 7. Referencias

- https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/rlm.md
- https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/rlm-runtime.md
- https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/skills.md
- https://opencode.ai/docs/plugins/ · https://opencode.ai/docs/custom-tools/ · https://opencode.ai/docs/sdk/
- Código local: `~/.prime/agent/kernel-venv/lib/python3.11/site-packages/rlm/`