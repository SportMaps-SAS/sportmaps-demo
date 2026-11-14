/**
 * Chequeo de los proveedores de IA: el OCR de comprobantes y el LLM del bot de
 * WhatsApp.
 *
 * Por qué existe. Dos fallas silenciosas costaron meses de trabajo manual:
 *
 *  1. La llave de `GEMINI_API_KEY` pertenecía a OTRO proyecto de Google. Daba 429
 *     permanente, que parece falta de saldo y no lo era — el proyecto con crédito
 *     era otro.
 *  2. Los modelos de Groq configurados devuelven 404: esa cuenta no tiene ningún
 *     modelo de visión, así que el OCR por Groq no puede funcionar nunca.
 *
 * Ninguna de las dos aparece en `/health`, y el OCR falla en silencio: el
 * comprobante queda sin `receipt_verdict` y alguien de la escuela lo aprueba a
 * mano sin saber que el automático estaba muerto.
 *
 * El sondeo NO gasta tokens. Pregunta por el metadato del modelo
 * (`GET .../models/<id>`), que valida la llave Y la existencia del modelo en una
 * sola llamada gratis. Es exactamente lo que habría atrapado las dos fallas.
 *
 *  3. (2026-11-09) La doble lectura de la aprobación automática tenía UN solo
 *     proveedor: nunca había lectura B y no se aprobaba ningún comprobante, sin
 *     un solo error en el log. Ahora es una advertencia (`dobleLectura`).
 */

import Anthropic from '@anthropic-ai/sdk';
import { listConfiguredProviders, modeloClaudeOcr } from './ocr.service';

export type ProviderName = 'gemini' | 'openai' | 'groq' | 'deepseek' | 'claude';
export type ProviderRole = 'ocr' | 'llm';

export interface ProviderCheck {
    role: ProviderRole;
    provider: ProviderName;
    /** Modelo que ese rol usaría con ese proveedor. */
    model: string;
    keyEnv: string;
    keyPresent: boolean;
    /** Posición en la cadena de intentos del rol: 1 = el que se usa primero. */
    order: number;
    /**
     * La llave es válida y el modelo existe. **No** significa que pueda inferir:
     * el endpoint de metadatos responde 200 aunque la cuenta esté sin saldo
     * (verificado con OpenAI el 2026-09-11, que devolvía 200 acá y 429 "no
     * credits remaining" al pedirle una extracción de verdad). Un verde acá
     * descarta llave equivocada y modelo inexistente, nada más.
     *
     * null = no se sondeó (sin llave).
     */
    reachable: boolean | null;
    detail?: string;
}

export interface AiHealthReport {
    /** Valor crudo de las variables que eligen proveedor. Nunca una llave. */
    config: { OCR_PROVIDER: string; WHATSAPP_LLM_PROVIDER: string; GROQ_OCR_MODEL: string | null };
    /**
     * Proveedores de la doble lectura de la aprobación automática, en orden
     * (`listConfiguredProviders`). Con menos de dos no se aprueba nada solo.
     */
    dobleLectura: string[];
    checks: ProviderCheck[];
    warnings: string[];
}

const KEY_ENV: Record<ProviderName, string> = {
    gemini: 'GEMINI_API_KEY',
    openai: 'OPENAI_API_KEY',
    groq: 'GROQ_API_KEY',
    deepseek: 'DEEPSEEK_API_KEY',
    claude: 'ANTHROPIC_API_KEY',
};

/** Modelos por rol. Deben espejar `ocr.service.ts` y `llm.service.ts`. */
function modelFor(role: ProviderRole, provider: ProviderName): string {
    if (role === 'ocr') {
        switch (provider) {
            case 'gemini': return process.env.GEMINI_MODEL || 'gemini-flash-latest';
            case 'openai': return 'gpt-4o-mini';
            case 'groq': return process.env.GROQ_OCR_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct';
            case 'claude': return modeloClaudeOcr();
            default: return '(no aplica)';
        }
    }
    switch (provider) {
        case 'gemini': return process.env.WHATSAPP_GEMINI_MODEL || 'gemini-flash-latest';
        case 'groq': return process.env.WHATSAPP_GROQ_MODEL || 'openai/gpt-oss-120b';
        case 'deepseek': return process.env.WHATSAPP_DEEPSEEK_MODEL || 'deepseek-chat';
        default: return 'gpt-4o-mini';
    }
}

/** Misma deduplicación de orden que `extractReceipt()`. */
function chain(role: ProviderRole): ProviderName[] {
    // Espejo exacto de las cadenas reales: `extractReceipt()` en ocr.service.ts y
    // `chatWithTools()` en llm.service.ts. Si divergen, el reporte miente sobre
    // quién contesta de segundo.
    //
    // En OCR, groq solo entra si `GROQ_OCR_MODEL` está definida — el mismo
    // interruptor que usa `groqPuedeVer()`, porque la cuenta no tiene modelos de
    // visión. Claude, solo con `ANTHROPIC_API_KEY`, igual que en `extractReceipt()`.
    const fallback: ProviderName[] = role === 'ocr'
        ? [
            'gemini', 'openai',
            ...(process.env.ANTHROPIC_API_KEY ? ['claude' as const] : []),
            ...(process.env.GROQ_OCR_MODEL ? ['groq' as const] : []),
        ]
        : ['gemini', 'groq', 'deepseek'];

    const crudo = (role === 'ocr' ? process.env.OCR_PROVIDER : process.env.WHATSAPP_LLM_PROVIDER)?.toLowerCase();
    const elegido = fallback.find((p) => p === crudo) ?? 'gemini';

    return [elegido, ...fallback].filter((v, i, a) => a.indexOf(v) === i);
}

/**
 * Lectura estática: qué quedó configurado. Sin red, seguro en el arranque.
 * NUNCA devuelve el valor de una llave, solo si está presente.
 */
export function describeAiProviders(): AiHealthReport {
    const checks: ProviderCheck[] = [];

    for (const role of ['ocr', 'llm'] as ProviderRole[]) {
        chain(role).forEach((provider, i) => {
            const keyEnv = KEY_ENV[provider];
            checks.push({
                role, provider, keyEnv,
                model: modelFor(role, provider),
                keyPresent: Boolean(process.env[keyEnv]),
                order: i + 1,
                reachable: null,
            });
        });
    }

    const warnings: string[] = [];
    const ocrPrimario = checks.find((c) => c.role === 'ocr' && c.order === 1);
    const llmPrimario = checks.find((c) => c.role === 'llm' && c.order === 1);

    if (process.env.OCR_PROVIDER?.toLowerCase() === 'groq' && !process.env.GROQ_OCR_MODEL) {
        warnings.push(
            'OCR_PROVIDER=groq pero la cuenta no tiene modelos de vision: se ignora y se usa gemini. Poner OCR_PROVIDER=gemini.',
        );
    }
    if (process.env.GROQ_OCR_MODEL) {
        warnings.push(
            `GROQ_OCR_MODEL=${process.env.GROQ_OCR_MODEL} reactiva groq para OCR. Confirmar arriba que ese modelo responde.`,
        );
    }
    for (const c of [ocrPrimario, llmPrimario]) {
        if (c && !c.keyPresent) {
            warnings.push(`${c.role.toUpperCase()} apunta a ${c.provider} pero ${c.keyEnv} esta vacia.`);
        }
    }
    if (!checks.some((c) => c.role === 'ocr' && c.keyPresent)) {
        warnings.push('Ningun proveedor de OCR tiene llave: todo comprobante quedara sin veredicto.');
    }
    const dobleLectura = listConfiguredProviders();
    if (dobleLectura.length < 2) {
        warnings.push(
            `La aprobacion automatica no puede aprobar: la doble lectura tiene ${dobleLectura.length} proveedor(es)` +
            ` (${dobleLectura.join(', ') || 'ninguno'}) y exige dos distintos. Configurar ANTHROPIC_API_KEY u OPENAI_API_KEY.`,
        );
    }

    return {
        config: {
            OCR_PROVIDER: process.env.OCR_PROVIDER || '(sin definir, cae en gemini)',
            WHATSAPP_LLM_PROVIDER: process.env.WHATSAPP_LLM_PROVIDER || '(sin definir, cae en gemini)',
            GROQ_OCR_MODEL: process.env.GROQ_OCR_MODEL || null,
        },
        dobleLectura,
        checks,
        warnings,
    };
}

/** URL de metadato del modelo. Gratis: no genera tokens. */
function probeUrl(provider: Exclude<ProviderName, 'claude'>, model: string): { url: string; headers: Record<string, string> } | null {
    const key = process.env[KEY_ENV[provider]];
    if (!key) return null;
    switch (provider) {
        case 'gemini':
            return { url: `https://generativelanguage.googleapis.com/v1beta/models/${model}?key=${key}`, headers: {} };
        // Sin `encodeURIComponent`: varios ids llevan barra (`openai/gpt-oss-120b`,
        // `meta-llama/...`) y codificarla da 404 aunque el modelo exista. Verificado
        // el 2026-09-11: `.../models/openai/gpt-oss-120b` → 200,
        // `.../models/openai%2Fgpt-oss-120b` → 404. El id viene de nuestro propio
        // entorno, no de una petición, así que no hay entrada hostil que escapar.
        case 'openai':
            return { url: `https://api.openai.com/v1/models/${model}`, headers: { Authorization: `Bearer ${key}` } };
        case 'groq':
            return { url: `https://api.groq.com/openai/v1/models/${model}`, headers: { Authorization: `Bearer ${key}` } };
        case 'deepseek':
            return { url: 'https://api.deepseek.com/v1/models', headers: { Authorization: `Bearer ${key}` } };
    }
}

/**
 * Estado HTTP del metadato del modelo. Claude va por el SDK oficial
 * (`models.retrieve`, también gratis); los demás, por `fetch` a `probeUrl`.
 */
async function sondear(provider: ProviderName, model: string, timeoutMs: number): Promise<number> {
    if (provider === 'claude') {
        try {
            await new Anthropic({ maxRetries: 0, timeout: timeoutMs }).models.retrieve(model);
            return 200;
        } catch (err) {
            if (err instanceof Anthropic.APIError && typeof err.status === 'number') return err.status;
            throw err;
        }
    }
    const probe = probeUrl(provider, model);
    if (!probe) throw new Error('sin llave');
    const res = await fetch(probe.url, { headers: probe.headers, signal: AbortSignal.timeout(timeoutMs) });
    return res.status;
}

/**
 * Sondea cada proveedor con llave. Resuelve siempre: un proveedor caído no puede
 * tumbar el arranque del BFF ni la respuesta del endpoint.
 */
export async function probeAiProviders(timeoutMs = 8000): Promise<AiHealthReport> {
    const report = describeAiProviders();

    await Promise.all(
        report.checks.map(async (c) => {
            if (!process.env[c.keyEnv]) { c.detail = 'sin llave, no se sondeo'; return; }
            try {
                const status = await sondear(c.provider, c.model, timeoutMs);
                c.reachable = status >= 200 && status < 300;
                if (!c.reachable) {
                    // 404 = el modelo no existe para esa cuenta (el caso Groq).
                    // 400/401/403 = llave de otro proyecto o sin permiso (el caso Gemini).
                    c.detail = `HTTP ${status}`;
                    report.warnings.push(
                        `${c.role.toUpperCase()} ${c.provider} (${c.model}): HTTP ${status}.` +
                        (status === 404 ? ' El modelo no existe para esa llave.' : '') +
                        ([400, 401, 403].includes(status) ? ' Llave invalida o de otro proyecto.' : ''),
                    );
                }
            } catch (err: unknown) {
                const e = err as { name?: string; message?: string };
                c.reachable = false;
                // `TimeoutError` de AbortSignal; `APIConnectionTimeoutError` del SDK de Anthropic.
                c.detail = /Timeout/.test(e?.name ?? '') ? 'timeout' : String(e?.message ?? err);
                report.warnings.push(`${c.role.toUpperCase()} ${c.provider}: ${c.detail}`);
            }
        }),
    );

    return report;
}

/**
 * Log de arranque. Sondea en segundo plano para no retrasar el `listen`, y grita
 * solo si hay algo mal: un arranque sano deja dos líneas, no veinte.
 */
export function logAiProvidersAtStartup(): void {
    const estatico = describeAiProviders();
    console.log(`🤖 IA — OCR: ${estatico.config.OCR_PROVIDER} · bot: ${estatico.config.WHATSAPP_LLM_PROVIDER}`);

    void probeAiProviders()
        .then((r) => {
            for (const c of r.checks) {
                if (c.reachable === false) {
                    console.warn(`   ✗ ${c.role}/${c.provider} ${c.model} — ${c.detail}`);
                }
            }
            if (r.warnings.length === 0) {
                const ok = r.checks.filter((c) => c.reachable).map((c) => `${c.role}/${c.provider}`);
                // "llave y modelo OK", no "puede inferir": ver el comentario de
                // `reachable`. Un proveedor sin saldo sale igual en esta lista.
                console.log(`   ✓ llave y modelo OK: ${ok.join(', ') || 'ninguno'}`);
                return;
            }
            console.warn('   ⚠️  Revisar la configuracion de IA:');
            for (const w of [...new Set(r.warnings)]) console.warn(`      · ${w}`);
        })
        .catch((err: unknown) => {
            console.warn('   ⚠️  no se pudo sondear los proveedores de IA:', (err as { message?: string })?.message);
        });
}
