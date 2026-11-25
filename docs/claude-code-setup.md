# Claude Code en SportMaps — `.claude/` y qué se tomó de los repos de Anthropic

Revisión del 2026-11-25 de los repos públicos de Anthropic que circularon como «las configuraciones que
usa el propio equipo». Se leyeron completos, sin ejecutar nada, y se adaptó **solo lo que sirve aquí**.
Ningún plugin se instaló: se copiaron patrones, no código con hooks o servidores de terceros.

## Qué quedó en el repo

| Archivo | Qué hace |
|---|---|
| `.claude/settings.json` | Permite sin preguntar los comandos de solo lectura del repo; **niega** leer `.env*` y los comandos prohibidos por `CLAUDE.md`. Registra la guardia |
| `.claude/hooks/guardia.mjs` | **Bloquea** antes de ejecutar: `vercel` deploy/link/--prod (también con `npx` o tras `cd`), `supabase db push/reset/execute`, `migration repair/up`, push a `main`/`stg`, `--force`, `--no-verify`, y editar o borrar migraciones **ya commiteadas** (por Edit/Write o por `rm/mv/sed -i/>>`). Después de editar `frontend/src` corre la compuerta V2 y avisa si algo empeoró |
| `.claude/hooks/guardia.test.mjs` | `node --test .claude/hooks/guardia.test.mjs` |
| `.claude/skills/nueva-migracion` | Orden de trabajo + lista de chequeo del SQL (search_path, GRANT, policies envueltas, alcance) |
| `.claude/skills/cerrar-rls` | Las cinco trampas, medir el radio antes de aplicar, invariantes después |
| `.claude/skills/qa-v2` | Compuerta V2, tests, `qa-responsive`, reglas a mano, carga local |
| `.claude/agents/revisor-rls` | Revisor independiente de migraciones (solo lectura: Read, Grep, Glob) |

`.claude/settings.local.json` sigue fuera de git: ahí va lo personal de cada uno.

**Por qué en Node y no en Python** como el ejemplo de Anthropic: hay gente trabajando en Windows
(`start-*.ps1`) y Node ya es requisito del repo.

**Límites honestos:** las reglas de Bash son expresiones regulares; un comando suficientemente torcido
puede esquivarlas; además, lo que va entre comillas o en un heredoc se ignora a propósito (si no, un
`git commit -m "…vercel deploy…"` se bloqueaba por el mensaje), así que `bash -c "vercel deploy"` pasa. Son una red, no un muro: el muro sigue siendo el pre-commit (`migrations:check`,
`tsc`, `eslint`) y CI. Si la guardia misma falla (JSON roto, sin git), deja pasar.

## Los repos, uno por uno

| Repo | Qué es en realidad | Veredicto |
|---|---|---|
| `anthropics/claude-code-playground` | Casi todo son README «Coming soon». Lo real: tres *mods*; uno útil (`blast-radius`, pide confirmar comandos destructivos y migraciones de Prisma/Django, **no** detecta `supabase db push`) | No es «la config del equipo». Se tomó la idea de `blast-radius`, cubierta por la guardia |
| `anthropics/claude-code` (`examples/`) | Ejemplos reales de settings (`settings-strict`, `-hipaa`) y del hook `bash_command_validator_example.py` (exit 2 = bloquear) | **Base de la guardia** |
| `anthropics/skills` | Formato de skills (`name` + `description`; `scripts/`, `references/`, `assets/`). Skills: docx, pdf, pptx, xlsx, webapp-testing, frontend-design, mcp-builder, skill-creator… | Formato adoptado. docx/pdf/pptx/xlsx ya están disponibles. Para más adelante: `webapp-testing` |
| `anthropics/claude-plugins-official` | Catálogo: `hookify`, `pr-review-toolkit`, `code-review`, `security-guidance`, `claude-code-setup`… y `external_plugins/` de terceros | Útiles para instalar a mano si se quiere: `pr-review-toolkit`. **No instalar** `security-guidance` (instala paquetes de Python desde internet al arrancar cada sesión) ni los `external_plugins` sin leerlos (descargan código con `npx …@latest`, `uvx git+…`) |
| `anthropics/knowledge-work-plugins` | Plugins por área (ventas, soporte, finanzas, legal, marketing, `small-business`) hechos de skills, con conectores a CRMs y contabilidad (HubSpot, QuickBooks, Stripe…) | `small-business` es el que mejor encaja (cobranza, cierre de mes, flujo de caja, respuesta rápida a prospectos), pero sus conectores no incluyen Wompi ni MercadoPago. Útil para el trabajo comercial, no para el repo |
| `anthropics/launch-your-agent` | Una skill que entrevista, crea un agente en **Claude Managed Agents** (beta) y lo programa con cron. Por defecto: herramientas `always_allow`, red sin restricción, sin tope de gasto; datos guardados en Anthropic (no ZDR) | Interesante para una auditoría nocturna **de solo lectura** (pagos vs. comprobantes, Disk IO). Solo con: rol de Postgres de solo lectura con `statement_timeout`, red limitada, presupuesto, y vistas/RPC agregadas (nada de N+1). **Nunca** con la `service_role` |
| `anthropics/claude-quickstarts` | Bot de soporte (RAG en Bedrock, salida JSON con `redirect_to_agent` + motivo), analista financiero (una herramienta de gráficas), `managed-agents/daily-brief` (cron que falla seguro) | Ideas para Mapi y un asistente de cartera. Algunos demos traen modelos viejos (`claude-3-5-sonnet`, `claude-sonnet-4-5`) y aceptan el modelo desde el cliente: no copiar eso |
| `anthropics/prompt-eng-interactive-tutorial` | El curso oficial de prompts | Ver «Mapi» abajo |

## Mapi: lo que el tutorial sugiere y el prompt aún no hace

El prompt vive en `bff/src/services/whatsapp-bot.service.ts` (~línea 6444). Ya hace bien: rol claro,
reglas con su porqué, «nunca inventes» con salida explícita («eso no lo tengo a la mano»), y trata el
texto del usuario como dato. Le falta (capítulos del tutorial):

1. **Separar datos de reglas con etiquetas XML** (cap. 4): precios, promo y resultados de herramientas
   dentro de `<precios_escuela>`, `<promo>`… y la regla «solo cifras que estén dentro de esas etiquetas».
2. **Ejemplos** (cap. 7): 3–5 conversaciones en `<ejemplo>` fijan el «tú», el formato de WhatsApp y un
   mensaje por turno mejor que una lista de reglas.
3. **Citar antes de responder montos** (cap. 6/8): un paso oculto que extrae la cifra de la fuente
   antes de escribirla.
4. **Salida estructurada** (cap. 5): un objeto con un solo campo `mensaje` asegura un mensaje por turno.

Es un cambio de comportamiento del bot de ventas: va con sus evals (`npm run mapi:evals`,
`qa:replay-ventas`) antes y después, no a ojo.
