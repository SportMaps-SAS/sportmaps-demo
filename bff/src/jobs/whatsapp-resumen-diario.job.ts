/**
 * whatsapp-resumen-diario.job — 7:00 a. m. (Colombia), un correo por escuela
 * con WhatsApp conectado, a owner + admins, con lo que quedó esperando:
 *
 *   1. Conversaciones de FAMILIAS sin responder (mismo cálculo de "pendiente"
 *      que el buzón: último entrante más nuevo que el último saliente, sin
 *      contar el saludo automático de la app del negocio).
 *   2. Comprobantes que el worker dejó para la escuela en las últimas 24 h
 *      (failed, ignored+escalated, waiting_user). Son los mismos estados que
 *      lista la pestaña "Bandeja" del canal.
 *   3. Prospectos de las últimas 24 h: desconocidos que preguntaron por
 *      inscripción (paso 'desconocido_tema_escolar', intención 'inscripcion').
 *   4. Clases de cortesía de HOY y MAÑANA (quién viene, grupo, hora, sede) y
 *      leads nuevos SIN agendar (school_signup_leads sin franja, 7 días). Lo
 *      pidió Dynasty el 2026-10-06: «la dueña tiene que saber dónde quedó
 *      agendado». Si la tabla de leads falla, la sección se omite.
 *   5. Borradores huérfanos: en modo AUTO, borradores `pending` de más de 30
 *      min en conversaciones sin respuesta y con la ventana abierta. En auto el
 *      bot no deja borradores; si los hay quedaron de un rato en asistido y
 *      nadie los va a aprobar (Dynasty, 2026-10-06).
 *
 * Si no hay NADA, no se manda: un correo diario que dice "todo en orden" se
 * aprende a ignorar en una semana, y entonces tampoco se lee el día que sí
 * importa.
 *
 * Idempotencia EN LA BASE (ver avisos-correo.service): reserva en
 * `email_sends` con id determinístico por escuela + fecha de Colombia. Los
 * tres BFF (dev/stg/prod) comparten la base y corren el mismo cron; solo el
 * primero que reserva manda. Un reinicio del BFF a las 7:00 tampoco duplica.
 *
 * Kill-switch: DISABLE_WHATSAPP_RESUMEN_CORREO=true.
 */

import { supabase } from '../config/supabase';
import {
    calcularPendientes, estaPendiente, esSalienteAutomatico, TIPOS_FAMILIA,
} from '../services/whatsapp-buzon';
import {
    destinatariosDeEscuela, enviarConReserva, etiquetaDeContacto, fechaColombia, horaColombia,
} from '../services/avisos-correo.service';
import {
    enmascararTelefonoLead, hoyBogota, hora12, listarCortesias, sumarDias,
} from '../services/cortesia-reservas.service';
import { contarBorradoresHuerfanos, HUERFANO_MIN_MS } from '../services/whatsapp-ponerse-al-dia.service';
import { estaCerrada } from '../services/whatsapp-bandeja.service';
import { lineaCarteraParaResumen } from '../services/informe-cartera.service';
import { avisarResumenPorPlataforma } from '../services/plataforma-wa-avisos.service';

/** El paso con que el bot contesta a un desconocido con tema escolar.
 *  Copia de PASO_DESCONOCIDO_ESCOLAR (whatsapp-bot.service): importarlo de ahí
 *  arrastraría el bot entero (LLM, OTP, Meta) a este job. */
const PASO_DESCONOCIDO_ESCOLAR = 'desconocido_tema_escolar';

const DIA_MS = 24 * 3600_000;
/** Lo que entra en el correo por sección. El resto se ve en la app. */
const MAX_FILAS = 15;

export interface FamiliaPendiente { contacto: string; esperaDesde: string; horas: number }
export interface ComprobanteParaEscuela { contacto: string; estado: string; hora: string }
export interface Prospecto { contacto: string; conEnlace: boolean; respondido: boolean; hora: string }

export interface CortesiaDelDia { dia: 'hoy' | 'mañana'; nombre: string; paraQuien: string; grupo: string; hora: string; sede: string; telefono: string }
export interface LeadSinAgendarResumen { nombre: string; paraQuien: string; telefono: string; origen: string; hora: string }

export interface ResumenEscuela {
    familias: FamiliaPendiente[];
    comprobantes: ComprobanteParaEscuela[];
    prospectos: Prospecto[];
    /** Opcionales: un resumen armado por código viejo (o pruebas) no los trae. */
    cortesias?: CortesiaDelDia[];
    leadsSinAgendar?: LeadSinAgendarResumen[];
    /** Sección 5: borradores huérfanos en modo auto. */
    borradoresHuerfanos?: { conversaciones: number; borradores: number };
}

export function resumenVacio(r: ResumenEscuela): boolean {
    return !r.familias.length && !r.comprobantes.length && !r.prospectos.length
        && !(r.cortesias?.length) && !(r.leadsSinAgendar?.length) && !(r.borradoresHuerfanos?.borradores);
}

/**
 * Sección 4. Nunca lanza: si la tabla de leads no responde, el resumen sale
 * igual con las otras tres secciones.
 */
export async function cortesiasDelResumen(schoolId: string, ahora = Date.now()): Promise<{
    cortesias: CortesiaDelDia[]; leadsSinAgendar: LeadSinAgendarResumen[];
}> {
    try {
        const hoy = hoyBogota(ahora);
        const manana = sumarDias(hoy, 1);
        const { reservas, sinAgendar } = await listarCortesias(schoolId, { desde: hoy, hasta: manana, diasLeads: 7 }, ahora);
        return {
            cortesias: reservas.map((r) => ({
                dia: r.fecha === hoy ? 'hoy' as const : 'mañana' as const,
                nombre: r.nombre,
                paraQuien: r.paraQuien,
                grupo: r.grupo,
                hora: hora12(r.horaInicio),
                sede: r.sede ?? '',
                telefono: enmascararTelefonoLead(r.telefono),
            })),
            leadsSinAgendar: sinAgendar.filter((l) => l.estado === 'new').map((l) => ({
                nombre: l.nombre,
                paraQuien: l.paraQuien,
                telefono: enmascararTelefonoLead(l.telefono),
                origen: l.origen === 'whatsapp' ? 'WhatsApp' : 'formulario web',
                hora: horaColombia(l.creadoEn),
            })),
        };
    } catch (err: any) {
        console.warn('[resumen-wa] sin sección de cortesías', { schoolId, error: err?.message || String(err) });
        return { cortesias: [], leadsSinAgendar: [] };
    }
}

const ESTADO_COMPROBANTE: Record<string, string> = {
    failed: 'No se pudo procesar: revísalo a mano',
    escalated: 'El asistente lo dejó para revisión de la escuela',
    waiting_user: 'Esperando que la familia diga a qué cobro corresponde',
};

/** Arma el resumen de una escuela. Exportado para probarlo sin cron. */
export async function armarResumenEscuela(
    schoolId: string, integrationId: string, ahora = Date.now(),
): Promise<ResumenEscuela> {
    const desde24 = new Date(ahora - DIA_MS).toISOString();

    // ── Conversaciones de la escuela (las de familias y las que tocan prospectos) ──
    const { data: convs } = await supabase.from('whatsapp_conversations')
        .select('id, contact_name, contact_wa_id, contact_kind, status, last_inbound_at')
        .eq('school_id', schoolId)
        .order('last_message_at', { ascending: false, nullsFirst: false })
        .limit(500);
    const porId = new Map<string, any>(((convs ?? []) as any[]).map((c) => [c.id, c]));

    // ── 1. Familias sin responder ──
    const familias = ((convs ?? []) as any[]).filter((c) =>
        (TIPOS_FAMILIA as readonly string[]).includes(c.contact_kind) && c.status !== 'closed' && c.last_inbound_at);
    const tiempos = new Map<string, { ultimoEntrante: number; ultimoSaliente: number }>();
    for (const c of familias) tiempos.set(c.id, { ultimoEntrante: new Date(c.last_inbound_at).getTime(), ultimoSaliente: 0 });
    if (tiempos.size) {
        const masViejo = Math.min(...[...tiempos.values()].map((t) => t.ultimoEntrante));
        const { data: salientes } = await supabase.from('whatsapp_messages')
            .select('conversation_id, direction, wa_timestamp, created_at, automatico:payload->automatico')
            .in('conversation_id', [...tiempos.keys()])
            .eq('direction', 'outbound')
            .gte('wa_timestamp', new Date(masViejo).toISOString())
            .limit(2000);
        for (const [id, t] of calcularPendientes((salientes ?? []) as any[])) {
            const e = tiempos.get(id);
            if (e) e.ultimoSaliente = t.ultimoSaliente;
        }
    }
    const familiasPendientes: FamiliaPendiente[] = familias
        .filter((c) => estaPendiente(c.status, tiempos.get(c.id)))
        .map((c) => {
            const t = tiempos.get(c.id)!.ultimoEntrante;
            return {
                contacto: etiquetaDeContacto(c.contact_name, c.contact_wa_id),
                esperaDesde: horaColombia(t),
                horas: Math.max(0, Math.floor((ahora - t) / 3600_000)),
            };
        })
        .sort((a, b) => b.horas - a.horas);

    // ── 2. Comprobantes que quedaron para la escuela (últimas 24 h) ──
    const { data: cola } = await supabase.from('whatsapp_inbound_queue')
        .select('wa_phone_number, status, result_type, error_message, created_at')
        .eq('school_id', schoolId)
        .in('status', ['failed', 'ignored', 'waiting_user'])
        .gte('created_at', desde24)
        .order('created_at', { ascending: false })
        .limit(100);
    const nombrePorNumero = new Map<string, string | null>();
    for (const c of porId.values()) nombrePorNumero.set(c.contact_wa_id, c.contact_name ?? null);
    const comprobantes: ComprobanteParaEscuela[] = ((cola ?? []) as any[])
        // 'ignored' sin 'escalated' es ruido (no era comprobante, bot apagado, contacto personal…).
        .filter((f) => f.status !== 'ignored' || f.result_type === 'escalated')
        // Lo que la escuela ya resolvió o descartó en la Bandeja no se le vuelve a contar.
        .filter((f) => !estaCerrada(f.error_message))
        .map((f) => ({
            contacto: etiquetaDeContacto(nombrePorNumero.get(f.wa_phone_number) ?? null, f.wa_phone_number),
            estado: ESTADO_COMPROBANTE[f.status === 'ignored' ? 'escalated' : f.status] ?? f.status,
            hora: horaColombia(f.created_at),
        }));

    // ── 3. Prospectos (últimas 24 h) ──
    const { data: pasos } = await supabase.from('whatsapp_messages')
        .select('conversation_id, created_at, payload')
        .eq('integration_id', integrationId)
        .eq('direction', 'outbound')
        .eq('payload->>step', PASO_DESCONOCIDO_ESCOLAR)
        .eq('payload->>intencion', 'inscripcion')
        .gte('created_at', desde24)
        .limit(200);
    const primeros = new Map<string, any>();
    for (const m of (pasos ?? []) as any[]) {
        const previo = primeros.get(m.conversation_id);
        if (!previo || m.created_at < previo.created_at) primeros.set(m.conversation_id, m);
    }
    // ¿Alguien de la escuela le escribió después del bot? Respuesta humana =
    // saliente no generado por IA y que no sea el saludo automático de la app.
    const respondidos = new Set<string>();
    if (primeros.size) {
        const desdeProspecto = Math.min(...[...primeros.values()].map((m) => new Date(m.created_at).getTime()));
        const { data: humanos } = await supabase.from('whatsapp_messages')
            .select('conversation_id, created_at, payload')
            .in('conversation_id', [...primeros.keys()])
            .eq('direction', 'outbound')
            .eq('ai_generated', false)
            .gte('created_at', new Date(desdeProspecto).toISOString())
            .limit(1000);
        for (const h of (humanos ?? []) as any[]) {
            const p = primeros.get(h.conversation_id);
            if (p && h.created_at > p.created_at && !esSalienteAutomatico(h)) respondidos.add(h.conversation_id);
        }
    }
    const prospectos: Prospecto[] = [...primeros.values()].map((m) => {
        const c = porId.get(m.conversation_id);
        return {
            contacto: etiquetaDeContacto(c?.contact_name ?? null, c?.contact_wa_id ?? null),
            conEnlace: m.payload?.con_enlace === true,
            respondido: respondidos.has(m.conversation_id),
            hora: horaColombia(m.created_at),
        };
    });

    const { cortesias, leadsSinAgendar } = await cortesiasDelResumen(schoolId, ahora);

    // ── 5. Borradores huérfanos (solo en modo auto) ──
    const { data: ajustes } = await supabase.from('whatsapp_settings')
        .select('mode').eq('integration_id', integrationId).maybeSingle();
    const borradoresHuerfanos = (ajustes as any)?.mode === 'auto'
        ? await contarBorradoresHuerfanos({ id: integrationId, school_id: schoolId }, { ahora, minEdadMs: HUERFANO_MIN_MS })
        : { conversaciones: 0, borradores: 0 };

    return { familias: familiasPendientes, comprobantes, prospectos, cortesias, leadsSinAgendar, borradoresHuerfanos };
}

export async function runWhatsAppResumenDiario(ahora = Date.now()): Promise<{ escuelas: number; enviados: number }> {
    if (process.env.DISABLE_WHATSAPP_RESUMEN_CORREO === 'true') return { escuelas: 0, enviados: 0 };

    const { data: integraciones, error } = await supabase.from('school_whatsapp_integrations')
        .select('id, school_id')
        .eq('status', 'active');
    if (error) {
        console.error('[resumen-wa] no se pudieron leer las integraciones:', error.message);
        return { escuelas: 0, enviados: 0 };
    }

    const fecha = fechaColombia(ahora);
    const base = (process.env.FRONTEND_URL || 'https://app.sportmaps.co').replace(/\/$/, '');
    let enviados = 0;

    for (const integ of (integraciones ?? []) as any[]) {
        try {
            const r = await armarResumenEscuela(integ.school_id, integ.id, ahora);
            if (resumenVacio(r)) continue;

            const { escuela, correos } = await destinatariosDeEscuela(integ.school_id);

            const url = `${base}/whatsapp?tab=conversaciones`;
            const partes = [
                r.familias.length ? `${r.familias.length} familia(s) sin respuesta` : '',
                r.comprobantes.length ? `${r.comprobantes.length} comprobante(s) para revisar` : '',
                r.prospectos.length ? `${r.prospectos.length} prospecto(s)` : '',
                r.cortesias?.length ? `${r.cortesias.length} clase(s) de cortesía hoy y mañana` : '',
                r.leadsSinAgendar?.length ? `${r.leadsSinAgendar.length} lead(s) sin agendar` : '',
                r.borradoresHuerfanos?.borradores
                    ? `${r.borradoresHuerfanos.borradores} borrador(es) sin enviar en ${r.borradoresHuerfanos.conversaciones} conversación(es)` : '',
            ].filter(Boolean);
            // Cartera (informe-cartera.service): una línea, solo si la escuela
            // tiene el informe activo. Va DESPUÉS de resumenVacio: nunca dispara
            // el resumen por sí sola (eso es el correo semanal de los lunes).
            const lineaCartera = await lineaCarteraParaResumen(integ.school_id, new Date(ahora));
            if (lineaCartera) partes.push(lineaCartera);
            const cortesias = r.cortesias ?? [];
            const leads = r.leadsSinAgendar ?? [];

            // Canal de plataforma: el mismo resumen, corto, al WhatsApp de la
            // dueña con opt-in. Va antes del corte por correos: una escuela sin
            // correo de admin igual lo recibe por acá. Flag apagado = nada.
            avisarResumenPorPlataforma({
                schoolId: integ.school_id, escuela, fecha, partes,
                cortesiasDeHoy: cortesias.filter((c) => c.dia === 'hoy')
                    .map((c) => `${c.hora} · ${c.nombre} — ${c.grupo}${c.sede ? ` (${c.sede})` : ''}`),
            });
            if (!correos.length) continue;

            const resultado = await enviarConReserva({
                clave: `wa_resumen_diario:${integ.school_id}:${fecha}`,
                tipo: 'wa_resumen_diario',
                // v2 = con la sección de cortesías. Mientras send-email no
                // tenga desplegada la v2, cae al respaldo (que sí la trae).
                plantilla: 'wa_resumen_diario_v2',
                schoolId: integ.school_id,
                refId: null,
                destinos: correos,
                data: {
                    schoolName: escuela,
                    fecha,
                    resumen: partes.join(' · '),
                    familiasJson: JSON.stringify(r.familias.slice(0, MAX_FILAS)),
                    familiasTotal: String(r.familias.length),
                    comprobantesJson: JSON.stringify(r.comprobantes.slice(0, MAX_FILAS)),
                    comprobantesTotal: String(r.comprobantes.length),
                    prospectosJson: JSON.stringify(r.prospectos.slice(0, MAX_FILAS)),
                    prospectosTotal: String(r.prospectos.length),
                    cortesiasJson: JSON.stringify(cortesias.slice(0, MAX_FILAS * 2)),
                    cortesiasTotal: String(cortesias.length),
                    leadsJson: JSON.stringify(leads.slice(0, MAX_FILAS)),
                    leadsTotal: String(leads.length),
                    borradoresHuerfanos: String(r.borradoresHuerfanos?.borradores ?? 0),
                    cortesiasUrl: `${base}/whatsapp?tab=cortesias`,
                    inboxUrl: url,
                },
                respaldo: {
                    subject: `WhatsApp de ${escuela}: ${partes.join(', ')}`,
                    titulo: 'Lo que quedó esperando en WhatsApp',
                    lineas: [
                        ...(lineaCartera ? [`Cartera: ${lineaCartera.replace(/^cartera: /, '')}. Detalle en Finanzas → Cartera.`] : []),
                        ...(r.borradoresHuerfanos?.borradores
                            ? [`Borradores sin enviar: ${r.borradoresHuerfanos.borradores} en ${r.borradoresHuerfanos.conversaciones} conversación(es) — el bot está en automático y nadie los va a aprobar. Ábrelos en Configuración → «Responder ahora».`]
                            : []),
                        ...cortesias.slice(0, MAX_FILAS * 2).map((c) => `Clase de cortesía ${c.dia.toUpperCase()} ${c.hora}: ${c.nombre} (${c.paraQuien}) — ${c.grupo}${c.sede ? ` · ${c.sede}` : ''} · ${c.telefono}`),
                        ...leads.slice(0, MAX_FILAS).map((l) => `Lead sin agendar: ${l.nombre} (${l.paraQuien}) · ${l.telefono} · por ${l.origen} (${l.hora})`),
                        ...r.familias.slice(0, MAX_FILAS).map((f) => `Familia sin respuesta: ${f.contacto} — escribió ${f.esperaDesde}`),
                        ...r.comprobantes.slice(0, MAX_FILAS).map((c) => `Comprobante: ${c.contacto} — ${c.estado} (${c.hora})`),
                        ...r.prospectos.slice(0, MAX_FILAS).map((p) => `Prospecto: ${p.contacto} — ${p.respondido ? 'ya le respondieron' : 'sin respuesta de la escuela'} (${p.hora})`),
                    ],
                    enlace: { url, texto: 'Abrir WhatsApp en SportMaps' },
                },
            });
            if (resultado === 'enviado') enviados++;
        } catch (err: any) {
            console.error('[resumen-wa] falló la escuela', { schoolId: integ.school_id, error: err?.message || String(err) });
        }
    }
    return { escuelas: (integraciones ?? []).length, enviados };
}
