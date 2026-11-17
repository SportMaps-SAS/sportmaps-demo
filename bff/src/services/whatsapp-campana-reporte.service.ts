/**
 * whatsapp-campana-reporte.service — el reporte básico de una campaña para la
 * escuela (fase F0.5 de docs/specs/whatsapp-autoservicio-escuelas-2026-11-15.md).
 *
 * POR QUÉ EXISTE
 *
 * La escuela autogestiona sus campañas. Para eso necesita ver, sin escribirle a
 * SportMaps: cuántos salieron, qué falta por salir y cuándo, a quién no se le
 * envió y por qué, qué falló y qué hacer, y qué tan cerca está del freno. Cada
 * fallo dice si «lo puedes corregir tú» o «lo revisa SportMaps».
 *
 * USA LO QUE YA SE GUARDA
 *
 * `whatsapp_campana_envios` (estado, motivo, proximo_intento_at), el estado de
 * entrega de `whatsapp_messages` y la RPC `wa_compradores_de_servicio`. No hay
 * tabla nueva. Lo que todavía no existe en la base viva (la columna
 * `servicio_id` y esa RPC llegan con la migración 20261115143758) se tolera:
 * «pagaron» vuelve `null` = sin dato. Nada de aquí lanza.
 *
 * DISK IO
 *
 * Una lectura del reporte son 6 consultas fijas (campaña, envíos paginados, dos
 * conteos de entrega, envíos de 24 h de la integración y, si la campaña vende
 * un servicio, la RPC). Ninguna por fila.
 *
 * EL AVISO AL EQUIPO DE SPORTMAPS (no es un caso de soporte)
 *
 * `avisarSoporteDeCampanas` corre al final del tick de campañas: UNA consulta
 * por tick para todas las campañas vivas y un correo al buzón de soporte por
 * campaña y tipo de error «lo revisa SportMaps». Lo que ya se avisó se recuerda
 * en `email_sends` (la reserva de `enviarConReserva`, id determinístico): no
 * necesita columna ni migración, y sirve entre los tres BFF y entre redeploys.
 *
 * Este archivo NO importa nada en tiempo de ejecución de
 * whatsapp-campanas.service (que lo llama desde el tick): solo tipos.
 */

import { supabase } from '../config/supabase';
import { dentroDeHorarioDeCobranza } from './whatsapp-plantillas.service';
import { esFestivoColombia } from '../utils/festivos-colombia';
import {
    MUESTRA_MINIMA, SALIERON, UMBRAL_BAJAS, UMBRAL_FALLOS, bajasFrenan, bajasQueFaltanParaElFreno,
} from './whatsapp-campanas-freno';
import { correosDeSoporte, enviarConReserva } from './avisos-correo.service';
import { nombreDeEscuela } from './plataforma-wa.service';
import { traducirErrorDeMeta, type QuienCorrige } from './whatsapp-errores-meta';
import type { EstadoCampana, EstadoEnvio } from './whatsapp-campanas.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Formas ──────────────────────────────────────────────────────────────────

export interface CampanaDelReporte {
    id: string;
    integration_id: string;
    school_id: string;
    nombre: string;
    plantilla: string;
    estado: EstadoCampana;
    destinatarios: number | null;
    aprobada_at: string | null;
    vence_at: string | null;
    pausa_motivo: string | null;
    servicio_id: string | null;
}

export interface EnvioDelReporte {
    contact_wa_id: string;
    estado: EstadoEnvio;
    motivo: string | null;
    proximo_intento_at: string | null;
    enviado_at: string | null;
}

export interface CompradorDeServicio { contact_wa_id: string; primer_pago_at: string | null }

export interface Senales24h { enviados: number; bajas: number; fallidos: number }

export interface GrupoPorSalir {
    motivo: string;
    texto: string;
    cantidad: number;
    /** Desde cuándo empiezan a salir (ya ajustado al horario permitido). null = saliendo ahora. */
    sale_desde_at: string | null;
    /** Hasta cuándo sale el último del grupo, si tienen fechas distintas. */
    sale_hasta_at: string | null;
    /** La fecha en palabras. */
    cuando: string;
    /** La campaña vence antes de esa fecha: esos mensajes no alcanzan a salir. */
    despues_de_vencer: boolean;
}

export interface GrupoNoEnviado {
    motivo: string; texto: string; que_hacer: string; quien: QuienCorrige;
    /** ¿La escuela tiene algo que hacer? false = nada que corregir (o lo revisa SportMaps). */
    requiere_accion: boolean;
    cantidad: number;
}

export interface GrupoFallido {
    clave: string;
    /** Código de error de Meta, si se supo. */
    codigo: number | null;
    texto: string;
    que_hacer: string;
    quien: QuienCorrige;
    /** ¿La escuela tiene algo que hacer? false = lo revisa SportMaps, o no tiene arreglo y no es una falla. */
    requiere_accion: boolean;
    cantidad: number;
}

export interface ReporteDeCampana {
    campana: {
        id: string; nombre: string; plantilla: string; estado: EstadoCampana;
        aprobada_at: string | null; vence_at: string | null; pausa_motivo: string | null; servicio_id: string | null;
    };
    generado_at: string;
    resumen: {
        destinatarios: number;
        enviados: number;
        /** null = no se pudo leer el estado de entrega. */
        entregados: number | null;
        leidos: number | null;
        respondieron: { si: number; luego: number; total: number };
        bajas_promos: number;
        /** null = la campaña no vende un servicio, o todavía no hay dato. */
        pagaron: { cantidad: number; desde: string; hasta: string } | null;
    };
    por_salir: {
        total: number;
        /** ¿Ahora mismo es horario de envío (L–V 7–19, sáb 8–15, sin domingos ni festivos)? */
        en_horario_ahora: boolean;
        proxima_ventana_at: string;
        /** Algo que cambia la lectura de las fechas (campaña en pausa, vencida…). */
        nota: string | null;
        grupos: GrupoPorSalir[];
    };
    no_enviados: { total: number; grupos: GrupoNoEnviado[] };
    fallidos: { total: number; grupos: GrupoFallido[] };
    inciertos: { cantidad: number; texto: string; que_hacer: string; quien: 'sportmaps' };
    /** Las tasas son de TODO el número de la escuela en las últimas 24 h. null = no se pudieron leer. */
    freno: {
        enviados_24h: number; bajas_24h: number; fallidos_24h: number;
        bajas_que_faltan: number; fallos_que_faltan: number;
        /** Con lo de hoy ya saltaría (o saltó) la pausa automática. */
        en_el_limite: boolean;
        texto: string;
    } | null;
    /** Se llena en una fase posterior. */
    lista_de_espera: null;
}

// ─── Horario (puras) ─────────────────────────────────────────────────────────

const COT_MS = 5 * 3600_000;
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

/**
 * El primer instante, igual o posterior a `desde`, en que las campañas pueden
 * salir: lunes a viernes 7:00–19:00, sábados 8:00–15:00, nunca domingos ni
 * festivos (el mismo horario del tick, `dentroDeHorarioDeCobranza`). Pura.
 */
export function proximaVentanaDeEnvio(desde: Date): Date {
    if (dentroDeHorarioDeCobranza(desde)) return desde;
    const cot = new Date(desde.getTime() - COT_MS);
    for (let i = 0; i < 15; i++) {
        const dia = new Date(Date.UTC(cot.getUTCFullYear(), cot.getUTCMonth(), cot.getUTCDate() + i));
        const semana = dia.getUTCDay();
        if (semana === 0) continue;
        const hora = semana === 6 ? 8 : 7;
        const apertura = new Date(dia.getTime() + hora * 3600_000 + COT_MS);
        if (apertura.getTime() < desde.getTime()) continue; // hoy ya cerró
        if (esFestivoColombia(apertura)) continue;
        return apertura;
    }
    return desde; // inalcanzable: no hay 15 días seguidos sin ventana
}

/** «martes 17 de noviembre, 7:00 a. m.» en hora de Colombia. Pura (sin depender del ICU del servidor). */
export function fechaEnPalabras(fecha: Date): string {
    const c = new Date(fecha.getTime() - COT_MS);
    const h = c.getUTCHours();
    const hora12 = h % 12 === 0 ? 12 : h % 12;
    const minutos = String(c.getUTCMinutes()).padStart(2, '0');
    return `${DIAS[c.getUTCDay()]} ${c.getUTCDate()} de ${MESES[c.getUTCMonth()]}, ${hora12}:${minutos} ${h < 12 ? 'a. m.' : 'p. m.'}`;
}

const mismoDiaCot = (a: Date, b: Date) =>
    new Date(a.getTime() - COT_MS).toISOString().slice(0, 10) === new Date(b.getTime() - COT_MS).toISOString().slice(0, 10);

// ─── Textos ──────────────────────────────────────────────────────────────────

/** Por qué un mensaje está esperando (sigue 'pendiente'). */
const TEXTO_POR_SALIR: Record<string, string> = {
    en_fila: 'En fila: salen de a poco, según el cupo de cada día',
    enviando: 'Saliendo en este momento',
    frecuencia: 'Ya recibieron otra campaña tuya hace poco: esperan los días mínimos entre una campaña y otra',
    ventana_abierta: 'Están conversando con tu escuela ahora mismo: se les envía después para no interrumpir la charla',
    escuela_escribio: 'Alguien de tu escuela les escribió hace poco: se les envía después para que no les llegue encima',
    meta_131049: 'Meta no se la entregó la primera vez: se reintenta una sola vez',
    reintento: 'Hubo un error al enviar: el sistema lo vuelve a intentar solo',
};

const TU_LISTA = 'No tienes que hacer nada.';

/** Por qué NO se le envió a alguien de la lista (estado 'omitido'). Motivos de `wa_campana_tomar_lote` y del tick. */
const NO_ENVIADOS: Record<string, { texto: string; que_hacer: string; quien: QuienCorrige }> = {
    baja: {
        texto: 'Pidieron no recibir más mensajes de tu escuela',
        que_hacer: `${TU_LISTA} Si alguno quiere volver, que te escriba ACTIVAR por WhatsApp.`,
        quien: 'escuela',
    },
    baja_promos: {
        texto: 'Pidieron no recibir más promociones',
        que_hacer: `${TU_LISTA} Los avisos de pago sí les siguen llegando. Si alguno quiere volver, que te escriba ACTIVAR.`,
        quien: 'escuela',
    },
    ya_compro: {
        texto: 'Ya pagaron o abonaron lo que ofrece esta campaña',
        que_hacer: `${TU_LISTA} No se les ofrece lo que ya compraron.`,
        quien: 'escuela',
    },
    bloqueado: {
        texto: 'Son contactos que tu escuela tiene bloqueados',
        que_hacer: 'Si fue un error, desbloquea el contacto desde el chat de WhatsApp.',
        quien: 'escuela',
    },
    marca_manual: {
        texto: 'Están marcados como familia, personal de la escuela u otro tipo de contacto, no como interesados',
        que_hacer: 'Si alguno sí es un interesado, cámbiale la marca desde el chat de WhatsApp antes de tu próxima campaña.',
        quien: 'escuela',
    },
    excluido: {
        texto: 'Salieron de tu lista de interesados (ya se inscribieron, dijeron que no les interesa o son de la escuela)',
        que_hacer: TU_LISTA,
        quien: 'escuela',
    },
    sin_optin: {
        texto: 'No han aceptado recibir mensajes de tu escuela',
        que_hacer: 'Solo se les puede escribir cuando acepten recibir mensajes.',
        quien: 'escuela',
    },
    campana_vencida: {
        texto: 'La campaña llegó a su fecha de cierre antes de que les tocara el turno',
        que_hacer: 'Si la oferta sigue en pie, crea una campaña nueva con otra fecha de cierre.',
        quien: 'escuela',
    },
    frecuencia: {
        texto: 'Ya habían recibido otra campaña tuya pocos días antes',
        que_hacer: 'Deja pasar unos días entre una campaña y otra para la misma lista.',
        quien: 'escuela',
    },
    no_interesa: {
        texto: 'Dijeron que no les interesa',
        que_hacer: TU_LISTA,
        quien: 'escuela',
    },
};

/** De los no enviados, en cuáles la escuela sí puede hacer algo (los demás son solo informativos). */
const CON_ACCION: ReadonlySet<string> = new Set(['bloqueado', 'marca_manual', 'campana_vencida', 'frecuencia']);

export const TEXTO_INCIERTO = 'No sabemos si salieron: el envío se interrumpió a la mitad';
export const QUE_HACER_INCIERTO = 'No se reenvían para no escribirle dos veces a la misma persona. El equipo de SportMaps ya recibió el aviso y lo revisa.';

// ─── Armado (puro) ───────────────────────────────────────────────────────────

/** Estados en los que el mensaje sí le salió a la persona. */
const CON_RESPUESTA_O_ENVIADO = new Set<EstadoEnvio>(['enviado', 'respondio_si', 'respondio_luego']);

/** ¿A esta persona sí se le envió? (la baja cuenta si salió: la pidió con el botón o Meta avisó después). Pura. */
export function seLeEnvio(e: Pick<EnvioDelReporte, 'estado' | 'enviado_at'>): boolean {
    return CON_RESPUESTA_O_ENVIADO.has(e.estado) || (e.estado === 'baja' && Boolean(e.enviado_at));
}

/** Cuántos fallos más (en 24 h) aguanta el número antes de la pausa automática. Pura; mínimo 0. */
export function fallosQueFaltanParaElFreno(enviados: number, fallidos: number): number {
    let extra = 0;
    // Un fallo más también cuenta como un envío más (así cuenta `leerSenales`).
    while (extra < 10_000 && (fallidos + extra) / Math.max(enviados + extra, MUESTRA_MINIMA) <= UMBRAL_FALLOS) extra++;
    return extra;
}

/** Cuántos pagaron o abonaron el servicio dentro de la vigencia, de aquellos a quienes SÍ se les envió. Pura. */
export function contarPagaron(p: {
    campana: Pick<CampanaDelReporte, 'servicio_id' | 'aprobada_at' | 'vence_at'>;
    envios: readonly EnvioDelReporte[];
    compradores: readonly CompradorDeServicio[] | null;
    ahora: Date;
}): ReporteDeCampana['resumen']['pagaron'] {
    if (!p.campana.servicio_id || !p.campana.aprobada_at || !p.compradores) return null;
    const desde = new Date(p.campana.aprobada_at).getTime();
    const vence = p.campana.vence_at ? new Date(p.campana.vence_at).getTime() : NaN;
    const hasta = Number.isFinite(vence) ? Math.min(vence, p.ahora.getTime()) : p.ahora.getTime();
    if (!Number.isFinite(desde)) return null;
    const enviados = new Set(p.envios.filter(seLeEnvio).map((e) => e.contact_wa_id));
    const pagaron = new Set<string>();
    for (const c of p.compradores) {
        const t = c.primer_pago_at ? new Date(c.primer_pago_at).getTime() : NaN;
        if (!Number.isFinite(t) || t < desde || t > hasta) continue;
        if (enviados.has(String(c.contact_wa_id))) pagaron.add(String(c.contact_wa_id));
    }
    return { cantidad: pagaron.size, desde: new Date(desde).toISOString(), hasta: new Date(hasta).toISOString() };
}

function motivoDePendiente(e: EnvioDelReporte, ahoraMs: number): string {
    if (e.estado === 'enviando') return 'enviando';
    const m = (e.motivo ?? '').trim();
    const futuro = e.proximo_intento_at ? new Date(e.proximo_intento_at).getTime() > ahoraMs : false;
    if (!m) return 'en_fila';
    if (m in TEXTO_POR_SALIR && m !== 'en_fila' && m !== 'enviando' && m !== 'reintento') return futuro ? m : 'en_fila';
    return futuro ? 'reintento' : 'en_fila';
}

/** Lo que falta por salir, agrupado por motivo y con la fecha ajustada al horario permitido. Pura. */
export function agruparPorSalir(p: {
    envios: readonly EnvioDelReporte[]; ahora: Date; venceAt: string | null;
}): GrupoPorSalir[] {
    const ahoraMs = p.ahora.getTime();
    const vence = p.venceAt ? new Date(p.venceAt).getTime() : NaN;
    const grupos = new Map<string, { cantidad: number; min: number; max: number }>();
    for (const e of p.envios) {
        if (e.estado !== 'pendiente' && e.estado !== 'enviando') continue;
        const motivo = motivoDePendiente(e, ahoraMs);
        const t = motivo === 'en_fila' || motivo === 'enviando' || !e.proximo_intento_at
            ? ahoraMs : Math.max(ahoraMs, new Date(e.proximo_intento_at).getTime());
        const g = grupos.get(motivo) ?? { cantidad: 0, min: t, max: t };
        g.cantidad++;
        g.min = Math.min(g.min, t);
        g.max = Math.max(g.max, t);
        grupos.set(motivo, g);
    }
    const orden = ['enviando', 'en_fila', 'reintento', 'meta_131049', 'ventana_abierta', 'escuela_escribio', 'frecuencia'];
    return [...grupos.entries()]
        .sort((a, b) => orden.indexOf(a[0]) - orden.indexOf(b[0]))
        .map(([motivo, g]) => {
            if (motivo === 'enviando') {
                return { motivo, texto: TEXTO_POR_SALIR[motivo], cantidad: g.cantidad, sale_desde_at: null, sale_hasta_at: null, cuando: 'Ahora', despues_de_vencer: false };
            }
            const desde = proximaVentanaDeEnvio(new Date(g.min));
            const hasta = proximaVentanaDeEnvio(new Date(g.max));
            const yaMismo = desde.getTime() === ahoraMs;
            let cuando: string;
            if (motivo === 'en_fila') {
                cuando = yaMismo
                    ? 'Hoy, de a poco y en horario de envío'
                    : `En la próxima ventana de envío: ${fechaEnPalabras(desde)}`;
            } else if (hasta.getTime() === desde.getTime() || mismoDiaCot(desde, hasta)) {
                cuando = yaMismo ? 'Hoy, en horario de envío' : `Desde el ${fechaEnPalabras(desde)}`;
            } else {
                cuando = `Entre el ${fechaEnPalabras(desde)} y el ${fechaEnPalabras(hasta)}`;
            }
            return {
                motivo, texto: TEXTO_POR_SALIR[motivo] ?? TEXTO_POR_SALIR.reintento, cantidad: g.cantidad,
                sale_desde_at: desde.toISOString(),
                sale_hasta_at: hasta.getTime() === desde.getTime() ? null : hasta.toISOString(),
                cuando,
                despues_de_vencer: Number.isFinite(vence) && desde.getTime() >= vence,
            };
        });
}

/** Los que no se enviaron (omitidos), por motivo en lenguaje simple. Pura. */
export function agruparNoEnviados(envios: readonly EnvioDelReporte[]): GrupoNoEnviado[] {
    const cuenta = new Map<string, number>();
    for (const e of envios) {
        if (e.estado !== 'omitido') continue;
        const m = (e.motivo ?? '').trim() || 'sin_motivo';
        cuenta.set(m, (cuenta.get(m) ?? 0) + 1);
    }
    return [...cuenta.entries()].sort((a, b) => b[1] - a[1]).map(([motivo, cantidad]) => {
        const t = NO_ENVIADOS[motivo];
        if (t) return { motivo, ...t, requiere_accion: CON_ACCION.has(motivo), cantidad };
        return {
            motivo, texto: 'No se enviaron por un motivo que no reconocemos',
            que_hacer: 'El equipo de SportMaps lo revisa.', quien: 'sportmaps' as const, requiere_accion: false, cantidad,
        };
    });
}

/** Los fallidos, por error de Meta traducido. Pura. */
export function agruparFallidos(envios: readonly Pick<EnvioDelReporte, 'estado' | 'motivo'>[]): GrupoFallido[] {
    const grupos = new Map<string, GrupoFallido>();
    for (const e of envios) {
        if (e.estado !== 'fallido') continue;
        const t = traducirErrorDeMeta(e.motivo);
        const g = grupos.get(t.clave);
        if (g) g.cantidad++;
        else grupos.set(t.clave, { ...t, cantidad: 1 });
    }
    return [...grupos.values()].sort((a, b) => b.cantidad - a.cantidad);
}

/** Qué tan cerca está el número de la pausa automática. Pura. */
export function resumenDelFreno(s: Senales24h | null): ReporteDeCampana['freno'] {
    if (!s) return null;
    const bajasFaltan = bajasQueFaltanParaElFreno(s.enviados, s.bajas);
    const fallosFaltan = fallosQueFaltanParaElFreno(s.enviados, s.fallidos);
    const enElLimite = bajasFrenan(s.enviados, s.bajas) || fallosFaltan === 0;
    const pct = Math.round(UMBRAL_BAJAS * 100);
    let texto: string;
    if (enElLimite) {
        texto = 'Ya se llegó al límite: el sistema pausa tus campañas para cuidar tu número.';
    } else if (s.enviados === 0) {
        texto = 'En las últimas 24 horas no ha salido ninguna campaña desde tu número.';
    } else {
        texto = `En las últimas 24 horas salieron ${s.enviados} mensajes de campaña desde tu número: `
            + `${s.bajas} ${s.bajas === 1 ? 'persona pidió' : 'personas pidieron'} no recibir más y ${s.fallidos} ${s.fallidos === 1 ? 'falló' : 'fallaron'}. `
            + `Tus campañas se pausan solas si ${bajasFaltan} ${bajasFaltan === 1 ? 'persona más pide' : 'personas más piden'} no recibir más `
            + `(el límite es más del ${pct} %) o si ${fallosFaltan} ${fallosFaltan === 1 ? 'mensaje más falla' : 'mensajes más fallan'}.`;
    }
    return {
        enviados_24h: s.enviados, bajas_24h: s.bajas, fallidos_24h: s.fallidos,
        bajas_que_faltan: bajasFaltan, fallos_que_faltan: fallosFaltan, en_el_limite: enElLimite, texto,
    };
}

/** Arma el reporte con todo ya leído. Pura. */
export function armarReporte(p: {
    campana: CampanaDelReporte;
    envios: readonly EnvioDelReporte[];
    entrega: { entregados: number; leidos: number } | null;
    compradores: readonly CompradorDeServicio[] | null;
    senales: Senales24h | null;
    ahora: Date;
}): ReporteDeCampana {
    const { campana, envios, ahora } = p;
    const cuenta = (estado: EstadoEnvio) => envios.reduce((n, e) => n + (e.estado === estado ? 1 : 0), 0);
    const si = cuenta('respondio_si');
    const luego = cuenta('respondio_luego');
    const enviados = envios.filter(seLeEnvio).length;
    const grupos = agruparPorSalir({ envios, ahora, venceAt: campana.vence_at });
    const porSalir = grupos.reduce((n, g) => n + g.cantidad, 0);
    const noEnviados = agruparNoEnviados(envios);
    const fallidos = agruparFallidos(envios);

    let nota: string | null = null;
    if (porSalir > 0) {
        if (campana.estado === 'pausada') nota = 'La campaña está en pausa: nada sale hasta que la reanudes.';
        else if (campana.estado === 'cancelada') nota = 'La campaña está cancelada: estos mensajes ya no salen.';
        else if (grupos.some((g) => g.despues_de_vencer)) nota = 'La campaña cierra antes de que salgan algunos de estos mensajes: los que no alcancen quedan sin enviar.';
    }

    return {
        campana: {
            id: campana.id, nombre: campana.nombre, plantilla: campana.plantilla, estado: campana.estado,
            aprobada_at: campana.aprobada_at, vence_at: campana.vence_at, pausa_motivo: campana.pausa_motivo,
            servicio_id: campana.servicio_id,
        },
        generado_at: ahora.toISOString(),
        resumen: {
            destinatarios: campana.destinatarios ?? envios.length,
            enviados,
            // Nunca más de lo que salió (un saliente repetido en el buzón no infla el número).
            entregados: p.entrega ? Math.min(p.entrega.entregados, enviados) : null,
            leidos: p.entrega ? Math.min(p.entrega.leidos, enviados) : null,
            respondieron: { si, luego, total: si + luego },
            bajas_promos: cuenta('baja'),
            pagaron: contarPagaron({ campana, envios, compradores: p.compradores, ahora }),
        },
        por_salir: {
            total: porSalir,
            en_horario_ahora: dentroDeHorarioDeCobranza(ahora),
            proxima_ventana_at: proximaVentanaDeEnvio(ahora).toISOString(),
            nota,
            grupos,
        },
        no_enviados: { total: noEnviados.reduce((n, g) => n + g.cantidad, 0), grupos: noEnviados },
        fallidos: { total: fallidos.reduce((n, g) => n + g.cantidad, 0), grupos: fallidos },
        inciertos: { cantidad: cuenta('incierto'), texto: TEXTO_INCIERTO, que_hacer: QUE_HACER_INCIERTO, quien: 'sportmaps' },
        freno: resumenDelFreno(p.senales),
        lista_de_espera: null,
    };
}

// ─── Lectura ─────────────────────────────────────────────────────────────────

const COLS_BASE = 'id, integration_id, school_id, nombre, plantilla, estado, destinatarios, aprobada_at, vence_at, pausa_motivo';

/** La campaña de ESA escuela. Tolera que `servicio_id` todavía no exista en la base (queda null). */
async function leerCampana(schoolId: string, campanaId: string): Promise<CampanaDelReporte | null> {
    const leer = (cols: string) => supabase.from('whatsapp_campanas').select(cols)
        .eq('id', campanaId).eq('school_id', schoolId).maybeSingle();
    let { data, error } = await leer(`${COLS_BASE}, servicio_id`);
    if (error) ({ data, error } = await leer(COLS_BASE));
    if (error || !data) return null;
    return { servicio_id: null, ...(data as any) } as CampanaDelReporte;
}

/** Todos los envíos de la campaña, de a 1000 (una columna de cinco, sin N+1). */
async function leerEnvios(campanaId: string): Promise<EnvioDelReporte[]> {
    const out: EnvioDelReporte[] = [];
    for (let desde = 0; desde < 100_000; desde += 1000) {
        const { data, error } = await supabase.from('whatsapp_campana_envios')
            .select('contact_wa_id, estado, motivo, proximo_intento_at, enviado_at')
            .eq('campana_id', campanaId).order('id', { ascending: true }).range(desde, desde + 999);
        if (error || !Array.isArray(data)) break;
        out.push(...(data as unknown as EnvioDelReporte[]));
        if (data.length < 1000) break;
    }
    return out;
}

/** Entregados y leídos según el webhook de estados (dos conteos, sin traer filas). null si no se pudo. */
async function leerEntrega(c: CampanaDelReporte): Promise<{ entregados: number; leidos: number } | null> {
    try {
        const contar = (estados: string[]) => {
            let q = supabase.from('whatsapp_messages').select('id', { count: 'exact', head: true })
                .eq('integration_id', c.integration_id)
                .eq('payload->>campana_id', c.id)
                .eq('payload->>step', 'campana')
                .in('status', estados);
            if (c.aprobada_at) q = q.gte('created_at', c.aprobada_at);
            return q;
        };
        const [entregados, leidos] = await Promise.all([contar(['delivered', 'read']), contar(['read'])]);
        if (entregados.error || leidos.error) return null;
        return { entregados: Number(entregados.count ?? 0), leidos: Number(leidos.count ?? 0) };
    } catch {
        return null;
    }
}

/** Compradores del servicio con la fecha de su primer pago. null = sin dato (la RPC aún no existe, o falló). */
async function leerCompradores(schoolId: string, servicioId: string | null): Promise<CompradorDeServicio[] | null> {
    if (!servicioId) return null;
    try {
        const { data, error } = await supabase.rpc('wa_compradores_de_servicio', { p_school_id: schoolId, p_item_id: servicioId });
        if (error || !Array.isArray(data)) return null;
        return (data as any[]).filter((f) => f && f.contact_wa_id)
            .map((f) => ({ contact_wa_id: String(f.contact_wa_id), primer_pago_at: f.primer_pago_at ?? null }));
    } catch {
        return null;
    }
}

/** Las tasas de 24 h de la integración, contadas igual que `leerSenales` (whatsapp-campanas-freno). */
async function leerSenales24h(integrationId: string, ahoraMs: number): Promise<Senales24h | null> {
    try {
        const { data, error } = await supabase.from('whatsapp_campana_envios')
            .select('estado')
            .eq('integration_id', integrationId)
            .gte('updated_at', new Date(ahoraMs - 24 * 3600_000).toISOString())
            .limit(5000);
        if (error || !Array.isArray(data)) return null;
        const s: Senales24h = { enviados: 0, bajas: 0, fallidos: 0 };
        for (const f of data as { estado: string }[]) {
            if (!SALIERON.has(f.estado)) continue;
            s.enviados++;
            if (f.estado === 'baja') s.bajas++;
            if (f.estado === 'fallido') s.fallidos++;
        }
        return s;
    } catch {
        return null;
    }
}

export type ResultadoReporte =
    | { ok: true; reporte: ReporteDeCampana }
    | { ok: false; status: number; error: string };

/** El reporte de una campaña de ESA escuela. Nunca lanza. */
export async function leerReporteDeCampana(schoolId: string, campanaId: string, ahora: Date = new Date()): Promise<ResultadoReporte> {
    try {
        if (!UUID.test(schoolId) || !UUID.test(campanaId)) return { ok: false, status: 400, error: 'id inválido' };
        const campana = await leerCampana(schoolId, campanaId);
        if (!campana) return { ok: false, status: 404, error: 'campana_no_encontrada' };
        if (campana.estado === 'borrador') return { ok: false, status: 409, error: 'sin_aprobar' };
        const [envios, entrega, compradores, senales] = await Promise.all([
            leerEnvios(campana.id),
            leerEntrega(campana),
            leerCompradores(schoolId, campana.servicio_id),
            leerSenales24h(campana.integration_id, ahora.getTime()),
        ]);
        return { ok: true, reporte: armarReporte({ campana, envios, entrega, compradores, senales, ahora }) };
    } catch (err: any) {
        console.error('[campana-reporte] no se pudo armar', { schoolId, campanaId, err: err?.message || err });
        return { ok: false, status: 500, error: 'No se pudo armar el reporte' };
    }
}

// ─── Aviso al equipo de SportMaps ────────────────────────────────────────────

export interface GrupoParaSoporte { clave: string; codigo: number | null; texto: string; cantidad: number }

/** De los fallidos e inciertos de UNA campaña, los grupos que revisa SportMaps. Pura. */
export function gruposParaSoporte(envios: readonly Pick<EnvioDelReporte, 'estado' | 'motivo'>[]): GrupoParaSoporte[] {
    const grupos: GrupoParaSoporte[] = agruparFallidos(envios).filter((g) => g.quien === 'sportmaps')
        .map((g) => ({ clave: g.clave, codigo: g.codigo, texto: g.texto, cantidad: g.cantidad }));
    const inciertos = envios.reduce((n, e) => n + (e.estado === 'incierto' ? 1 : 0), 0);
    if (inciertos > 0) grupos.push({ clave: 'incierto', codigo: null, texto: TEXTO_INCIERTO, cantidad: inciertos });
    return grupos;
}

/** La clave única de un aviso: una por campaña y tipo de error. Pura. */
export const claveDeAviso = (campanaId: string, claveDeError: string) => `wa_campana_soporte:${campanaId}:${claveDeError}`;

/** De estos grupos, los que todavía no se avisaron. Pura. */
export function gruposSinAvisar(campanaId: string, grupos: readonly GrupoParaSoporte[], avisadas: ReadonlySet<string>): GrupoParaSoporte[] {
    return grupos.filter((g) => !avisadas.has(claveDeAviso(campanaId, g.clave)));
}

/**
 * Lo ya avisado (o ya visto como avisado) por ESTE proceso: ahorra el INSERT de
 * la reserva en cada tick. La verdad entre procesos y redeploys es `email_sends`.
 */
const avisadasEnMemoria = new Set<string>();
/** Solo para pruebas. */
export function _olvidarAvisos(): void { avisadasEnMemoria.clear(); }

const frontendUrl = () => (process.env.FRONTEND_URL || 'https://app.sportmaps.co').replace(/\/$/, '');

/**
 * Al final del tick: si alguna campaña viva tiene fallidos o inciertos que
 * revisa SportMaps, manda UN correo al buzón de soporte por campaña y tipo de
 * error (no uno por mensaje), con el enlace, los conteos y el código de Meta.
 * Una consulta para todas las campañas. Nunca lanza. Devuelve cuántos mandó.
 */
export async function avisarSoporteDeCampanas(
    campanas: readonly { id: string; school_id: string; nombre: string }[],
): Promise<number> {
    let enviados = 0;
    try {
        if (!campanas.length) return 0;
        const { data, error } = await supabase.from('whatsapp_campana_envios')
            .select('campana_id, estado, motivo')
            .in('campana_id', campanas.map((c) => c.id))
            .in('estado', ['fallido', 'incierto'])
            .limit(5000);
        if (error || !Array.isArray(data) || data.length === 0) return 0;
        const porCampana = new Map<string, { estado: EstadoEnvio; motivo: string | null }[]>();
        for (const f of data as any[]) {
            const lista = porCampana.get(f.campana_id) ?? [];
            lista.push({ estado: f.estado, motivo: f.motivo ?? null });
            porCampana.set(f.campana_id, lista);
        }
        for (const c of campanas) {
            const todos = gruposParaSoporte(porCampana.get(c.id) ?? []);
            const nuevos = gruposSinAvisar(c.id, todos, avisadasEnMemoria);
            if (!nuevos.length) continue;
            const escuela = await nombreDeEscuela(c.school_id).catch(() => null);
            for (const g of nuevos) {
                const clave = claveDeAviso(c.id, g.clave);
                const r = await enviarConReserva({
                    clave, tipo: 'wa_campana_soporte', schoolId: c.school_id, refId: c.id,
                    destinos: correosDeSoporte(), data: {}, plantilla: null,
                    respaldo: {
                        subject: `[WhatsApp] Campaña con envíos por revisar: ${c.nombre}`,
                        titulo: 'Una campaña de WhatsApp tiene envíos que revisa SportMaps',
                        lineas: [
                            `Escuela: ${escuela || 'sin nombre'} (${c.school_id})`,
                            `Campaña: ${c.nombre} (${c.id})`,
                            `Qué pasó: ${g.texto}`,
                            `Código de error de Meta: ${g.codigo !== null ? `#${g.codigo}` : 'sin código'} (${g.clave})`,
                            `Mensajes con este problema hasta ahora: ${g.cantidad}`,
                            `Otros problemas de esta campaña que revisa SportMaps: ${todos.filter((o) => o.clave !== g.clave).map((o) => `${o.clave} × ${o.cantidad}`).join(', ') || 'ninguno'}`,
                            'Es un aviso único por campaña y tipo de error: no se repite aunque fallen más mensajes. La escuela ve en su reporte «Lo revisa SportMaps».',
                        ],
                        enlace: { url: `${frontendUrl()}/whatsapp?tab=campanas&campana=${c.id}`, texto: 'Ver la campaña' },
                    },
                });
                // 'duplicado' = ya lo avisó otro proceso o un tick anterior; 'fallo' = quedó reservado y no se repite.
                avisadasEnMemoria.add(clave);
                if (r === 'enviado') enviados++;
            }
        }
    } catch (err: any) {
        console.error('[campana-reporte] el aviso a soporte falló', { err: err?.message || err });
    }
    return enviados;
}
