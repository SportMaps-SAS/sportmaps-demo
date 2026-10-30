/**
 * whatsapp-plantillas.service — cobranza automática con las plantillas de Meta
 * aprobadas en la WABA de CADA escuela.
 *
 * POR QUÉ EXISTE
 *
 * Hasta el 2026-10-04 la cobranza automática salía solo por correo
 * (payment-lifecycle-emails.job) e in-app (send_payment_reminders, pg_cron).
 * Las plantillas de Meta estaban registradas pero nada las usaba:
 * `payment_message_templates.meta_template_name/status` vacías en las 18 filas,
 * cero lectores en el código.
 *
 * Y no se podían enganchar ahí: una plantilla de Meta vive DENTRO de una WABA.
 * `pago_vence_hoy_v4` APROBADA en la WABA de prueba no sirve para el número de
 * Dynasty; allá se registró de nuevo el 2026-10-04 y arrancó en PENDING. El
 * estado es por (integración, nombre, idioma) → tabla `whatsapp_template_status`
 * (migración 20261004080918), alimentada por `sincronizarPlantillas`.
 *
 * EL MAPEO VA EN CÓDIGO, NO EN payment_message_templates
 *
 * Cada plantilla de Meta tiene variables POSICIONALES fijas, y las versiones
 * nuevas las movieron: en `_v3`/`_v4` {{2}} pasó a ser la escuela y {{4}} el
 * periodo. Un nombre en una columna sin el orden de variables que le
 * corresponde manda el nombre del niño donde va la escuela. Cambiar de nombre
 * exige cambiar código de todos modos, así que nombre y variables viajan juntos
 * aquí (CONCEPTOS).
 *
 * NUNCA LANZA
 *
 * `enviarCobroPorPlantilla` devuelve `{ enviado:false, motivo }` ante cualquier
 * faltante — sin plantilla aprobada, sin opt-in, fuera de horario, Graph caído —
 * para que el job caiga a correo/push sin try/catch alrededor.
 */

import { supabase } from '../config/supabase';
import { decryptToken } from './whatsapp.service';
import { esFestivoColombia } from '../utils/festivos-colombia';

const GRAPH_API_VERSION = process.env.WHATSAPP_GRAPH_VERSION || 'v21.0';
const GRAPH = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

// ─── Conceptos de la escalera de cobranza ────────────────────────────────────

export type ConceptoCobro =
    | 'recordatorio_previo'   // día -5
    | 'vence_manana'          // día -1
    | 'vence_hoy'             // día 0
    | 'pendiente_suave'       // día +2
    | 'pendiente_directo'     // día +7
    | 'aviso_final'           // día +12
    | 'pago_confirmado'       // evento
    | 'abono_recibido'        // evento
    | 'comprobante_rechazado' // evento: la escuela no validó el comprobante
    | 'pago_recibido_otro_concepto' // evento: pagado un cobro que NO es mensualidad (uniforme, torneo…)
    | 'comprobante_en_revision'     // evento: el comprobante quedó en un cobro, en revisión de la escuela
    | 'recordatorio_clase_cortesia' // víspera de la clase de cortesía (no es cobro)
    // Embudo del interesado y agenda de la clase de prueba (Monster, 2026-10-30). Ninguna es cobro.
    | 'recordatorio_clase_prueba'    // víspera de la clase de PRUEBA (escuela con nombre_clase='prueba')
    | 'clase_prueba_cupo_por_vencer' // el cupo separado vence en ~2 h y la ventana ya cerró
    | 'clase_prueba_reprogramada';   // la sesión se canceló (lluvia / el profe): elegir otro horario

/** Datos del cobro ya formateados para mostrar (COP, fechas en español). */
export interface DatosCobro {
    nombreContacto: string;   // "Carolina"
    nombreAtleta: string;     // "Samuel"
    nombreEscuela: string;    // "Dynasty Volley Club"
    periodo?: string | null;  // "octubre 2026"
    fechaVencimiento?: string | null; // "5 de octubre"
    monto: string;            // "$150.000"
    diasVencido?: number | null;
    montoAbono?: string | null;
    saldoPendiente?: string | null;
    /** Por qué no se validó un comprobante (comprobante_rechazado). */
    motivo?: string | null;
    /** Qué se pagó, como lo nombró la escuela («Uniforme de competencia»). pago_recibido_otro_concepto. */
    conceptoPago?: string | null;
    /** Clase de cortesía: «sábado 11 de octubre», «9:00 a. m.», «Coliseo (Cra 68 #63-45)». */
    dia?: string | null;
    hora?: string | null;
    sede?: string | null;
    /** Cupo separado: cuándo vence («hoy a las 4:45 p. m.»). clase_prueba_cupo_por_vencer. */
    vence?: string | null;
}

interface DefConcepto {
    /** Nombre en Meta. Un solo nombre por concepto: el que tiene variables codificadas abajo. */
    plantilla: string;
    idioma: string;
    /** ¿Es cobro? Los cobros respetan horario (Ley 2300 de 2023); los avisos de pago recibido no. */
    esCobro: boolean;
    /** Arma {{1}}..{{n}} en el orden EXACTO del cuerpo aprobado (ver whatsapp-templates/*.json). */
    variables: (d: DatosCobro) => (string | null | undefined)[];
}

export const CONCEPTOS: Record<ConceptoCobro, DefConcepto> = {
    // "Hola {{1}}, este es el estado de tu cuenta en {{2}}: la mensualidad de {{3}}
    //  correspondiente a {{4}} tiene fecha de vencimiento el {{5}}. Valor del cobro: {{6}}."
    recordatorio_previo: {
        plantilla: 'pago_recordatorio_previo_v3', idioma: 'es_CO', esCobro: true,
        variables: (d) => [d.nombreContacto, d.nombreEscuela, d.nombreAtleta, d.periodo, d.fechaVencimiento, d.monto],
    },
    // "Hola {{1}}, mañana vence la mensualidad de {{2}} por {{3}}."
    vence_manana: {
        plantilla: 'pago_vence_manana', idioma: 'es_CO', esCobro: true,
        variables: (d) => [d.nombreContacto, d.nombreAtleta, d.monto],
    },
    // "Hola {{1}}, este es el estado de tu cuenta en {{2}}: la mensualidad de {{3}}
    //  correspondiente a {{4}} vence hoy. Valor del cobro: {{5}}."
    vence_hoy: {
        plantilla: 'pago_vence_hoy_v4', idioma: 'es_CO', esCobro: true,
        variables: (d) => [d.nombreContacto, d.nombreEscuela, d.nombreAtleta, d.periodo, d.monto],
    },
    // "Hola {{1}}, quedó pendiente la mensualidad de {{2}} por {{3}}."
    pendiente_suave: {
        plantilla: 'pago_pendiente_suave', idioma: 'es_CO', esCobro: true,
        variables: (d) => [d.nombreContacto, d.nombreAtleta, d.monto],
    },
    // "Hola {{1}}, la mensualidad de {{2}} en {{3}} presenta {{4}} días de vencida (valor: {{5}})."
    pendiente_directo: {
        plantilla: 'pago_pendiente_directo', idioma: 'es_CO', esCobro: true,
        variables: (d) => [d.nombreContacto, d.nombreAtleta, d.nombreEscuela,
            d.diasVencido != null ? String(d.diasVencido) : null, d.monto],
    },
    // "...mensualidad de {{2}} por {{3}}. A partir de mañana el caso pasa a gestión directa de {{4}}."
    aviso_final: {
        plantilla: 'pago_aviso_final', idioma: 'es_CO', esCobro: true,
        variables: (d) => [d.nombreContacto, d.nombreAtleta, d.monto, d.nombreEscuela],
    },
    // "✅ Pago recibido: {{1}} por la mensualidad de {{2}} en {{3}}."
    pago_confirmado: {
        plantilla: 'pago_confirmado', idioma: 'es_CO', esCobro: false,
        variables: (d) => [d.monto, d.nombreAtleta, d.nombreEscuela],
    },
    // "Recibimos tu abono de {{1}} a la mensualidad de {{2}}. Saldo pendiente: {{3}} con fecha límite {{4}}."
    abono_recibido: {
        plantilla: 'abono_recibido', idioma: 'es_CO', esCobro: false,
        variables: (d) => [d.montoAbono, d.nombreAtleta, d.saldoPendiente, d.fechaVencimiento],
    },
    // "Hola {{1}}, revisamos el comprobante que enviaste por {{2}} de {{3}} y no pudimos validarlo: {{4}}."
    comprobante_rechazado: {
        plantilla: 'comprobante_rechazado', idioma: 'es_CO', esCobro: false,
        variables: (d) => [d.nombreContacto, d.monto, d.nombreAtleta, d.motivo],
    },
    // "✅ Pago recibido: {{1}} por {{2}} de {{3}} en {{4}}. ¡Gracias! Tu comprobante está disponible en el botón."
    // `pago_confirmado` dice «la mensualidad»: para un uniforme o un torneo sería mentirle a la familia.
    pago_recibido_otro_concepto: {
        plantilla: 'pago_recibido_otro_concepto', idioma: 'es_CO', esCobro: false,
        variables: (d) => [d.monto, d.conceptoPago, d.nombreAtleta, d.nombreEscuela],
    },
    // "Hola {{1}}, recibimos tu comprobante por {{2}} de {{3}}. {{4}} lo está revisando y te avisamos…"
    comprobante_en_revision: {
        plantilla: 'comprobante_en_revision', idioma: 'es_CO', esCobro: false,
        variables: (d) => [d.nombreContacto, d.monto, d.nombreAtleta, d.nombreEscuela],
    },
    // "Hola {{1}}, te recordamos la clase de cortesía que reservaste en {{2}}: {{3}} a las {{4}}, en {{5}}.
    //  Si no puedes asistir, responde CANCELAR y liberamos el cupo."
    recordatorio_clase_cortesia: {
        plantilla: 'recordatorio_clase_cortesia', idioma: 'es_CO', esCobro: false,
        variables: (d) => [d.nombreContacto, d.nombreEscuela, d.dia, d.hora, d.sede],
    },
    // "Hola {{1}}, te recordamos la clase de prueba de {{2}} en {{3}}: {{4}} a las {{5}}, en {{6}}.
    //  Si no pueden asistir, toquen «Cambiar horario»." [Ahí estaremos] [Cambiar horario] [No puedo ir]
    recordatorio_clase_prueba: {
        plantilla: 'recordatorio_clase_prueba', idioma: 'es_CO', esCobro: false,
        variables: (d) => [d.nombreContacto, d.nombreAtleta, d.nombreEscuela, d.dia, d.hora, d.sede],
    },
    // "Hola {{1}}, el cupo que separaste para la clase de prueba de {{2}} ({{3}} a las {{4}}) vence {{5}}.
    //  Para confirmarlo, envía por este chat el comprobante de pago por {{6}}."
    clase_prueba_cupo_por_vencer: {
        plantilla: 'clase_prueba_cupo_por_vencer', idioma: 'es_CO', esCobro: false,
        variables: (d) => [d.nombreContacto, d.nombreAtleta, d.dia, d.hora, d.vence, d.monto],
    },
    // "Hola {{1}}, la clase de prueba de {{2}} del {{3}} a las {{4}} no se va a realizar por {{5}}.
    //  Toca «Elegir otro horario» para escoger una nueva fecha, sin costo adicional." [Elegir otro horario]
    clase_prueba_reprogramada: {
        plantilla: 'clase_prueba_reprogramada', idioma: 'es_CO', esCobro: false,
        variables: (d) => [d.nombreContacto, d.nombreAtleta, d.dia, d.hora, d.motivo],
    },
};

// ─── Ventana de 24 h ─────────────────────────────────────────────────────────

/** Horas en que Meta deja mandar texto libre después del último mensaje del contacto. */
export const HORAS_VENTANA = 24;

/**
 * ¿Se le puede escribir texto libre? Solo si la familia escribió en las últimas
 * 24 h (con 15 min de margen: el aviso puede tardar en salir). Sin dato, no:
 * fuera de la ventana Meta rechaza el texto con 131047 y el mensaje se pierde.
 */
export function ventanaAbierta(ultimoEntrante: string | null | undefined, ahora: number = Date.now()): boolean {
    if (!ultimoEntrante) return false;
    const t = new Date(ultimoEntrante).getTime();
    if (Number.isNaN(t)) return false;
    return ahora - t < HORAS_VENTANA * 3600_000 - 15 * 60_000;
}

/** ¿El error de Meta es la ventana cerrada? (131047, «Re-engagement message»). */
export function esErrorDeVentana(detalle: string | null | undefined): boolean {
    return /131047|re-?engagement/i.test(String(detalle ?? ''));
}

// ─── Motivos de no envío ──────────────────────────────────────────────────────

export type MotivoNoEnvio =
    | 'sin_integracion'          // la escuela no tiene WhatsApp activo con WABA
    | 'integracion_ambigua'      // más de una integración activa: no se adivina
    | 'plantilla_no_aprobada'    // no está APPROVED en ESTA WABA (o nunca se sincronizó)
    | 'plantilla_recategorizada' // Meta la pasó a MARKETING: otro costo y otro consentimiento
    | 'variables_no_coinciden'   // lo aprobado en Meta no tiene las variables que armamos
    | 'dato_faltante'            // alguna variable quedaría vacía (Meta rechaza el envío)
    | 'telefono_invalido'
    | 'sin_optin'                // wa_can_send_template = false (sin consentimiento o bloqueado)
    | 'fuera_de_horario'         // cobro fuera del horario legal de cobranza
    | 'sin_enlace'               // el botón URL necesita token y no hay
    | 'token_invalido'
    | 'error_graph';

export type ResultadoEnvio =
    | { enviado: true; waMessageId: string | null; plantilla: string }
    | { enviado: false; motivo: MotivoNoEnvio; detalle?: string };

// ─── Utilidades puras (testeables sin base) ───────────────────────────────────

/**
 * Teléfono → wa_id de Meta (E.164 sin '+'). Solo Colombia, que es donde están
 * todas las escuelas conectadas: 10 dígitos que empiezan por 3 → 57 + número.
 * Lo que no se reconoce devuelve null: mandarle cobranza a un número mal
 * armado es mandársela a un desconocido.
 */
export function aWaId(telefono: string | null | undefined): string | null {
    if (!telefono) return null;
    const d = telefono.replace(/\D/g, '');
    if (/^3\d{9}$/.test(d)) return `57${d}`;
    if (/^573\d{9}$/.test(d)) return d;
    return null;
}

/**
 * Meta rechaza parámetros con saltos de línea, tabs o más de 4 espacios
 * seguidos (error 132018). Un nombre pegado de un Excel los trae.
 */
export function limpiarParametro(v: string): string {
    return v.replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim();
}

/** Mayor {{n}} del cuerpo aprobado; 0 si no hay cuerpo. */
export function variablesDelCuerpo(components: any[] | null | undefined): number {
    const body = (components ?? []).find((c: any) => String(c?.type).toUpperCase() === 'BODY');
    const nums = [...String(body?.text ?? '').matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
    return nums.length ? Math.max(...nums) : 0;
}

/** ¿El cuerpo aprobado tiene un botón URL dinámico? (todas las de cobranza lo tienen) */
export function tieneBotonUrlDinamico(components: any[] | null | undefined): boolean {
    const botones = (components ?? []).find((c: any) => String(c?.type).toUpperCase() === 'BUTTONS');
    return (botones?.buttons ?? []).some((b: any) => String(b?.type).toUpperCase() === 'URL' && /\{\{1\}\}/.test(b?.url ?? ''));
}

/** El cuerpo con las variables puestas — para que el buzón muestre lo que le llegó al acudiente. */
export function renderizarCuerpo(components: any[] | null | undefined, vars: string[]): string {
    const body = (components ?? []).find((c: any) => String(c?.type).toUpperCase() === 'BODY');
    return String(body?.text ?? '').replace(/\{\{(\d+)\}\}/g, (_, n) => vars[Number(n) - 1] ?? '');
}

/**
 * Horario legal de cobranza en Colombia (Ley 2300 de 2023, "dejen de fregar"):
 * lunes a viernes 7:00–19:00, sábados 8:00–15:00, nunca domingos ni festivos
 * (art. 3: "excluyendo cualquier tipo de contacto con el consumidor los domingos
 * y días festivos"). Los festivos salen de un calendario calculado
 * (utils/festivos-colombia) y no de la base, para que no dependa de cargar el
 * año. El job de "pago vencido" corre a las 07:15 UTC = 02:15 COT, así que sin
 * este control mandaría la cobranza de madrugada.
 */
export function dentroDeHorarioDeCobranza(ahora: Date = new Date()): boolean {
    // Bogotá es UTC-5 todo el año (sin horario de verano).
    const cot = new Date(ahora.getTime() - 5 * 3600_000);
    const dia = cot.getUTCDay(); // 0 domingo
    const minutos = cot.getUTCHours() * 60 + cot.getUTCMinutes();
    if (dia === 0) return false;
    // Festivo = domingo para la ley: ningún cobro, a ninguna hora.
    if (esFestivoColombia(ahora)) return false;
    if (dia === 6) return minutos >= 8 * 60 && minutos < 15 * 60;
    return minutos >= 7 * 60 && minutos < 19 * 60;
}

/** Arma el payload `type: template` de Graph. Puro: lo prueban los tests de _v3/_v4. */
export function armarPayloadPlantilla(params: {
    toWaId: string;
    plantilla: string;
    idioma: string;
    variables: string[];
    tokenBoton: string | null;
}): any {
    const components: any[] = [{
        type: 'body',
        parameters: params.variables.map((text) => ({ type: 'text', text })),
    }];
    if (params.tokenBoton) {
        // El botón dinámico se llena SOLO con el sufijo (token), nunca la URL
        // completa: la base https://sportmaps.co/p/ es parte de lo aprobado.
        components.push({
            type: 'button', sub_type: 'url', index: '0',
            parameters: [{ type: 'text', text: params.tokenBoton }],
        });
    }
    return {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: params.toWaId,
        type: 'template',
        template: { name: params.plantilla, language: { code: params.idioma }, components },
    };
}

// ─── Integración ─────────────────────────────────────────────────────────────

interface IntegracionMin {
    id: string;
    school_id: string;
    waba_id: string | null;
    phone_number_id: string;
    access_token_encrypted: string | null;
    status: string;
}

const COLS_INTEGRACION = 'id, school_id, waba_id, phone_number_id, access_token_encrypted, status';

async function integracionPorId(integrationId: string): Promise<IntegracionMin | null> {
    const { data } = await supabase
        .from('school_whatsapp_integrations')
        .select(COLS_INTEGRACION)
        .eq('id', integrationId)
        .maybeSingle();
    return (data as IntegracionMin) ?? null;
}

async function integracionDeEscuela(schoolId: string): Promise<IntegracionMin | MotivoNoEnvio> {
    const { data } = await supabase
        .from('school_whatsapp_integrations')
        .select(COLS_INTEGRACION)
        .eq('school_id', schoolId)
        .eq('status', 'active');
    const activas = ((data as IntegracionMin[]) ?? []).filter((i) => i.waba_id && i.access_token_encrypted);
    if (activas.length === 0) return 'sin_integracion';
    if (activas.length > 1) return 'integracion_ambigua';
    return activas[0];
}

// ─── Sync: Meta → whatsapp_template_status ──────────────────────────────────

/** Estados que acepta el CHECK de la tabla. Lo demás entra como UNKNOWN. */
const ESTADOS_CONOCIDOS = new Set([
    'APPROVED', 'PENDING', 'REJECTED', 'PAUSED', 'DISABLED', 'IN_APPEAL',
    'PENDING_DELETION', 'DELETED', 'LIMIT_EXCEEDED', 'ARCHIVED',
]);
const normalizarEstado = (s: unknown) => {
    const v = String(s ?? '').toUpperCase();
    return ESTADOS_CONOCIDOS.has(v) ? v : 'UNKNOWN';
};

export interface ResultadoSync {
    integrationId: string;
    ok: boolean;
    fuente: 'graph' | 'webhook' | 'ninguna';
    plantillas: number;
    aprobadas: number;
    error?: string;
}

/** GET /{waba}/message_templates con paginación. Solo lectura en Meta. */
export async function listarPlantillasEnMeta(wabaId: string, token: string): Promise<any[]> {
    const todas: any[] = [];
    let url: string | undefined =
        `${GRAPH}/${wabaId}/message_templates?fields=id,name,status,category,language,components,rejected_reason&limit=100`;
    while (url) {
        const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        const j: any = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j?.error?.message || `graph_${r.status}`);
        todas.push(...(j.data ?? []));
        url = j.paging?.next;
    }
    return todas;
}

/**
 * Trae el estado REAL de las plantillas de la WABA de esta integración y lo
 * guarda. Fuente de verdad: el listado de Meta. Si Graph falla (token vencido,
 * caída), se aplican los eventos `message_template_status_update` que el
 * webhook ya dejó en whatsapp_account_events — así una plantilla que Meta
 * desactiva deja de usarse aunque el listado no responda.
 */
export async function sincronizarPlantillas(integrationId: string): Promise<ResultadoSync> {
    const base: ResultadoSync = { integrationId, ok: false, fuente: 'ninguna', plantillas: 0, aprobadas: 0 };
    const integ = await integracionPorId(integrationId);
    if (!integ?.waba_id) return { ...base, error: 'sin_waba' };

    let token: string | null = null;
    try {
        token = integ.access_token_encrypted ? decryptToken(integ.access_token_encrypted) : null;
    } catch {
        token = null;
    }

    if (token) {
        try {
            const enMeta = await listarPlantillasEnMeta(integ.waba_id, token);
            const ahora = new Date().toISOString();
            const filas = enMeta.map((t) => ({
                integration_id: integ.id,
                school_id: integ.school_id,
                waba_id: integ.waba_id,
                name: String(t.name),
                language: String(t.language),
                category: t.category ?? null,
                status: normalizarEstado(t.status),
                meta_id: t.id != null ? String(t.id) : null,
                rejected_reason: t.rejected_reason && t.rejected_reason !== 'NONE' ? String(t.rejected_reason) : null,
                components: t.components ?? null,
                source: 'sync',
                synced_at: ahora,
                updated_at: ahora,
            }));
            if (filas.length) {
                const { error } = await supabase
                    .from('whatsapp_template_status')
                    .upsert(filas, { onConflict: 'integration_id,name,language' });
                if (error) return { ...base, error: error.message };
            }

            // Lo que ya no está en el listado fue borrado en Meta. Si quedara
            // APPROVED aquí, la cobranza intentaría mandarla y Graph la rechazaría
            // mensaje por mensaje.
            const vivas = new Set(filas.map((f) => `${f.name}|${f.language}`));
            const { data: guardadas } = await supabase
                .from('whatsapp_template_status')
                .select('id, name, language, status')
                .eq('integration_id', integ.id)
                .eq('waba_id', integ.waba_id);
            const borradas = ((guardadas as any[]) ?? [])
                .filter((g) => !vivas.has(`${g.name}|${g.language}`) && g.status !== 'DELETED')
                .map((g) => g.id);
            if (borradas.length) {
                await supabase.from('whatsapp_template_status')
                    .update({ status: 'DELETED', source: 'sync', synced_at: ahora, updated_at: ahora })
                    .in('id', borradas);
            }

            return {
                ...base, ok: true, fuente: 'graph',
                plantillas: filas.length,
                aprobadas: filas.filter((f) => f.status === 'APPROVED').length,
            };
        } catch (err: any) {
            base.error = err?.message || 'graph_error';
        }
    } else {
        base.error = 'token_invalido';
    }

    // Respaldo: eventos del webhook.
    const aplicados = await aplicarEventosDelWebhook(integ);
    return { ...base, fuente: aplicados > 0 ? 'webhook' : 'ninguna', plantillas: aplicados };
}

/**
 * Aplica sobre la tabla los eventos de plantilla posteriores al último sync de
 * cada fila. Lee whatsapp_account_events (que escribe routes/whatsapp.ts); no
 * toca el webhook. Los eventos de plantilla son de nivel WABA: se buscan por
 * integration_id o, si el webhook no pudo atribuirlos, por waba_id.
 */
export async function aplicarEventosDelWebhook(integ: IntegracionMin): Promise<number> {
    if (!integ.waba_id) return 0;
    const { data: eventos } = await supabase
        .from('whatsapp_account_events')
        .select('field, template_name, nuevo_estado, motivo, payload, created_at, integration_id, waba_id')
        .in('field', ['message_template_status_update', 'template_category_update'])
        .or(`integration_id.eq.${integ.id},waba_id.eq.${integ.waba_id}`)
        .order('created_at', { ascending: true })
        .limit(500);
    if (!eventos?.length) return 0;

    const { data: filas } = await supabase
        .from('whatsapp_template_status')
        .select('id, name, language, synced_at')
        .eq('integration_id', integ.id);
    const porClave = new Map(((filas as any[]) ?? []).map((f) => [`${f.name}|${f.language}`, f]));

    let aplicados = 0;
    for (const e of eventos as any[]) {
        const v = e.payload?.value ?? {};
        const nombre = e.template_name ?? v.message_template_name;
        const idioma = v.message_template_language;
        if (!nombre || !idioma) continue;
        const actual = porClave.get(`${nombre}|${idioma}`);
        // Un evento más viejo que el último sync ya está reflejado en el listado.
        if (actual && new Date(e.created_at) <= new Date(actual.synced_at)) continue;

        const cambios: Record<string, any> = { source: 'webhook', synced_at: e.created_at, updated_at: new Date().toISOString() };
        if (e.field === 'message_template_status_update') {
            const estado = String(v.event ?? e.nuevo_estado ?? '').toUpperCase();
            // FLAGGED / REINSTATED no son estados de la plantilla sino avisos de
            // calidad: FLAGGED sigue APPROVED (puede pausarse después), REINSTATED
            // vuelve a APPROVED.
            if (estado === 'FLAGGED') continue;
            cambios.status = estado === 'REINSTATED' ? 'APPROVED' : normalizarEstado(estado);
            cambios.rejected_reason = v.reason && v.reason !== 'NONE' ? String(v.reason) : null;
            if (v.message_template_category) cambios.category = v.message_template_category;
            if (v.message_template_id != null) cambios.meta_id = String(v.message_template_id);
        } else {
            if (!v.new_category) continue;
            cambios.category = String(v.new_category);
        }

        if (actual) {
            await supabase.from('whatsapp_template_status').update(cambios).eq('id', actual.id);
            actual.synced_at = e.created_at;
        } else if (cambios.status) {
            // Una plantilla que el sync nunca vio (registrada después del último
            // listado): se crea con lo que dice el evento, sin componentes. El
            // envío la rechaza por 'variables_no_coinciden' hasta el próximo sync
            // exitoso, que es lo prudente.
            const { data: nueva } = await supabase.from('whatsapp_template_status').insert({
                integration_id: integ.id, school_id: integ.school_id, waba_id: integ.waba_id,
                name: nombre, language: idioma, ...cambios,
            }).select('id, name, language, synced_at').maybeSingle();
            if (nueva) porClave.set(`${nombre}|${idioma}`, nueva);
        } else {
            continue;
        }
        aplicados++;
    }
    return aplicados;
}

// ─── ¿Está aprobada? ────────────────────────────────────────────────────────

export type PlantillaVigente =
    | { aprobada: true; nombre: string; idioma: string; components: any[] }
    | { aprobada: false; motivo: MotivoNoEnvio; detalle?: string };

/**
 * ¿La plantilla del concepto está APPROVED y sigue siendo UTILITY en la WABA
 * ACTUAL de esta integración? Lee solo la tabla (el sync la mantiene).
 */
export async function plantillaAprobada(integrationId: string, concepto: ConceptoCobro): Promise<PlantillaVigente> {
    const def = CONCEPTOS[concepto];
    const integ = await integracionPorId(integrationId);
    if (!integ?.waba_id) return { aprobada: false, motivo: 'sin_integracion' };

    const { data } = await supabase
        .from('whatsapp_template_status')
        .select('name, language, category, status, components, waba_id')
        .eq('integration_id', integrationId)
        .eq('name', def.plantilla)
        .eq('language', def.idioma)
        .maybeSingle();
    const fila = data as any;

    // waba_id distinto = la escuela reconectó con otra WABA: lo guardado es de la vieja.
    if (!fila || fila.waba_id !== integ.waba_id || fila.status !== 'APPROVED') {
        return { aprobada: false, motivo: 'plantilla_no_aprobada', detalle: `${def.plantilla}: ${fila?.status ?? 'sin sincronizar'}` };
    }
    // Recategorizada a MARKETING: cuesta ~3x y el opt-in que tenemos no la cubre.
    if (fila.category && fila.category !== 'UTILITY') {
        return { aprobada: false, motivo: 'plantilla_recategorizada', detalle: `${def.plantilla}: ${fila.category}` };
    }
    return { aprobada: true, nombre: fila.name, idioma: fila.language, components: fila.components ?? [] };
}

// ─── Envío ──────────────────────────────────────────────────────────────────

export interface EnvioCobro {
    schoolId: string;
    concepto: ConceptoCobro;
    telefono: string | null | undefined;
    datos: DatosCobro;
    /** Sufijo de https://sportmaps.co/p/{token}. Sin él no se manda (el botón es obligatorio). */
    tokenBoton: string | null;
    /** Para trazabilidad en el payload del mensaje saliente. */
    paymentId?: string;
    parentId?: string | null;
    ahora?: Date;
    /**
     * Se mezcla en el payload del saliente que queda en el buzón. Lo usa el
     * recordatorio de cortesía para dejar el estado del flujo (`flujo`,
     * `paso_cortesia`), así la respuesta «CANCELAR» se lee contra él.
     */
    payloadExtra?: Record<string, unknown>;
}

/**
 * Manda un cobro por la plantilla aprobada de la WABA de la escuela.
 *
 * Orden de los controles: integración → plantilla → teléfono → opt-in → datos →
 * botón → token → horario → envío. Todo faltante vuelve como motivo; nada lanza.
 */
export async function enviarCobroPorPlantilla(p: EnvioCobro): Promise<ResultadoEnvio> {
    const def = CONCEPTOS[p.concepto];

    const integ = await integracionDeEscuela(p.schoolId);
    if (typeof integ === 'string') return { enviado: false, motivo: integ };

    const vigente = await plantillaAprobada(integ.id, p.concepto);
    if (!vigente.aprobada) return { enviado: false, motivo: vigente.motivo, detalle: vigente.detalle };

    const toWaId = aWaId(p.telefono);
    if (!toWaId) return { enviado: false, motivo: 'telefono_invalido' };

    // Consentimiento + kill-switch en una sola pregunta (spec de opt-in §4.2).
    // Ante error de consulta, NO se envía: mandar cobranza sin consentimiento es
    // el riesgo que puede tumbar el Tech Provider.
    const { data: puede, error: errOptin } = await supabase.rpc('wa_can_send_template', {
        p_integration_id: integ.id,
        p_contact_wa_id: toWaId,
    });
    if (errOptin || puede !== true) {
        return { enviado: false, motivo: 'sin_optin', detalle: errOptin?.message };
    }

    const crudas = def.variables(p.datos);
    if (crudas.some((v) => v == null || String(v).trim() === '')) {
        return { enviado: false, motivo: 'dato_faltante', detalle: def.plantilla };
    }
    const variables = crudas.map((v) => limpiarParametro(String(v)));
    const esperadas = variablesDelCuerpo(vigente.components);
    if (esperadas !== variables.length) {
        return {
            enviado: false, motivo: 'variables_no_coinciden',
            detalle: `${def.plantilla}: Meta tiene ${esperadas}, armamos ${variables.length}`,
        };
    }
    const llevaBoton = tieneBotonUrlDinamico(vigente.components);
    if (llevaBoton && !p.tokenBoton) return { enviado: false, motivo: 'sin_enlace' };

    let token: string;
    try {
        token = decryptToken(integ.access_token_encrypted as string);
    } catch {
        return { enviado: false, motivo: 'token_invalido' };
    }

    // El horario va AL FINAL a propósito: 'fuera_de_horario' significa "todo
    // está listo, solo falta la hora". Así el job puede posponer ESE cobro al
    // siguiente tick sin confundirlo con uno que nunca va a salir por WhatsApp.
    if (def.esCobro && !dentroDeHorarioDeCobranza(p.ahora)) {
        return { enviado: false, motivo: 'fuera_de_horario' };
    }

    const payload = armarPayloadPlantilla({
        toWaId, plantilla: vigente.nombre, idioma: vigente.idioma, variables,
        tokenBoton: llevaBoton ? p.tokenBoton : null,
    });

    let waMessageId: string | null = null;
    try {
        const r = await fetch(`${GRAPH}/${integ.phone_number_id}/messages`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const j: any = await r.json().catch(() => ({}));
        if (!r.ok) return { enviado: false, motivo: 'error_graph', detalle: j?.error?.message || `graph_${r.status}` };
        waMessageId = j?.messages?.[0]?.id ?? null;
    } catch (err: any) {
        return { enviado: false, motivo: 'error_graph', detalle: err?.message || 'network_error' };
    }

    // El mensaje YA salió: un fallo al registrarlo no lo convierte en "no enviado"
    // (eso haría que el job cayera a correo y el acudiente recibiera dos avisos).
    await registrarSaliente({
        integ, toWaId, waMessageId, plantilla: vigente.nombre,
        texto: renderizarCuerpo(vigente.components, variables),
        // parent_id va al payload y NO a la conversación: allí solo se estampa
        // tras OTP (riesgo R17); que el cobro sea suyo no prueba que el número lo sea.
        payload: {
            step: `cobro_${p.concepto}`, plantilla: vigente.nombre,
            payment_id: p.paymentId ?? null, parent_id: p.parentId ?? null, variables,
            ...(p.payloadExtra ?? {}),
        },
    }).catch(() => undefined);

    return { enviado: true, waMessageId, plantilla: vigente.nombre };
}

/**
 * Deja el saliente en el buzón. La conversación puede no existir (es la primera
 * vez que la escuela le escribe a ese número): se crea, para que la respuesta
 * del acudiente caiga en el mismo hilo (uq_wa_conversation).
 */
async function registrarSaliente(a: {
    integ: IntegracionMin; toWaId: string; waMessageId: string | null; plantilla: string;
    texto: string; payload: Record<string, any>;
}): Promise<void> {
    await supabase.from('whatsapp_conversations').upsert({
        integration_id: a.integ.id,
        school_id: a.integ.school_id,
        contact_wa_id: a.toWaId,
    }, { onConflict: 'integration_id,contact_wa_id', ignoreDuplicates: true });

    const { data: conv } = await supabase
        .from('whatsapp_conversations')
        .select('id')
        .eq('integration_id', a.integ.id)
        .eq('contact_wa_id', a.toWaId)
        .maybeSingle();
    if (!conv?.id) return;

    await supabase.rpc('wa_record_outbound_message', {
        p_conversation_id: conv.id,
        p_integration_id: a.integ.id,
        p_wa_message_id: a.waMessageId || `local-${crypto.randomUUID()}`,
        p_type: 'template',
        p_text_body: a.texto,
        // Plantilla de un job: no es una persona de la escuela (ver esHumanoDeLaEscuela).
        p_payload: { ...a.payload, automatico: true },
        p_ai_generated: false,
        p_to_wa_id: a.toWaId,
    });
}
