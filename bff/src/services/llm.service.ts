import Anthropic from '@anthropic-ai/sdk';
import { conContextoLlm, registrarUsoLlm, tokensDeRespuesta, type ContextoUsoLlm, type TokensUso } from './llm-usage.service';
/**
 * llm.service — Abstracción de LLM con tool-calling para el bot de WhatsApp (WA2).
 *
 * Default: Gemini Flash (baja latencia, buena gobernanza para datos de menores).
 * Fallback: DeepSeek V3 (OpenAI-compatible). Se cambia con WHATSAPP_LLM_PROVIDER.
 *
 * Expone una interfaz única `chatWithTools()` que devuelve, o bien una lista de
 * tool calls que el bot debe ejecutar, o bien texto final. El bot orquesta el
 * loop (ejecutar tool → devolver resultado → pedir redacción final).
 *
 * IMPORTANTE (decisión #6, cero alucinaciones): el bot NUNCA responde datos sin
 * un tool exitoso. Este módulo solo decide QUÉ tool llamar y REDACTA con datos
 * ya obtenidos; no inventa.
 */

export type LlmProvider = 'gemini' | 'deepseek' | 'groq' | 'claude';

export interface LlmTool {
    name: string;
    description: string;
    /** JSON Schema de los parámetros (objeto con properties/required). */
    parameters: Record<string, unknown>;
}

export interface LlmMessage {
    role: 'user' | 'assistant' | 'tool';
    content: string;
    /** Para role 'tool': nombre de la tool cuyo resultado es este mensaje. */
    toolName?: string;
}

/** 'auto': puede llamar herramientas. 'none': las ve pero solo redacta. */
export type LlmToolChoice = 'auto' | 'none';

export interface LlmToolCall {
    name: string;
    args: Record<string, unknown>;
}

export interface LlmResult {
    /** Si el modelo pidió ejecutar tools. */
    toolCalls?: LlmToolCall[];
    /** Texto final (cuando no hay tool call). */
    text?: string;
    provider: LlmProvider;
    /**
     * Proveedores que fallaron ANTES del que respondió (vacío o ausente si
     * respondió el primero). Para dejarlo consultable en la base (P1-6 de la
     * auditoría 2026-10-06): hasta acá la causa solo quedaba en los logs.
     */
    fallas?: LlmFalla[];
}

/** Una falla de un proveedor: quién, qué dijo y cuánto tardó en fallar. */
export interface LlmFalla {
    proveedor: LlmProvider;
    error: string;
    ms: number;
}

/** El error que lanza `chatWithTools` cuando fallan todos: lleva el detalle. */
export interface LlmErrorTotal extends Error {
    fallas: LlmFalla[];
}

/** Las fallas que trae un error de `chatWithTools` (o [] si no es de acá). */
export function fallasDeError(err: unknown): LlmFalla[] {
    const f = (err as any)?.fallas;
    return Array.isArray(f) ? f : [];
}

// 2026-09-04: gemini-2.5-flash quedó 404 ("no longer available to new users")
// — Google retira versiones puntuales de Flash cada pocos meses. Se usa el
// alias `gemini-flash-latest` (Google lo mantiene apuntando al Flash vigente)
// en vez de fijar una versión, para no repetir este apagón.
const GEMINI_MODEL = process.env.WHATSAPP_GEMINI_MODEL || 'gemini-flash-latest';

/**
 * Tope por llamada a un proveedor (P15, análisis 2026-10-06). Sin tope, un
 * proveedor colgado se comía la latencia entera antes de pasar al siguiente:
 * el estado de pagos llegó a tardar 269 s.
 */
const TIMEOUT_LLM_MS = Number(process.env.WHATSAPP_LLM_TIMEOUT_MS) || 20_000;

function sinRequiredVacio(p: Record<string, unknown>): Record<string, unknown> {
    const { required, ...resto } = p as any;
    return Array.isArray(required) && required.length ? { ...resto, required } : resto;
}

/** ¿El esquema de parámetros declara alguna propiedad? */
function tieneParametros(p: Record<string, unknown> | undefined): boolean {
    const props = (p as any)?.properties;
    return !!props && typeof props === 'object' && Object.keys(props).length > 0;
}

// Proveedores OpenAI-compatibles (mismo shape de request/response).
const OPENAI_COMPAT: Record<string, { baseUrl: string; model: string; keyEnv: string }> = {
    deepseek: {
        baseUrl: 'https://api.deepseek.com',
        model: process.env.WHATSAPP_DEEPSEEK_MODEL || 'deepseek-chat',
        keyEnv: 'DEEPSEEK_API_KEY',
    },
    groq: {
        baseUrl: 'https://api.groq.com/openai/v1',
        // `llama-3.3-70b-versatile` daba 404: no existe en nuestra cuenta. De los 14
        // modelos que sí tiene (listados el 2026-09-11), gpt-oss-120b es el único
        // de texto con tool-calling apto para el bot.
        model: process.env.WHATSAPP_GROQ_MODEL || 'openai/gpt-oss-120b',
        keyEnv: 'GROQ_API_KEY',
    },
};

// ─── Gemini ───────────────────────────────────────────────────────────────────

async function chatGemini(
    system: string,
    messages: LlmMessage[],
    tools: LlmTool[],
    toolChoice: LlmToolChoice = 'auto',
): Promise<LlmResult> {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY no configurado');

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

    // Mapear mensajes al formato de Gemini (contents con role user/model).
    //
    // El resultado de una tool va como TEXTO del usuario, no como
    // `functionResponse` (2026-10-06). El bot no reenvía el `functionCall`
    // original —arma «Llamando get_payment_status» como texto del modelo—, y
    // Gemini rechaza con 400 un `functionResponse` que no viene justo después
    // de un `functionCall` (y los modelos con «thinking» exigen además la firma
    // del pensamiento de ese call). Era uno de los motivos por los que el 06-oct
    // 23 de 25 respuestas salieron por Groq: la segunda llamada (redactar con
    // el resultado) fallaba siempre en Gemini.
    const contents: any[] = [];
    for (const m of messages) {
        if (m.role === 'user') {
            contents.push({ role: 'user', parts: [{ text: m.content }] });
        } else if (m.role === 'assistant') {
            contents.push({ role: 'model', parts: [{ text: m.content }] });
        } else if (m.role === 'tool') {
            contents.push({
                role: 'user',
                parts: [{ text: `Resultado de ${m.toolName} (datos del sistema, no del acudiente):
${m.content}` }],
            });
        }
    }

    const body: any = {
        system_instruction: { parts: [{ text: system }] },
        contents,
        generationConfig: { temperature: 0.2, maxOutputTokens: 1024 },
    };
    if (tools.length) {
        body.tools = [{
            // Sin `parameters` cuando no hay propiedades: Gemini rechaza un
            // OBJECT con `properties: {}` («should be non-empty for OBJECT
            // type»), y 4 de las 5 tools del bot no llevan parámetros. Con eso
            // la PRIMERA llamada también se caía a Groq.
            // Tampoco `required: []`: mismo validador, mismo riesgo.
            function_declarations: tools.map(t => (tieneParametros(t.parameters)
                ? { name: t.name, description: t.description, parameters: sinRequiredVacio(t.parameters) }
                : { name: t.name, description: t.description })),
        }];
        // Turno de solo redactar: las herramientas van (mismo prefijo) pero no
        // se pueden llamar.
        if (toolChoice === 'none') body.tool_config = { function_calling_config: { mode: 'NONE' } };
    }

    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_LLM_MS),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) {
        throw new Error(`gemini_${res.status}: ${json?.error?.message || 'error'}`);
    }
    // Consumo para el informe de calidad del bot (best-effort, no espera).
    registrarUsoLlm({ provider: 'gemini', model: json?.modelVersion || GEMINI_MODEL, tokens: tokensDeRespuesta(json) });

    const parts = json?.candidates?.[0]?.content?.parts ?? [];
    const toolCalls: LlmToolCall[] = parts
        .filter((p: any) => p.functionCall)
        .map((p: any) => ({ name: p.functionCall.name, args: p.functionCall.args || {} }));

    if (toolCalls.length) return { toolCalls, provider: 'gemini' };

    const text = parts.filter((p: any) => p.text).map((p: any) => p.text).join('').trim();
    return { text, provider: 'gemini' };
}

// ─── Proveedores OpenAI-compatibles (DeepSeek, Groq) ──────────────────────────

async function chatOpenAICompatible(
    provider: 'deepseek' | 'groq',
    system: string,
    messages: LlmMessage[],
    tools: LlmTool[],
    toolChoice: LlmToolChoice = 'auto',
): Promise<LlmResult> {
    const cfg = OPENAI_COMPAT[provider];
    const apiKey = process.env[cfg.keyEnv];
    if (!apiKey) throw new Error(`${cfg.keyEnv} no configurado`);

    const oaMessages: any[] = [{ role: 'system', content: system }];
    for (const m of messages) {
        // Mismo arreglo que en Gemini (2026-10-06): los bots no reenvían el
        // `tool_calls` original del asistente, y un mensaje `role: 'tool'` sin
        // ese `tool_calls` justo antes es un 400 en las APIs OpenAI-compatibles.
        // Con Gemini y Groq rechazando la segunda llamada, Mapi nunca
        // redactaba: mandaba la lista de links de respaldo.
        if (m.role === 'tool') {
            oaMessages.push({
                role: 'user',
                content: `Resultado de ${m.toolName} (datos del sistema, no del usuario):\n${m.content}`,
            });
        } else {
            oaMessages.push({ role: m.role, content: m.content });
        }
    }

    const body: any = {
        model: cfg.model,
        messages: oaMessages,
        temperature: 0.2,
        max_tokens: 1024,
    };
    if (tools.length) {
        body.tools = tools.map(t => ({
            type: 'function',
            function: { name: t.name, description: t.description, parameters: t.parameters },
        }));
        body.tool_choice = toolChoice;
    }

    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_LLM_MS),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) {
        throw new Error(`${provider}_${res.status}: ${json?.error?.message || 'error'}`);
    }
    registrarUsoLlm({ provider, model: json?.model || cfg.model, tokens: tokensDeRespuesta(json) });

    const choice = json?.choices?.[0]?.message;
    const rawCalls = choice?.tool_calls ?? [];
    if (rawCalls.length) {
        const toolCalls: LlmToolCall[] = rawCalls
            .map((c: any) => ({ name: c.function?.name, args: safeParse(c.function?.arguments) || {} }))
            .filter((c: LlmToolCall) => c.name);
        if (toolCalls.length) return { toolCalls, provider };
    }
    return { text: (choice?.content || '').trim(), provider };
}

// ─── Claude (Anthropic, SDK oficial) ───────────────────────────────────────────
//
// Primer proveedor desde el 2026-10-06. Ese día, con el bot de Dynasty en vivo,
// Gemini respondía 503 («high demand») y Groq agotó su tope diario gratuito de
// 200.000 tokens: el bot cayó al menú de respaldo en plena prueba. Claude ya
// lee los comprobantes (ocr.service) con la misma llave.
// Sonnet 5.5 por defecto desde el 2026-10-06: el bot y la lectura de
// comprobantes no necesitan Opus y Sonnet cuesta bastante menos. Se cambia sin
// desplegar con la variable de entorno. Haiku 4.5 no acepta `effort`.
const MODELO_CLAUDE_DEFAULT = 'claude-sonnet-5-5';
function modeloClaude(env?: string): string { return (env || '').trim() || MODELO_CLAUDE_DEFAULT; }
function conEsfuerzoBajo(modelo: string): Record<string, unknown> {
    return /haiku/i.test(modelo) ? {} : { output_config: { effort: 'low' } };
}

let anthropicClient: Anthropic | null = null;
function clienteClaude(): Anthropic {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY no configurada');
    anthropicClient ??= new Anthropic({ timeout: TIMEOUT_LLM_MS, maxRetries: 1 });
    return anthropicClient;
}

/**
 * TTL de la caché de prompt de Claude. 1 h por defecto (2026-10-10): el
 * SYSTEM_PROMPT y las herramientas del bot son los MISMOS para todas las
 * escuelas, y entre un mensaje de WhatsApp y el siguiente suelen pasar más de
 * 5 minutos, así que con el TTL de 5 min casi cada turno volvía a escribir la
 * caché. Escribir con 1 h cuesta 2× (5 min: 1,25×) y leer 0,1×: con más de una
 * lectura por hora sale más barato. `ttl: '1h'` es GA en la API (sin header
 * beta) y el SDK 0.131 lo tipa en `CacheControlEphemeral`. Se vuelve a 5 min
 * con WHATSAPP_CLAUDE_CACHE_TTL=5m, sin desplegar.
 */
export const CACHE_TTL_CLAUDE: '5m' | '1h' =
    process.env.WHATSAPP_CLAUDE_CACHE_TTL === '5m' ? '5m' : '1h';

/** El `cache_control` de los puntos de corte (sistema y última herramienta), con el mismo TTL. */
export function cacheControlClaude(ttl: '5m' | '1h' = CACHE_TTL_CLAUDE): { type: 'ephemeral'; ttl?: '1h' } {
    return ttl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };
}

async function chatClaude(
    system: string,
    messages: LlmMessage[],
    tools: LlmTool[],
    toolChoice: LlmToolChoice = 'auto',
    modelo?: string,
): Promise<LlmResult> {
    const client = clienteClaude();
    // Mismo criterio que OpenAI-compatible: el resultado de una tool va como
    // texto del usuario (los bots no reenvían el tool_use original).
    const msgs: any[] = [];
    for (const m of messages) {
        const content = m.role === 'tool'
            ? `Resultado de ${m.toolName} (datos del sistema, no del usuario):
${m.content}`
            : m.content;
        const role = m.role === 'assistant' ? 'assistant' : 'user';
        if (!content) continue;
        // La API exige que el primer mensaje sea del usuario.
        if (!msgs.length && role === 'assistant') continue;
        msgs.push({ role, content });
    }
    if (!msgs.length) msgs.push({ role: 'user', content: '(sin texto)' });

    const body: any = {
        model: modeloClaude(modelo || process.env.WHATSAPP_CLAUDE_MODEL),
        max_tokens: 2048,
        // Respuestas cortas de WhatsApp: esfuerzo bajo = menos latencia y costo.
        ...conEsfuerzoBajo(modeloClaude(modelo || process.env.WHATSAPP_CLAUDE_MODEL)),
        // Caché de prompt: herramientas + sistema son casi siempre iguales y el
        // bot llama al modelo 2+ veces por turno (herramienta → respuesta). Lo
        // cacheado se cobra ~10 % en las lecturas siguientes (2026-10-07).
        // El orden del prefijo es herramientas → sistema → mensajes: si la
        // segunda llamada del turno no manda las MISMAS herramientas, el
        // prefijo cambia y no lee nada de lo que escribió la primera. Por eso
        // el turno de «solo redactar» manda las herramientas con
        // tool_choice 'none' (cambiar tool_choice no invalida la caché de
        // herramientas ni de sistema) en vez de `tools: []`.
        system: [{ type: 'text', text: system, cache_control: cacheControlClaude() }],
        messages: msgs,
    };
    if (tools.length) {
        body.tools = tools.map((t, i) => ({
            name: t.name,
            description: t.description,
            input_schema: { type: 'object', ...(t.parameters || {}) },
            ...(i === tools.length - 1 ? { cache_control: cacheControlClaude() } : {}),
        }));
        if (toolChoice === 'none') body.tool_choice = { type: 'none' };
    }
    const res: any = await client.messages.create(body);
    const u = res.usage;
    if (u) {
        console.info('[llm] claude uso', {
            modelo: body.model,
            entrada: u.input_tokens,
            cache_lectura: u.cache_read_input_tokens ?? 0,
            cache_escritura: u.cache_creation_input_tokens ?? 0,
            salida: u.output_tokens,
        });
    }
    registrarUsoLlm({ provider: 'claude', model: res.model || body.model, tokens: tokensDeRespuesta(res) });
    if (res.stop_reason === 'refusal') throw new Error('claude_refusal');
    const blocks: any[] = res.content ?? [];
    const toolCalls: LlmToolCall[] = blocks
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({ name: b.name, args: (b.input as Record<string, unknown>) || {} }));
    if (toolCalls.length) return { toolCalls, provider: 'claude' };
    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    return { text, provider: 'claude' };
}

// ─── Entrada pública con fallback ──────────────────────────────────────────────

export async function chatWithTools(params: {
    system: string;
    messages: LlmMessage[];
    tools?: LlmTool[];
    /**
     * 'none': el modelo ve las herramientas pero no puede llamarlas (turno de
     * solo redactar con datos ya obtenidos). Se mandan igual para que el
     * prefijo —y la caché de prompt— sea el de la primera llamada.
     */
    toolChoice?: LlmToolChoice;
    provider?: LlmProvider;
    /** Escuela / conversación / función para el registro de consumo (llm_usage). */
    uso?: ContextoUsoLlm;
    /** Modelo de Claude para esta llamada (p. ej. Haiku); los demás proveedores lo ignoran. */
    modeloClaude?: string;
}): Promise<LlmResult> {
    const primary: LlmProvider =
        params.provider || (process.env.WHATSAPP_LLM_PROVIDER as LlmProvider) || 'gemini';
    const tools = params.tools ?? [];
    const toolChoice: LlmToolChoice = params.toolChoice ?? 'auto';

    const run = (p: LlmProvider): Promise<LlmResult> => (params.uso
        ? conContextoLlm(params.uso, () => correr(p))
        : correr(p));
    const correr = (p: LlmProvider) =>
        p === 'claude'
            ? chatClaude(params.system, params.messages, tools, toolChoice, params.modeloClaude)
            : p === 'gemini'
                ? chatGemini(params.system, params.messages, tools, toolChoice)
                : chatOpenAICompatible(p as 'deepseek' | 'groq', params.system, params.messages, tools, toolChoice);

    // Cadena: primario → resto (resiliencia si un proveedor está sin saldo/caído).
    //
    // DeepSeek salió el 2026-09-12. Era el TERCER respaldo —solo entraba si
    // Gemini y Groq fallaban a la vez— y a cambio obligaba a declarar una
    // transferencia de datos a China: país sin nivel adecuado de protección
    // según la SIC, con datos de menores y de pagos de familias colombianas
    // de por medio. El amparo habría sido una cláusula contractual con el
    // encargado, y con DeepSeek no hay contrato: es una llave de API y nada
    // más. La política de privacidad no puede afirmar garantías que no
    // existen. Si algún día se firma un DPA, se vuelve a agregar acá.
    // Claude va primero si hay llave (salvo que se pida un proveedor explícito).
    const conClaude: LlmProvider[] = process.env.ANTHROPIC_API_KEY && !params.provider ? ['claude'] : [];
    const order: LlmProvider[] = [...conClaude, primary, ...(['gemini', 'groq'] as LlmProvider[])]
        .filter((p, i, a) => a.indexOf(p) === i)
        .filter((p) => p !== 'claude' || !!process.env.ANTHROPIC_API_KEY);

    let lastErr: any;
    const fallas: LlmFalla[] = [];
    for (const p of order) {
        const inicio = Date.now();
        // Un 429 NO es que el proveedor este caido: es que llegamos muy rapido.
        // Antes se pasaba al siguiente sin esperar ni un segundo, y si el
        // siguiente tambien venia saturado la cadena entera se caia y el padre
        // recibia el texto plano de respaldo.
        //
        // Se ve con un solo usuario mandando mensajes cada 15 segundos (chat de
        // prueba, 2026-09-14: el respaldo salio 4 veces). Con treinta familias
        // escribiendo a la vez —un dia de cobro— seria el comportamiento normal,
        // no la excepcion.
        //
        // Dos reintentos cortos absorben la rafaga. Mas que eso no: Meta espera
        // el webhook y el padre esta mirando la pantalla.
        for (let intento = 0; intento < 3; intento++) {
            try {
                const r = await run(p);
                return fallas.length ? { ...r, fallas } : r;
            } catch (err: any) {
                lastErr = err;
                const msg = String(err?.message ?? '');
                // Claude se negó: es la respuesta, no una caída. Reintentar con
                // Gemini o Groq era darle al jailbreak un modelo menos estricto
                // (auditoría 2026-10-28, P-05). Quien llama ya tiene su respaldo
                // determinista para el error total.
                if (msg === 'claude_refusal') {
                    fallas.push({ proveedor: p, error: msg, ms: Date.now() - inicio });
                    const rechazo = new Error('el modelo se negó a responder (claude_refusal)') as LlmErrorTotal;
                    rechazo.fallas = fallas;
                    throw rechazo;
                }
                const saturado = /\b429\b|rate.?limit|too many requests|quota|resource_exhausted/i.test(msg);

                if (!saturado || intento === 2) {
                    console.warn(`[llm.service] ${p} falló (${msg}); intento siguiente proveedor`);
                    fallas.push({ proveedor: p, error: msg.slice(0, 300), ms: Date.now() - inicio });
                    break;
                }
                // 400 ms, 1200 ms. Con jitter para que treinta webhooks
                // simultaneos no reintenten todos en el mismo instante y se
                // vuelvan a saturar entre ellos.
                const espera = 400 * Math.pow(3, intento) * (0.7 + Math.random() * 0.6);
                console.warn(`[llm.service] ${p} saturado; reintento en ${Math.round(espera)} ms`);
                await new Promise((r) => setTimeout(r, espera));
            }
        }
    }
    // El error final nombra a TODOS: antes solo quedaba el del último y la causa
    // de que el primero (Gemini) fallara no se veía en ningún lado.
    const total = new Error(fallas.length
        ? `todos los proveedores LLM fallaron — ${fallas.map((f) => `${f.proveedor}: ${f.error}`).join(' | ')}`
        : (lastErr?.message || 'todos los proveedores LLM fallaron')) as LlmErrorTotal;
    total.fallas = fallas;
    throw total;
}

function safeParse(s: unknown): any {
    if (typeof s !== 'string') return s;
    try { return JSON.parse(s); } catch { return s; }
}

// ─── Salida JSON estructurada (pizarra IA, M3) ─────────────────────────────────
//
// Una sola llamada que devuelve un JSON con forma fija. Claude usa structured
// outputs (`output_config.format` json_schema: la respuesta respeta el esquema);
// los respaldos piden JSON (Gemini `responseMimeType`, Groq `json_object`) y el
// esquema va en el sistema. En TODOS los casos quien llama valida la respuesta:
// es dato no confiable. Cada proveedor que responde registra su consumo en
// llm_usage con la función del contexto (`uso.feature`).

export interface JsonEstructuradoParams {
    system: string;
    user: string;
    schema: Record<string, unknown>;
    /** Tope de salida (tokens). */
    maxTokens?: number;
    /** Tope por proveedor (ms). */
    timeoutMs?: number;
    uso?: ContextoUsoLlm;
    /** Para pruebas o para forzar uno: si no, Claude (con llave) → Gemini → Groq. */
    providers?: LlmProvider[];
}

export interface JsonEstructuradoResult {
    /** Texto crudo del modelo (JSON sin validar). */
    texto: string;
    provider: LlmProvider;
    model: string;
    tokens: TokensUso | null;
    fallas?: LlmFalla[];
}

/** Esfuerzo de Claude para la pizarra (TACTICAL_AI_EFFORT=low|medium|high).
 *  'low' por defecto (2026-10-14): comparado contra 'medium' en fútbol,
 *  baloncesto y voleibol, los contraataques salen igual de coherentes y cuesta
 *  ~15 % menos (la salida es casi toda el JSON de los cuadros, no razonamiento). */
function esfuerzoPizarra(modelo: string): Record<string, unknown> {
    if (/haiku-4/i.test(modelo)) return {};
    const e = (process.env.TACTICAL_AI_EFFORT || 'low').trim();
    return { effort: ['low', 'medium', 'high'].includes(e) ? e : 'low' };
}

async function jsonClaude(p: JsonEstructuradoParams): Promise<JsonEstructuradoResult> {
    const client = clienteClaude();
    const model = modeloClaude(process.env.TACTICAL_AI_CLAUDE_MODEL || process.env.WHATSAPP_CLAUDE_MODEL);
    const body: any = {
        model,
        max_tokens: p.maxTokens ?? 12_000,
        system: [{ type: 'text', text: p.system, cache_control: cacheControlClaude('5m') }],
        messages: [{ role: 'user', content: p.user }],
        output_config: { ...esfuerzoPizarra(model), format: { type: 'json_schema', schema: p.schema } },
    };
    const res: any = await client.messages.create(body, { timeout: p.timeoutMs ?? 60_000, maxRetries: 0 });
    const tokens = tokensDeRespuesta(res);
    registrarUsoLlm({ provider: 'claude', model: res.model || model, tokens });
    if (res.stop_reason === 'refusal') throw new Error('claude_refusal');
    if (res.stop_reason === 'max_tokens') throw new Error('claude_max_tokens: respuesta cortada');
    const texto = (res.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('').trim();
    return { texto, provider: 'claude', model: res.model || model, tokens };
}

const conEsquema = (p: JsonEstructuradoParams) =>
    `${p.system}\n\nResponde SOLO con un objeto JSON que cumpla este JSON Schema, sin texto alrededor:\n${JSON.stringify(p.schema)}`;

async function jsonGemini(p: JsonEstructuradoParams): Promise<JsonEstructuradoResult> {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY no configurado');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            system_instruction: { parts: [{ text: conEsquema(p) }] },
            contents: [{ role: 'user', parts: [{ text: p.user }] }],
            generationConfig: { temperature: 0.4, maxOutputTokens: p.maxTokens ?? 12_000, responseMimeType: 'application/json' },
        }),
        signal: AbortSignal.timeout(p.timeoutMs ?? 60_000),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`gemini_${res.status}: ${json?.error?.message || 'error'}`);
    const model = json?.modelVersion || GEMINI_MODEL;
    const tokens = tokensDeRespuesta(json);
    registrarUsoLlm({ provider: 'gemini', model, tokens });
    const texto = (json?.candidates?.[0]?.content?.parts ?? []).filter((x: any) => x.text).map((x: any) => x.text).join('').trim();
    return { texto, provider: 'gemini', model, tokens };
}

async function jsonGroq(p: JsonEstructuradoParams): Promise<JsonEstructuradoResult> {
    const cfg = OPENAI_COMPAT.groq;
    const apiKey = process.env[cfg.keyEnv];
    if (!apiKey) throw new Error(`${cfg.keyEnv} no configurado`);
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
            model: cfg.model,
            messages: [{ role: 'system', content: conEsquema(p) }, { role: 'user', content: p.user }],
            temperature: 0.4,
            max_tokens: Math.min(p.maxTokens ?? 12_000, 16_000),
            response_format: { type: 'json_object' },
        }),
        signal: AbortSignal.timeout(p.timeoutMs ?? 60_000),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`groq_${res.status}: ${json?.error?.message || 'error'}`);
    const model = json?.model || cfg.model;
    const tokens = tokensDeRespuesta(json);
    registrarUsoLlm({ provider: 'groq', model, tokens });
    return { texto: String(json?.choices?.[0]?.message?.content || '').trim(), provider: 'groq', model, tokens };
}

/**
 * Una llamada con salida JSON. Recorre los proveedores en orden y devuelve el
 * primero que responde; si fallan todos lanza un error con `fallas` (mismo
 * contrato que chatWithTools). Sin reintentos por 429: el coach está mirando la
 * pantalla y el tope total ya es largo.
 */
export async function generarJsonEstructurado(params: JsonEstructuradoParams): Promise<JsonEstructuradoResult> {
    const orden: LlmProvider[] = (params.providers ?? [
        ...(process.env.ANTHROPIC_API_KEY ? ['claude' as const] : []),
        'gemini', 'groq',
    ]).filter((x, i, a) => a.indexOf(x) === i && x !== 'deepseek');
    const fallas: LlmFalla[] = [];
    for (const prov of orden) {
        const inicio = Date.now();
        const correr = () => (prov === 'claude' ? jsonClaude(params) : prov === 'gemini' ? jsonGemini(params) : jsonGroq(params));
        try {
            const r = await (params.uso ? conContextoLlm(params.uso, correr) : correr());
            if (!r.texto) throw new Error(`${prov}: respuesta vacía`);
            return fallas.length ? { ...r, fallas } : r;
        } catch (err: any) {
            const msg = String(err?.message ?? err);
            console.warn(`[llm.service] json ${prov} falló (${msg.slice(0, 200)})`);
            fallas.push({ proveedor: prov, error: msg.slice(0, 300), ms: Date.now() - inicio });
        }
    }
    const total = new Error(fallas.length
        ? `todos los proveedores LLM fallaron — ${fallas.map((f) => `${f.proveedor}: ${f.error}`).join(' | ')}`
        : 'no hay proveedores LLM configurados') as LlmErrorTotal;
    total.fallas = fallas;
    throw total;
}
