/**
 * Acción de la oleada 1: recordatorio de pago a pedido (plan §4 «Recordatorio
 * manual: cómo encaja con el del cron», §10, §13.2 y §16.7). Solo administración.
 *
 * Mapi no mueve plata: solo manda avisos, y todo monto sale de la base.
 *
 * Reusa la cadencia del cron (recordatorios-cobro.service), no la copia:
 *   · `planDeEscuela` en modo manual arma los contactos: un mensaje por familia
 *     con el total, agrupado por teléfono, con el mismo opt-in, el mismo candado
 *     familia-día (compartido con el cron) y los mismos filtros de baja y
 *     duplicados.
 *   · `enviarContacto` reclama y envía con la PLANTILLA del escalón que le toca
 *     al cobro (`recordatorio_previo` si no ha vencido, `pendiente_suave` si ya
 *     venció) y REGISTRA notice_type = 'recordatorio_manual'.
 *
 * Lo propio del manual vive aquí:
 *   · Solo mensualidades del periodo: las dos plantillas dicen «la mensualidad de…».
 *   · Un recordatorio manual por cobro cada 7 días (§16.7).
 *   · Tope de 300 familias por envío y una acción igual por día y escuela (§13.2).
 *   · Solo dentro del horario de la Ley 2300.
 *
 * Necesita la migración 20261123120036 (CHECK con 'recordatorio_manual' e índice
 * parcial). Sin ella el registro choca con el CHECK y no sale nada; por eso el
 * registro la ofrece solo con MAPI_RECORDATORIO_MANUAL=true.
 */

import { z } from 'zod';
import { supabase } from '../../../config/supabase';
import {
    COLUMNAS_PAGO_RECORDATORIO, cobrosDeLotesSilenciosos, entraEnRecordatorios, enviarContacto, planDeEscuela,
    type ContactoPlaneado, type ResultadoContacto,
} from '../../recordatorios-cobro.service';
import { dentroDeHorarioDeCobranza } from '../../whatsapp-plantillas.service';
import { mesDelCobro } from '../../informe-cartera.service';
import { fmtCop } from '../../estado-de-cuenta.service';
import { saldoDelCobro } from '../../../utils/saldo-cobro';
import { normalizar } from '../deportistas';
import { esMes, limitesDelMes, nombreDelMes, sumarDias } from '../fechas';
import { RechazoHerramienta, type Alcance, type HerramientaAccion } from '../tipos';

export const NOMBRE = 'enviar_recordatorio_pago';
/** Tope de destinatarios por envío (plan §13.2; pendiente de verificar el límite de Meta, §18.4). */
export const TOPE_FAMILIAS = 300;
/** Un recordatorio manual por cobro cada 7 días (§16.7): el del día D bloquea hasta D+6. */
export const DIAS_ENTRE_MANUALES = 7;
/** Envíos simultáneos al ejecutar. Cada familia es independiente (su propio candado). */
const EN_PARALELO = 4;
/** Mismos estados que lee la cadencia (planDeEscuela). */
const ESTADOS_RECORDABLES = ['pending', 'overdue', 'partial'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ArgsRecordatorio {
    periodo: string;
    /** Id del equipo. El modelo puede mandar el nombre; preparar lo resuelve y guarda el id. */
    equipo?: string;
}

// ─── Exclusiones (lo que la vista previa cuenta y explica) ──────────────────

export interface Exclusiones {
    // Por familia
    sinCanal: number;
    yaAvisadaHoy: number;
    plantillaSinAprobar: number;
    // Por cobro
    manualReciente: number;
    enRevision: number;
    dadoDeBaja: number;
    loteSilencioso: number;
    duplicado: number;
    sinContacto: number;
    noMensualidad: number;
}

const EXCLUSIONES: { clave: keyof Exclusiones; unidad: 'familia' | 'cobro'; texto: (correo: boolean) => string }[] = [
    { clave: 'sinCanal', unidad: 'familia', texto: (correo) => `sin WhatsApp autorizado${correo ? ' ni correo' : ''}` },
    { clave: 'yaAvisadaHoy', unidad: 'familia', texto: () => 'con aviso de cobro hoy (máximo uno al día)' },
    { clave: 'plantillaSinAprobar', unidad: 'familia', texto: () => 'por plantilla de WhatsApp sin aprobar en la cuenta de la escuela' },
    { clave: 'manualReciente', unidad: 'cobro', texto: () => `con recordatorio manual hace menos de ${DIAS_ENTRE_MANUALES} días` },
    { clave: 'enRevision', unidad: 'cobro', texto: () => 'con comprobante en revisión' },
    { clave: 'dadoDeBaja', unidad: 'cobro', texto: () => 'de deportista dado de baja' },
    { clave: 'loteSilencioso', unidad: 'cobro', texto: () => 'de lotes creados sin «Avisar a las familias»' },
    { clave: 'duplicado', unidad: 'cobro', texto: () => 'por duplicado' },
    { clave: 'sinContacto', unidad: 'cobro', texto: () => 'sin teléfono ni correo de contacto' },
    { clave: 'noMensualidad', unidad: 'cobro', texto: () => 'de otro concepto (torneo, uniforme…): este recordatorio es solo de mensualidades' },
];

const plural = (n: number, uno: string, varios: string) => `${n} ${n === 1 ? uno : varios}`;
const familias = (n: number) => plural(n, 'familia', 'familias');

/** «Se omiten 3 familias sin WhatsApp autorizado», una por motivo con algo. Pura. */
export function lineasDeExclusion(x: Exclusiones, correo: boolean): string[] {
    return EXCLUSIONES.filter((e) => x[e.clave] > 0).map((e) => {
        const n = x[e.clave];
        const unidad = e.unidad === 'familia' ? familias(n) : plural(n, 'cobro', 'cobros');
        return `Se omite${n === 1 ? '' : 'n'} ${unidad} ${e.texto(correo)}.`;
    });
}

// ─── Lecturas ───────────────────────────────────────────────────────────────

const trozos = <T,>(a: T[], n = 200) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

/** Equipo por id o por nombre (sin tildes ni signos: «sub 12» = «Sub-12»), solo de esta escuela. */
async function resolverEquipo(schoolId: string, texto: string): Promise<{ id: string; nombre: string }> {
    if (UUID.test(texto)) {
        const { data } = await supabase.from('teams').select('id, name').eq('school_id', schoolId).eq('id', texto.toLowerCase()).maybeSingle();
        if (!data) throw new RechazoHerramienta('No encontré ese equipo en esta escuela.');
        // Mismo recorte que la búsqueda por nombre: el título no cambia entre la vista previa y el Confirmar.
        return { id: String((data as any).id), nombre: String((data as any).name ?? '').trim() || 'Equipo sin nombre' };
    }
    const clave = (s: string) => normalizar(s).replace(/[^a-z0-9]/g, '');
    const buscado = clave(texto);
    if (!buscado) throw new RechazoHerramienta('Dime el nombre del equipo.');
    const { data, error } = await supabase.from('teams').select('id, name').eq('school_id', schoolId).limit(500);
    if (error) throw new Error(`teams: ${error.message}`);
    const todos = ((data as any[]) ?? []).map((t) => ({ id: String(t.id), nombre: String(t.name ?? '').trim() })).filter((t) => t.nombre);
    const exactos = todos.filter((t) => clave(t.nombre) === buscado);
    const candidatos = exactos.length ? exactos : todos.filter((t) => clave(t.nombre).includes(buscado));
    if (candidatos.length === 1) return candidatos[0];
    if (!candidatos.length) throw new RechazoHerramienta(`No encontré un equipo llamado «${texto}» en esta escuela.`);
    throw new RechazoHerramienta(`Hay varios equipos que coinciden: ${candidatos.slice(0, 6).map((t) => t.nombre).join(', ')}. ¿Cuál?`);
}

/** Deportistas del equipo (vista school_athletes: menores, adultos y fichas sin cuenta). */
async function deportistasDelEquipo(schoolId: string, teamId: string) {
    const res = await Promise.all(['team_id', 'enrolled_team_id'].map((col) =>
        supabase.from('school_athletes').select('id, athlete_type').eq('school_id', schoolId).eq(col, teamId).limit(2000)));
    const ids = { child: new Set<string>(), adult: new Set<string>(), unregistered: new Set<string>() };
    for (const r of res) {
        if (r.error) throw new Error(`school_athletes: ${r.error.message}`);
        for (const f of (r.data as any[]) ?? []) ids[f.athlete_type as keyof typeof ids]?.add(String(f.id));
    }
    return ids;
}

function esDelEquipo(p: any, ids: Awaited<ReturnType<typeof deportistasDelEquipo>>): boolean {
    if (p.child_id) return ids.child.has(p.child_id);
    if (p.unregistered_athlete_id) return ids.unregistered.has(p.unregistered_athlete_id);
    return !!p.user_id && ids.adult.has(p.user_id);
}

/**
 * Cobros abiertos del periodo. Mismo criterio de mes que cartera (`mesDelCobro`):
 * su periodo y, si no tiene, el mes en que vence. Dos consultas (por periodo y por
 * vencimiento) y el filtro fino en código. Ordenados por id para que la vista previa
 * salga igual al volver a prepararla (§10.1).
 */
async function cobrosDelPeriodo(schoolId: string, periodo: string): Promise<any[]> {
    const [anio, mes] = periodo.split('-').map(Number);
    const { desde, hasta } = limitesDelMes(periodo);
    const base = () => supabase.from('payments').select(COLUMNAS_PAGO_RECORDATORIO)
        .eq('school_id', schoolId).in('status', ESTADOS_RECORDABLES);
    const res = await Promise.all([
        base().eq('period_year', anio).eq('period_month', mes).limit(5000),
        base().gte('due_date', desde).lte('due_date', hasta).limit(5000),
    ]);
    const porId = new Map<string, any>();
    for (const r of res) {
        if (r.error) throw new Error(`payments: ${r.error.message}`);
        for (const p of (r.data as any[]) ?? []) porId.set(p.id, p);
    }
    return [...porId.values()].filter((p) => mesDelCobro(p) === periodo).sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

/** Cobros con un recordatorio manual en los últimos 7 días (hoy incluido). */
async function conManualReciente(schoolId: string, ids: string[], hoy: string): Promise<Set<string>> {
    const out = new Set<string>();
    const desde = sumarDias(hoy, -(DIAS_ENTRE_MANUALES - 1));
    for (const t of trozos(ids)) {
        const { data, error } = await supabase.from('collection_notices').select('payment_id, status')
            .eq('school_id', schoolId).eq('notice_type', 'recordatorio_manual')
            .in('payment_id', t).gte('contact_day', desde);
        if (error) throw new Error(`collection_notices: ${error.message}`);
        for (const r of (data as any[]) ?? []) if (r.status !== 'failed') out.add(String(r.payment_id));
    }
    return out;
}

/** ¿Ya salió hoy esta misma acción en la escuela? (§13.2: 1 acción masiva igual por día). */
async function yaSalioHoy(a: Alcance, targetKey: string): Promise<boolean> {
    const { data, error } = await supabase.from('mapi_action_drafts').select('id')
        .eq('school_id', a.schoolId).eq('tool', NOMBRE).eq('target_key', targetKey)
        .in('status', ['executed', 'partial'])
        .gte('executed_at', `${a.hoy}T05:00:00.000Z`) // 00:00 de Bogotá
        .limit(1);
    if (error) throw new Error(`mapi_action_drafts: ${error.message}`);
    return ((data as any[]) ?? []).length > 0;
}

/** La escuela eligió recordar por correo a quien no tiene WhatsApp (mismo interruptor que la cadencia). */
async function usaCorreo(schoolId: string): Promise<boolean> {
    const { data, error } = await supabase.from('school_settings').select('email_collection_reminders_enabled').eq('school_id', schoolId).maybeSingle();
    return !error && (data as any)?.email_collection_reminders_enabled === true;
}

// ─── Armado (lo comparten preparar y ejecutar) ──────────────────────────────

interface Armado {
    hoy: string;
    periodo: string;
    equipo: { id: string; nombre: string } | null;
    targetKey: string;
    contactos: ContactoPlaneado[];
    excluidas: Exclusiones;
    correo: boolean;
    sinWhatsapp: boolean;
    /** Saldo de cada cobro (misma regla que el mensaje): va en la huella. */
    saldos: Map<string, number>;
}

const HORARIO_LEY = 'Por la Ley 2300 los recordatorios de cobro solo salen de lunes a viernes de 7:00 a. m. a 7:00 p. m. y los sábados de 8:00 a. m. a 3:00 p. m., nunca domingos ni festivos. Pídemelo dentro de ese horario.';

async function armar(a: Alcance, args: ArgsRecordatorio): Promise<{ ok: true; x: Armado } | { ok: false; motivo: string }> {
    if (a.rol !== 'admin') throw new RechazoHerramienta('Solo la administración de la escuela puede enviar recordatorios de pago.');
    if (!dentroDeHorarioDeCobranza(new Date())) return { ok: false, motivo: HORARIO_LEY };

    const { periodo } = args;
    const mes = nombreDelMes(periodo);
    const equipo = args.equipo ? await resolverEquipo(a.schoolId, args.equipo) : null;
    const targetKey = `recordatorio:${periodo}${equipo ? `:${equipo.id}` : ''}`;
    const dondeEquipo = equipo ? ` de ${equipo.nombre}` : '';

    if (await yaSalioHoy(a, targetKey)) {
        return { ok: false, motivo: `El recordatorio de ${mes}${dondeEquipo} ya se envió hoy. Se puede volver a pedir desde mañana.` };
    }

    let cobros = await cobrosDelPeriodo(a.schoolId, periodo);
    if (equipo) {
        const ids = await deportistasDelEquipo(a.schoolId, equipo.id);
        cobros = cobros.filter((p) => esDelEquipo(p, ids));
    }
    if (!cobros.length) return { ok: false, motivo: `No hay cobros pendientes de ${mes}${dondeEquipo}.` };

    // Filtros propios del manual, en este orden: cada cobro cuenta en el primer motivo.
    const excluidas: Exclusiones = {
        sinCanal: 0, yaAvisadaHoy: 0, plantillaSinAprobar: 0,
        manualReciente: 0, enRevision: 0, dadoDeBaja: 0, loteSilencioso: 0, duplicado: 0, sinContacto: 0, noMensualidad: 0,
    };
    const quitar = (lista: any[], fuera: (p: any) => boolean, clave: keyof Exclusiones) => lista.filter((p) => {
        if (!fuera(p)) return true;
        excluidas[clave]++;
        return false;
    });
    cobros = quitar(cobros, (p) => p.requires_review === true, 'enRevision');
    cobros = quitar(cobros, (p) => !entraEnRecordatorios(p), 'noMensualidad');
    // La escuela creó el lote sin «Avisar a las familias» y nunca les llegó el aviso de cobro:
    // mismo criterio que la cadencia y que payment-lifecycle-emails.
    const silenciosos = await cobrosDeLotesSilenciosos(cobros.filter((p) => !p.charge_notice_sent_at).map((p) => p.id));
    cobros = quitar(cobros, (p) => silenciosos.has(p.id), 'loteSilencioso');
    const recientes = cobros.length ? await conManualReciente(a.schoolId, cobros.map((p) => p.id), a.hoy) : new Set<string>();
    cobros = quitar(cobros, (p) => recientes.has(p.id), 'manualReciente');

    const correo = await usaCorreo(a.schoolId);
    let contactos: ContactoPlaneado[] = [];
    let sinWhatsapp = false;
    if (cobros.length) {
        const { plan, diag } = await planDeEscuela(a.schoolId, new Date(), a.hoy, { whatsapp: true, correo }, { cobros });
        if (!diag.migracionAplicada) {
            return { ok: false, motivo: 'La cobranza por WhatsApp no está instalada para esta escuela todavía. Avísale a soporte de SportMaps.' };
        }
        excluidas.duplicado = diag.duplicadosExcluidos;
        excluidas.dadoDeBaja = diag.atletaDadoDeBaja;
        excluidas.sinContacto = diag.sinContacto;
        excluidas.sinCanal = plan.descartes.sin_optin + plan.descartes.sin_telefono;
        excluidas.yaAvisadaHoy = plan.descartes.ya_contactada_hoy;
        sinWhatsapp = !diag.integracion;
        // Plantilla del escalón sin aprobar (o recategorizada): ese WhatsApp no saldría.
        const aprobada = (c: ContactoPlaneado) => c.canal === 'email' || String(diag.plantillas[c.concepto] ?? '').startsWith('APPROVED');
        excluidas.plantillaSinAprobar = plan.contactos.filter((c) => !aprobada(c)).length;
        contactos = plan.contactos.filter(aprobada);
    }

    if (!contactos.length) {
        const porQue = sinWhatsapp && !correo
            ? ['La escuela no tiene WhatsApp conectado.']
            : lineasDeExclusion(excluidas, correo);
        return { ok: false, motivo: [`No hay a quién enviarle el recordatorio de ${mes}${dondeEquipo}.`, ...porQue].join(' ') };
    }
    if (contactos.length > TOPE_FAMILIAS) {
        return { ok: false, motivo: `Son ${contactos.length} familias y el tope por envío es ${TOPE_FAMILIAS}. Pídelo por equipo para dividirlo.` };
    }

    const saldos = new Map(cobros.map((p) => [String(p.id), saldoDelCobro(p)]));
    return { ok: true, x: { hoy: a.hoy, periodo, equipo, targetKey, contactos, excluidas, correo, sinWhatsapp, saldos } };
}

// ─── Vista previa ───────────────────────────────────────────────────────────

const vencida = (c: ContactoPlaneado) => c.concepto === 'pendiente_suave';

/** «Samuel y Sofía (Carolina) · $250.000 · vencida». Sin teléfonos ni correos. */
function itemDetalle(c: ContactoPlaneado): string {
    const atleta = c.datos.nombreAtleta || 'Deportista';
    const quien = c.datos.nombreContacto && c.datos.nombreContacto !== atleta ? `${atleta} (${c.datos.nombreContacto})` : atleta;
    return [quien, fmtCop(c.total ?? 0), vencida(c) ? 'vencida' : 'por vencer', ...(c.canal === 'email' ? ['por correo'] : [])].join(' · ');
}

function vistaDe(x: Armado) {
    const n = x.contactos.length;
    const cobros = x.contactos.reduce((s, c) => s + c.paymentIds.length, 0);
    const total = x.contactos.reduce((s, c) => s + (c.total ?? 0), 0);
    const mora = x.contactos.reduce((s, c) => s + (c.mora ?? 0), 0);
    const vencidas = x.contactos.filter(vencida).length;
    const porCorreo = x.contactos.filter((c) => c.canal === 'email').length;
    const mes = nombreDelMes(x.periodo);
    const tipos = [
        ...(vencidas ? [`${familias(vencidas)} con la mensualidad vencida (mensaje «quedó pendiente»)`] : []),
        ...(n - vencidas ? [`${familias(n - vencidas)} por vencer (recordatorio con la fecha de pago)`] : []),
    ];
    return {
        titulo: `Recordatorio de pago · ${mes[0].toUpperCase()}${mes.slice(1)}${x.equipo ? ` · ${x.equipo.nombre}` : ''}`,
        lineas: [
            `${familias(n)} · ${plural(cobros, 'mensualidad', 'mensualidades')} · ${fmtCop(total)}${mora > 0 ? ` (incluye ${fmtCop(mora)} de mora)` : ''}`,
            tipos.join(' · '),
            porCorreo
                ? `${n - porCorreo} por WhatsApp y ${porCorreo} por correo.${x.sinWhatsapp ? ' La escuela no tiene WhatsApp conectado.' : ''}`
                : 'Por WhatsApp, con las plantillas aprobadas de la escuela. Un solo mensaje por familia con su total.',
            ...lineasDeExclusion(x.excluidas, x.correo),
        ],
        aviso: 'Los mensajes salen apenas confirmes y no se pueden deshacer.',
        detalle: {
            etiqueta: `Ver ${n === 1 ? 'la familia' : `las ${n} familias`}`,
            items: x.contactos.map(itemDetalle).sort((a, b) => a.localeCompare(b, 'es')),
        },
        botonConfirmar: `Enviar a ${familias(n)}`,
    };
}

// ─── Envío ──────────────────────────────────────────────────────────────────

/** Motivo de un envío que no salió, como frase corta (sin concordancia: va «motivo: N»). */
const MOTIVO_ENVIO: Record<string, string> = {
    ya_contactada: 'ya con aviso de cobro hoy',
    sin_optin: 'sin autorización de WhatsApp',
    telefono_invalido: 'número inválido',
    plantilla_no_aprobada: 'plantilla sin aprobar',
    plantilla_recategorizada: 'plantilla recategorizada por Meta',
    sin_integracion: 'WhatsApp de la escuela desconectado',
    fuera_de_horario: 'fuera del horario permitido',
    error_graph: 'WhatsApp rechazó el envío',
    correo_fallo: 'el correo falló',
    sin_correo: 'sin correo',
    reserva: 'no se pudo registrar el envío',
    error: 'error del sistema',
};
const motivoLegible = (k: string) => MOTIVO_ENVIO[k] ?? 'error al armar el mensaje';

async function enParalelo<T>(items: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
        while (i < items.length) await fn(items[i++]);
    }));
}

/** «sin autorización de WhatsApp: 2 · número inválido: 1». Pura. */
export function resumenFallos(porMotivo: Record<string, number> | null | undefined): string {
    return Object.entries(porMotivo ?? {})
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([k, n]) => `${motivoLegible(k)}: ${n}`)
        .join(' · ');
}

// ─── La herramienta ─────────────────────────────────────────────────────────

const esquema = z.object({
    periodo: z.string().trim(),
    equipo: z.string().trim().max(80).optional(),
});

export const enviarRecordatorioPago: HerramientaAccion<ArgsRecordatorio> = {
    tipo: 'accion',
    nombre: NOMBRE,
    // Hasta 300 familias: más que lo que aguanta un request detrás de Cloudflare.
    segundoPlano: true,
    descripcion: 'PREPARA un recordatorio de pago por WhatsApp a las familias que deben mensualidades de un mes (no lo envía: la persona confirma en la tarjeta). Usa las plantillas aprobadas de la escuela: «recordatorio» si la mensualidad no ha vencido y «quedó pendiente» si ya venció. Respeta la autorización de cada familia, máximo un aviso de cobro por familia al día y un recordatorio manual por cobro cada 7 días. Opcional: solo un equipo. Solo administración.',
    esquema: {
        type: 'object',
        properties: {
            periodo: { type: 'string', description: 'Mes de las mensualidades, AAAA-MM (ej. "2026-11")' },
            equipo: { type: 'string', description: 'Opcional: id del equipo (el de la pantalla) o su nombre' },
        },
        required: ['periodo'],
        additionalProperties: false,
    },
    roles: ['admin'],
    validar(args) {
        const r = esquema.safeParse(args ?? {});
        if (!r.success) throw new RechazoHerramienta('Faltan datos: el mes (AAAA-MM) y, si es para un equipo, su nombre.');
        if (!esMes(r.data.periodo)) throw new RechazoHerramienta('El mes tiene que venir como AAAA-MM (ej. 2026-11).');
        return { periodo: r.data.periodo, ...(r.data.equipo ? { equipo: r.data.equipo } : {}) };
    },
    async preparar(a, args) {
        const r = await armar(a, args);
        if (!r.ok) return r;
        const { x } = r;
        return {
            ok: true,
            // Con el equipo ya resuelto a su id: el Confirmar no vuelve a buscar por nombre.
            args: { periodo: x.periodo, ...(x.equipo ? { equipo: x.equipo.id } : {}) },
            vista: vistaDe(x),
            targetKey: x.targetKey,
            huella: {
                periodo: x.periodo,
                equipo: x.equipo?.id ?? null,
                cobros: x.contactos.flatMap((c) => c.paymentIds).sort().map((id) => [id, x.saldos.get(id) ?? null]),
            },
        };
    },
    async ejecutar(a, args) {
        const r = await armar(a, args);
        if (!r.ok) return { estado: 'failed', resultado: { motivo: r.motivo } };
        const { x } = r;
        const ahora = new Date();
        const porMotivo: Record<string, number> = {};
        const fallos: { familia: string; motivo: string }[] = [];
        let enviadas = 0;
        await enParalelo(x.contactos, EN_PARALELO, async (c) => {
            let res: ResultadoContacto;
            try {
                res = await enviarContacto(a.schoolId, c, ahora, x.hoy, 'recordatorio_manual');
            } catch (err: any) {
                console.error('[mapi-agente] recordatorio a una familia falló:', err?.message || String(err));
                res = 'no_enviado:error';
            }
            if (res === 'enviado') { enviadas++; return; }
            const clave = res === 'ya_reclamado' ? 'ya_contactada' : res.slice('no_enviado:'.length).split(' ')[0];
            if (clave === 'reserva') console.warn('[mapi-agente] recordatorio no reservado:', res);
            porMotivo[clave] = (porMotivo[clave] || 0) + 1;
            if (fallos.length < 50) fallos.push({ familia: itemDetalle(c).split(' · ')[0], motivo: motivoLegible(clave) });
        });
        const n = x.contactos.length;
        return {
            estado: enviadas === n ? 'executed' : enviadas > 0 ? 'partial' : 'failed',
            resultado: {
                periodo: x.periodo,
                equipo: x.equipo?.nombre ?? null,
                familias: n,
                enviadas,
                no_enviadas: n - enviadas,
                por_motivo: porMotivo,
                fallos,
                // borradores.ts lo guarda como failure_reason cuando no salió ninguno.
                ...(enviadas === 0 ? { motivo: `Ninguna familia recibió el mensaje (${resumenFallos(porMotivo)}).` } : {}),
            },
        };
    },
    mensajeResultado(r, args) {
        const x = r.resultado as any;
        const de = `${nombreDelMes(args.periodo)}${x.equipo ? ` (${x.equipo})` : ''}`;
        if (r.estado === 'failed') {
            return x.por_motivo
                ? `No salió ningún recordatorio de ${de} (${resumenFallos(x.por_motivo)}).`
                : `No salió ningún recordatorio de ${de}. ${x.motivo || ''}`.trim();
        }
        const base = `Salió el recordatorio de ${de} a ${familias(x.enviadas)}.`;
        if (r.estado === 'partial') return `${base} No salió para ${x.no_enviadas} (${resumenFallos(x.por_motivo)}).`;
        return base;
    },
};
