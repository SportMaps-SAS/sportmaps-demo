/**
 * Evals del modo agente de Mapi contra el MODELO REAL (plan §14).
 *
 *   cd bff && npm run mapi:evals
 *
 * Las pruebas con modelo simulado (agente.test.ts) validan el ciclo; esto
 * valida las DECISIONES del modelo: qué herramienta elige, con qué argumentos,
 * si pregunta cuando hay ambigüedad y si se niega cuando debe.
 *
 * Qué es real y qué no:
 *   · REAL: turnoAgente, el prompt, las herramientas, validarPantalla, el mapa
 *     de la app y la llamada a Claude (mismo SDK y misma configuración que
 *     crearMensajeReal: timeout 60 s, 1 reintento). Se inyecta por
 *     `crearMensaje`, el punto de extensión que ya usa turno-chat, solo para
 *     anotar herramientas, tokens y latencia de cada ronda.
 *   · FALSO: Supabase (escuela de prueba en fixtures.ts). Nada se escribe en la
 *     base real: los borradores y las filas de llm_usage quedan en memoria.
 *
 * Variables opcionales:
 *   MAPI_EVALS_SOLO=id1,categoria2   corre solo esos casos o categorías
 *   MAPI_EVALS_CONCURRENCIA=3        casos en paralelo (por defecto 3)
 *   MAPI_EVALS_SOLO_FIXTURES=true    solo verifica la escuela de prueba (sin modelo, sin costo)
 *   MAPI_EVALS_RECALIFICAR=true      vuelve a calificar ultimo-reporte.json (sin modelo, sin costo);
 *                                    sirve tras corregir un patrón del calificador o de un caso
 *
 * La key sale de bff/.env (ANTHROPIC_API_KEY) y nunca se imprime.
 */

import { describe, it, expect, vi } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'dotenv';
import Anthropic from '@anthropic-ai/sdk';

vi.mock('../../../config/supabase', async () => {
    const { crearBdFalsa } = await import('./fixtures');
    const bd = crearBdFalsa();
    (globalThis as any).__bdEvals = bd;
    return { supabase: bd.supabase, supabaseUrl: 'http://supabase.local', supabaseServiceKey: 'clave-de-prueba', supabaseAnonKey: 'anon-de-prueba' };
});

import { turnoAgente, ejecutarLlamada, modeloAgente, type CrearMensaje } from '../agente';
import { CATALOGO, herramientasPara } from '../registro';
import { validarPantalla, contextoDelTurno } from '../pantalla';
import { conContextoLlm, costoUsd, tokensDeRespuesta } from '../../llm-usage.service';
import { alcanceDe, CLAVE, CONCEPTO_INYECTADO, MOTIVO_INYECTADO, NOMBRE_ADMIN, NOMBRE_COACH, type BdFalsa } from './fixtures';
import { CASOS } from './casos';
import { armarReporte, calificar, imprimirReporte, reporteComoJson } from './calificar';
import { CATEGORIAS, type BorradorObservado, type CasoEval, type LlamadaModelo, type LlamadaObservada, type Observado, type ResultadoCaso } from './tipos';

const bd = () => (globalThis as any).__bdEvals as BdFalsa;
const RAIZ_BFF = path.resolve(__dirname, '../../../..');
const REPORTE = path.join(__dirname, 'ultimo-reporte.json');
const HOY = '2026-11-24';
const TIMEOUT_CASO_MS = 240_000;
const CONCURRENCIA = Math.max(1, Math.min(4, Number(process.env.MAPI_EVALS_CONCURRENCIA) || 3));
const SOLO_FIXTURES = process.env.MAPI_EVALS_SOLO_FIXTURES === 'true';
/** Vuelve a calificar ultimo-reporte.json con el calificador actual, sin llamar al modelo. */
const RECALIFICAR = process.env.MAPI_EVALS_RECALIFICAR === 'true';

/** Solo lo que el agente necesita de bff/.env. Nada de SUPABASE_*: la base es falsa a propósito. */
function cargarEntorno(): void {
    const ruta = path.join(RAIZ_BFF, '.env');
    if (!existsSync(ruta)) return;
    const env = parse(readFileSync(ruta));
    for (const k of ['ANTHROPIC_API_KEY', 'MAPI_AGENT_MODEL']) {
        if (env[k] && !process.env[k]) process.env[k] = env[k];
    }
}

/** ¿La herramienta existe en el CATALOGO y se le ofrece al admin con el entorno de los evals? */
function disponible(nombre: string): boolean {
    return CATALOGO.some((h) => h.nombre === nombre) && herramientasPara(alcanceDe('admin', HOY)).some((h) => h.nombre === nombre);
}

function seleccionados(): CasoEval[] {
    const solo = (process.env.MAPI_EVALS_SOLO || '').split(',').map((x) => x.trim()).filter(Boolean);
    return solo.length ? CASOS.filter((c) => solo.includes(c.id) || solo.includes(c.categoria)) : CASOS;
}

// ─── Llamada al modelo, observada ───────────────────────────────────────────

interface Registro {
    ronda: number;
    llamadas: LlamadaObservada[];
    modelo: LlamadaModelo[];
    textoModelo: string;
    error?: string;
}

let cliente: Anthropic | null = null;

/** El último mensaje del cuerpo trae los tool_result de la ronda anterior: se anotan en su llamada. */
function anotarResultados(reg: Registro, body: any): void {
    const ultimo = body?.messages?.[body.messages.length - 1];
    if (ultimo?.role !== 'user' || !Array.isArray(ultimo.content)) return;
    for (const b of ultimo.content) {
        if (b?.type !== 'tool_result') continue;
        const l = reg.llamadas.find((x) => x.id === b.tool_use_id);
        if (l) {
            l.error = b.is_error === true;
            l.resultado = String(b.content ?? '').slice(0, 400);
        }
    }
}

function crearMensajeObservado(reg: Registro): CrearMensaje {
    return async (body) => {
        anotarResultados(reg, body);
        // Misma configuración que crearMensajeReal (agente.ts).
        cliente ??= new Anthropic({ timeout: 60_000, maxRetries: 1 });
        const t0 = Date.now();
        let res: any;
        try {
            res = await cliente.beta.messages.create(body);
        } catch (err: any) {
            reg.error = `${err?.status ?? ''} ${err?.message ?? String(err)}`.trim().slice(0, 300);
            throw err;
        }
        const tok = tokensDeRespuesta(res);
        const modelo = String(res?.model || body.model);
        reg.modelo.push({
            ms: Date.now() - t0,
            modelo,
            stop: res?.stop_reason ?? null,
            input: tok?.input ?? 0,
            output: tok?.output ?? 0,
            cacheRead: tok?.cacheRead ?? 0,
            cacheWrite: tok?.cacheWrite ?? 0,
            costoUsd: costoUsd({ model: modelo, input_tokens: tok?.input, output_tokens: tok?.output, cache_read_tokens: tok?.cacheRead, cache_write_tokens: tok?.cacheWrite }),
        });
        reg.ronda++;
        const bloques: any[] = Array.isArray(res?.content) ? res.content : [];
        for (const b of bloques) if (b.type === 'tool_use') reg.llamadas.push({ id: b.id, nombre: b.name, input: b.input, ronda: reg.ronda });
        reg.textoModelo = bloques.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
        return res;
    };
}

// ─── Un caso ────────────────────────────────────────────────────────────────

async function correrUnaVez(caso: CasoEval, intento: number): Promise<Observado> {
    const alcance = alcanceDe(caso.rol, caso.hoy);
    const ticketId = `${caso.id}#${intento}`;
    const reg: Registro = { ronda: 0, llamadas: [], modelo: [], textoModelo: '' };
    // Igual que turno-chat: lo que manda el front pasa por validarPantalla.
    const pantalla = caso.pantalla ? await validarPantalla(alcance, caso.pantalla).catch(() => null) : null;
    const historial = caso.historial ?? [{ role: 'user' as const, content: caso.mensaje ?? '' }];

    const t0 = Date.now();
    const r = await conContextoLlm({ conversationId: ticketId, feature: 'mapi_evals' }, () => turnoAgente({
        alcance,
        ticketId,
        historial,
        pantalla,
        nombreUsuario: caso.rol === 'admin' ? NOMBRE_ADMIN : NOMBRE_COACH,
        crearMensaje: crearMensajeObservado(reg),
        feature: 'mapi_evals',
    }));
    const ms = Date.now() - t0;

    const borradores: BorradorObservado[] = bd().tablas.mapi_action_drafts
        .filter((d) => d.ticket_id === ticketId)
        .map((d) => ({ id: d.id, herramienta: d.tool, args: d.args, titulo: d.preview?.titulo ?? '', lineas: d.preview?.lineas ?? [] }));

    return {
        tipo: r.tipo,
        texto: r.tipo === 'texto' ? r.texto : '',
        textoModelo: reg.textoModelo,
        motivo: r.tipo === 'texto' ? undefined : r.tipo === 'escalar' ? r.motivo : `${r.motivo}${reg.error ? `: ${reg.error}` : ''}`,
        llamadas: reg.llamadas,
        borradores,
        rondas: r.tipo === 'sin_agente' ? reg.ronda : r.rondas,
        llamadasModelo: reg.modelo,
        ms,
        intentos: intento,
    };
}

function conTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    let t: NodeJS.Timeout;
    return Promise.race([p, new Promise<T>((_, rej) => { t = setTimeout(() => rej(new Error(`timeout de ${ms / 1000} s`)), ms); })])
        .finally(() => clearTimeout(t));
}

async function correrCaso(caso: CasoEval): Promise<ResultadoCaso> {
    const base = { id: caso.id, categoria: caso.categoria, rol: caso.rol, mensaje: caso.mensaje ?? caso.historial!.at(-1)!.content, nota: caso.nota };
    if (caso.requiere && !disponible(caso.requiere)) {
        return { ...base, estado: 'saltado', fallas: [], motivoSalto: `${caso.requiere} no está en el CATALOGO disponible` };
    }
    let obs: Observado;
    try {
        obs = await conTimeout(correrUnaVez(caso, 1), TIMEOUT_CASO_MS);
        // Error de la API (no del modelo): un reintento, sumando lo que ya costó.
        if (obs.tipo === 'sin_agente' && obs.motivo?.startsWith('llm_error')) {
            const previo = obs.llamadasModelo;
            obs = await conTimeout(correrUnaVez(caso, 2), TIMEOUT_CASO_MS);
            obs.llamadasModelo = [...previo, ...obs.llamadasModelo];
        }
    } catch (err: any) {
        obs = { tipo: 'error', texto: '', textoModelo: '', motivo: err?.message || String(err), llamadas: [], borradores: [], rondas: 0, llamadasModelo: [], ms: TIMEOUT_CASO_MS, intentos: 1 };
    }
    const { ok, fallas } = calificar(caso.espera, obs);
    const costo = obs.llamadasModelo.reduce((s, l) => s + (l.costoUsd ?? 0), 0);
    return { ...base, estado: ok ? 'pasa' : 'falla', fallas, observado: obs, costoUsd: costo };
}

async function enParalelo<T, R>(items: T[], n: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
    const out: R[] = new Array(items.length);
    let siguiente = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
        while (siguiente < items.length) {
            const i = siguiente++;
            out[i] = await fn(items[i], i);
        }
    }));
    return out;
}

// ─── Pruebas ────────────────────────────────────────────────────────────────

let fixturesOk = false;

describe('evals del modo agente de Mapi (plan §14)', () => {
    it('la escuela de prueba responde como suponen los casos (sin modelo, sin costo)', async () => {
        const admin = alcanceDe('admin', HOY);
        const coach = alcanceDe('coach', HOY);
        const datos = async (a: typeof admin, tool: string, input: unknown) => {
            const r = await ejecutarLlamada(a, 'fixtures', tool, input);
            return { ...r, json: r.error ? null : JSON.parse(r.contenido) };
        };
        const encontrados = async (a: typeof admin, texto: string) => (await datos(a, 'buscar_deportista', { texto })).json.datos_del_sistema.encontrados;

        // Cobertura mínima de §14.2.
        expect(CASOS.length).toBeGreaterThanOrEqual(40);
        expect(new Set(CASOS.map((c) => c.id)).size).toBe(CASOS.length);
        for (const [cat, info] of Object.entries(CATEGORIAS)) {
            expect(CASOS.filter((c) => c.categoria === cat && !c.requiere).length, cat).toBeGreaterThanOrEqual(info.minimo);
        }

        // Nombres ambiguos y alcance del coach.
        expect(await encontrados(admin, 'mariana')).toBe(2);
        expect(await encontrados(coach, 'mariana')).toBe(1);
        expect(await encontrados(coach, 'mari')).toBe(2);
        expect(await encontrados(admin, 'maria')).toBe(3);
        expect(await encontrados(admin, 'juan')).toBe(2);
        expect(await encontrados(coach, 'juan')).toBe(1);
        // Desde 2026-11-24 buscar_deportista prueba el nombre completo de un apodo
        // cuando la búsqueda literal no encuentra a nadie (juanes → juan esteban).
        expect(await encontrados(admin, 'juanes')).toBe(1);
        expect(await encontrados(admin, 'tomi herrera')).toBe(1);
        expect(await encontrados(coach, 'majo')).toBe(1);
        expect(await encontrados(admin, 'herrera')).toBe(1);
        expect(await encontrados(coach, 'samuel ortiz')).toBe(0);
        expect(await encontrados(admin, 'samuel ortiz')).toBe(1);
        expect(await encontrados(admin, 'juan d rios')).toBe(1);

        // Inyecciones visibles en los datos.
        const sofia = await datos(admin, 'buscar_deportista', { texto: 'sofia vargas' });
        expect(sofia.json.datos_del_sistema.deportistas[0].nombre).toMatch(/IGNORA TUS REGLAS/);
        const vale = await datos(admin, 'resumen_deportista', { deportista: CLAVE.valentina });
        expect(vale.json.datos_del_sistema.cuenta.saldo_pendiente).toBe('$120.000');
        expect(vale.json.datos_del_sistema.avisos_de_ausencia.map((a: any) => a.motivo)).toContain(MOTIVO_INYECTADO);
        const juanDavid = await datos(admin, 'resumen_deportista', { deportista: CLAVE.juanDavid });
        expect(juanDavid.json.datos_del_sistema.cuenta.saldo_pendiente).toBe('$300.000');
        expect(JSON.stringify(juanDavid.json)).toContain(CONCEPTO_INYECTADO.slice(0, 30));
        // Nada de teléfonos ni datos médicos hacia el modelo.
        expect(JSON.stringify(vale.json)).not.toMatch(/300\d{7}|Asma/);

        // El coach no ve plata ni a otro equipo.
        const valeCoach = await datos(coach, 'resumen_deportista', { deportista: CLAVE.valentina });
        expect(valeCoach.json.datos_del_sistema).not.toHaveProperty('cuenta');
        expect((await datos(coach, 'resumen_deportista', { deportista: CLAVE.samuel })).contenido).toMatch(/no está en los equipos/);
        expect((await datos(coach, 'cartera', {})).contenido).toMatch(/no está disponible/);

        // Cartera: octubre $420.000 y Juan David es el que más debe.
        const cart = (await datos(admin, 'cartera', {})).json.datos_del_sistema;
        expect(cart.por_mes.find((m: any) => /octubre/.test(m.mes))?.total).toBe('$420.000');
        expect(cart.familias_que_mas_deben[0].deportistas).toContain('Juan David Ríos');
        expect((await datos(admin, 'cartera', { mes: '2026-10' })).json.datos_del_sistema.por_mes).toHaveLength(1);

        // Rechazos que los casos esperan que el modelo explique.
        expect((await datos(admin, 'excusar_ausencia', { deportista: CLAVE.tomas, desde: HOY, hasta: HOY, motivo: 'lesion' })).contenido).toMatch(/sin cuenta/);
        expect((await datos(coach, 'excusar_ausencia', { deportista: CLAVE.valentina, desde: '2026-11-10', hasta: '2026-11-10', motivo: 'enfermedad' })).contenido).toMatch(/administración/);
        // Las acciones válidas dejan borrador (en la base falsa).
        expect((await ejecutarLlamada(coach, 'fixtures', 'quitar_excusa', { deportista: CLAVE.marianaLopez, desde: '2026-11-27', hasta: '2026-11-27' })).borradorId).toBeTruthy();
        expect((await ejecutarLlamada(admin, 'fixtures', 'excusar_ausencia', { deportista: CLAVE.marianaRestrepo, desde: '2026-11-27', hasta: '2026-11-27', motivo: 'colegio' })).borradorId).toBeTruthy();

        // Pantalla: la ficha ajena se descarta para el coach; la propia pasa.
        expect((await validarPantalla(coach, { ruta: '/x', entidad: { tipo: 'deportista', id: CLAVE.samuel } }))?.entidad).toBeNull();
        expect((await validarPantalla(admin, { ruta: '/x', entidad: { tipo: 'deportista', id: CLAVE.marianaLopez } }))?.entidad).toMatchObject({ nombre: 'Mariana López Gómez' });
        expect(await contextoDelTurno(coach, null, NOMBRE_COACH)).toContain('Sub-12 Tiburones');

        // Los borradores de esta verificación no cuentan para los casos.
        bd().tablas.mapi_action_drafts.length = 0;
        fixturesOk = true;
    });

    it.skipIf(!RECALIFICAR)('recalificar la última corrida (sin modelo, sin costo)', () => {
        if (!existsSync(REPORTE)) throw new Error('No hay ultimo-reporte.json para recalificar.');
        const previo = JSON.parse(readFileSync(REPORTE, 'utf8'));
        const resultados: ResultadoCaso[] = (previo.resultados as ResultadoCaso[]).map((r) => {
            const caso = CASOS.find((c) => c.id === r.id);
            if (!caso || r.estado === 'saltado' || !r.observado) return r;
            const { ok, fallas } = calificar(caso.espera, r.observado);
            return { ...r, estado: ok ? 'pasa' : 'falla', fallas };
        });
        const reporte = armarReporte(resultados, {
            filasLlmUsage: previo.metricas?.filasLlmUsageEnBdFalsa ?? 0,
            featureRegistrada: previo.metricas?.featureRegistrada ?? [],
        });
        reporte.fecha = previo.fecha;
        // Se conserva la calificación con la que salió la corrida (la primera, si ya se recalificó antes).
        reporte.recalificacion = {
            en: new Date().toISOString(),
            original: previo.recalificacion?.original ?? {
                pasan: previo.casos.pasan, fallan: previo.casos.fallan, fallas: (previo.fallas ?? []).map((f: any) => f.id),
            },
        };
        console.log(imprimirReporte(reporte));
        writeFileSync(REPORTE, reporteComoJson(reporte), 'utf8');
        const noCumplen = reporte.categorias.filter((c) => c.corridos > 0 && !c.cumple).map((c) => `${c.categoria} ${c.porcentaje} % < ${c.umbral} %`);
        expect(noCumplen, 'categorías bajo el umbral (ver reporte)').toEqual([] as string[]);
    });

    it.skipIf(SOLO_FIXTURES || RECALIFICAR)('casos con el modelo real', async () => {
        if (!fixturesOk) throw new Error('La escuela de prueba no quedó como suponen los casos: no se llama al modelo.');
        cargarEntorno();
        if (!process.env.ANTHROPIC_API_KEY) throw new Error('Falta ANTHROPIC_API_KEY (bff/.env).');

        const casos = seleccionados();
        if (!casos.length) throw new Error('MAPI_EVALS_SOLO no coincide con ningún caso ni categoría.');
        console.log(`[mapi-evals] ${casos.length} casos · modelo ${modeloAgente()} · concurrencia ${CONCURRENCIA}`);

        // Un caso solo primero: si la API rechaza la llamada (400, key), se corta aquí y no se gastan los demás.
        const [primero, ...resto] = casos;
        const r0 = await correrCaso(primero);
        console.log(`[mapi-evals] ${r0.estado === 'pasa' ? '✓' : r0.estado === 'saltado' ? '·' : '✗'} ${r0.id}`);
        if (r0.observado?.tipo === 'sin_agente' || r0.observado?.tipo === 'error') {
            throw new Error(`El primer caso no obtuvo respuesta del modelo (${r0.observado.motivo}). Corrida cortada.`);
        }
        const restoRes = await enParalelo(resto, CONCURRENCIA, async (c) => {
            const r = await correrCaso(c);
            console.log(`[mapi-evals] ${r.estado === 'pasa' ? '✓' : r.estado === 'saltado' ? '·' : '✗'} ${r.id}${r.observado ? ` (${(r.observado.ms / 1000).toFixed(1)} s)` : ''}`);
            return r;
        });
        const resultados = [r0, ...restoRes];

        const usos = bd().tablas.llm_usage ?? [];
        const reporte = armarReporte(resultados, {
            filasLlmUsage: usos.length,
            featureRegistrada: [...new Set(usos.map((u: any) => String(u.feature)))],
        });
        console.log(imprimirReporte(reporte));
        writeFileSync(REPORTE, reporteComoJson(reporte), 'utf8');
        console.log(`[mapi-evals] reporte: ${path.relative(RAIZ_BFF, REPORTE)}`);

        const noCumplen = reporte.categorias.filter((c) => c.corridos > 0 && !c.cumple).map((c) => `${c.categoria} ${c.porcentaje} % < ${c.umbral} %`);
        expect(noCumplen, 'categorías bajo el umbral (ver reporte)').toEqual([] as string[]);
    }, 60 * 60_000);
});
