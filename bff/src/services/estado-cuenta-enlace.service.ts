/**
 * estado-cuenta-enlace.service — el enlace público del estado de cuenta de una
 * familia (https://app.sportmaps.co/e/<token>) y su envío por correo.
 *
 * Plan: docs/specs/estado-de-cuenta-envio-a-familias.md. Migración
 * 20261112122901_estado_cuenta_enlaces (tabla + 2 RPC, solo service_role).
 *
 * Qué hace:
 *   · `vistaPublicaDeEnlace(token)`  → lo que ve la familia al abrir el enlace.
 *   · `enviarEstadoAFamilia(...)`    → lo que dispara la escuela con «Enviar al acudiente»
 *                                       (con `aplicar: false` solo simula: no escribe nada).
 *
 * Qué NO hace: decidir qué dato sale (eso es `estado-cuenta-enlace.contenido`, puro y
 * probado) ni cobrar nada (el «Pagar» abre el enlace de cobro que ya existe).
 *
 * Seguridad:
 *   · El token es la única credencial de la ruta pública; la escuela y los
 *     deportistas salen de la FILA del token, nunca de la URL ni del cuerpo.
 *   · Todo se lee con `school_id` de la fila: un id de otra escuela devuelve vacío.
 *   · El envío lo autoriza la ruta (rol de administración de ESA escuela); acá
 *     además se exige que el deportista tenga cobros en la escuela.
 *   · Lecturas en lote con `.in('id', ids)`: el costo no crece con las familias.
 *
 * Reglas de contacto (las mismas del estado de cuenta mensual): horario de
 * cobranza (L-V 7-19, sáb 8-15, nunca domingos ni festivos), un contacto por
 * familia y día, una reserva determinística en `email_sends` por familia y día.
 */

import { supabase } from '../config/supabase';
import { emailClient } from '../utils/emailClient';
import { buildBrandedEmail } from '../utils/emailLayout';
import { resolveSchoolBranding } from '../utils/schoolBrandingResolver';
import { appPublica, enlaceDeCobro, UrlNoPublicaError } from '../utils/url-publica-familias';
import { cerrarEnvio, reservarEnvio } from './avisos-correo.service';
import { dentroDeHorarioDeCobranza } from './whatsapp-plantillas.service';
import { emitirTokenCobro } from './cobro-enlace-publico.service';
import {
    COLUMNAS_CONTACTO_FICHA, COLUMNAS_CONTACTO_HIJO, contactoDeFicha, contactoDeHijoSinCuenta,
} from './contacto-acudiente';
import { contactosConEstadoDeCuentaHoy } from './estado-de-cuenta.service';
import {
    atletaPublico, claveEnvioEstadoEnlace, cuerpoCorreoEstadoEnlace, enmascararCorreo, hoyColombia,
    resumenParaCorreo, ventanaDe,
    type AsistenciaFila, type AtletaPublico, type PagoFila, type VistaEstadoPublico,
} from './estado-cuenta-enlace.contenido';

/** Formato del token que emite la RPC: 18 bytes → 24 caracteres base64url. */
export const TOKEN_ESTADO_RE = /^[A-Za-z0-9_-]{24}$/;
export const TIPO_ENVIO_ESTADO_ENLACE = 'estado_cuenta_enlace';
export const MESES_VENTANA = 12;
/** Vigencia del enlace (plan D3). */
const DIAS_VIGENCIA = 60;

export type TipoAtleta = 'hijo' | 'adulto' | 'ficha';
export interface AtletaRef { tipo: TipoAtleta; id: string }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Valida el arreglo `atletas` que guarda el token (también lo usa la prueba de la ruta). */
export function atletasValidos(x: unknown): AtletaRef[] | null {
    if (!Array.isArray(x) || x.length === 0 || x.length > 20) return null;
    const out: AtletaRef[] = [];
    for (const a of x) {
        if (!a || typeof a !== 'object') return null;
        const { tipo, id } = a as Record<string, unknown>;
        if ((tipo !== 'hijo' && tipo !== 'adulto' && tipo !== 'ficha') || typeof id !== 'string' || !UUID_RE.test(id)) return null;
        out.push({ tipo, id });
    }
    return out;
}

const enlaceDeEstado = (appBase: string, token: string) => `${appBase}/e/${encodeURIComponent(token)}`;

const trozos = <T,>(a: T[], n = 200) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, (i + 1) * n));

const COLUMNAS_PAGO =
    'id, status, amount, amount_paid, late_fee_amount, concept, due_date, payment_date, period_year, period_month, created_at, '
    + 'payment_method, payment_channel, payment_provider, receipt_url, wompi_reference, wompi_transaction_id, provider_transaction_id, '
    + 'child_id, user_id, unregistered_athlete_id, parent_id';

type PagoConIds = PagoFila & { id: string; child_id: string | null; user_id: string | null; unregistered_athlete_id: string | null; parent_id: string | null };

// ─────────────────────────────────────────────────────────────────────────────
// Token: emitir y resolver (RPC solo service_role)
// ─────────────────────────────────────────────────────────────────────────────

export async function emitirEnlaceEstado(p: {
    schoolId: string; familiaClave: string; atletas: AtletaRef[]; creadoPor: string | null; meses?: number;
}): Promise<{ token: string; venceEn: string } | null> {
    // Orden estable: la RPC compara el jsonb para decidir si reusa el enlace.
    const atletas = [...p.atletas].sort((a, b) => `${a.tipo}:${a.id}`.localeCompare(`${b.tipo}:${b.id}`));
    try {
        const { data, error } = await supabase.rpc('estado_cuenta_enlace_emitir', {
            p_school_id: p.schoolId,
            p_familia_clave: p.familiaClave,
            p_atletas: atletas,
            p_meses: p.meses ?? MESES_VENTANA,
            p_created_by: p.creadoPor,
            p_dias: DIAS_VIGENCIA,
        });
        if (error) {
            console.warn('[estado-cuenta-enlace] no se pudo emitir el enlace', { schoolId: p.schoolId, error: error.message });
            return null;
        }
        const fila: any = Array.isArray(data) ? data[0] : data;
        const token = fila?.enlace_token;
        return typeof token === 'string' && TOKEN_ESTADO_RE.test(token) ? { token, venceEn: String(fila.vence_en) } : null;
    } catch (e: any) {
        console.warn('[estado-cuenta-enlace] emitir lanzó', { error: e?.message });
        return null;
    }
}

export type ResolucionEnlace =
    | { estado: 'no_existe' | 'vencido' | 'revocado' }
    | { estado: 'vigente'; schoolId: string; atletas: AtletaRef[]; meses: number; venceEn: string };

export async function resolverEnlaceEstado(token: string): Promise<ResolucionEnlace> {
    if (!TOKEN_ESTADO_RE.test(token)) return { estado: 'no_existe' };
    const { data, error } = await supabase.rpc('estado_cuenta_enlace_resolver', { p_token: token });
    // Sin tabla (migración sin aplicar) o cualquier error: «no existe», igual que un token inventado.
    if (error) return { estado: 'no_existe' };
    const fila: any = Array.isArray(data) ? data[0] : data;
    if (!fila) return { estado: 'no_existe' };
    if (fila.estado === 'vencido' || fila.estado === 'revocado') return { estado: fila.estado };
    const atletas = atletasValidos(fila.atletas);
    if (fila.estado !== 'vigente' || !atletas || !fila.school_id) return { estado: 'no_existe' };
    return { estado: 'vigente', schoolId: String(fila.school_id), atletas, meses: Number(fila.meses) || MESES_VENTANA, venceEn: String(fila.vence_en) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Lectura en lote de una familia
// ─────────────────────────────────────────────────────────────────────────────

async function leerPorIds(tabla: string, columnas: string, ids: string[]): Promise<any[]> {
    const out: any[] = [];
    for (const t of trozos(ids)) {
        const { data, error } = await (supabase.from(tabla) as any).select(columnas).in('id', t);
        if (error) throw new Error(error.message);
        out.push(...(data ?? []));
    }
    return out;
}

async function leerPagos(schoolId: string, columna: 'child_id' | 'user_id' | 'unregistered_athlete_id', ids: string[]): Promise<PagoConIds[]> {
    const out: PagoConIds[] = [];
    for (const t of trozos(ids)) {
        const { data, error } = await (supabase.from('payments') as any)
            .select(COLUMNAS_PAGO).eq('school_id', schoolId).in(columna, t).order('due_date');
        if (error) throw new Error(error.message);
        out.push(...((data ?? []) as PagoConIds[]));
    }
    return out;
}

async function leerAsistencia(schoolId: string, columna: 'child_id' | 'user_id' | 'unregistered_athlete_id', ids: string[], desde: string):
    Promise<Array<AsistenciaFila & { child_id: string | null; user_id: string | null; unregistered_athlete_id: string | null }>> {
    const out: any[] = [];
    for (const t of trozos(ids)) {
        const { data, error } = await (supabase.from('attendance_records') as any)
            .select(`attendance_date, status, child_id, user_id, unregistered_athlete_id`)
            .eq('school_id', schoolId).in(columna, t).gte('attendance_date', desde);
        if (error) throw new Error(error.message);
        out.push(...(data ?? []));
    }
    return out;
}

const idsDe = (atletas: AtletaRef[], tipo: TipoAtleta) => atletas.filter((a) => a.tipo === tipo).map((a) => a.id);

/**
 * Los deportistas de la familia, ya recortados para publicar, y el id del cobro
 * abierto más viejo (para el botón «Pagar»; ese id NO sale en la vista).
 */
export async function leerFamilia(schoolId: string, atletas: AtletaRef[], ahora: Date, meses = MESES_VENTANA):
    Promise<{ atletas: AtletaPublico[]; cobroAbiertoId: string | null; desde: string; hasta: string }> {
    const { desde, hasta } = ventanaDe(ahora, meses);
    const hijos = idsDe(atletas, 'hijo');
    const adultos = idsDe(atletas, 'adulto');
    const fichas = idsDe(atletas, 'ficha');

    const [nHijos, nPerfiles, nFichas, pHijos, pAdultos, pFichas, aHijos, aAdultos, aFichas] = await Promise.all([
        leerPorIds('children', 'id, full_name', hijos),
        leerPorIds('profiles', 'id, full_name', adultos),
        leerPorIds('unregistered_athletes', 'id, full_name', fichas),
        hijos.length ? leerPagos(schoolId, 'child_id', hijos) : [],
        adultos.length ? leerPagos(schoolId, 'user_id', adultos) : [],
        fichas.length ? leerPagos(schoolId, 'unregistered_athlete_id', fichas) : [],
        hijos.length ? leerAsistencia(schoolId, 'child_id', hijos, desde) : [],
        adultos.length ? leerAsistencia(schoolId, 'user_id', adultos, desde) : [],
        fichas.length ? leerAsistencia(schoolId, 'unregistered_athlete_id', fichas, desde) : [],
    ]);

    const nombres = new Map<string, string>([...nHijos, ...nPerfiles, ...nFichas].map((r) => [r.id, r.full_name]));
    // Un cobro de un menor puede traer también el user_id del acudiente: manda child_id / ficha.
    const pagosDe = (a: AtletaRef): PagoConIds[] => {
        if (a.tipo === 'hijo') return pHijos.filter((p) => p.child_id === a.id);
        if (a.tipo === 'ficha') return pFichas.filter((p) => p.unregistered_athlete_id === a.id);
        return pAdultos.filter((p) => p.user_id === a.id && !p.child_id && !p.unregistered_athlete_id);
    };
    const asistenciaDe = (a: AtletaRef) => {
        if (a.tipo === 'hijo') return aHijos.filter((r) => r.child_id === a.id);
        if (a.tipo === 'ficha') return aFichas.filter((r) => r.unregistered_athlete_id === a.id);
        return aAdultos.filter((r) => r.user_id === a.id);
    };

    const abiertos: PagoConIds[] = [];
    const publicos = atletas.map((a) => {
        const pagos = pagosDe(a);
        abiertos.push(...pagos.filter((p) => ['pending', 'overdue', 'partial'].includes(p.status)));
        return atletaPublico({ nombreCompleto: nombres.get(a.id) ?? null, pagos, asistencia: asistenciaDe(a), desde });
    });
    abiertos.sort((x, y) => String(x.due_date ?? '9999').localeCompare(String(y.due_date ?? '9999')));
    return { atletas: publicos, cobroAbiertoId: abiertos[0]?.id ?? null, desde, hasta };
}

// ─────────────────────────────────────────────────────────────────────────────
// Lo que ve la familia
// ─────────────────────────────────────────────────────────────────────────────

export type ResultadoVista =
    | { estado: 'no_existe' | 'vencido' | 'revocado' }
    | { estado: 'vigente'; vista: VistaEstadoPublico };

export async function vistaPublicaDeEnlace(token: string, ahora: Date = new Date()): Promise<ResultadoVista> {
    const r = await resolverEnlaceEstado(token);
    if (r.estado !== 'vigente') return { estado: r.estado };

    const [branding, familia] = await Promise.all([
        resolveSchoolBranding(r.schoolId),
        leerFamilia(r.schoolId, r.atletas, ahora, r.meses),
    ]);
    // Los atletas de un enlace vigente que ya no tienen ni un cobro en la escuela no se publican vacíos.
    if (familia.atletas.every((a) => a.cobros.length === 0 && Object.keys(a.asistencia).length === 0)) return { estado: 'no_existe' };

    let pagarUrl: string | null = null;
    if (familia.cobroAbiertoId) {
        const tokenCobro = await emitirTokenCobro(familia.cobroAbiertoId);
        if (tokenCobro) pagarUrl = enlaceDeCobro(appPublica(), tokenCobro);
    }
    return {
        estado: 'vigente',
        vista: {
            escuela: {
                nombre: branding.schoolName.replace(/&amp;/g, '&'),
                logoUrl: branding.logoUrl,
                colorPrimario: branding.primaryColor,
                mostrarMarcaSportmaps: branding.showWatermark,
            },
            generadoEn: ahora.toISOString(),
            periodo: { desde: familia.desde, hasta: familia.hasta, meses: r.meses },
            enlaceVenceEn: r.venceEn,
            atletas: familia.atletas,
            pagarUrl,
        },
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// A quién se le manda
// ─────────────────────────────────────────────────────────────────────────────

export interface FamiliaDestino {
    /** Correo en minúscula, o 'wa:<wa_id>' si no hay correo (misma clave que el estado de cuenta mensual). */
    clave: string;
    email: string | null;
    nombre: string;
    atletas: AtletaRef[];
}

export type ErrorFamilia = 'no_pertenece' | 'sin_contacto';

/**
 * Resuelve la familia de UN deportista: su contacto (el del acudiente si es menor)
 * y todos los hermanos con cobros en la escuela. Devuelve un error si el
 * deportista no tiene cobros en ESTA escuela (nunca se manda nada de otra).
 */
export async function familiaDeAtleta(schoolId: string, atleta: AtletaRef, ahora: Date = new Date()): Promise<FamiliaDestino | { error: ErrorFamilia }> {
    const columna = atleta.tipo === 'hijo' ? 'child_id' : atleta.tipo === 'ficha' ? 'unregistered_athlete_id' : 'user_id';
    const { data: propios } = await (supabase.from('payments') as any)
        .select('id, parent_id').eq('school_id', schoolId).eq(columna, atleta.id).limit(50);
    if (!propios || propios.length === 0) return { error: 'no_pertenece' };

    const hoy = hoyColombia(ahora);
    let email = '';
    let nombre = '';
    let hermanos: AtletaRef[] = [];

    if (atleta.tipo === 'hijo') {
        const [hijo] = await leerPorIds('children', `id, parent_id, ${COLUMNAS_CONTACTO_HIJO}`, [atleta.id]);
        if (!hijo) return { error: 'no_pertenece' };
        const perfilId: string | null = hijo.parent_id || propios.find((p: any) => p.parent_id)?.parent_id || null;
        const [perfil] = perfilId ? await leerPorIds('profiles', 'id, full_name, email', [perfilId]) : [];
        const temp = contactoDeHijoSinCuenta(hijo);
        email = String(perfil?.email || temp.email || '').trim().toLowerCase();
        nombre = perfil?.full_name || temp.nombre || 'Familia';
        hermanos = [{ tipo: 'hijo', id: atleta.id }];
        if (perfilId) {
            const { data: otros } = await (supabase.from('payments') as any)
                .select('child_id, unregistered_athlete_id').eq('school_id', schoolId).eq('parent_id', perfilId).limit(1000);
            for (const o of otros ?? []) {
                if (o.child_id) hermanos.push({ tipo: 'hijo', id: o.child_id });
                else if (o.unregistered_athlete_id) hermanos.push({ tipo: 'ficha', id: o.unregistered_athlete_id });
            }
        }
    } else if (atleta.tipo === 'ficha') {
        const [ficha] = await leerPorIds('unregistered_athletes', `id, ${COLUMNAS_CONTACTO_FICHA}`, [atleta.id]);
        if (!ficha) return { error: 'no_pertenece' };
        const c = contactoDeFicha(ficha, hoy);
        email = String(c.email || '').trim().toLowerCase();
        nombre = c.nombre || 'Familia';
        hermanos = [{ tipo: 'ficha', id: atleta.id }];
    } else {
        const [perfil] = await leerPorIds('profiles', 'id, full_name, email', [atleta.id]);
        if (!perfil) return { error: 'no_pertenece' };
        email = String(perfil.email || '').trim().toLowerCase();
        nombre = perfil.full_name || 'Deportista';
        hermanos = [{ tipo: 'adulto', id: atleta.id }];
    }

    const unicos = new Map(hermanos.map((a) => [`${a.tipo}:${a.id}`, a]));
    const atletas = [...unicos.values()].slice(0, 20);
    if (!email.includes('@')) return { clave: '', email: null, nombre, atletas };
    return { clave: email, email, nombre, atletas };
}

// ─────────────────────────────────────────────────────────────────────────────
// Envío (o simulación)
// ─────────────────────────────────────────────────────────────────────────────

export type MotivoNoEnvio =
    | 'no_pertenece' | 'sin_correo' | 'fuera_de_horario' | 'ya_enviado_hoy' | 'contactada_hoy' | 'no_disponible' | 'fallo_envio';

export const MENSAJE_NO_ENVIO: Record<MotivoNoEnvio, string> = {
    no_pertenece: 'Este deportista no tiene cobros en la escuela.',
    sin_correo: 'Esta familia no tiene un correo registrado. Agrégalo en la ficha del deportista para poder enviarle el estado de cuenta.',
    fuera_de_horario: 'Fuera del horario de cobranza (lunes a viernes 7-19, sábado 8-15, sin domingos ni festivos). No se envió nada.',
    ya_enviado_hoy: 'Ya se le envió el estado de cuenta a esta familia hoy. Si necesitas mandarlo otra vez, usa «Reenviar».',
    contactada_hoy: 'Esta familia ya recibió un estado de cuenta hoy: solo se le contacta una vez al día.',
    no_disponible: 'El envío del estado de cuenta todavía no está disponible. Inténtalo más tarde.',
    fallo_envio: 'No se pudo enviar el correo. Inténtalo de nuevo en unos minutos.',
};

export type ResultadoEnvio =
    | { ok: true; simulado: boolean; canal: 'correo'; destino: string; atletas: string[]; vigenciaDias: number }
    | { ok: false; motivo: MotivoNoEnvio; mensaje: string };

const noEnvio = (motivo: MotivoNoEnvio): ResultadoEnvio => ({ ok: false, motivo, mensaje: MENSAJE_NO_ENVIO[motivo] });

export interface PedidoEnvio {
    schoolId: string;
    atleta: AtletaRef;
    creadoPor: string;
    /** false = simulación: no emite el enlace, no reserva, no manda. */
    aplicar: boolean;
    reenviar?: boolean;
    ahora?: Date;
}

export async function enviarEstadoAFamilia(p: PedidoEnvio): Promise<ResultadoEnvio> {
    const ahora = p.ahora ?? new Date();
    const appBase = appPublica(); // lanza UrlNoPublicaError si no es https pública: la ruta lo convierte en 503

    const familia = await familiaDeAtleta(p.schoolId, p.atleta, ahora);
    if ('error' in familia) return noEnvio(familia.error === 'no_pertenece' ? 'no_pertenece' : 'sin_correo');
    if (!familia.email) return noEnvio('sin_correo');

    const [branding, datos] = await Promise.all([
        resolveSchoolBranding(p.schoolId),
        leerFamilia(p.schoolId, familia.atletas, ahora, MESES_VENTANA),
    ]);
    const escuela = branding.schoolName.replace(/&amp;/g, '&');
    const nombresCortos = datos.atletas.map((a) => a.nombre);
    const vistaPrevia: ResultadoEnvio = {
        ok: true, simulado: !p.aplicar, canal: 'correo', destino: enmascararCorreo(familia.email), atletas: nombresCortos, vigenciaDias: DIAS_VIGENCIA,
    };

    if (!p.aplicar) {
        // Aun simulando se avisa lo que de verdad frenaría el envío real.
        if (!dentroDeHorarioDeCobranza(ahora)) return noEnvio('fuera_de_horario');
        if ((await contactosConEstadoDeCuentaHoy(p.schoolId, ahora)).has(familia.email)) return noEnvio('contactada_hoy');
        return vistaPrevia;
    }

    if (!dentroDeHorarioDeCobranza(ahora)) return noEnvio('fuera_de_horario');
    if ((await contactosConEstadoDeCuentaHoy(p.schoolId, ahora)).has(familia.email)) return noEnvio('contactada_hoy');

    const reserva = await reservarEnvio({
        clave: claveEnvioEstadoEnlace({ schoolId: p.schoolId, familia: familia.clave, dia: hoyColombia(ahora), reenvio: !!p.reenviar }),
        tipo: TIPO_ENVIO_ESTADO_ENLACE, schoolId: p.schoolId, refId: null, destinos: [familia.email],
    });
    if (!reserva) return noEnvio('ya_enviado_hoy');

    try {
        const enlace = await emitirEnlaceEstado({ schoolId: p.schoolId, familiaClave: familia.clave, atletas: familia.atletas, creadoPor: p.creadoPor });
        if (!enlace) {
            await cerrarEnvio(reserva, { ok: false, error: 'no se pudo emitir el enlace (¿migración sin aplicar?)' });
            return noEnvio('no_disponible');
        }
        const html = buildBrandedEmail({
            branding,
            title: 'Tu estado de cuenta',
            greeting: `Hola ${familia.nombre},`,
            bodyHtml: cuerpoCorreoEstadoEnlace({ escuela, atletas: datos.atletas.map(resumenParaCorreo), meses: MESES_VENTANA }),
            cta: { label: 'Ver mi estado de cuenta', url: enlaceDeEstado(appBase, enlace.token) },
            closingHtml: `Este enlace es solo para ti y funciona durante ${DIAS_VIGENCIA} días. Si ya pagaste, ignora lo que figure pendiente: la escuela lo está revisando.`,
        });
        const env = await emailClient.send({ to: familia.email, subject: `Estado de cuenta — ${escuela}`, html });
        const ok = !!env.success && !(env as any).simulated;
        await cerrarEnvio(reserva, { ok, error: ok ? undefined : String((env as any).error?.message ?? (env as any).error ?? 'simulado') });
        return ok ? vistaPrevia : noEnvio('fallo_envio');
    } catch (e: any) {
        if (e instanceof UrlNoPublicaError) throw e;
        await cerrarEnvio(reserva, { ok: false, error: e?.message || String(e) });
        return noEnvio('fallo_envio');
    }
}
