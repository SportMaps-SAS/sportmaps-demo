/**
 * recordatorio-cortesia.service — recordatorio de la clase de cortesía por
 * WhatsApp (2026-10-07, aprobado por el usuario).
 *
 * Hasta hoy la reserva (formulario /inscripcion/<slug> o el bot) terminaba en
 * la confirmación y nadie volvía a escribirle al prospecto: si no podía ir, el
 * cupo quedaba tomado y la escuela esperaba a alguien que no llegaba.
 *
 * DOS AVISOS por reserva (`school_signup_leads.trial_slot_id` → `school_trial_slots`):
 *
 *   víspera   18:00 COT del día anterior. Casi siempre la ventana de 24 h de
 *             Meta está CERRADA (el prospecto escribió al reservar, días antes):
 *             va la plantilla UTILITY `recordatorio_clase_cortesia`, que exige
 *             APPROVED en la WABA de la escuela + opt-in del contacto
 *             (`wa_can_send_template`). Con la ventana abierta, texto (más
 *             completo: grupo, qué llevar, botón «Cancelar mi clase»).
 *   mismo_día ~3 h antes (entre 2 h 30 y 3 h 15), cron cada 15 min de 7:00 a
 *             19:45 COT. SOLO texto y SOLO con la ventana abierta; si está
 *             cerrada no se manda nada (no hay segunda plantilla a propósito:
 *             dos plantillas en menos de 24 h a un prospecto es spam).
 *
 * «CANCELAR»: el saliente queda en el buzón con el estado del flujo de cortesía
 * (`paso_cortesia: 'recordatorio'`), y el bot lee la respuesta contra él
 * (whatsapp-clase-cortesia.service, `cancelaTrasRecordatorio`): libera el cupo
 * con `wa_cancelar_clase_de_prueba` y avisa a la escuela, como el botón.
 *
 * IDEMPOTENCIA entre los 3 BFF: tabla `school_trial_reminders` (migración
 * 20261007095845), UNIQUE (lead, cupo, tipo). Se RESERVA con un INSERT antes de
 * enviar: el que lo logra manda; 23505 = otro BFF ya lo tomó. Sin la tabla
 * (migración sin aplicar) el job no manda nada: sin idempotencia, los tres BFF
 * mandarían tres recordatorios.
 *
 * Respeta: bot apagado de la escuela, conversación tomada por una persona,
 * contacto dado de baja (texto) y opt-in (plantilla). Solo celulares
 * colombianos (`aWaId`); un teléfono fijo o mal escrito no recibe nada.
 * Nunca lanza.
 *
 * ESCUELA CON EMBUDO (B2/B3, Monster 2026-10-30; `wa_preguntas_prospecto`): el
 * recordatorio usa el nombre y el valor de SU clase (nunca «gratis» si se cobra),
 * la plantilla `recordatorio_clase_prueba` ([Ahí estaremos] [Cambiar horario]
 * [No puedo ir]) y deja en el saliente el estado del embudo, para que «Cambiar
 * horario» lo atienda el embudo sin volver a cobrar. Una clase cuya sesión el
 * profe canceló o movió («clase reprogramada») no se recuerda. La dirección de la
 * cancha sale por coincidencia EXACTA (`enriquecerFranja`: «Pinar» no es «Pinar 2»).
 * Sin embudo, todo igual que antes.
 */

import crypto from 'node:crypto';
import { supabase } from '../config/supabase';
import {
    sendTextMessage, sendInteractiveButtons, aFormatoWhatsApp,
    type WhatsAppIntegration, type SendTextResult,
} from './whatsapp.service';
import {
    aWaId, ventanaAbierta, esErrorDeVentana, enviarCobroPorPlantilla, type ResultadoEnvio,
} from './whatsapp-plantillas.service';
import {
    FLUJO_CORTESIA, QUE_LLEVAR, BOTON_CANCELAR_MI_CLASE, bloqueFranja, sedeConDireccion,
    fechaLegible, horaLegible, enriquecerFranja, type FranjaCortesia,
} from './whatsapp-clase-cortesia.service';
import { indicacionesCortesiaDeEscuela, ajustesWhatsAppDeEscuela, embudoActivo } from './whatsapp-ajustes-escuela.service';
import { lugaresDeEscuela, type LugarDeEscuela } from './grupos-por-edad.service';
import { textosClaseDeEscuela, TEXTOS_POR_DEFECTO, type TextosClase } from './textos-clase-prueba';
import type { BotonInteractivo } from './whatsapp.service';

/** Botones del recordatorio de la escuela con embudo (los atiende el embudo, ids `sm_em_*`). */
export const BOTONES_RECORDATORIO_EMBUDO: BotonInteractivo[] = [
    { id: 'sm_em_ahi', title: 'Ahí estaremos' },
    { id: 'sm_em_cambiar', title: 'Cambiar horario' },
];

export type TipoRecordatorio = 'vispera' | 'mismo_dia';

/** Ventana del aviso del mismo día: minutos que faltan para la clase. */
export const MISMO_DIA_DESDE_MIN = 150;
export const MISMO_DIA_HASTA_MIN = 195;
/** Horario razonable para el del mismo día (COT): ni de madrugada ni de noche. */
export const MISMO_DIA_HORA_MIN = 7 * 60;
export const MISMO_DIA_HORA_MAX = 20 * 60;
/** Quien reservó hace menos de esto ya tiene la confirmación fresca: no se le recuerda. */
export const RESERVA_RECIENTE_MIN = 180;

// ─── Puras ───────────────────────────────────────────────────────────────────

/** Fecha (YYYY-MM-DD) y minuto del día en Bogotá (UTC-5 todo el año). */
export function ahoraBogota(ahora: Date): { iso: string; minutos: number } {
    const cot = new Date(ahora.getTime() - 5 * 3600_000);
    return { iso: cot.toISOString().slice(0, 10), minutos: cot.getUTCHours() * 60 + cot.getUTCMinutes() };
}

export function sumarDias(iso: string, n: number): string {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + n, 12)).toISOString().slice(0, 10);
}

export function minutosDeHora(hora: string): number {
    const [hh, mm] = String(hora).split(':').map(Number);
    return hh * 60 + (mm || 0);
}

/** ¿Le toca el aviso del mismo día a una clase que empieza a `horaInicio`? */
export function tocaMismoDia(horaInicio: string, ahoraMin: number): boolean {
    if (ahoraMin < MISMO_DIA_HORA_MIN || ahoraMin >= MISMO_DIA_HORA_MAX) return false;
    const faltan = minutosDeHora(horaInicio) - ahoraMin;
    return faltan >= MISMO_DIA_DESDE_MIN && faltan <= MISMO_DIA_HASTA_MIN;
}

/** «ISABELLA RODRIGUEZ HERNANDEZ» → «Isabella Rodriguez». */
function nombreCorto(nombre: string | null | undefined): string | null {
    const partes = String(nombre ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 2);
    if (!partes.length) return null;
    return partes.map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join(' ');
}

/** A quién se saluda (el acudiente si lo hay) y de quién es la clase. */
export function nombresDelLead(l: { full_name: string | null; guardian_name: string | null }): { saludo: string; atleta: string | null } {
    const atleta = nombreCorto(l.full_name);
    const acudiente = nombreCorto(l.guardian_name);
    const saludo = (acudiente ?? atleta)?.split(' ')[0] ?? 'hola';
    return { saludo, atleta };
}

export function textoRecordatorio(
    tipo: TipoRecordatorio,
    a: {
        saludo: string; atleta: string | null; esAcudiente: boolean; escuela: string; franja: FranjaCortesia;
        /** school_settings.wa_cortesia_indicaciones: reemplaza el «qué llevar» genérico. */
        indicaciones?: string | null;
        /** Nombre y valor de la clase de la escuela (B3). Por defecto, «clase de cortesía». */
        textos?: TextosClase;
        /** Escuela con embudo: el cambio de horario se pide con el botón, no con CANCELAR. */
        embudo?: boolean;
    },
): string {
    const cuando = tipo === 'vispera' ? 'mañana' : 'hoy';
    const clase = (a.textos ?? TEXTOS_POR_DEFECTO).nombre;
    const de = a.esAcudiente && a.atleta ? `la ${clase} de *${a.atleta}*` : `tu ${clase}`;
    return `Hola ${a.saludo} 👋 Te recuerdo ${de} ${cuando} en *${a.escuela}*:\n\n`
        + `${bloqueFranja(a.franja)}\n\n`
        + (a.indicaciones?.trim() ? `🎒 ${a.indicaciones.trim()}\n\n` : `🎒 Qué llevar: ${QUE_LLEVAR}.\n\n`)
        + (a.embudo
            ? 'Si no pueden ir, toca *Cambiar horario* y eliges otro, sin pagar de nuevo.'
            : 'Si no puedes ir, responde *CANCELAR* y liberamos el cupo para otra persona.');
}

/** {{5}} de la plantilla: sede con dirección; sin sede, la principal de la escuela. */
export function sedeParaPlantilla(franja: FranjaCortesia, principal: { name: string | null; address: string | null } | null): string {
    const sede = sedeConDireccion(franja);
    if (sede) return sede;
    if (principal?.name) return principal.address ? `${principal.name} (${principal.address})` : principal.name;
    return 'la sede de la escuela';
}

// ─── Datos ───────────────────────────────────────────────────────────────────

export interface ReservaParaRecordar {
    leadId: string;
    schoolId: string;
    nombre: string | null;
    acudiente: string | null;
    telefono: string | null;
    creadaEn: string | null;
    slot: {
        id: string; label: string | null; slot_date: string; start_time: string; end_time: string | null; location: string | null;
        team_id?: string | null;
    };
    /** `source_detail.reprogramada.id`: la franja cuya sesión se canceló o movió (B2). */
    reprogramadaSlotId?: string | null;
}

export interface ResumenRecordatorios {
    candidatas: number;
    enviados: number;
    noEnviados: number;
    omitidos: number;
    sinTabla?: boolean;
}

type Cierre = { estado: 'enviado' | 'no_enviado'; canal?: 'plantilla' | 'texto' | null; waMessageId?: string | null; motivo?: string | null };

export interface DepsRecordatorio {
    reservasDelDia: (fecha: string) => Promise<ReservaParaRecordar[]>;
    integracion: (schoolId: string) => Promise<WhatsAppIntegration | null>;
    conversacion: (integrationId: string, waId: string) => Promise<{ id: string; last_inbound_at: string | null } | null>;
    escuela: (schoolId: string) => Promise<{
        nombre: string; sedes: { name: string | null; address: string | null; is_main?: boolean | null }[];
        /** Qué llevar / a quién buscar (school_settings.wa_cortesia_indicaciones); null = genérico. */
        indicaciones?: string | null;
        /** Canchas con dirección, Maps e indicaciones (mig. M1; sin ella, vacío = como antes). */
        lugares?: LugarDeEscuela[];
        /** La escuela tiene el embudo del interesado (B2). */
        embudo?: boolean;
        /** Nombre y valor de su clase (B3). */
        textos?: TextosClase;
    }>;
    /** 'ok' = este BFF lo tomó; 'ya' = otro lo tomó; 'sin_tabla' = migración sin aplicar. */
    reservar: (r: ReservaParaRecordar, tipo: TipoRecordatorio, waId: string) => Promise<{ estado: 'ok'; id: string } | { estado: 'ya' | 'sin_tabla' | 'error'; detalle?: string }>;
    cerrar: (id: string, c: Cierre) => Promise<void>;
    botEncendido: (integrationId: string) => Promise<boolean>;
    tomada: (conversationId: string) => Promise<boolean>;
    /** Modo discreto: ¿una persona de la escuela escribió en el chat en las últimas 12 h? */
    escuelaActiva?: (conversationId: string) => Promise<boolean>;
    dadoDeBaja: (integrationId: string, waId: string) => Promise<boolean>;
    enviarTexto: (integ: WhatsAppIntegration, waId: string, texto: string, botones?: BotonInteractivo[]) => Promise<SendTextResult>;
    registrarTexto: (a: { integ: WhatsAppIntegration; conversationId: string; waId: string; waMessageId: string | null; texto: string; payload: Record<string, unknown> }) => Promise<void>;
    enviarPlantilla: typeof enviarCobroPorPlantilla;
}

const SELECT_LEAD = 'id, school_id, full_name, guardian_name, phone, status, created_at, trial_slot_id, source_detail, '
    + 'school_trial_slots!inner(id, label, slot_date, start_time, end_time, location, team_id)';

const DEPS: DepsRecordatorio = {
    async reservasDelDia(fecha) {
        const { data, error } = await supabase.from('school_signup_leads')
            .select(SELECT_LEAD)
            .not('trial_slot_id', 'is', null)
            .in('status', ['new', 'contacted', 'converted'])
            .eq('school_trial_slots.slot_date', fecha)
            .limit(1000);
        if (error || !Array.isArray(data)) {
            if (error) console.warn('[recordatorio-cortesia] no se pudieron leer las reservas', { err: error.message });
            return [];
        }
        return (data as any[]).flatMap((l) => {
            const s = Array.isArray(l.school_trial_slots) ? l.school_trial_slots[0] : l.school_trial_slots;
            if (!s || String(s.slot_date).slice(0, 10) !== fecha) return [];
            return [{
                leadId: l.id, schoolId: l.school_id, nombre: l.full_name ?? null, acudiente: l.guardian_name ?? null,
                telefono: l.phone ?? null, creadaEn: l.created_at ?? null,
                slot: {
                    id: s.id, label: s.label ?? null, slot_date: String(s.slot_date).slice(0, 10),
                    start_time: String(s.start_time).slice(0, 5), end_time: s.end_time ? String(s.end_time).slice(0, 5) : null,
                    location: s.location ?? null, team_id: s.team_id ?? null,
                },
                reprogramadaSlotId: l.source_detail?.reprogramada?.id ?? null,
            }];
        });
    },
    async integracion(schoolId) {
        const { data } = await supabase.from('school_whatsapp_integrations')
            .select('id, school_id, phone_number_id, waba_id, display_phone_number, access_token_encrypted, verify_token, status')
            .eq('school_id', schoolId).eq('status', 'active');
        const activas = ((data as any[]) ?? []).filter((i) => i.access_token_encrypted && i.phone_number_id);
        // Más de una: no se adivina por cuál número escribir (mismo criterio que la cobranza).
        return activas.length === 1 ? (activas[0] as WhatsAppIntegration) : null;
    },
    async conversacion(integrationId, waId) {
        const { data } = await supabase.from('whatsapp_conversations')
            .select('id, last_inbound_at').eq('integration_id', integrationId).eq('contact_wa_id', waId).maybeSingle();
        return (data as any) ?? null;
    },
    async escuela(schoolId) {
        const [{ data: s }, { data: b }, indicaciones, lugares, ajustes, textos] = await Promise.all([
            supabase.from('schools').select('name').eq('id', schoolId).maybeSingle(),
            supabase.from('school_branches').select('name, address, is_main').eq('school_id', schoolId).limit(50),
            indicacionesCortesiaDeEscuela(schoolId),
            lugaresDeEscuela(schoolId).catch(() => [] as LugarDeEscuela[]),
            ajustesWhatsAppDeEscuela(schoolId),
            textosClaseDeEscuela(schoolId).catch(() => TEXTOS_POR_DEFECTO),
        ]);
        return {
            nombre: (s as any)?.name ?? 'la escuela', sedes: ((b as any[]) ?? []), indicaciones,
            lugares, embudo: embudoActivo(ajustes), textos,
        };
    },
    async reservar(r, tipo, waId) {
        const { data, error } = await supabase.from('school_trial_reminders')
            .insert({ school_id: r.schoolId, lead_id: r.leadId, trial_slot_id: r.slot.id, tipo, contact_wa_id: waId })
            .select('id').maybeSingle();
        if (!error && (data as any)?.id) return { estado: 'ok', id: (data as any).id };
        const code = (error as any)?.code;
        if (code === '23505') return { estado: 'ya' };
        if (code === '42P01' || code === 'PGRST205' || /school_trial_reminders/.test(error?.message ?? '') && /exist|find/i.test(error?.message ?? '')) {
            return { estado: 'sin_tabla' };
        }
        return { estado: 'error', detalle: error?.message };
    },
    async cerrar(id, c) {
        await supabase.from('school_trial_reminders').update({
            estado: c.estado, canal: c.canal ?? null, wa_message_id: c.waMessageId ?? null,
            motivo: c.motivo ? String(c.motivo).slice(0, 300) : null, updated_at: new Date().toISOString(),
        }).eq('id', id);
    },
    async botEncendido(integrationId) {
        const { botEncendido } = await import('./whatsapp-atencion.service');
        return botEncendido(integrationId);
    },
    async tomada(conversationId) {
        const { conversacionTomada } = await import('./whatsapp-tomada.service');
        return conversacionTomada(conversationId);
    },
    async escuelaActiva(conversationId) {
        const { modoDiscreto, escuelaActiva } = await import('./whatsapp-modo-discreto');
        return modoDiscreto() && escuelaActiva(conversationId);
    },
    async dadoDeBaja(integrationId, waId) {
        const { estaDadoDeBaja } = await import('./whatsapp-optin.service');
        return estaDadoDeBaja(integrationId, waId);
    },
    async enviarTexto(integ, waId, texto, botones) {
        const r = await sendInteractiveButtons(integ, waId, texto, botones ?? BOTON_CANCELAR_MI_CLASE);
        // Si Meta rechaza los botones por otra cosa que la ventana, el texto
        // plano igual sale: dice «responde CANCELAR».
        return r.ok || esErrorDeVentana(r.error) ? r : sendTextMessage(integ, waId, texto);
    },
    async registrarTexto(a) {
        await supabase.rpc('wa_record_outbound_message', {
            p_conversation_id: a.conversationId,
            p_integration_id: a.integ.id,
            p_wa_message_id: a.waMessageId || `local-${crypto.randomUUID()}`,
            p_type: 'interactive',
            p_text_body: a.texto,
            // `automatico`: lo mandó un job, no una persona. Sin la marca, el bot
            // lo leía como «Milena escribió» y callaba la conversación hasta 30
            // días (auditoría 2026-10-28, X-01: …0683 canceló y nadie le contestó).
            p_payload: { ...a.payload, automatico: true },
            p_ai_generated: false,
            p_to_wa_id: a.waId,
        });
    },
    enviarPlantilla: enviarCobroPorPlantilla,
};

// ─── Job ─────────────────────────────────────────────────────────────────────

/**
 * `vispera`: reservas de MAÑANA (correr a las 18:00 COT).
 * `mismo_dia`: reservas de HOY que empiezan en 2 h 30 – 3 h 15 (cada 15 min).
 */
export async function runRecordatorioCortesia(
    tipo: TipoRecordatorio,
    opciones: { ahora?: Date; deps?: Partial<DepsRecordatorio>; log?: { info?: Function; warn?: Function } } = {},
): Promise<ResumenRecordatorios> {
    const d: DepsRecordatorio = { ...DEPS, ...(opciones.deps ?? {}) };
    const ahora = opciones.ahora ?? new Date();
    const hoy = ahoraBogota(ahora);
    const resumen: ResumenRecordatorios = { candidatas: 0, enviados: 0, noEnviados: 0, omitidos: 0 };

    if (tipo === 'mismo_dia' && (hoy.minutos < MISMO_DIA_HORA_MIN || hoy.minutos >= MISMO_DIA_HORA_MAX)) return resumen;

    const fecha = tipo === 'vispera' ? sumarDias(hoy.iso, 1) : hoy.iso;
    let reservas = await d.reservasDelDia(fecha);
    if (tipo === 'mismo_dia') reservas = reservas.filter((r) => tocaMismoDia(r.slot.start_time, hoy.minutos));
    resumen.candidatas = reservas.length;

    const integraciones = new Map<string, WhatsAppIntegration | null>();
    const escuelas = new Map<string, Awaited<ReturnType<DepsRecordatorio['escuela']>>>();

    for (const r of reservas) {
        try {
            const waId = aWaId(r.telefono);
            if (!waId) { resumen.omitidos++; continue; }
            // La sesión de esa franja se canceló o movió y ya se le avisó «clase
            // reprogramada» (B2): no se le recuerda una clase que no va a pasar.
            if (r.reprogramadaSlotId && r.reprogramadaSlotId === r.slot.id) { resumen.omitidos++; continue; }
            // Recién reservada: la confirmación todavía está fresca.
            if (r.creadaEn && ahora.getTime() - new Date(r.creadaEn).getTime() < RESERVA_RECIENTE_MIN * 60_000) {
                resumen.omitidos++; continue;
            }
            if (!integraciones.has(r.schoolId)) integraciones.set(r.schoolId, await d.integracion(r.schoolId));
            const integ = integraciones.get(r.schoolId);
            if (!integ) { resumen.omitidos++; continue; }

            const conv = await d.conversacion(integ.id, waId);
            const abierta = ventanaAbierta(conv?.last_inbound_at ?? null, ahora.getTime());
            // El del mismo día solo existe como texto: con la ventana cerrada no
            // se reserva, así un tick posterior lo manda si el prospecto escribe.
            if (tipo === 'mismo_dia' && (!abierta || !conv)) { resumen.omitidos++; continue; }

            const toma = await d.reservar(r, tipo, waId);
            if (toma.estado === 'sin_tabla') {
                opciones.log?.warn?.('[recordatorio-cortesia] falta la tabla school_trial_reminders (migración 20261007095845): no se manda nada');
                return { ...resumen, sinTabla: true };
            }
            if (toma.estado !== 'ok') { resumen.omitidos++; continue; }

            const cierre = await enviarUno(d, tipo, r, integ, waId, conv, abierta, escuelas);
            await d.cerrar(toma.id, cierre).catch(() => undefined);
            if (cierre.estado === 'enviado') resumen.enviados++; else resumen.noEnviados++;
        } catch (e: any) {
            resumen.noEnviados++;
            opciones.log?.warn?.({ leadId: r.leadId, err: e?.message }, '[recordatorio-cortesia] falló una reserva');
        }
    }
    return resumen;
}

async function enviarUno(
    d: DepsRecordatorio, tipo: TipoRecordatorio, r: ReservaParaRecordar, integ: WhatsAppIntegration, waId: string,
    conv: { id: string; last_inbound_at: string | null } | null, abierta: boolean,
    escuelas: Map<string, Awaited<ReturnType<DepsRecordatorio['escuela']>>>,
): Promise<Cierre> {
    if (!(await d.botEncendido(integ.id))) return { estado: 'no_enviado', motivo: 'bot_apagado' };
    if (conv && await d.tomada(conv.id)) return { estado: 'no_enviado', motivo: 'conversacion_tomada' };
    // Modo discreto: si la escuela está coordinando en el chat, el recordatorio
    // automático puede contradecirla (Milena reprogramó a mano y salió el de la franja vieja).
    if (conv && d.escuelaActiva && await d.escuelaActiva(conv.id)) {
        return { estado: 'no_enviado', motivo: 'escuela_en_la_conversacion' };
    }

    if (!escuelas.has(r.schoolId)) escuelas.set(r.schoolId, await d.escuela(r.schoolId));
    const esc = escuelas.get(r.schoolId)!;
    const textos = esc.textos ?? TEXTOS_POR_DEFECTO;
    // Dirección de la cancha por coincidencia EXACTA (sin canchas cargadas, la de la sede como antes).
    const franja: FranjaCortesia = enriquecerFranja({
        id: r.slot.id, grupo: r.slot.label ?? textos.nombreInicial, fecha: r.slot.slot_date,
        horaInicio: r.slot.start_time, horaFin: r.slot.end_time, sede: r.slot.location, cupos: 0,
        direccion: null,
    }, { teamId: r.slot.team_id ?? null, rango: null, lugares: esc.lugares ?? [], sedes: esc.sedes });
    const { saludo, atleta } = nombresDelLead({ full_name: r.nombre, guardian_name: r.acudiente });
    // Estado del flujo en el saliente: la respuesta «CANCELAR» se lee contra él. Con
    // embudo, el del embudo: «Cambiar horario» / «No puedo ir» los atiende él.
    const { estadoParaRecordatorio } = await import('./whatsapp-embudo-prospecto');
    const estadoFlujo: Record<string, unknown> = esc.embudo
        ? { step: `recordatorio_cortesia_${tipo}`, lead_id: r.leadId, ...estadoParaRecordatorio(r.leadId, r.slot.team_id ?? null, r.slot.id) }
        : {
            step: `recordatorio_cortesia_${tipo}`, flujo: FLUJO_CORTESIA, paso_cortesia: 'recordatorio',
            datos_cortesia: { franja, nombre: r.nombre }, lead_id: r.leadId,
        };

    if (abierta && conv) {
        if (await d.dadoDeBaja(integ.id, waId)) return { estado: 'no_enviado', motivo: 'dado_de_baja' };
        const texto = aFormatoWhatsApp(textoRecordatorio(tipo, {
            saludo, atleta, esAcudiente: !!r.acudiente, escuela: esc.nombre, franja,
            indicaciones: esc.indicaciones ?? null, textos, embudo: !!esc.embudo,
        }));
        const env = esc.embudo
            ? await d.enviarTexto(integ, waId, texto, BOTONES_RECORDATORIO_EMBUDO)
            : await d.enviarTexto(integ, waId, texto);
        if (env.ok) {
            await d.registrarTexto({ integ, conversationId: conv.id, waId, waMessageId: env.waMessageId ?? null, texto, payload: estadoFlujo })
                .catch(() => undefined);
            return { estado: 'enviado', canal: 'texto', waMessageId: env.waMessageId ?? null };
        }
        // La ventana cerró justo (borde de las 24 h): la víspera cae a la plantilla.
        if (!(tipo === 'vispera' && esErrorDeVentana(env.error))) {
            return { estado: 'no_enviado', canal: 'texto', motivo: env.error ?? 'envio_fallido' };
        }
    }

    if (tipo !== 'vispera') return { estado: 'no_enviado', motivo: 'ventana_cerrada' };

    const principal = esc.sedes.find((s) => s.is_main) ?? esc.sedes[0] ?? null;
    const env: ResultadoEnvio = await d.enviarPlantilla({
        schoolId: r.schoolId,
        concepto: esc.embudo ? 'recordatorio_clase_prueba' : 'recordatorio_clase_cortesia',
        telefono: waId,
        tokenBoton: null,
        datos: {
            nombreContacto: saludo, nombreAtleta: atleta ?? '', nombreEscuela: esc.nombre, monto: '',
            dia: fechaLegible(franja.fecha), hora: horaLegible(franja.horaInicio),
            sede: sedeParaPlantilla(franja, principal),
        },
        payloadExtra: estadoFlujo,
    });
    if (env.enviado) return { estado: 'enviado', canal: 'plantilla', waMessageId: env.waMessageId };
    return { estado: 'no_enviado', canal: 'plantilla', motivo: `${env.motivo}${env.detalle ? ` (${env.detalle})` : ''}` };
}
