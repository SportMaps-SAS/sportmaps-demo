/**
 * directo/enrutador — Mapi responde SIN modelo lo que ya resuelve una consulta
 * (docs/specs/mapi-consultas-sin-ia.md):
 *
 *   capa 1 · botón / menú de WhatsApp (`mapi:m:…`, `mapi:q:…`) → consulta fija;
 *   capa 2 · palabras clave reconocidas (app y WhatsApp)       → consulta fija;
 *   capa 3 · todo lo demás → `al_modelo` (turnoAgente, que ya trae la regla de alcance).
 *
 * Seguridad (lo que NO cambia): toda consulta pasa por `buscarHerramienta(nombre,
 * alcance)` —rol, flags de la escuela, sesión— y llama la MISMA `validar` +
 * `ejecutar` que usa el modelo, con el MISMO `Alcance`. La escuela sale de la
 * sesión; el coach ve sus equipos; la plata solo la administración. Un rechazo
 * de la herramienta se le muestra tal cual. Solo herramientas de tipo
 * 'consulta': ningún botón ni palabra de aquí prepara ni ejecuta una acción.
 *
 * Ids de botón (≠ los de las tarjetas `mapi:[cxl]:<borrador>:<código>` y de
 * escuela `mapi:e:<uuid>`, que maneja canal-whatsapp):
 *   · `mapi:m:<clave>`               opción del menú;
 *   · `mapi:q:<cod>:<arg>[:<arg2>]`  elegir entre varios (deportista, equipo, pago).
 * El id no autoriza nada: el argumento se vuelve a validar con el alcance del clic.
 */

import { buscarHerramienta } from '../registro';
import { RechazoHerramienta, type Alcance } from '../tipos';
import { coincideNombre } from '../deportistas';
import { fechaCorta, sumarDias } from '../fechas';
import { tareaUnicaDelMapa } from '../../../data/app-map';
import { reconocer, type Intencion, type TipoIntencion } from './intenciones';
import { sinModeloActivo } from './tope';
import * as P from './plantillas';
import type { CanalDirecto } from './plantillas';

// ─── Tipos ──────────────────────────────────────────────────────────────────

export interface OpcionDirecta {
    /** Id del botón o de la fila (WhatsApp). */
    id: string;
    titulo: string;
    descripcion?: string;
    /** En la app no hay botones: la frase que la persona puede escribir para elegirla. */
    ejemplo?: string;
}

export type EntradaDirecta = { texto: string } | { boton: string };

export type RespuestaDirecta =
    | { tipo: 'respuesta'; texto: string; botones?: OpcionDirecta[]; intencion: string; capa: 1 | 2 }
    | { tipo: 'elegir'; texto: string; opciones: OpcionDirecta[]; intencion: string; capa: 1 | 2 }
    | { tipo: 'al_modelo'; motivo: string };

// ─── Textos fijos ───────────────────────────────────────────────────────────

export const TEXTOS_DIRECTO = {
    soloAdminPlata: 'Los pagos solo los ve la administración de la escuela.',
    noDisponible: 'Esa consulta no está disponible para tu rol en esta escuela.',
    error: 'No pude obtener ese dato por un error del sistema. Intenta de nuevo en un rato.',
    opcionVencida: 'Esa opción ya no está disponible. Escríbeme lo que necesitas.',
    otro: 'Escríbeme el nombre completo (nombre y apellido) y lo busco de nuevo.',
    otroEquipo: 'Escríbeme el nombre del equipo, por ejemplo «asistencia de hoy de Sub 12».',
    menuApp: 'Esto te lo respondo al instante; escríbelo así:',
    menuWhatsApp: '¿Qué quieres consultar? Toca *Ver opciones* o escríbeme con tus palabras.',
    pieMenu: 'Para lo demás, escríbeme con tus palabras.',
} as const;

const AL_MODELO = (motivo: string): RespuestaDirecta => ({ tipo: 'al_modelo', motivo });

// ─── Contadores (sin PII) ───────────────────────────────────────────────────

const contadores = new Map<string, number>();

/** Log estructurado de qué capa resolvió el turno. Sin texto, nombres ni ids de personas. */
export function registrarCapa(e: { canal: CanalDirecto; capa: 1 | 2 | 3 | 'tope'; resultado: string; intencion?: string | null }): void {
    const clave = `${e.canal}|${e.capa}|${e.intencion ?? '-'}`;
    contadores.set(clave, (contadores.get(clave) ?? 0) + 1);
    console.info('[mapi-directo] capa', { feature: 'mapi_agente', canal: e.canal, capa: e.capa, intencion: e.intencion ?? null, resultado: e.resultado });
}

/** Turnos por canal|capa|intención desde que arrancó el proceso. */
export function contadoresDeCapas(): Record<string, number> {
    return Object.fromEntries(contadores);
}

export function _reiniciarContadores(): void {
    contadores.clear();
}

// ─── Herramientas: el MISMO camino que el modelo ────────────────────────────

type Resultado = { ok: true; datos: any } | { ok: false; motivo: 'no_disponible' | 'rechazo' | 'error'; texto: string };

/** buscarHerramienta (rol + flags) → validar → ejecutar, como `ejecutarLlamada` del agente. Solo consultas. */
export async function consultar(a: Alcance, nombre: string, args: Record<string, unknown>): Promise<Resultado> {
    const h = buscarHerramienta(nombre, a);
    if (!h || h.tipo !== 'consulta') return { ok: false, motivo: 'no_disponible', texto: TEXTOS_DIRECTO.noDisponible };
    try {
        const v = h.validar(args);
        return { ok: true, datos: await h.ejecutar(a, v) };
    } catch (err: any) {
        if (err instanceof RechazoHerramienta) return { ok: false, motivo: 'rechazo', texto: P.sinNombresInternos(err.message) };
        console.error(`[mapi-directo] ${nombre} falló:`, err?.message || String(err));
        return { ok: false, motivo: 'error', texto: TEXTOS_DIRECTO.error };
    }
}

/** Herramientas que usa cada intención (todas tienen que estar disponibles para este alcance). */
const HERRAMIENTAS: Record<Exclude<TipoIntencion, 'menu'>, string[]> = {
    ayuda: ['buscar_ayuda'],
    cartera: ['cartera'],
    debe: ['buscar_deportista', 'resumen_deportista'],
    resumen: ['buscar_deportista', 'resumen_deportista'],
    por_validar: ['pagos_por_validar'],
    por_que: ['pagos_por_validar', 'por_que_no_se_aprobo'],
    auditar: ['auditar_pendientes'],
    aprobacion_automatica: ['estado_aprobacion_automatica'],
    asistencia: ['asistencia_de_sesion'],
    semana: ['semana_del_equipo'],
    horarios: ['equipos_y_horarios'],
    clases_prueba: ['clases_de_prueba'],
    whatsapp: ['seguimiento_whatsapp'],
    reservas: ['reservas'],
    tienda: ['ventas_tienda'],
    inventario: ['inventario'],
    torneos: ['torneos'],
    servicios: ['ventas_de_servicio'],
    informes: ['buscar_deportista', 'informes_del_atleta'],
};

/** Consultas de plata: al entrenador se le responde lo mismo que la herramienta de pagos. */
const DE_PLATA = new Set<TipoIntencion>(['cartera', 'debe', 'por_validar', 'por_que', 'auditar', 'aprobacion_automatica']);

function permitida(a: Alcance, tipo: Exclude<TipoIntencion, 'menu'>): boolean {
    // «¿Cuánto debe X?»: resumen_deportista se le ofrece al coach, pero SIN la cuenta.
    if (tipo === 'debe' && a.rol !== 'admin') return false;
    return HERRAMIENTAS[tipo].every((n) => buscarHerramienta(n, a) !== null);
}

function textoNoPermitida(a: Alcance, tipo: TipoIntencion): string {
    return DE_PLATA.has(tipo) && a.rol !== 'admin' ? TEXTOS_DIRECTO.soloAdminPlata : TEXTOS_DIRECTO.noDisponible;
}

// ─── Menú (capa 1) ──────────────────────────────────────────────────────────

interface EntradaMenu { clave: string; titulo: string; descripcion: string; ejemplo: string; intencion: (hoy: string) => Intencion }

const MENU: EntradaMenu[] = [
    { clave: 'cartera', titulo: 'Quién debe', descripcion: 'Cartera vencida y familias en mora', ejemplo: 'quién debe', intencion: () => ({ tipo: 'cartera', mes: null }) },
    { clave: 'validar', titulo: 'Por validar', descripcion: 'Comprobantes que esperan aprobación', ejemplo: 'por validar', intencion: () => ({ tipo: 'por_validar' }) },
    { clave: 'auditar', titulo: 'Auditar comprobantes', descripcion: 'Propuesta para cada comprobante (no aprueba)', ejemplo: 'auditar comprobantes', intencion: () => ({ tipo: 'auditar' }) },
    { clave: 'asistencia', titulo: 'Asistencia de hoy', descripcion: 'Quién vino y quién faltó', ejemplo: 'asistencia de hoy', intencion: (hoy) => ({ tipo: 'asistencia', equipo: null, fecha: hoy }) },
    { clave: 'horarios', titulo: 'Equipos y horarios', descripcion: 'Sesiones de hoy y de mañana', ejemplo: 'horarios', intencion: () => ({ tipo: 'horarios' }) },
    { clave: 'semana', titulo: 'Semana del equipo', descripcion: 'Los próximos 7 días de un equipo', ejemplo: 'semana de Sub 12', intencion: () => ({ tipo: 'semana', equipo: null }) },
    { clave: 'prueba', titulo: 'Clases de prueba', descripcion: 'Agenda de los próximos 7 días', ejemplo: 'clases de prueba', intencion: () => ({ tipo: 'clases_prueba', fecha: null }) },
    { clave: 'whatsapp', titulo: 'WhatsApp sin responder', descripcion: 'Quién escribió y espera respuesta', ejemplo: 'sin responder', intencion: () => ({ tipo: 'whatsapp', dias: null }) },
    { clave: 'servicios', titulo: 'Ventas de servicios', descripcion: 'Clínicas, vacacionales: interesados y cupos', ejemplo: 'ventas de servicios', intencion: () => ({ tipo: 'servicios', item: null }) },
    { clave: 'torneos', titulo: 'Torneos', descripcion: 'Próximos torneos e inscritos', ejemplo: 'torneos', intencion: () => ({ tipo: 'torneos', estado: 'vigentes' }) },
    { clave: 'reservas', titulo: 'Reservas de hoy', descripcion: 'Canchas y espacios reservados y libres', ejemplo: 'reservas de hoy', intencion: (hoy) => ({ tipo: 'reservas', fecha: hoy, instalacion: null }) },
    { clave: 'tienda', titulo: 'Ventas de la tienda', descripcion: 'Pedidos y ventas del mes', ejemplo: 'ventas de la tienda', intencion: () => ({ tipo: 'tienda', mes: null }) },
    { clave: 'inventario', titulo: 'Inventario', descripcion: 'Lo agotado y lo que se está acabando', ejemplo: 'inventario', intencion: () => ({ tipo: 'inventario', producto: null }) },
    { clave: 'aprobacion', titulo: 'Aprobación automática', descripcion: 'Qué le falta a la escuela para encenderla', ejemplo: 'aprobación automática', intencion: () => ({ tipo: 'aprobacion_automatica' }) },
];

/** Orden por rol: la administración primero lo de plata; el entrenador, su cancha. */
const ORDEN_MENU: Record<Alcance['rol'], string[]> = {
    admin: ['cartera', 'validar', 'auditar', 'asistencia', 'horarios', 'prueba', 'whatsapp', 'servicios', 'torneos', 'reservas', 'tienda', 'inventario', 'semana', 'aprobacion'],
    coach: ['asistencia', 'horarios', 'semana', 'prueba'],
};

/** Máximo de filas de una lista de WhatsApp (Meta). */
export const MAX_FILAS_MENU = 10;

/** Opciones del menú que ESTE alcance puede usar (las que no, no se ofrecen). */
export function opcionesDelMenu(a: Alcance): EntradaMenu[] {
    return ORDEN_MENU[a.rol]
        .map((c) => MENU.find((m) => m.clave === c)!)
        .filter((m) => {
            const it = m.intencion(a.hoy);
            return it.tipo !== 'menu' && permitida(a, it.tipo);
        });
}

function menu(a: Alcance, canal: CanalDirecto, capa: 1 | 2): RespuestaDirecta {
    const ops = opcionesDelMenu(a);
    if (canal === 'whatsapp') {
        return {
            tipo: 'respuesta', capa, intencion: 'menu', texto: TEXTOS_DIRECTO.menuWhatsApp,
            botones: ops.slice(0, MAX_FILAS_MENU).map((m) => ({ id: `mapi:m:${m.clave}`, titulo: m.titulo, descripcion: m.descripcion, ejemplo: m.ejemplo })),
        };
    }
    const ejemplos = [...ops.map((m) => `- «${m.ejemplo}» — ${m.descripcion.toLowerCase()}`)];
    if (permitida(a, 'debe')) ejemplos.splice(1, 0, '- «cuánto debe Samuel» — la cuenta de un deportista');
    if (permitida(a, 'resumen')) ejemplos.push('- «cómo va Samuel» — asistencia e inscripción del mes');
    return { tipo: 'respuesta', capa, intencion: 'menu', texto: [TEXTOS_DIRECTO.menuApp, ...ejemplos, '', TEXTOS_DIRECTO.pieMenu].join('\n') };
}

// ─── Ids de botón ───────────────────────────────────────────────────────────

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const CLAVE = `(?:child|adult|unregistered):${UUID}`;
const RE_MENU = /^mapi:m:([a-z_]{2,20})$/;
const RE_DEPORTISTA = new RegExp(`^mapi:q:([dri]):(${CLAVE})(?::(\\d{4}-(?:0[1-9]|1[0-2])))?$`, 'i');
const RE_PAGO = new RegExp(`^mapi:q:p:(${UUID})$`, 'i');
const RE_ASISTENCIA = new RegExp(`^mapi:q:a:(${UUID}):(\\d{4}-\\d{2}-\\d{2})$`, 'i');
const RE_SEMANA = new RegExp(`^mapi:q:s:(${UUID})$`, 'i');
const RE_OTRO = /^mapi:q:o(?::([a-z]))?$/;

/** ¿Es un id de botón de ESTE módulo (menú o elegir)? Nunca uno de confirmar/cancelar/escuela. Pura. */
export function esBotonDeConsulta(id: string | null | undefined): boolean {
    return /^mapi:[mq]:/.test(String(id ?? ''));
}

const COD_DEPORTISTA = { debe: 'd', resumen: 'r', informes: 'i' } as const;
type IntencionDeportista = keyof typeof COD_DEPORTISTA;

// ─── Deportistas: búsqueda con la MISMA herramienta (apodos + fonética) ─────

type Resolucion<T> = { ok: true; valor: T } | { ok: false; respuesta: RespuestaDirecta };

const corto = (s: string, k: number) => (Array.from(s).length > k ? `${Array.from(s).slice(0, k - 1).join('')}…` : s);
const opcionOtro = (cod = ''): OpcionDirecta => ({ id: `mapi:q:o${cod ? `:${cod}` : ''}`, titulo: 'Otro' });

function frase(tipo: IntencionDeportista, nombre: string, mes: string | null): string {
    const enMes = mes ? ` en ${P.limpio(mes)}` : '';
    if (tipo === 'debe') return `cuánto debe ${nombre}${enMes}`;
    if (tipo === 'resumen') return `cómo va ${nombre}${enMes}`;
    return `informes de ${nombre}`;
}

function opcionesDeportistas(ds: any[], tipo: IntencionDeportista, mes: string | null): OpcionDirecta[] {
    return ds.slice(0, 3).map((d) => {
        const nombre = P.limpio(d.nombre, 60);
        const equipos = ((d.equipos ?? []) as unknown[]).map((e) => P.limpio(e, 30)).filter(Boolean).join(', ');
        return {
            id: `mapi:q:${COD_DEPORTISTA[tipo]}:${d.id}${mes ? `:${mes}` : ''}`,
            titulo: corto(nombre, 24),
            descripcion: [equipos, d.activo === false ? 'inactivo' : ''].filter(Boolean).join(' · ') || undefined,
            ejemplo: frase(tipo, nombre, mes),
        };
    });
}

async function resolverDeportistaPorNombre(
    a: Alcance, canal: CanalDirecto, capa: 1 | 2, tipo: IntencionDeportista, nombre: string, mes: string | null,
): Promise<Resolucion<string>> {
    const r = await consultar(a, 'buscar_deportista', { texto: nombre });
    if (!r.ok) return { ok: false, respuesta: { tipo: 'respuesta', capa, intencion: tipo, texto: r.texto } };
    const d = r.datos ?? {};
    const lista = (d.deportistas ?? []) as any[];
    const escrito = P.limpio(nombre, 60);
    const donde = a.rol === 'coach' ? 'en tus equipos' : 'en la escuela';

    if (!lista.length) {
        // Sugerencias: la misma búsqueda (literal, apodo y fonética) con la palabra más larga.
        const palabras = nombre.split(' ').filter((w) => w.length >= 3).sort((x, y) => y.length - x.length);
        if (palabras.length > 1) {
            const s = await consultar(a, 'buscar_deportista', { texto: palabras[0] });
            const sug = s.ok ? ((s.datos?.deportistas ?? []) as any[]) : [];
            if (sug.length) {
                return { ok: false, respuesta: {
                    tipo: 'elegir', capa, intencion: tipo,
                    texto: `No encontré a «${escrito}» ${donde}. ¿Es alguno de estos?`,
                    opciones: [...opcionesDeportistas(sug, tipo, mes), opcionOtro()],
                } };
            }
        }
        return { ok: false, respuesta: { tipo: 'respuesta', capa, intencion: tipo, texto: `No encontré a «${escrito}» ${donde}. Escríbeme nombre y apellido.` } };
    }
    if (Number(d.encontrados) > 8) {
        return { ok: false, respuesta: { tipo: 'respuesta', capa, intencion: tipo, texto: `Hay ${Number(d.encontrados)} deportistas que coinciden con «${escrito}». Escríbeme nombre y apellido.` } };
    }
    if (lista.length === 1 && !d.aproximado) return { ok: true, valor: String(lista[0].id) };
    return { ok: false, respuesta: {
        tipo: 'elegir', capa, intencion: tipo,
        texto: d.aproximado
            ? `Nadie se llama «${escrito}» tal cual. ¿Es alguno de estos?`
            : `Hay ${lista.length} con ese nombre${lista.length > 3 ? ' (te muestro 3)' : ''}. ¿Cuál es?`,
        opciones: [...opcionesDeportistas(lista, tipo, mes), opcionOtro()],
    } };
}

// ─── Equipos ────────────────────────────────────────────────────────────────

/** Sin equipo: el único del coach, o elegir entre los de la escuela (con la herramienta de equipos). */
async function elegirEquipo(a: Alcance, canal: CanalDirecto, capa: 1 | 2, cod: 'a' | 's', fecha: string | null): Promise<Resolucion<string>> {
    if (a.rol === 'coach' && a.teamIds.length === 1) return { ok: true, valor: a.teamIds[0] };
    const intencion = cod === 'a' ? 'asistencia' : 'semana';
    const r = await consultar(a, 'equipos_y_horarios', {});
    if (!r.ok) return { ok: false, respuesta: { tipo: 'respuesta', capa, intencion, texto: r.texto } };
    const equipos = (r.datos?.equipos ?? []) as any[];
    if (!equipos.length) return { ok: false, respuesta: { tipo: 'respuesta', capa, intencion, texto: P.limpio(r.datos?.nota, 200) || 'No hay equipos.' } };
    const hoyConEntreno = equipos.filter((e) => ((e.sesiones_hoy ?? []) as unknown[]).length > 0);
    const candidatos = cod === 'a' && fecha === a.hoy && hoyConEntreno.length ? hoyConEntreno : equipos;
    if (candidatos.length === 1) return { ok: true, valor: String(candidatos[0].id) };
    const cuando = fecha === a.hoy ? 'hoy' : fecha === sumarDias(a.hoy, -1) ? 'ayer' : fecha ? `del ${fechaCorta(fecha)}` : '';
    const opciones: OpcionDirecta[] = candidatos.slice(0, MAX_FILAS_MENU - 1).map((e) => {
        const nombre = P.limpio(e.nombre, 50);
        const hoy = ((e.sesiones_hoy ?? []) as unknown[]).map((s) => P.limpio(s, 30)).join(' · ');
        return {
            id: cod === 'a' ? `mapi:q:a:${e.id}:${fecha ?? a.hoy}` : `mapi:q:s:${e.id}`,
            titulo: corto(nombre, 24),
            descripcion: (cod === 'a' && hoy ? `hoy ${hoy}` : P.limpio(e.categoria, 40)) || undefined,
            ejemplo: cod === 'a' ? `asistencia ${cuando} de ${nombre}` : `semana de ${nombre}`,
        };
    });
    return { ok: false, respuesta: {
        tipo: 'elegir', capa, intencion,
        texto: cod === 'a' ? `¿De qué equipo quieres la asistencia${cuando ? ` de ${cuando}` : ''}?` : '¿De qué equipo quieres la semana?',
        opciones: [...opciones, opcionOtro('e')],
    } };
}

/** Un equipo escrito que la herramienta no conoce: puede que no fuera un equipo («asistencia de Samuel») → modelo. */
const NO_ES_EQUIPO = /^No encontré (un equipo|«)/;

// ─── Ejecutar una intención ─────────────────────────────────────────────────

const respuesta = (capa: 1 | 2, intencion: string, texto: string): RespuestaDirecta => ({ tipo: 'respuesta', capa, intencion, texto });

/** Resultado de la herramienta → plantilla; un rechazo o error, con su texto. */
function conPlantilla(capa: 1 | 2, intencion: string, r: Resultado, f: (d: any) => string): RespuestaDirecta {
    return respuesta(capa, intencion, r.ok ? f(r.datos) : r.texto);
}

async function ejecutarIntencion(a: Alcance, it: Intencion, canal: CanalDirecto, capa: 1 | 2): Promise<RespuestaDirecta> {
    if (it.tipo === 'menu') return menu(a, canal, capa);
    if (!permitida(a, it.tipo)) {
        // «¿Cómo hago…?» sin ayuda disponible: que lo resuelva el modelo con su mapa.
        if (it.tipo === 'ayuda') return AL_MODELO('ayuda_no_disponible');
        return respuesta(capa, it.tipo, textoNoPermitida(a, it.tipo));
    }

    switch (it.tipo) {
        case 'ayuda': {
            const t = tareaUnicaDelMapa(a.rol === 'admin' ? 'school' : 'coach', it.consulta);
            if (!t) return AL_MODELO('ayuda_sin_coincidencia');
            const pasos = P.limpio(t.pasos, 900);
            return respuesta(capa, it.tipo, P.unir([
                P.negrita(canal, P.limpio(t.tarea, 120)),
                pasos,
                t.articulo && canal === 'app' ? `[Guía paso a paso](/ayuda/${t.articulo})` : null,
            ]));
        }
        case 'cartera':
            return conPlantilla(capa, it.tipo, await consultar(a, 'cartera', it.mes ? { mes: it.mes } : {}), (d) => P.plantillaCartera(d, canal, it.mes));
        case 'debe':
        case 'resumen': {
            const id = await resolverDeportistaPorNombre(a, canal, capa, it.tipo, it.nombre, it.mes);
            if (!id.ok) return id.respuesta;
            return deportistaPorId(a, canal, capa, it.tipo, id.valor, it.mes);
        }
        case 'informes': {
            const id = await resolverDeportistaPorNombre(a, canal, capa, 'informes', it.nombre, null);
            if (!id.ok) return id.respuesta;
            return deportistaPorId(a, canal, capa, 'informes', id.valor, null);
        }
        case 'por_validar':
            return conPlantilla(capa, it.tipo, await consultar(a, 'pagos_por_validar', { sede: null, tipo: null }), (d) => P.plantillaPorValidar(d, canal));
        case 'por_que':
            return porQue(a, canal, capa, it.nombre);
        case 'auditar':
            return conPlantilla(capa, it.tipo, await consultar(a, 'auditar_pendientes', {}), (d) => P.plantillaAuditoria(d, canal));
        case 'aprobacion_automatica':
            return conPlantilla(capa, it.tipo, await consultar(a, 'estado_aprobacion_automatica', {}), (d) => P.plantillaAprobacionAutomatica(d, canal));
        case 'asistencia': {
            if (!it.equipo) {
                const e = await elegirEquipo(a, canal, capa, 'a', it.fecha);
                if (!e.ok) return e.respuesta;
                return asistenciaDe(a, canal, capa, e.valor, it.fecha);
            }
            const r = await consultar(a, 'asistencia_de_sesion', { equipo: it.equipo, fecha: it.fecha });
            if (!r.ok && r.motivo === 'rechazo' && NO_ES_EQUIPO.test(r.texto)) return AL_MODELO('equipo_desconocido');
            return conPlantilla(capa, it.tipo, r, (d) => P.plantillaAsistencia(d, canal));
        }
        case 'semana': {
            if (!it.equipo) {
                const e = await elegirEquipo(a, canal, capa, 's', null);
                if (!e.ok) return e.respuesta;
                return conPlantilla(capa, it.tipo, await consultar(a, 'semana_del_equipo', { equipo: e.valor }), (d) => P.plantillaSemana(d, canal));
            }
            const r = await consultar(a, 'semana_del_equipo', { equipo: it.equipo });
            if (!r.ok && r.motivo === 'rechazo' && NO_ES_EQUIPO.test(r.texto)) return AL_MODELO('equipo_desconocido');
            return conPlantilla(capa, it.tipo, r, (d) => P.plantillaSemana(d, canal));
        }
        case 'horarios':
            return conPlantilla(capa, it.tipo, await consultar(a, 'equipos_y_horarios', {}), (d) => P.plantillaHorarios(d, canal));
        case 'clases_prueba':
            return conPlantilla(capa, it.tipo, await consultar(a, 'clases_de_prueba', { fecha: it.fecha }), (d) => P.plantillaClasesPrueba(d, canal));
        case 'whatsapp':
            return conPlantilla(capa, it.tipo, await consultar(a, 'seguimiento_whatsapp', { dias: it.dias }), (d) => P.plantillaWhatsapp(d, canal));
        case 'reservas':
            return conPlantilla(capa, it.tipo, await consultar(a, 'reservas', { fecha: it.fecha, instalacion: it.instalacion }), (d) => P.plantillaReservas(d, canal));
        case 'tienda':
            return conPlantilla(capa, it.tipo, await consultar(a, 'ventas_tienda', { periodo: it.mes }), (d) => P.plantillaTienda(d, canal));
        case 'inventario':
            return conPlantilla(capa, it.tipo, await consultar(a, 'inventario', { producto: it.producto }), (d) => P.plantillaInventario(d, canal));
        case 'torneos':
            return conPlantilla(capa, it.tipo, await consultar(a, 'torneos', { estado: it.estado }), (d) => P.plantillaTorneos(d, canal));
        case 'servicios':
            return conPlantilla(capa, it.tipo, await consultar(a, 'ventas_de_servicio', { item: it.item }), (d) => P.plantillaServicios(d, canal));
    }
    return AL_MODELO('sin_intencion');
}

async function deportistaPorId(a: Alcance, canal: CanalDirecto, capa: 1 | 2, tipo: IntencionDeportista, clave: string, mes: string | null): Promise<RespuestaDirecta> {
    if (tipo === 'informes') {
        return conPlantilla(capa, tipo, await consultar(a, 'informes_del_atleta', { deportista: clave }), (d) => P.plantillaInformes(d, canal));
    }
    const r = await consultar(a, 'resumen_deportista', { deportista: clave, ...(mes ? { mes } : {}) });
    return conPlantilla(capa, tipo, r, (d) => (tipo === 'debe' ? P.plantillaDebe(d, canal) : P.plantillaResumen(d, canal)));
}

async function asistenciaDe(a: Alcance, canal: CanalDirecto, capa: 1 | 2, equipoId: string, fecha: string): Promise<RespuestaDirecta> {
    return conPlantilla(capa, 'asistencia', await consultar(a, 'asistencia_de_sesion', { equipo: equipoId, fecha }), (d) => P.plantillaAsistencia(d, canal));
}

/** «¿Por qué no se aprobó el de X?»: el pago sale de la MISMA cola que ve el modelo (pagos_por_validar). */
async function porQue(a: Alcance, canal: CanalDirecto, capa: 1 | 2, nombre: string | null): Promise<RespuestaDirecta> {
    const cola = await consultar(a, 'pagos_por_validar', { sede: null, tipo: null });
    if (!cola.ok) return respuesta(capa, 'por_que', cola.texto);
    const total = Number(cola.datos?.por_validar ?? 0);
    const lista = (cola.datos?.lista ?? []) as any[];
    if (!total) return respuesta(capa, 'por_que', 'No hay comprobantes por validar.');
    const candidatos = nombre ? lista.filter((x) => coincideNombre(P.limpio(x.deportista, 120), nombre)) : lista;
    if (nombre && !candidatos.length) {
        // La lista trae solo los primeros: si hay más en la cola, que busque el modelo.
        return total > lista.length ? AL_MODELO('por_que_fuera_de_la_lista') : respuesta(capa, 'por_que', `No veo comprobantes por validar de «${P.limpio(nombre, 60)}».`);
    }
    if (candidatos.length === 1) return porQueDePago(a, canal, capa, String(candidatos[0].pago));
    return {
        tipo: 'elegir', capa, intencion: 'por_que',
        texto: nombre ? `Hay ${candidatos.length} comprobantes por validar de «${P.limpio(nombre, 60)}». ¿Cuál?` : '¿De qué comprobante?',
        opciones: [
            ...candidatos.slice(0, 3).map((x) => ({
                id: `mapi:q:p:${x.pago}`,
                titulo: corto(P.limpio(x.deportista, 60), 24),
                descripcion: `${P.limpio(x.concepto, 40)} · ${P.limpio(x.cobro, 20)}`,
                ejemplo: `por qué no se aprobó el de ${P.limpio(x.deportista, 60)}`,
            })),
            opcionOtro(),
        ],
    };
}

async function porQueDePago(a: Alcance, canal: CanalDirecto, capa: 1 | 2, pago: string): Promise<RespuestaDirecta> {
    return conPlantilla(capa, 'por_que', await consultar(a, 'por_que_no_se_aprobo', { pago }), (d) => P.plantillaPorQue(d, canal));
}

// ─── Botones (capa 1) ───────────────────────────────────────────────────────

async function porBoton(a: Alcance, id: string, canal: CanalDirecto): Promise<RespuestaDirecta> {
    const s = id.trim();
    const m = RE_MENU.exec(s);
    if (m) {
        const op = MENU.find((x) => x.clave === m[1]);
        if (!op) return respuesta(1, 'boton_desconocido', TEXTOS_DIRECTO.opcionVencida);
        return ejecutarIntencion(a, op.intencion(a.hoy), canal, 1);
    }
    const d = RE_DEPORTISTA.exec(s);
    if (d) {
        const tipo = (Object.entries(COD_DEPORTISTA).find(([, c]) => c === d[1].toLowerCase())?.[0] ?? 'resumen') as IntencionDeportista;
        if (!permitida(a, tipo)) return respuesta(1, tipo, textoNoPermitida(a, tipo));
        return deportistaPorId(a, canal, 1, tipo, d[2].toLowerCase(), d[3] ?? null);
    }
    const p = RE_PAGO.exec(s);
    if (p) {
        if (!permitida(a, 'por_que')) return respuesta(1, 'por_que', textoNoPermitida(a, 'por_que'));
        return porQueDePago(a, canal, 1, p[1].toLowerCase());
    }
    const asis = RE_ASISTENCIA.exec(s);
    if (asis) {
        if (!permitida(a, 'asistencia')) return respuesta(1, 'asistencia', textoNoPermitida(a, 'asistencia'));
        return asistenciaDe(a, canal, 1, asis[1].toLowerCase(), asis[2]);
    }
    const sem = RE_SEMANA.exec(s);
    if (sem) {
        if (!permitida(a, 'semana')) return respuesta(1, 'semana', textoNoPermitida(a, 'semana'));
        return conPlantilla(1, 'semana', await consultar(a, 'semana_del_equipo', { equipo: sem[1].toLowerCase() }), (x) => P.plantillaSemana(x, canal));
    }
    const o = RE_OTRO.exec(s);
    if (o) return respuesta(1, 'otro', o[1] === 'e' ? TEXTOS_DIRECTO.otroEquipo : TEXTOS_DIRECTO.otro);
    return respuesta(1, 'boton_desconocido', TEXTOS_DIRECTO.opcionVencida);
}

// ─── Entrada ────────────────────────────────────────────────────────────────

/**
 * Capas 1 y 2: la respuesta sin modelo, o `al_modelo`. Nunca lanza: un error de
 * la base responde un texto fijo (el modelo tampoco tendría el dato).
 */
export async function responderSinModelo(a: Alcance, entrada: EntradaDirecta, canal: CanalDirecto): Promise<RespuestaDirecta> {
    if (!sinModeloActivo()) return AL_MODELO('apagado');
    const capa: 1 | 2 = 'boton' in entrada ? 1 : 2;
    let r: RespuestaDirecta;
    try {
        if ('boton' in entrada) {
            r = esBotonDeConsulta(entrada.boton) ? await porBoton(a, entrada.boton, canal) : respuesta(1, 'boton_desconocido', TEXTOS_DIRECTO.opcionVencida);
        } else {
            const it = reconocer(entrada.texto, a.hoy);
            r = it ? await ejecutarIntencion(a, it, canal, 2) : AL_MODELO('sin_intencion');
        }
    } catch (err: any) {
        console.error('[mapi-directo] la respuesta directa falló', { err: err?.message || String(err) });
        r = respuesta(capa, 'error', TEXTOS_DIRECTO.error);
    }
    if (r.tipo === 'al_modelo') registrarCapa({ canal, capa: 3, resultado: r.motivo });
    else registrarCapa({ canal, capa: r.capa, resultado: r.tipo, intencion: r.intencion });
    return r;
}

/** Cómo se ve en la app (sin botones): el texto, y si hay que elegir, la frase que elige cada opción. Pura. */
export function textoParaApp(r: Exclude<RespuestaDirecta, { tipo: 'al_modelo' }>): string {
    if (r.tipo === 'respuesta') return r.texto;
    const ops = r.opciones.filter((o) => o.ejemplo);
    return P.unir([
        r.texto,
        ...ops.map((o) => `- **${o.titulo}**${o.descripcion ? ` (${o.descripcion})` : ''}: escribe «${o.ejemplo}»`),
        r.opciones.some((o) => !o.ejemplo) ? 'Si no es ninguno, escríbeme el nombre completo.' : null,
    ]);
}
