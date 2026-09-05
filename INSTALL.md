# Guía de instalación — plugin RLM para OpenCode

Guía paso a paso para instalar y usar el plugin RLM (kernel Python persistente
+ subagentes) en OpenCode.

## Requisitos

| Requisito | Versión mínima | Notas |
|---|---|---|
| OpenCode | 1.18+ | El plugin usa la API de plugins con hook `tool` |
| Python | 3.9+ (recomendado 3.11+) | Solo stdlib; `dill` opcional para snapshots más ricos |
| macOS / Linux | — | Probado en macOS; Windows no verificado |

## Instalación (2 minutos)

### Opción A — script (recomendada)

```bash
# Desde el repo clonado
./install.sh
```

### Opción B — manual

```bash
# 1. Copiar el plugin a la carpeta global de plugins de OpenCode
cp plugin/rlm.ts ~/.config/opencode/plugins/rlm.ts

# 2. Copiar el kernel Python
mkdir -p ~/.config/opencode/rlm-kernel
cp kernel/kernel.py ~/.config/opencode/rlm-kernel/kernel.py

# 3. Reiniciar OpenCode (los plugins se cargan al arrancar)
```

### Verificar que está instalado

1. Abre OpenCode en cualquier proyecto.
2. Escribe `/help` o mira la lista de tools disponibles — deben aparecer:
   `ipython`, `rlm`, `rlm_list`, `rlm_result`, `rlm_delete`, `rlm_snapshot`,
   `rlm_restore`, `rlm_store`, `rlm_get`, `rlm_search`, `rlm_find`,
   `rlm_stats`, `rlm_forget`.
3. Prueba rápida: pídele al modelo *"usa ipython para calcular 6*7"* — debe
   responder 42.

## ¿Funciona por defecto?

**Sí.** Al copiar `rlm.ts` a `~/.config/opencode/plugins/`, OpenCode lo carga
automáticamente en cada arranque:

- Las 7 tools quedan registradas para todas las sesiones y agentes.
- El plugin inyecta instrucciones RLM en el system prompt, así que el modelo
  sabe que existe el kernel persistente y cómo usarlo.
- No hay que tocar `opencode.json` ni configurar nada más.

Único matiz: el modelo **elige** cuándo usar las tools (igual que con `bash` o
`read`). Las instrucciones del system prompt hacen que las use cuando toca,
pero no se fuerzan.

## Configuración opcional

Variables de entorno:

```bash
# Ruta alternativa al kernel (por defecto: ~/.config/opencode/rlm-kernel/kernel.py)
export RLM_KERNEL=/ruta/a/kernel.py

# Intérprete Python (por defecto: python3 en PATH)
export RLM_KERNEL_PYTHON=/opt/homebrew/bin/python3.11
```

Los snapshots del kernel se guardan en
`~/.config/opencode/rlm-state/<sessionID>/kernel-state.pkl`.

## Uso

### Kernel Python persistente (`ipython`)

El estado (variables, imports, funciones) **sobrevive entre llamadas**:

```
⚙ ipython {"code": "primes = [2, 3, 5, 7, 11]"}
⚙ ipython {"code": "primes[-1] * 2"}
→ 22
```

- `%%bash` — ejecuta un comando shell en subshell.
- `%cd <dir>` — cambia el directorio de trabajo del kernel (persistente).
- Top-level `await` soportado.
- La salida está capada (100KB stdout, 4000 chars repr) a propósito: consulta
  valores concretos con celdas pequeñas en vez de volcar datos al contexto.

### Subagentes (`rlm`)

```
⚙ rlm {"prompt": "Revisa el flujo de autenticación", "name": "auth-reviewer"}
→ {"rlm_child_id": "ses_...", "name": "auth-reviewer", "status": "running"}

⚙ rlm_result {"child": "auth-reviewer"}
→ {"status": "completed", "text": "..."}
```

- `rlm` devuelve el handle **inmediatamente**; el hijo procesa en background.
- `rlm_list` — lista los hijos de la sesión actual.
- `rlm_delete` — borra un hijo.
- Profundidad de recursión limitada a 2 (root → hijo → nieto).

### Persistencia entre turnos

- `rlm_snapshot` — guarda el estado del kernel a disco.
- `rlm_restore` — lo recupera (útil tras una compactación o reinicio).
- La compactación de OpenCode hace snapshot automático e inyecta un resumen
  de variables en el prompt de compactación.

### Lago de contexto (datos que nunca entran en el prompt)

- `rlm_store` — guarda datos grandes en el lago persistente del proyecto.
- `rlm_get` / `rlm_search` / `rlm_find` — recupera por clave, regex o texto
  (solo snippets).
- `rlm_stats` / `rlm_forget` — estadísticas y limpieza.
- Salidas de tools >10KB se capturan automáticamente en el lago
  (`auto:<tool>:<hash>`).

## Solución de problemas

| Problema | Causa / solución |
|---|---|
| Las tools no aparecen | OpenCode no se ha reiniciado tras copiar el plugin. Reinícialo. |
| `RLM kernel failed to start` | Python no está en PATH o `RLM_KERNEL_PYTHON` apunta a un intérprete roto. Prueba `export RLM_KERNEL_PYTHON=/opt/homebrew/bin/python3.11`. |
| El modelo no usa `ipython` | Modelo con tool-calling débil (p. ej. LFM2.5-8B). Usa un modelo con tool-calling fiable (deepseek, glm, kimi, qwen…). |
| `rlm_result` dice "running" siempre | El hijo murió con un servidor efímero (`opencode run`). En TUI o servidor persistente los hijos sobreviven. |
| El kernel no responde | Timeout por celda (120s por defecto) — el kernel interrumpe la celda con SIGINT. |

## Seguridad

El kernel ejecuta Python generado por el modelo con los permisos de tu
usuario. Es un entorno de control duradero, **no un sandbox de seguridad**
(mismo modelo de confianza que prime-agent). Para repositorios no confiables,
usa un sandbox externo.

## Tests

```bash
python3 tests/test_kernel.py    # 20/20 tests del protocolo del kernel
```