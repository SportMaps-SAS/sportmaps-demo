/**
 * whatsapp-admin.routes — lo que la ESCUELA ve y configura de su canal.
 *
 *   GET   /api/v1/whatsapp/:schoolId            → integración, ajustes y consumo
 *   PATCH /api/v1/whatsapp/:schoolId/settings   → modo, IA, horario, saludo
 *   GET   /api/v1/whatsapp/:schoolId/bandeja    → comprobantes que quedaron sin resolver
 *   GET   /api/v1/whatsapp/:schoolId/eventos    → avisos de Meta (plantillas, calidad)
 *   GET   /api/v1/whatsapp/:schoolId/conversaciones?vista=familias|otros|todas → buzón (Fase A)
 *   PATCH /api/v1/whatsapp/:schoolId/conversaciones/:id/tipo   → marcar/desmarcar personal
 *   POST  /api/v1/whatsapp/:schoolId/conversaciones/:id/cerrar → dar por atendida
 *
 * Sobre la autorización: NO se reusa el `isSchoolAuthorized` que hay en
 * payment-providers.routes y reconciliation.routes. Ese termina en
 *
 *     return profile?.role === 'school_admin' || profile?.role === 'owner';
 *
 * que mira el rol GLOBAL del perfil y no lo compara contra la escuela pedida:
 * quien tuviera ese rol entraría a cualquier escuela. Hoy no otorga acceso a
 * nadie —ningún perfil tiene `school_admin`, y `owner` ni siquiera es un valor
 * válido del enum— pero es una bomba de tiempo. Acá se verifica la membresía
 * REAL en ESA escuela.
 */

import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import { CONCEPTOS } from '../services/whatsapp-plantillas.service';
import { supabase } from '../config/supabase';
import { requireAuth, type AuthenticatedRequest } from '../middlewares/authMiddleware';
import { decryptToken, sendTextMessage, aFormatoWhatsApp,
         type WhatsAppIntegration } from '../services/whatsapp.service';
import { conectarEscuela } from '../services/whatsapp-onboarding.service';
import { calcularPendientes, contarPorVista, esColumnaInexistente, estaPendiente, vistaDeTipo,
         type VistaDelBuzon } from '../services/whatsapp-buzon';
import { tomarConversacion, soltarConversacion, tomasDe, HORAS_TOMADA_DEFAULT, HORAS_TOMADA_MAX,
         HORAS_TOMADA_AL_RESPONDER } from '../services/whatsapp-tomada.service';
import { PASO_PROSPECTO } from '../services/whatsapp-metricas';
import { esCierreSuelto } from '../services/whatsapp-reglas-turno';
import { vocativosDeEscuela } from '../services/whatsapp-bot.service';
import { contarBorradoresHuerfanos, ponerseAlDia } from '../services/whatsapp-ponerse-al-dia.service';
import { prospectosDeConversaciones } from '../services/whatsapp-prospecto-lead.service';
import { medioDelMensaje } from '../services/whatsapp-medios';
import { ESTADOS_BANDEJA, PREFIJO_CERRADA, candidatosASugerir, clasificarFila, contarCierres, estaCerrada,
         filaCuentaEnBandeja, filasParaAutocierre, filasParaAutocierrePorDecision, filasParaCierrePorMarca, huellasDeFila,
         marcaDeCierre, motivoDeCierrePorMarca, motivoDeFila, referenciaUsada, resumenDeGrupos,
         type GrupoBandeja, type PagoDecidible, type PagoMinimo, type SugerenciaDeMarca } from '../services/whatsapp-bandeja.service';
import { TIPOS_MARCADOS, esMarcaNoFamilia, type TipoMarcado } from '../services/whatsapp-tipo-contacto';

const router = Router();

/** Mensajes incluidos por mes y por número. Meta regala 1.000 por número. */
const INCLUIDOS_POR_DEFECTO = 1000;
/** A partir de este consumo se avisa que se acerca al tope. */
const UMBRAL_AVISO = 0.8;

/**
 * ¿Este usuario administra ESTA escuela?
 *
 * Se pregunta por la membresía real, no por el rol del perfil. El super admin de
 * plataforma pasa, como en el resto del producto.
 */
/** Primer instante del mes corriente en hora de Bogota, que es como factura Meta. */
function inicioDelMesBogota(): string {
    const ahora = new Date();
    const bogota = new Date(ahora.toLocaleString('en-US', { timeZone: 'America/Bogota' }));
    return new Date(Date.UTC(bogota.getFullYear(), bogota.getMonth(), 1, 5, 0, 0)).toISOString();
}

export async function administraEstaEscuela(userId: string, schoolId: string): Promise<boolean> {
    // Las tres preguntas van EN PARALELO. Encadenadas costaban ~1,6 s, y como
    // este chequeo corre en cada endpoint, la pantalla gastaba unos 6 segundos
    // verificando cuatro veces lo mismo. Cada consulta contra esta Supabase
    // ronda el medio segundo, asi que lo que se paga es el viaje, no el trabajo.
    const [plataforma, escuela, miembro] = await Promise.all([
        // SEG-26: el atajo de plataforma preguntaba a profiles.role (autoasignable).
        // Ahora a platform_admins, misma fuente que is_super_admin().
        supabase.from('platform_admins').select('profile_id')
            .eq('profile_id', userId).eq('is_active', true).limit(1),
        supabase.from('schools').select('owner_id').eq('id', schoolId).maybeSingle(),
        supabase.from('school_members').select('role, status')
            .eq('school_id', schoolId).eq('profile_id', userId).maybeSingle(),
    ]);

    if ((plataforma.data ?? []).length > 0) return true;
    if (escuela.data?.owner_id === userId) return true;

    return miembro.data?.status === 'active'
        && ['owner', 'admin', 'school_admin'].includes(String(miembro.data?.role));
}

/**
 * Ajustes del canal, con `responder_desconocidos` si la columna ya existe.
 *
 * La columna llega con la migración 20261003193624 (Fase A), que se aplica a
 * mano. Mientras no esté, pedirla rompe la consulta entera: se reintenta sin
 * ella y se informa `false`, que es su default.
 */
const COLUMNAS_AJUSTES = 'mode, ai_enabled, assisted_until, business_hours, welcome_message';
async function ajustesDe(integrationId: string) {
    // `responder_prospectos` (migración 20261006110920): sin la columna, true.
    const conProspectos = await supabase.from('whatsapp_settings')
        .select(`${COLUMNAS_AJUSTES}, responder_desconocidos, responder_prospectos`)
        .eq('integration_id', integrationId).maybeSingle();
    if (!conProspectos.error) return conProspectos;
    const con0 = await supabase.from('whatsapp_settings')
        .select(`${COLUMNAS_AJUSTES}, responder_desconocidos`)
        .eq('integration_id', integrationId).maybeSingle();
    if (!con0.error) {
        return { ...con0, data: con0.data ? { ...(con0.data as any), responder_prospectos: true } : con0.data };
    }
    const con = await supabase.from('whatsapp_settings')
        .select(`${COLUMNAS_AJUSTES}, responder_desconocidos`)
        .eq('integration_id', integrationId).maybeSingle();
    if (!con.error) return con;
    if (!esColumnaInexistente(con.error)) return con;
    const sin = await supabase.from('whatsapp_settings')
        .select(COLUMNAS_AJUSTES)
        .eq('integration_id', integrationId).maybeSingle();
    return { ...sin, data: sin.data ? { ...(sin.data as any), responder_desconocidos: false } : sin.data };
}

async function integracionDe(schoolId: string) {
    const { data } = await supabase
        .from('school_whatsapp_integrations')
        .select('id, school_id, phone_number_id, waba_id, display_phone_number, status, created_at')
        .eq('school_id', schoolId)
        .maybeSingle();
    return data;
}

// ── GET / — el estado completo del canal ────────────────────────────────────
router.get('/:schoolId', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const { schoolId } = req.params as { schoolId: string };
    if (!(await administraEstaEscuela(req.user.id, schoolId))) {
        return res.status(403).json({ error: 'forbidden' });
    }

    const integracion = await integracionDe(schoolId);
    if (!integracion) {
        // La escuela no tiene el canal conectado. No es un error: es el estado
        // normal antes del Embedded Signup.
        return res.json({ conectado: false, integracion: null, ajustes: null, consumo: null });
    }

    // Todo lo que sale de la base, en un solo viaje de ida. La bandeja y los
    // eventos venian en endpoints aparte: eran dos verificaciones de permisos
    // mas y dos round-trips mas, para datos chicos de la misma consulta.
    const [ajustesR, consumoR, bandejaR, eventosR] = await Promise.all([
        ajustesDe(integracion.id),
        // OJO: aca NO va `wa_consumo_del_mes`. Ese RPC lleva su propio candado
        // (`is_school_admin`) pensado para que el navegador lo llame directo. El
        // BFF entra con service_role, que no tiene JWT, asi que el candado daba
        // false y la funcion devolvia todo en cero — el medidor se veia vacio con
        // mensajes cobrados de por medio. Se lee la tabla directo, que es lo que
        // la propia migracion prescribe para los llamadores internos; la
        // autorizacion ya la hizo `administraEstaEscuela()` mas arriba.
        supabase.from('whatsapp_messages')
            .select('billable, pricing_category')
            .eq('integration_id', integracion.id)
            .eq('direction', 'outbound')
            .gte('created_at', inicioDelMesBogota()),
        filasAbiertasDeBandeja(schoolId),
        supabase.from('whatsapp_account_events')
            .select('id, field, template_name, estado_previo, nuevo_estado, motivo, visto_at, created_at')
            .eq('school_id', schoolId)
            .order('created_at', { ascending: false }).limit(50),
    ]);
    const ajustes = ajustesR.data;
    // El barrido corre también acá (no solo al abrir la pestaña): si no, el
    // contador de la pestaña y del Resumen cuenta comprobantes que ya se
    // decidieron en Pagos hasta que alguien entre a la Bandeja.
    const cerradasAlCargar = await autocerrarYaRegistradas(schoolId, bandejaR.filas, req.log).catch(() => new Set<string>());
    const filasBandeja = bandejaR.filas.filter((f) => !cerradasAlCargar.has(f.id));
    // La bandeja va clasificada: el contador de la pestaña es lo que requiere
    // acción, no todo lo que el bot no aplicó (ver whatsapp-bandeja.service).
    const bandeja = armarBandeja(filasBandeja,
        await conversacionesPorNumero(integracion.id, filasBandeja.map((f) => f.wa_phone_number)));

    // El desglose se arma aca con la misma forma que devolvia el RPC, para que
    // la pantalla no note la diferencia.
    const salientes = consumoR.data ?? [];
    const porCategoria: Record<string, number> = {};
    for (const m of salientes) {
        if (m.billable !== true) continue;
        const k = m.pricing_category ?? 'sin_categoria';
        porCategoria[k] = (porCategoria[k] ?? 0) + 1;
    }
    const consumo = {
        desde: inicioDelMesBogota(),
        facturables: salientes.filter((m) => m.billable === true).length,
        gratis: salientes.filter((m) => m.billable === false).length,
        // Salientes cuyo `status` de Meta nunca llego. Si esto crece, el webhook
        // de statuses dejo de procesarse y el medidor esta quedando ciego.
        sin_estado: salientes.filter((m) => m.billable === null || m.billable === undefined).length,
        por_categoria: porCategoria,
    };

    const facturables = Number((consumo as any)?.facturables ?? 0);
    const incluidos = INCLUIDOS_POR_DEFECTO;
    // En modo auto el bot no deja borradores: si hay `pending` con la ventana
    // abierta, quedaron de un rato en asistido y nadie los va a aprobar.
    const borradoresHuerfanos = (ajustes as any)?.mode === 'auto'
        ? await contarBorradoresHuerfanos(integracion as any)
        : { conversaciones: 0, borradores: 0 };

    return res.json({
        conectado: true,
        integracion,
        // `mode` por defecto 'assisted' si no hay fila: es el default de la tabla,
        // y es importante que la UI lo muestre — una escuela en asistido tiene un
        // bot que responde y nada sale hasta que alguien aprueba.
        //
        // Sin fila de ajustes el asistente está APAGADO: así lo trata
        // whatsapp-atencion.service. La pantalla tiene que decir lo mismo que hace.
        ajustes: ajustes ?? { mode: 'assisted', ai_enabled: false, business_hours: null, welcome_message: null,
                              responder_desconocidos: false, responder_prospectos: true },
        borradores_huerfanos: borradoresHuerfanos,
        consumo: {
            ...(consumo as object ?? {}),
            incluidos,
            restantes: Math.max(incluidos - facturables, 0),
            excedente: Math.max(facturables - incluidos, 0),
            // Se AVISA al 80%, no se corta. Con el costo por mensaje que maneja
            // Meta, frenarle la cobranza a una escuela cuesta mucho más de lo que
            // ahorra; el excedente se factura como paquete.
            avisar: facturables >= incluidos * UMBRAL_AVISO,
        },
        bandeja: bandeja.filas.map(sinHuellas),
        bandeja_resumen: bandeja.resumen,
        eventos: eventosR.data ?? [],
    });
});

// ── PATCH /settings — configurar el canal ───────────────────────────────────
const HoraHHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'usa HH:MM');

const AjustesSchema = z.object({
    mode: z.enum(['auto', 'assisted']).optional(),
    ai_enabled: z.boolean().optional(),
    // Fase A: el asistente atiende solo familias. Esto lo extiende a números
    // desconocidos (prospectos). Staff y personal no se atienden nunca.
    responder_desconocidos: z.boolean().optional(),
    // Con `responder_desconocidos=false`, igual contestar al desconocido con
    // intención CLARA de prospecto (regla sin LLM, whatsapp-atencion.service).
    responder_prospectos: z.boolean().optional(),
    welcome_message: z.string().max(1000).nullable().optional(),
    business_hours: z.object({
        tz: z.string().min(1).default('America/Bogota'),
        // Claves '0'..'6' como Date.getDay(): 0 = domingo.
        dias: z.record(z.string().regex(/^[0-6]$/), z.tuple([HoraHHMM, HoraHHMM])),
    }).nullable().optional(),
}).refine((v) => Object.keys(v).length > 0, { message: 'nada que cambiar' });

router.patch('/:schoolId/settings', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const { schoolId } = req.params as { schoolId: string };
    if (!(await administraEstaEscuela(req.user.id, schoolId))) {
        return res.status(403).json({ error: 'forbidden' });
    }

    const parsed = AjustesSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: 'datos_invalidos', details: parsed.error.issues });
    }

    // El horario se valida de verdad: una franja que cierra antes de abrir dejaría
    // al bot prometiendo una atención que nunca llega.
    const horario = parsed.data.business_hours;
    if (horario) {
        for (const [dia, [abre, cierra]] of Object.entries(horario.dias)) {
            if (abre >= cierra) {
                return res.status(400).json({
                    error: 'horario_invalido',
                    detalle: `El día ${dia} cierra (${cierra}) antes o al mismo tiempo que abre (${abre}).`,
                });
            }
        }
    }

    const integracion = await integracionDe(schoolId);
    if (!integracion) return res.status(404).json({ error: 'sin_integracion' });

    // Sin la migración 20261006110920 no hay `responder_prospectos`: si la
    // escuela pidió cambiarlo se le dice claro; si no, se sigue como antes.
    const conProspectos = await supabase
        .from('whatsapp_settings')
        .upsert({ integration_id: integracion.id, ...parsed.data, updated_at: new Date().toISOString() },
            { onConflict: 'integration_id' })
        .select('mode, ai_enabled, business_hours, welcome_message, responder_desconocidos, responder_prospectos')
        .single();
    if (conProspectos.error && esColumnaInexistente(conProspectos.error)
        && parsed.data.responder_prospectos !== undefined) {
        return res.status(409).json({ error: 'responder_prospectos_no_disponible',
            detalle: 'Falta aplicar la migración 20261006110920 (responder_prospectos).' });
    }
    const { responder_prospectos: _rp, ...sinProspectos } = parsed.data;
    const conColumna = !conProspectos.error ? conProspectos : await supabase
        .from('whatsapp_settings')
        .upsert({ integration_id: integracion.id, ...sinProspectos, updated_at: new Date().toISOString() },
            { onConflict: 'integration_id' })
        .select('mode, ai_enabled, business_hours, welcome_message, responder_desconocidos')
        .single();
    let data: any = conColumna.data
        ? { responder_prospectos: true, ...(conColumna.data as any) }
        : conColumna.data;
    let error = conColumna.error;

    // Sin la migración de Fase A, la columna no existe y la consulta falla
    // (tanto por pedirla en el SELECT como por escribirla). Si la escuela no
    // pidió cambiarla, se reintenta sin ella; si la pidió, se le dice claro.
    if (error && esColumnaInexistente(error)) {
        if (parsed.data.responder_desconocidos !== undefined) {
            return res.status(409).json({ error: 'responder_desconocidos_no_disponible',
                detalle: 'Falta aplicar la migración de Fase A (responder_desconocidos).' });
        }
        const sin = await supabase
            .from('whatsapp_settings')
            .upsert({ integration_id: integracion.id, ...sinProspectos, updated_at: new Date().toISOString() },
                { onConflict: 'integration_id' })
            .select('mode, ai_enabled, business_hours, welcome_message')
            .single();
        data = sin.data ? { ...(sin.data as any), responder_desconocidos: false } : sin.data;
        error = sin.error;
    }

    if (error) return res.status(500).json({ error: error.message });

    req.log?.info({ schoolId, cambios: Object.keys(parsed.data) }, '[wa-admin] ajustes actualizados');

    // Pasar de asistido a auto NO reprocesa nada solo: los borradores que
    // quedaron `pending` (Dynasty, 2026-10-06: 38 en 19 conversaciones) se
    // devuelven contados y la pantalla ofrece «Responder ahora» (POST
    // /ponerse-al-dia) o «Revisar». Se eligió así y no el reproceso automático
    // porque el cambio de modo puede ser un error de dedo, o un apagón del
    // modelo que sigue: mandar 20 respuestas en un clic sin que nadie lo pida
    // es peor que mostrar el número.
    const borradoresHuerfanos = (data as any)?.mode === 'auto'
        ? await contarBorradoresHuerfanos(integracion as any)
        : { conversaciones: 0, borradores: 0 };
    return res.json({ ...data, borradores_huerfanos: borradoresHuerfanos });
});

/**
 * POST /api/v1/whatsapp/:schoolId/ponerse-al-dia  { solo_borradores?: boolean }
 *
 * «Responder ahora»: contesta lo que quedó sin respuesta con la ventana abierta
 * (whatsapp-ponerse-al-dia.service): cierres → atendidas, comprobantes → cola o
 * estado, preguntas → turno real del bot. Lo personal y lo dudoso no se toca.
 * Solo en modo auto (en asistido dejaría más borradores). Corre en segundo
 * plano (un turno con modelo tarda 5–40 s) y responde 202 con cuántas hay.
 * Idempotente entre BFF: ver el servicio.
 */
router.post('/:schoolId/ponerse-al-dia', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const { schoolId } = req.params as { schoolId: string };
    if (!(await administraEstaEscuela(req.user.id, schoolId))) {
        return res.status(403).json({ error: 'forbidden' });
    }
    const integracion = await integracionParaEnviar(schoolId);
    if (!integracion) return res.status(404).json({ error: 'sin_integracion' });
    const { data: ajustes } = await ajustesDe(integracion.id);
    if ((ajustes as any)?.mode !== 'auto' || (ajustes as any)?.ai_enabled !== true) {
        return res.status(409).json({ error: 'no_auto', detalle: 'El asistente tiene que estar encendido y en automático.' });
    }
    const soloBorradores = req.body?.solo_borradores === true;
    const pendientes = await contarBorradoresHuerfanos(integracion);
    void ponerseAlDia(integracion, { soloConBorradores: soloBorradores, log: req.log as any })
        .catch((err) => req.log?.error({ schoolId, err: err?.message || err }, '[wa-admin] ponerse al día falló'));
    return res.status(202).json({ ok: true, en_curso: true, borradores_huerfanos: pendientes });
});

// ── Lo que la familia escribió con el comprobante ───────────────────────────
//
// GET /api/v1/whatsapp/:schoolId/notas-de-comprobantes?payment_ids=a,b
//
// El pie de la foto («envío saldo sept 15 - oct 15 $80.000») vive en la cola
// (`whatsapp_inbound_queue.media_caption`), no en `payments`: la hoja de
// aprobación no lo veía y la escuela aprobó como abono algo que la familia
// había explicado (Dynasty 2026-10-09). Esto lo expone por cobro, para que la
// pantalla de Pagos lo pueda mostrar sin leer la cola.

const MAX_IDS_NOTAS = 100;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface NotaDeComprobante { pie: string; recibido_at: string | null }

/** El pie más reciente de cada cobro (filas de la cola que lo estamparon). Pura. */
export function notasPorCobro(
    filas: { result_ref_id?: string | null; media_caption?: string | null; created_at?: string | null }[],
): Record<string, NotaDeComprobante> {
    const out: Record<string, NotaDeComprobante> = {};
    for (const f of Array.isArray(filas) ? filas : []) {
        const id = f?.result_ref_id;
        const pie = String(f?.media_caption ?? '').trim();
        if (!id || !pie) continue;
        const previa = out[id];
        if (previa && String(previa.recibido_at ?? '') >= String(f.created_at ?? '')) continue;
        out[id] = { pie, recibido_at: f.created_at ?? null };
    }
    return out;
}

router.get('/:schoolId/notas-de-comprobantes', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const { schoolId } = req.params as { schoolId: string };
    if (!(await administraEstaEscuela(req.user.id, schoolId))) {
        return res.status(403).json({ error: 'forbidden' });
    }
    const ids = [...new Set(String(req.query.payment_ids ?? '').split(',').map((x) => x.trim()).filter((x) => UUID_RE.test(x)))]
        .slice(0, MAX_IDS_NOTAS);
    if (!ids.length) return res.json({ notas: {} });
    const { data, error } = await supabase.from('whatsapp_inbound_queue')
        .select('result_ref_id, media_caption, created_at')
        .eq('school_id', schoolId)
        .eq('result_type', 'payment_receipt')
        .in('result_ref_id', ids)
        .not('media_caption', 'is', null)
        .limit(MAX_IDS_NOTAS * 3);
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ notas: notasPorCobro((data ?? []) as any[]) });
});

// ── Bandeja de comprobantes ─────────────────────────────────────────────────
// Ver whatsapp-bandeja.service: grupos accion/revisar/informativo, cierre por
// la escuela (prefijo en error_message, sin migración) y barrido de lo que ya
// estaba registrado.

const COLUMNAS_BANDEJA = 'id, status, wa_phone_number, message_type, media_mime_type, storage_path, '
    + 'media_caption, error_message, result_type, result_ref_id, matched_child_id, retries, created_at, processed_at, '
    // sha y referencia del OCR: enlazan la fila con el pago para cerrarla sola.
    // Se quitan antes de responder (sinHuellas).
    + 'pregunta_ocr';
/** Techo de filas abiertas. Antes era 100 y el contador se quedaba ahí (Dynasty tenía 113). */
const TECHO_BANDEJA = 500;
const BUCKET_COMPROBANTES = 'payment-receipts';
const TTL_MINIATURA_SEG = 15 * 60;

/** Filas abiertas (no cerradas por la escuela), más nuevas primero. */
async function filasAbiertasDeBandeja(schoolId: string): Promise<{ filas: any[]; error: string | null }> {
    const { data, error } = await supabase.from('whatsapp_inbound_queue')
        .select(COLUMNAS_BANDEJA)
        .eq('school_id', schoolId)
        .in('status', [...ESTADOS_BANDEJA])
        .order('created_at', { ascending: false })
        .limit(TECHO_BANDEJA);
    if (error) return { filas: [], error: error.message };
    return { filas: ((data ?? []) as any[]).filter((f) => !estaCerrada(f.error_message)), error: null };
}

/** Lo que la bandeja necesita de la conversación de cada número. */
export interface ConvDeBandeja {
    id: string;
    contact_name: string | null;
    contact_kind: string | null;
    tambien_familia: boolean;
    identified: boolean | null;
    parent_id: string | null;
}

/** Conversación de cada número: id (para «Ver chat»), nombre, tipo de contacto y «también es familia». */
async function conversacionesPorNumero(integrationId: string, numeros: string[]) {
    const mapa = new Map<string, ConvDeBandeja>();
    const unicos = [...new Set(numeros.filter(Boolean))];
    const BASE = 'id, contact_wa_id, contact_name, identified, parent_id';
    for (let i = 0; i < unicos.length; i += 100) {
        const lote = unicos.slice(i, i + 100);
        const consulta = (cols: string) => supabase.from('whatsapp_conversations')
            .select(cols)
            .eq('integration_id', integrationId)
            .in('contact_wa_id', lote);
        // De la más completa a la más pobre: `tambien_familia` (20261013164839) y
        // `contact_kind` (Fase A) se aplican a mano. Sin ellas: sin marca.
        let r: { data: any; error: any } = await consulta(`${BASE}, contact_kind, tambien_familia`);
        if (r.error && esColumnaInexistente(r.error)) r = await consulta(`${BASE}, contact_kind`);
        if (r.error && esColumnaInexistente(r.error)) r = await consulta(BASE);
        for (const c of (r.data ?? []) as any[]) {
            mapa.set(c.contact_wa_id, {
                id: c.id,
                contact_name: c.contact_name ?? null,
                contact_kind: c.contact_kind ?? null,
                tambien_familia: c.tambien_familia === true,
                identified: c.identified ?? null,
                parent_id: c.parent_id ?? null,
            });
        }
    }
    return mapa;
}

const tel10 = (s: string | null | undefined) => String(s ?? '').replace(/\D/g, '').slice(-10);

/**
 * De estos números, los que ALGUNA VEZ estuvieron en una ficha de la escuela:
 * `children.parent_phone_temp` (activos o no), `unregistered_athletes`
 * (`guardian_phone`/`phone`, activos o no), o el `profiles.phone` de un
 * acudiente de la escuela o de un miembro. Solo lectura. Ante un error, el
 * número cuenta como «con ficha» (no se sugiere marcar a una posible familia).
 */
async function numerosConFicha(schoolId: string, numeros: string[]): Promise<Set<string>> {
    const con = new Set<string>();
    const porTel = new Map<string, string[]>();
    for (const n of numeros) {
        const t = tel10(n);
        if (t.length < 7) { con.add(n); continue; }
        if (!porTel.has(t)) porTel.set(t, []);
        porTel.get(t)!.push(n);
    }
    const tels = [...porTel.keys()];
    if (!tels.length) return con;
    const marcar = (valor: string | null | undefined) => {
        const t = tel10(valor);
        for (const n of porTel.get(t) ?? []) con.add(n);
    };
    const or = (col: string) => tels.map((t) => `${col}.ilike.%${t}`).join(',');
    try {
        const [hijos, sinReg, perfiles] = await Promise.all([
            supabase.from('children').select('parent_phone_temp')
                .eq('school_id', schoolId).or(or('parent_phone_temp')).limit(500),
            supabase.from('unregistered_athletes').select('guardian_phone, phone')
                .eq('school_id', schoolId).or(`${or('guardian_phone')},${or('phone')}`).limit(500),
            supabase.from('profiles').select('id, phone').or(or('phone')).limit(500),
        ]);
        if (hijos.error || sinReg.error || perfiles.error) return new Set(numeros);
        for (const h of (hijos.data ?? []) as any[]) marcar(h.parent_phone_temp);
        for (const u of (sinReg.data ?? []) as any[]) { marcar(u.guardian_phone); marcar(u.phone); }
        const perfilesConTel = ((perfiles.data ?? []) as any[]).filter((p) => porTel.has(tel10(p.phone)));
        const ids = perfilesConTel.map((p) => p.id as string);
        if (ids.length) {
            const [comoAcudiente, comoMiembro] = await Promise.all([
                supabase.from('children').select('parent_id').eq('school_id', schoolId).in('parent_id', ids).limit(500),
                supabase.from('school_members').select('profile_id').eq('school_id', schoolId).in('profile_id', ids).limit(500),
            ]);
            if (comoAcudiente.error || comoMiembro.error) return new Set(numeros);
            const deLaEscuela = new Set<string>([
                ...((comoAcudiente.data ?? []) as any[]).map((c) => c.parent_id),
                ...((comoMiembro.data ?? []) as any[]).map((m) => m.profile_id),
            ]);
            for (const p of perfilesConTel) if (deLaEscuela.has(p.id)) marcar(p.phone);
        }
    } catch {
        return new Set(numeros);
    }
    return con;
}

/**
 * Sugerencias «¿Marcar como negocio/personal…?» para la bandeja. Nunca marca:
 * solo propone. Ver `candidatosASugerir`. Ante un error, ninguna.
 */
async function sugerenciasDeMarca(schoolId: string, filas: any[], convs: Map<string, ConvDeBandeja>,
                                  log?: any): Promise<SugerenciaDeMarca[]> {
    try {
        const candidatos = candidatosASugerir(filas, convs);
        if (!candidatos.length) return [];
        const conFicha = await numerosConFicha(schoolId, candidatos.map((c) => c.wa_phone_number));
        return candidatos.filter((c) => !conFicha.has(c.wa_phone_number)).slice(0, 20);
    } catch (err: any) {
        log?.warn?.({ schoolId, err: err?.message || err }, '[wa-bandeja] sugerencias de marca fallaron');
        return [];
    }
}

/**
 * Barrido idempotente: cierra como `resuelto_auto` las `ya_registrado` cuyo pago
 * sigue registrado. No toca `payments`. El UPDATE exige el `error_message`
 * previo, así dos BFF (o un cierre manual simultáneo) no se pisan.
 */
async function autocerrarYaRegistradas(schoolId: string, filas: any[], log?: any): Promise<Set<string>> {
    const candidatas = filas.filter((f) => f.status === 'ignored' && motivoDeFila(f).motivo === 'ya_registrado');
    const cerradas = new Set<string>();
    if (candidatas.length) await autocerrarRegistradas(schoolId, candidatas, cerradas, log);

    // 2026-10-13: además, las que pedían decidir y cuyo pago enlazado ya se
    // aprobó o rechazó (por cualquier camino) después de que llegaron. Ver
    // filasParaAutocierrePorDecision. La migración 20261013124655 hace lo mismo
    // con un trigger en `payments`; esto cubre lo que ya estaba y el tiempo
    // hasta que se aplique.
    for (const id of await autocerrarPorDecision(schoolId, filas.filter((f) => !cerradas.has(f.id)), log)) {
        cerradas.add(id);
    }
    return cerradas;
}

async function autocerrarRegistradas(schoolId: string, candidatas: any[], cerradas: Set<string>, log?: any) {
    const ids = [...new Set(candidatas.map((f) => f.result_ref_id).filter(Boolean))] as string[];
    const refs = [...new Set(candidatas.map((f) => referenciaUsada(f.error_message)).filter(Boolean))] as string[];
    const [porIdR, porRefR] = await Promise.all([
        ids.length
            ? supabase.from('payments').select('id, school_id, status, concept, ocr_reference').in('id', ids)
            : Promise.resolve({ data: [], error: null } as any),
        refs.length
            ? supabase.from('payments').select('id, school_id, status, concept, ocr_reference')
                .eq('school_id', schoolId).in('ocr_reference', refs)
            : Promise.resolve({ data: [], error: null } as any),
    ]);
    const pagosPorId = new Map<string, PagoMinimo>(((porIdR.data ?? []) as PagoMinimo[]).map((p) => [p.id, p]));
    const pagosPorRef = new Map<string, PagoMinimo>(((porRefR.data ?? []) as PagoMinimo[])
        .filter((p) => p.ocr_reference).map((p) => [p.ocr_reference as string, p]));

    for (const { fila, pago } of filasParaAutocierre(schoolId, candidatas, pagosPorId, pagosPorRef)) {
        const motivo = `el pago ya está registrado (${pago.status}: ${(pago.concept ?? '').slice(0, 80)})`;
        const { data, error } = await supabase.from('whatsapp_inbound_queue')
            .update({ error_message: marcaDeCierre('resuelto_auto', motivo, null, fila.error_message),
                      updated_at: new Date().toISOString() })
            .eq('id', fila.id)
            .eq('school_id', schoolId)
            .eq('status', 'ignored')
            .eq('error_message', fila.error_message as string)
            .select('id');
        if (error) { log?.warn?.({ schoolId, fila: fila.id, err: error.message }, '[wa-bandeja] autocierre falló'); continue; }
        if ((data ?? []).length) cerradas.add(fila.id);
    }
    if (cerradas.size) log?.info?.({ schoolId, cerradas: cerradas.size }, '[wa-bandeja] cerradas solas (ya registradas)');
}

const COLUMNAS_PAGO_DECIDIBLE = 'id, school_id, status, concept, ocr_reference, approved_at, payment_date, updated_at, '
    + 'receipt_rejected_at, receipt_image_sha256, receipt_reference_norm';

async function autocerrarPorDecision(schoolId: string, filas: any[], log?: any): Promise<string[]> {
    const conEnlace = filas.filter((f) => f.result_ref_id || huellasDeFila(f).sha || huellasDeFila(f).referencias.length);
    if (!conEnlace.length) return [];
    const ids = [...new Set(conEnlace.map((f) => f.result_ref_id).filter(Boolean))] as string[];
    const shas = [...new Set(conEnlace.map((f) => huellasDeFila(f).sha).filter(Boolean))] as string[];
    // Todas las referencias de la fila (la del OCR y las alternativas).
    const refs = [...new Set(conEnlace.flatMap((f) => huellasDeFila(f).referencias))].slice(0, 500);
    const vacio = Promise.resolve({ data: [], error: null } as any);
    const lecturas = await Promise.all([
        ids.length ? supabase.from('payments').select(COLUMNAS_PAGO_DECIDIBLE).eq('school_id', schoolId).in('id', ids) : vacio,
        shas.length ? supabase.from('payments').select(COLUMNAS_PAGO_DECIDIBLE).eq('school_id', schoolId).in('receipt_image_sha256', shas) : vacio,
        refs.length ? supabase.from('payments').select(COLUMNAS_PAGO_DECIDIBLE).eq('school_id', schoolId).in('ocr_reference', refs) : vacio,
        refs.length ? supabase.from('payments').select(COLUMNAS_PAGO_DECIDIBLE).eq('school_id', schoolId).in('receipt_reference_norm', refs) : vacio,
    ]);
    // Una columna que no exista todavía (migración sin aplicar) no tumba la bandeja.
    const pagos = new Map<string, PagoDecidible>();
    for (const r of lecturas) for (const p of ((r as any).data ?? []) as PagoDecidible[]) pagos.set(p.id, p);

    const cerradas: string[] = [];
    for (const { fila, pago, decision } of filasParaAutocierrePorDecision(schoolId, conEnlace, [...pagos.values()])) {
        const motivo = decision === 'aprobado'
            ? `el pago se aprobó (${pago.status}: ${(pago.concept ?? '').slice(0, 80)})`
            : `el comprobante se rechazó en Pagos (${(pago.concept ?? '').slice(0, 80)})`;
        let upd = supabase.from('whatsapp_inbound_queue')
            .update({ status: 'ignored', locked_until: null,
                      error_message: marcaDeCierre('resuelto_auto', motivo, null, fila.error_message),
                      updated_at: new Date().toISOString() })
            .eq('id', fila.id)
            .eq('school_id', schoolId)
            .eq('status', fila.status);
        upd = fila.error_message === null ? upd.is('error_message', null) : upd.eq('error_message', fila.error_message as string);
        const { data, error } = await upd.select('id');
        if (error) { log?.warn?.({ schoolId, fila: fila.id, err: error.message }, '[wa-bandeja] autocierre por decisión falló'); continue; }
        if ((data ?? []).length) cerradas.push(fila.id);
    }
    if (cerradas.length) log?.info?.({ schoolId, cerradas: cerradas.length }, '[wa-bandeja] cerradas solas (pago decidido)');
    return cerradas;
}

/** Cierres de los últimos 30 días: cuántos hizo la escuela y cuántos se hicieron solos. */
async function cierresRecientes(schoolId: string) {
    const desde = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const { data, error } = await supabase.from('whatsapp_inbound_queue')
        .select('error_message')
        .eq('school_id', schoolId)
        .like('error_message', `${PREFIJO_CERRADA}%`)
        .gte('updated_at', desde)
        .limit(5000);
    if (error) return null;
    return contarCierres(((data ?? []) as any[]).map((f) => f.error_message));
}

/** Lo que viaja a la pantalla: sin `pregunta_ocr` (trae datos del OCR y del acudiente). */
function sinHuellas<T extends Record<string, any>>(f: T): Omit<T, 'pregunta_ocr'> {
    const { pregunta_ocr: _p, ...resto } = f;
    return resto;
}

/**
 * Clasifica y ordena: acción primero, después revisar, después informativo.
 * Las filas de contactos marcados como no-familia (personal, negocio, otro
 * club, plataforma, sin «también es familia») NO entran: ni en la lista ni en
 * los contadores. Al marcar se cierran (PATCH …/tipo); esto cubre las que
 * quedaran abiertas por una carrera o porque se marcó antes de este cambio.
 */
function armarBandeja(filas: any[], convs: Map<string, Partial<ConvDeBandeja> & { id: string }>) {
    const orden: Record<GrupoBandeja, number> = { accion: 0, revisar: 1, informativo: 2 };
    const enriquecidas = filas.flatMap((f) => {
        const c = convs.get(f.wa_phone_number) ?? null;
        if (!filaCuentaEnBandeja(c?.contact_kind ?? null, c?.tambien_familia ?? false, f.error_message ?? null)) return [];
        return [{
            ...f,
            ...clasificarFila(f, c?.contact_kind ?? null, c?.tambien_familia ?? false),
            conversacion_id: c?.id ?? null,
            contacto: c?.contact_name ?? null,
            tipo_contacto: c?.contact_kind ?? null,
            tambien_familia: c?.tambien_familia === true,
        }];
    });
    enriquecidas.sort((a, b) => (orden[a.grupo as GrupoBandeja] - orden[b.grupo as GrupoBandeja])
        || String(b.created_at).localeCompare(String(a.created_at)));
    return { filas: enriquecidas, resumen: resumenDeGrupos(enriquecidas) };
}

// ── GET /bandeja — lo que quedó sin resolver, agrupado ──────────────────────
router.get('/:schoolId/bandeja', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const { schoolId } = req.params as { schoolId: string };
    if (!(await administraEstaEscuela(req.user.id, schoolId))) {
        return res.status(403).json({ error: 'forbidden' });
    }

    const leidas = await filasAbiertasDeBandeja(schoolId);
    if (leidas.error) return res.status(500).json({ error: leidas.error });

    const cerradasSolas = await autocerrarYaRegistradas(schoolId, leidas.filas, req.log);
    const abiertas = leidas.filas.filter((f) => !cerradasSolas.has(f.id));

    const integracion = await integracionDe(schoolId);
    const convs = integracion
        ? await conversacionesPorNumero(integracion.id, abiertas.map((f) => f.wa_phone_number))
        : new Map();
    const { filas, resumen } = armarBandeja(abiertas, convs);
    const [cierres, sugerencias] = await Promise.all([
        cierresRecientes(schoolId),
        sugerenciasDeMarca(schoolId, filas, convs, req.log),
    ]);

    // Miniatura firmada del comprobante (15 min). Las rutas son de ESTA escuela
    // (salen de filas filtradas por school_id); el bucket es privado.
    const rutas = [...new Set(filas.map((f) => f.storage_path).filter(Boolean))] as string[];
    const urlPorRuta = new Map<string, string>();
    if (rutas.length) {
        try {
            const { data } = await supabase.storage.from(BUCKET_COMPROBANTES).createSignedUrls(rutas, TTL_MINIATURA_SEG);
            for (const d of (data ?? []) as any[]) if (d?.path && d?.signedUrl) urlPorRuta.set(d.path, d.signedUrl);
        } catch (err: any) {
            req.log?.warn({ schoolId, err: err?.message || err }, '[wa-bandeja] no se pudieron firmar las miniaturas');
        }
    }

    return res.json({
        filas: filas.map((f) => ({ ...sinHuellas(f), archivo_url: f.storage_path ? urlPorRuta.get(f.storage_path) ?? null : null })),
        resumen,
        cerradas_solas: cerradasSolas.size,
        // Cierres de los últimos 30 días (null si no se pudo contar).
        cierres_30d: cierres,
        // «¿Marcar como negocio/personal…?»: números sin ficha con ráfaga de
        // adjuntos o nombre de negocio. Solo sugerencias; marcar es de la escuela.
        sugerencias_marca: sugerencias,
    });
});

/**
 * POST /api/v1/whatsapp/:schoolId/bandeja/:filaId/cerrar  { accion, motivo }
 *
 * «Marcar resuelto» / «Descartar». Solo administración de ESA escuela
 * (`administraEstaEscuela`), y la fila tiene que ser de esa escuela: el UPDATE
 * va con school_id. No toca pagos: si el comprobante había que aplicarlo, se
 * aplica en Pagos y aquí se marca resuelto. Idempotente: una fila ya cerrada
 * responde 409.
 */
const CierreBandejaSchema = z.object({
    accion: z.enum(['resuelto', 'descartado']),
    motivo: z.string().trim().min(3, 'escribe el motivo').max(200),
});

router.post('/:schoolId/bandeja/:filaId/cerrar', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const { schoolId, filaId } = req.params as { schoolId: string; filaId: string };
    if (!(await administraEstaEscuela(req.user.id, schoolId))) {
        return res.status(403).json({ error: 'forbidden' });
    }
    const parsed = CierreBandejaSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'datos_invalidos', details: parsed.error.issues });

    const { data: fila, error: errLee } = await supabase.from('whatsapp_inbound_queue')
        .select('id, school_id, status, error_message')
        .eq('id', filaId)
        .eq('school_id', schoolId)
        .maybeSingle();
    if (errLee) return res.status(500).json({ error: errLee.message });
    if (!fila || !(ESTADOS_BANDEJA as readonly string[]).includes((fila as any).status)) {
        return res.status(404).json({ error: 'no_encontrada' });
    }
    if (estaCerrada((fila as any).error_message)) return res.status(409).json({ error: 'ya_cerrada' });

    const previo = ((fila as any).error_message ?? null) as string | null;
    let upd = supabase.from('whatsapp_inbound_queue')
        .update({
            // waiting_user/failed pasan a ignored: dejan de esperar a la familia
            // y de contar como fallo. El result_type se conserva (métricas).
            status: 'ignored',
            error_message: marcaDeCierre(parsed.data.accion, parsed.data.motivo, req.user.id, previo),
            locked_until: null,
            updated_at: new Date().toISOString(),
        })
        .eq('id', filaId)
        .eq('school_id', schoolId)
        .eq('status', (fila as any).status);
    upd = previo === null ? upd.is('error_message', null) : upd.eq('error_message', previo);
    const { data, error } = await upd.select('id, status, error_message');
    if (error) return res.status(500).json({ error: error.message });
    if (!(data ?? []).length) return res.status(409).json({ error: 'cambio_en_curso' });

    req.log?.info({ schoolId, filaId, accion: parsed.data.accion, por: req.user.id }, '[wa-bandeja] fila cerrada');
    return res.json({ ok: true, fila: (data as any[])[0] });
});

/**
 * POST /api/v1/whatsapp/:schoolId/bandeja/cerrar-lote  { ids, accion, motivo }
 *
 * Por qué existe (2026-10-13): en Dynasty había 206 abiertas y 0 cerradas por
 * la escuela. El cierre funcionaba, pero era de a una, con un diálogo y un
 * motivo escrito, sobre una lista donde 131 eran fotos de contactos que no son
 * familias o capturas que no eran comprobantes. Nadie cierra 200 filas de a
 * una. Con esto la pantalla ofrece «Cerrar las N de esta sección» con un solo
 * motivo. Mismas reglas que el cierre individual: solo administración de ESA
 * escuela, solo filas abiertas de esa escuela, sin tocar pagos, y cada UPDATE
 * condicionado al estado leído (dos pestañas no se pisan).
 */
const CierreLoteSchema = z.object({
    ids: z.array(z.string().uuid()).min(1).max(300),
    accion: z.enum(['resuelto', 'descartado']),
    motivo: z.string().trim().min(3, 'escribe el motivo').max(200),
});

router.post('/:schoolId/bandeja/cerrar-lote', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const { schoolId } = req.params as { schoolId: string };
    if (!(await administraEstaEscuela(req.user.id, schoolId))) {
        return res.status(403).json({ error: 'forbidden' });
    }
    const parsed = CierreLoteSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'datos_invalidos', details: parsed.error.issues });
    const ids = [...new Set(parsed.data.ids)];

    const { data: filas, error: errLee } = await supabase.from('whatsapp_inbound_queue')
        .select('id, school_id, status, error_message')
        .eq('school_id', schoolId)
        .in('id', ids);
    if (errLee) return res.status(500).json({ error: errLee.message });

    const abiertas = ((filas ?? []) as any[]).filter((f) =>
        (ESTADOS_BANDEJA as readonly string[]).includes(f.status) && !estaCerrada(f.error_message));
    const cerradas: string[] = [];
    for (const f of abiertas) {
        const previo = (f.error_message ?? null) as string | null;
        let upd = supabase.from('whatsapp_inbound_queue')
            .update({
                status: 'ignored',
                error_message: marcaDeCierre(parsed.data.accion, parsed.data.motivo, req.user.id, previo),
                locked_until: null,
                updated_at: new Date().toISOString(),
            })
            .eq('id', f.id)
            .eq('school_id', schoolId)
            .eq('status', f.status);
        upd = previo === null ? upd.is('error_message', null) : upd.eq('error_message', previo);
        const { data, error } = await upd.select('id');
        if (error) { req.log?.warn({ schoolId, fila: f.id, err: error.message }, '[wa-bandeja] cierre en lote falló'); continue; }
        if ((data ?? []).length) cerradas.push(f.id);
    }

    req.log?.info({ schoolId, pedidas: ids.length, cerradas: cerradas.length, accion: parsed.data.accion, por: req.user.id },
        '[wa-bandeja] cierre en lote');
    // Las que no se cerraron: de otra escuela, ya cerradas o cambiadas en el camino.
    return res.json({ ok: true, cerradas, omitidas: ids.length - cerradas.length });
});

// ── GET /eventos — lo que avisa Meta ────────────────────────────────────────
router.get('/:schoolId/eventos', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const { schoolId } = req.params as { schoolId: string };
    if (!(await administraEstaEscuela(req.user.id, schoolId))) {
        return res.status(403).json({ error: 'forbidden' });
    }

    const { data, error } = await supabase
        .from('whatsapp_account_events')
        .select('id, field, template_name, estado_previo, nuevo_estado, motivo, visto_at, created_at')
        .eq('school_id', schoolId)
        .order('created_at', { ascending: false })
        .limit(50);

    if (error) return res.status(500).json({ error: error.message });
    return res.json({ eventos: data ?? [] });
});

// ── Plantillas de Meta ──────────────────────────────────────────────────────
// La escuela necesita verlas por una razon concreta: si Meta desactiva o
// recategoriza una plantilla de cobranza, los envios dejan de salir. Hasta hoy
// eso solo se veia preguntandole a Graph a mano.

const GRAPH = `https://graph.facebook.com/${process.env.WHATSAPP_GRAPH_VERSION || 'v21.0'}`;

/** Token de la integracion, descifrado. Nunca sale de aca. */
function tokenDe(integracion: { access_token_encrypted: string | null }): string | null {
    if (!integracion.access_token_encrypted) return null;
    try { return decryptToken(integracion.access_token_encrypted); } catch { return null; }
}

router.get('/:schoolId/plantillas', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const { schoolId } = req.params as { schoolId: string };
    if (!(await administraEstaEscuela(req.user.id, schoolId))) {
        return res.status(403).json({ error: 'forbidden' });
    }

    const { data: integracion } = await supabase
        .from('school_whatsapp_integrations')
        .select('waba_id, access_token_encrypted')
        .eq('school_id', schoolId)
        .maybeSingle();

    if (!integracion?.waba_id) return res.status(404).json({ error: 'sin_integracion' });
    const token = tokenDe(integracion as any);
    if (!token) return res.status(409).json({ error: 'sin_token' });

    const r = await fetch(
        `${GRAPH}/${integracion.waba_id}/message_templates?fields=name,status,category,language,quality_score&limit=100`,
        { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) },
    );
    const j: any = await r.json();
    if (!r.ok) {
        req.log?.warn({ schoolId, status: r.status }, '[wa-admin] Meta rechazo el listado de plantillas');
        return res.status(502).json({ error: 'meta_error', detalle: j?.error?.message ?? null });
    }

    return res.json({ plantillas: j.data ?? [] });
});

const PlantillaSchema = z.object({
    // Meta exige minusculas, numeros y guion bajo.
    name: z.string().regex(/^[a-z0-9_]{3,60}$/, 'solo minusculas, numeros y guion bajo'),
    language: z.string().min(2).max(10).default('es_CO'),
    category: z.enum(['UTILITY', 'MARKETING', 'AUTHENTICATION']).default('UTILITY'),
    body: z.string().min(10).max(1024),
    // Los ejemplos de cada {{n}}: Meta los EXIGE si el texto trae variables.
    ejemplos: z.array(z.string()).default([]),
    // Campañas (plan B5 T5): pie y hasta 3 botones de respuesta rápida
    // («Sí, cuéntame», «Más adelante», «No recibir más»). Opcionales: sin ellos
    // el cuerpo que va a Meta es idéntico al de siempre.
    pie: z.string().trim().min(1).max(60).optional(),
    botones_rapidos: z.array(z.string().trim().min(1).max(25)).min(1).max(3).optional(),
});

/** El cuerpo del POST a Meta. Puro: lo fija la prueba de «sin campos nuevos, idéntico». */
export function cuerpoDePlantilla(p: z.infer<typeof PlantillaSchema>): any {
    const components: any[] = [{
        type: 'BODY',
        text: p.body,
        ...(p.ejemplos.length ? { example: { body_text: [p.ejemplos] } } : {}),
    }];
    if (p.pie) components.push({ type: 'FOOTER', text: p.pie });
    if (p.botones_rapidos?.length) {
        components.push({ type: 'BUTTONS', buttons: p.botones_rapidos.map((text) => ({ type: 'QUICK_REPLY', text })) });
    }
    return { name: p.name, language: p.language, category: p.category, components };
}

router.post('/:schoolId/plantillas', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const { schoolId } = req.params as { schoolId: string };
    if (!(await administraEstaEscuela(req.user.id, schoolId))) {
        return res.status(403).json({ error: 'forbidden' });
    }

    const parsed = PlantillaSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: 'datos_invalidos', details: parsed.error.issues });
    }
    const p = parsed.data;

    // Se valida ANTES de llamar a Meta, porque su error para esto es opaco.
    const variables = [...new Set(Array.from(p.body.matchAll(/\{\{(\d+)\}\}/g)).map((m) => Number(m[1])))]
        .sort((a, b) => a - b);
    if (variables.length !== p.ejemplos.length) {
        return res.status(400).json({
            error: 'ejemplos_incompletos',
            detalle: `El texto usa ${variables.length} variable(s) y llegaron ${p.ejemplos.length} ejemplo(s).`,
        });
    }
    if (variables.length && (variables[0] !== 1 || variables[variables.length - 1] !== variables.length)) {
        return res.status(400).json({
            error: 'variables_no_consecutivas',
            detalle: 'Las variables deben ir de {{1}} en adelante, sin saltos.',
        });
    }
    // Meta rechaza que el cuerpo empiece o termine con una variable. Ya nos paso
    // con tres plantillas y el mensaje de error no lo dice claro.
    if (/^\s*\{\{\d+\}\}/.test(p.body) || /\{\{\d+\}\}\s*$/.test(p.body)) {
        return res.status(400).json({
            error: 'variable_en_el_borde',
            detalle: 'El texto no puede empezar ni terminar con una variable. Agrega una palabra antes o despues.',
        });
    }

    const { data: integracion } = await supabase
        .from('school_whatsapp_integrations')
        .select('waba_id, access_token_encrypted')
        .eq('school_id', schoolId)
        .maybeSingle();

    if (!integracion?.waba_id) return res.status(404).json({ error: 'sin_integracion' });
    const token = tokenDe(integracion as any);
    if (!token) return res.status(409).json({ error: 'sin_token' });

    const cuerpo = cuerpoDePlantilla(p);

    const r = await fetch(`${GRAPH}/${integracion.waba_id}/message_templates`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(cuerpo),
        signal: AbortSignal.timeout(30_000),
    });
    const j: any = await r.json();

    if (!r.ok) {
        return res.status(400).json({
            error: 'meta_rechazo',
            // `error_user_msg` es el texto que Meta escribe para humanos; el
            // `message` tecnico no le sirve a nadie en la pantalla.
            detalle: j?.error?.error_user_msg ?? j?.error?.message ?? 'Meta rechazo la plantilla.',
        });
    }

    req.log?.info({ schoolId, plantilla: p.name, id: j?.id, estado: j?.status }, '[wa-admin] plantilla registrada');
    return res.status(201).json({ id: j?.id, status: j?.status, category: j?.category, name: p.name });
});

// ── Catalogo de plantillas de SportMaps ────────────────────────────────────
// Las plantillas que USA el codigo (CONCEPTOS de whatsapp-plantillas.service)
// estan definidas en bff/whatsapp-templates/<nombre>.json, con sus ejemplos y su
// boton URL. Una escuela que conecta su propia WABA tiene que registrarlas alla;
// antes eso era un script (scripts/wa-registrar-plantilla.ts) que solo podia
// correr alguien con la base a mano, y el formulario de «Nueva plantilla» no
// sabe de botones. Esto deja registrarlas desde la pestania «Plantillas» tal
// cual estan en el repo: mismo texto, mismos ejemplos, mismo boton.

/** Carpeta de los JSON: igual desde src/ (dev) que desde dist/ (Render). */
function carpetaCatalogo(): string | null {
    for (const dir of [path.resolve(__dirname, '../../whatsapp-templates'), path.resolve(process.cwd(), 'whatsapp-templates')]) {
        if (fs.existsSync(dir)) return dir;
    }
    return null;
}

/** Nombres del catalogo: uno por concepto que el codigo sabe mandar, sin repetir. */
export function nombresDelCatalogo(): string[] {
    return [...new Set(Object.values(CONCEPTOS).map((c) => c.plantilla))].sort();
}

function leerDelCatalogo(nombre: string): any | null {
    if (!nombresDelCatalogo().includes(nombre)) return null;
    const dir = carpetaCatalogo();
    if (!dir) return null;
    try {
        return JSON.parse(fs.readFileSync(path.join(dir, `${nombre}.json`), 'utf8'));
    } catch {
        return null;
    }
}

router.get('/:schoolId/plantillas/catalogo', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const { schoolId } = req.params as { schoolId: string };
    if (!(await administraEstaEscuela(req.user.id, schoolId))) {
        return res.status(403).json({ error: 'forbidden' });
    }
    const catalogo = nombresDelCatalogo().flatMap((nombre) => {
        const t = leerDelCatalogo(nombre);
        if (!t) return [];
        const comps: any[] = t.components ?? [];
        const body = comps.find((c) => String(c?.type).toUpperCase() === 'BODY');
        const botones = comps.find((c) => String(c?.type).toUpperCase() === 'BUTTONS')?.buttons ?? [];
        return [{
            name: t.name, language: t.language, category: t.category,
            texto: body?.text ?? '', ejemplos: body?.example?.body_text?.[0] ?? [],
            boton: botones[0]?.text ?? null,
        }];
    });
    return res.json({ catalogo });
});

router.post('/:schoolId/plantillas/catalogo/:nombre', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const { schoolId, nombre } = req.params as { schoolId: string; nombre: string };
    if (!(await administraEstaEscuela(req.user.id, schoolId))) {
        return res.status(403).json({ error: 'forbidden' });
    }
    const plantilla = leerDelCatalogo(nombre);
    if (!plantilla) return res.status(404).json({ error: 'no_esta_en_el_catalogo' });

    const { data: integracion } = await supabase
        .from('school_whatsapp_integrations')
        .select('waba_id, access_token_encrypted')
        .eq('school_id', schoolId)
        .maybeSingle();
    if (!integracion?.waba_id) return res.status(404).json({ error: 'sin_integracion' });
    const token = tokenDe(integracion as any);
    if (!token) return res.status(409).json({ error: 'sin_token' });

    const r = await fetch(`${GRAPH}/${integracion.waba_id}/message_templates`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(plantilla),
        signal: AbortSignal.timeout(30_000),
    });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) {
        return res.status(400).json({
            error: 'meta_rechazo',
            detalle: j?.error?.error_user_msg ?? j?.error?.message ?? 'Meta rechazo la plantilla.',
        });
    }
    req.log?.info({ schoolId, plantilla: nombre, id: j?.id, estado: j?.status }, '[wa-admin] plantilla del catalogo registrada');
    return res.status(201).json({ id: j?.id, status: j?.status, category: j?.category, name: nombre });
});

// ─── Buzon de conversaciones (F3) ────────────────────────────────────────────
//
// Hasta ahora la escuela no tenia donde LEER ni RESPONDER: la pestania
// "Bandeja" lista comprobantes que fallaron, no chats. El bot atendia, y lo que
// no sabia manejar quedaba marcado como escalado sin que nadie pudiera verlo.
//
// La ventana de 24 horas manda sobre todo lo de aca. Meta solo deja responder
// en texto libre mientras el titular haya escrito en las ultimas 24 h; pasado
// eso hay que mandar una plantilla aprobada. Por eso cada conversacion viaja
// con `ventana_abierta` y `ventana_vence`: si la pantalla mostrara un cuadro de
// texto normal con la ventana cerrada, la escuela escribiria, enviaria, y
// recibiria un error que no sabe leer.

const VENTANA_MS = 24 * 60 * 60 * 1000;

export function estadoDeVentana(lastInboundAt: string | null) {
    if (!lastInboundAt) return { ventana_abierta: false, ventana_vence: null };
    const vence = new Date(new Date(lastInboundAt).getTime() + VENTANA_MS);
    return { ventana_abierta: vence.getTime() > Date.now(), ventana_vence: vence.toISOString() };
}

/**
 * La integracion CON el token descifrable, para poder enviar.
 *
 * Distinta de `integracionDe`, que alimenta la pantalla de estado y a
 * proposito no selecciona `access_token_encrypted`: ese dato no tiene por
 * que viajar en una respuesta que solo pinta un encabezado.
 */
export async function integracionParaEnviar(schoolId: string): Promise<WhatsAppIntegration | null> {
    const { data } = await supabase
        .from('school_whatsapp_integrations')
        .select('id, school_id, phone_number_id, waba_id, display_phone_number, '
              + 'access_token_encrypted, verify_token, status')
        .eq('school_id', schoolId)
        .maybeSingle();
    return (data as unknown as WhatsAppIntegration) ?? null;
}

/**
 * Último mensaje, pendiente/requiere respuesta, borradores, toma, prospecto y
 * ventana de cada conversación. Sale de GET /conversaciones para que la
 * búsqueda en servidor (whatsapp-buzon.routes) devuelva filas idénticas.
 */
export async function enriquecerConversaciones(schoolId: string, data: any[]): Promise<{
    filas: any[]; tomaDisponible: boolean;
}> {
    const ids = data.map((c: any) => c.id);

    // El ultimo mensaje de cada hilo. Una sola consulta para las 200
    // conversaciones, no una por cada una.
    const ultimos = new Map<string, any>();
    if (ids.length) {
        const { data: msgs } = await supabase
            .from('whatsapp_messages')
            .select('conversation_id, direction, text_body, type, created_at, ai_generated')
            .in('conversation_id', ids)
            .order('created_at', { ascending: false })
            .limit(1000);
        for (const m of (msgs ?? []) as any[]) {
            if (!ultimos.has(m.conversation_id)) ultimos.set(m.conversation_id, m);
        }
        // El tope de 1000 lo pueden llenar pocos hilos muy conversados: los
        // demás llegaban como «(sin mensajes)» aunque sí tuvieran. Segunda
        // pasada solo para los que quedaron sin último mensaje.
        const faltan = ids.filter((id: string) => !ultimos.has(id));
        if (msgs && msgs.length >= 1000 && faltan.length) {
            const { data: resto } = await supabase
                .from('whatsapp_messages')
                .select('conversation_id, direction, text_body, type, created_at, ai_generated')
                .in('conversation_id', faltan)
                .order('created_at', { ascending: false })
                .limit(1000);
            for (const m of (resto ?? []) as any[]) {
                if (!ultimos.has(m.conversation_id)) ultimos.set(m.conversation_id, m);
            }
        }
    }

    // ¿Es un prospecto? Un número que no es familia y al que el asistente ya
    // contestó en el paso de «tema escolar» (pidió información de clases,
    // precios, inscripción). Solo se busca entre los que no son familia.
    // TODO: cuando el backend guarde la detección de prospectos en la
    // conversación (otro frente, whatsapp-atencion.service), leerla de ahí.
    const prospectos = new Set<string>();
    const noFamilia = data.filter((c: any) => vistaDeTipo(c.contact_kind) === 'otros'
        && !esMarcaNoFamilia(c.contact_kind) && c.contact_kind !== 'staff').map((c: any) => c.id);
    if (noFamilia.length) {
        const [enviados, propuestos] = await Promise.all([
            supabase.from('whatsapp_messages')
                .select('conversation_id')
                .in('conversation_id', noFamilia)
                .eq('direction', 'outbound')
                .eq('payload->>step', PASO_PROSPECTO)
                .limit(1000),
            // En modo asistido la respuesta al prospecto queda como borrador.
            supabase.from('whatsapp_message_drafts')
                .select('conversation_id')
                .in('conversation_id', noFamilia)
                .eq('tool_context->>step', PASO_PROSPECTO)
                .limit(1000),
        ]);
        for (const r of [enviados, propuestos]) {
            if (r.error) continue; // Sin la columna o el dato: el buzón no se cae.
            for (const x of (r.data ?? []) as any[]) prospectos.add(x.conversation_id);
        }
    }
    // El lead que registró la puerta de prospecto (school_signup_leads, por
    // teléfono): `prospecto: {estado, interes, ...}` aunque el bot no haya
    // alcanzado a contestar (ventana cerrada, escuela atendiendo).
    const leads = await prospectosDeConversaciones(schoolId,
        data.filter((c: any) => noFamilia.includes(c.id)));

    // Cuantos borradores esperan aprobacion en cada hilo.
    const borradores = new Map<string, number>();
    if (ids.length) {
        const { data: d } = await supabase
            .from('whatsapp_message_drafts')
            .select('conversation_id')
            .in('conversation_id', ids)
            .eq('status', 'pending');
        for (const x of (d ?? []) as any[]) {
            borradores.set(x.conversation_id, (borradores.get(x.conversation_id) ?? 0) + 1);
        }
    }

    // ¿Espera respuesta? Último entrante vs. último saliente (bot, buzón o echo
    // del celular). El entrante sale de `last_inbound_at`, que mantiene
    // `wa_ingest_inbound_message` con GREATEST; los salientes se piden solo
    // desde el entrante más viejo de la lista, porque uno anterior no puede
    // haber respondido nada. Así la consulta no crece con el historial.
    const tiempos = new Map<string, { ultimoEntrante: number; ultimoSaliente: number }>();
    for (const c of data) {
        if (c.last_inbound_at) {
            tiempos.set(c.id, { ultimoEntrante: new Date(c.last_inbound_at).getTime(), ultimoSaliente: 0 });
        }
    }
    const desde = [...tiempos.values()].reduce((min, t) => Math.min(min, t.ultimoEntrante), Infinity);
    if (tiempos.size && Number.isFinite(desde)) {
        // `automatico`: el saludo / mensaje de ausencia de la app WhatsApp
        // Business llega como echo y NO es una respuesta (en Dynasty, 7 envíos
        // de "Gracias por comunicarte…" el 2026-10-03). Lo marca procesarEchos
        // al recibirlo; los echos anteriores a la regla los marca
        // scripts/wa-fase-a-limpieza.ts --aplicar. No se recalcula la regla de
        // repetición acá: pediría todos los echos de 7 días de la integración
        // en cada carga del buzón para corregir un pasado que el script deja
        // marcado una sola vez.
        const { data: salientes } = await supabase
            .from('whatsapp_messages')
            .select('conversation_id, direction, wa_timestamp, created_at, automatico:payload->automatico')
            .in('conversation_id', [...tiempos.keys()])
            .eq('direction', 'outbound')
            .gte('wa_timestamp', new Date(desde).toISOString())
            .order('wa_timestamp', { ascending: false })
            .limit(1000);
        for (const [convId, t] of calcularPendientes((salientes ?? []) as any[])) {
            const e = tiempos.get(convId);
            if (e) e.ultimoSaliente = t.ultimoSaliente;
        }
    }

    // Nombres del equipo: «Gracias Mile» también es un cierre (requiere_respuesta).
    const equipo = await vocativosDeEscuela(schoolId).catch(() => new Map<string, string>());

    // Mejora 9: quién tiene tomada cada conversación (solo tomas vigentes).
    // Consulta aparte para que la migración sin aplicar no tumbe la lista.
    const { disponible: tomaDisponible, tomas } = await tomasDe(ids);

    return {
        tomaDisponible,
        filas: data.map((c: any) => ({
            ...c,
            ...estadoDeVentana(c.last_inbound_at),
            pendiente: estaPendiente(c.status, tiempos.get(c.id)),
            // «Por responder» sin los cierres: si lo último que entró es un
            // «gracias / ok / 👍», no hay nada que contestar.
            requiere_respuesta: estaPendiente(c.status, tiempos.get(c.id))
                && !(ultimos.get(c.id)?.direction === 'inbound' && esCierreSuelto(ultimos.get(c.id)?.text_body, equipo)),
            ultimo_mensaje: ultimos.get(c.id) ?? null,
            borradores_pendientes: borradores.get(c.id) ?? 0,
            toma: tomas.get(c.id) ?? null,
            es_prospecto: prospectos.has(c.id) || leads.has(c.id) || c.contact_kind === 'prospecto',
            prospecto: leads.has(c.id)
                ? { ...leads.get(c.id)!, interes: leads.get(c.id)!.intereses.join(', ') || null }
                : null,
        })),
    };
}

/** GET /api/v1/whatsapp/:schoolId/conversaciones */
router.get('/:schoolId/conversaciones', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const { schoolId } = req.params as { schoolId: string };
    const userId = req.user.id;
    if (!(await administraEstaEscuela(userId, schoolId))) {
        return res.status(403).json({ error: 'Sin permiso sobre esta escuela' });
    }

    const vistaPedida = VistaSchema.safeParse(req.query.vista ?? 'familias');
    if (!vistaPedida.success) {
        return res.status(400).json({ error: 'vista_invalida', detalle: 'usa familias | otros | todas' });
    }

    // Fase A: con Coexistence el número es también el WhatsApp personal de
    // quien dirige la escuela (Dynasty, 2026-10-03: 30 de 55 conversaciones
    // eran familias). Por defecto se muestran solo familias; el resto va a
    // "otros". Se trae la lista completa (hasta 500) para poder devolver los
    // conteos de las tres pestañas en el mismo viaje, y se filtra acá.
    const COLUMNAS = 'id, contact_wa_id, contact_name, identified, status, unread_count, '
                   + 'last_message_at, last_inbound_at, parent_id';
    const listar = (cols: string) => supabase
        .from('whatsapp_conversations')
        .select(cols)
        .eq('school_id', schoolId)
        .order('last_message_at', { ascending: false, nullsFirst: false })
        .limit(500);
    // `tambien_familia` llega con 20261013164839 (a mano): sin ella, false.
    let conTipo: { data: any; error: any } = await listar(`${COLUMNAS}, contact_kind, tambien_familia`);
    if (conTipo.error && esColumnaInexistente(conTipo.error)) {
        conTipo = await listar(`${COLUMNAS}, contact_kind`);
    }

    let todas: any[] = (conTipo.data as any[]) ?? [];
    let clasificacionDisponible = true;
    if (conTipo.error) {
        // La migración 20261003193624 se aplica a mano. Mientras no esté, la
        // columna no existe y la consulta falla: se degrada a la lista de
        // siempre, sin filtrar, para que el buzón no se caiga.
        if (!esColumnaInexistente(conTipo.error)) {
            return res.status(500).json({ error: conTipo.error.message });
        }
        clasificacionDisponible = false;
        const sinTipo = await supabase
            .from('whatsapp_conversations')
            .select(COLUMNAS)
            .eq('school_id', schoolId)
            .order('last_message_at', { ascending: false, nullsFirst: false })
            .limit(500);
        if (sinTipo.error) return res.status(500).json({ error: sinTipo.error.message });
        todas = ((sinTipo.data as any[]) ?? []).map((c) => ({ ...c, contact_kind: null }));
    }

    const vista: VistaDelBuzon = clasificacionDisponible ? vistaPedida.data : 'todas';
    const conteos = clasificacionDisponible ? contarPorVista(todas) : null;
    const data = (vista === 'todas' ? todas : todas.filter((c) => vistaDeTipo(c.contact_kind) === vista))
        .slice(0, 200);

    const { filas: conversaciones, tomaDisponible } = await enriquecerConversaciones(schoolId, data);

    return res.json({
        vista,
        // false = la migración de Fase A aún no está aplicada: la lista viene
        // sin filtrar y `conteos` en null. La pantalla debería ocultar las pestañas.
        clasificacion_disponible: clasificacionDisponible,
        // false = falta la migración 20261006101521: el botón «Tomar» se deshabilita.
        toma_disponible: tomaDisponible,
        conteos,
        conversaciones,
    });
});

const VistaSchema = z.enum(['familias', 'otros', 'todas']);

/**
 * Cuerpo del PATCH …/tipo. La forma nueva es `{ tipo, tambien_familia? }`; la
 * vieja `{ personal: boolean }` se sigue aceptando (pantallas en caché).
 */
const TipoSchema = z.union([
    z.object({
        tipo: z.enum(['familia', ...TIPOS_MARCADOS] as [string, ...string[]]),
        tambien_familia: z.boolean().optional(),
    }).strict(),
    z.object({ personal: z.boolean() }).strict(),
]);

/** `{ personal }` o `{ tipo, tambien_familia }` → la marca a guardar. Pura. */
export function marcaPedida(body: z.infer<typeof TipoSchema>): { tipo: TipoMarcado | null; tambienFamilia: boolean } {
    if ('personal' in body) return { tipo: body.personal ? 'personal' : null, tambienFamilia: false };
    const tipo = esMarcaNoFamilia(body.tipo) ? body.tipo : null;
    return { tipo, tambienFamilia: tipo ? body.tambien_familia === true : false };
}

/**
 * Cierra en lote las filas abiertas de la bandeja de un número recién marcado
 * como no-familia. Mismo formato que el cierre manual (`descartado`, por quien
 * marcó) y la misma guarda de concurrencia (cada UPDATE exige el estado y el
 * `error_message` leídos). Con «también es familia» se quedan las que pueden
 * ser el pago de un hijo (`filasParaCierrePorMarca`). Nunca lanza.
 */
async function cerrarFilasDeContactoMarcado(
    schoolId: string, waPhone: string, tipo: TipoMarcado, tambienFamilia: boolean, userId: string, log?: any,
): Promise<string[]> {
    const { data, error } = await supabase.from('whatsapp_inbound_queue')
        .select('id, status, error_message, matched_child_id')
        .eq('school_id', schoolId)
        .eq('wa_phone_number', waPhone)
        .in('status', [...ESTADOS_BANDEJA])
        .limit(TECHO_BANDEJA);
    if (error) { log?.warn?.({ schoolId, err: error.message }, '[wa-admin] no se pudieron leer las filas del contacto'); return []; }
    const motivo = motivoDeCierrePorMarca(tipo);
    const cerradas: string[] = [];
    for (const f of filasParaCierrePorMarca((data ?? []) as any[], tambienFamilia)) {
        const previo = (f.error_message ?? null) as string | null;
        let upd = supabase.from('whatsapp_inbound_queue')
            .update({
                status: 'ignored',
                error_message: marcaDeCierre('descartado', motivo, userId, previo),
                locked_until: null,
                updated_at: new Date().toISOString(),
            })
            .eq('id', f.id)
            .eq('school_id', schoolId)
            .eq('status', f.status);
        upd = previo === null ? upd.is('error_message', null) : upd.eq('error_message', previo);
        const r = await upd.select('id');
        if (r.error) { log?.warn?.({ schoolId, fila: f.id, err: r.error.message }, '[wa-admin] cierre por marca falló'); continue; }
        if ((r.data ?? []).length) cerradas.push(f.id);
    }
    return cerradas;
}

/**
 * PATCH /api/v1/whatsapp/:schoolId/conversaciones/:conversationId/tipo
 *
 * `{ tipo: 'personal'|'negocio'|'otro_club'|'plataforma', tambien_familia? }`
 *     → marca manual de no-familia: el asistente no le habla, no se guarda el
 *       contenido de sus mensajes y sus filas abiertas de la bandeja se cierran
 *       («contacto marcado como …»). Con `tambien_familia` sus comprobantes se
 *       siguen aplicando en silencio a los cobros de sus hijos.
 * `{ tipo: 'familia' }` → contact_kind=NULL: se reclasifica sola con el próximo
 *       mensaje entrante (clasificarContacto). No se adivina acá el tipo,
 *       porque eso exige `wa_identify_by_phone`, que además VINCULA la conversación.
 * `{ personal: boolean }` → forma vieja (= personal / familia).
 */
router.patch('/:schoolId/conversaciones/:conversationId/tipo', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const { schoolId, conversationId } = req.params as { schoolId: string; conversationId: string };
    if (!(await administraEstaEscuela(req.user.id, schoolId))) {
        return res.status(403).json({ error: 'Sin permiso sobre esta escuela' });
    }

    const parsed = TipoSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: 'datos_invalidos', details: parsed.error.issues });
    }

    const { tipo, tambienFamilia } = marcaPedida(parsed.data);
    const viejo = 'personal' in parsed.data;

    // El school_id en el FILTRO: un admin de A no marca conversaciones de B.
    // La forma vieja no toca `tambien_familia` (puede no existir la columna).
    const cambios: Record<string, unknown> = { contact_kind: tipo, updated_at: new Date().toISOString() };
    if (!viejo) cambios.tambien_familia = tambienFamilia;
    let r: { data: any; error: any } = await supabase
        .from('whatsapp_conversations')
        .update(cambios)
        .eq('id', conversationId)
        .eq('school_id', schoolId)
        .select('id, contact_wa_id, contact_kind')
        .maybeSingle();

    if (r.error && esColumnaInexistente(r.error) && !viejo) {
        // Sin `tambien_familia` (migración 20261013164839 sin aplicar) ni el
        // CHECK nuevo: solo se puede guardar personal / familia.
        if (tambienFamilia || (tipo && tipo !== 'personal')) {
            return res.status(409).json({ error: 'clasificacion_no_disponible',
                detalle: 'Falta aplicar la migración 20261013164839 (tipos de contacto).' });
        }
        r = await supabase.from('whatsapp_conversations')
            .update({ contact_kind: tipo, updated_at: new Date().toISOString() })
            .eq('id', conversationId).eq('school_id', schoolId)
            .select('id, contact_wa_id, contact_kind').maybeSingle();
    }
    const { data, error } = r;
    if (error) {
        if (esColumnaInexistente(error)) {
            return res.status(409).json({ error: 'clasificacion_no_disponible',
                detalle: 'Falta aplicar la migración de Fase A (contact_kind).' });
        }
        // 23514 = el CHECK viejo no admite negocio/otro_club/plataforma.
        if (String(error.code) === '23514') {
            return res.status(409).json({ error: 'clasificacion_no_disponible',
                detalle: 'Falta aplicar la migración 20261013164839 (tipos de contacto).' });
        }
        return res.status(500).json({ error: error.message });
    }
    if (!data) return res.status(404).json({ error: 'Conversacion no encontrada' });

    // Marcar es decir «esto no es de la escuela»: lo que ya estaba en la
    // bandeja de ese número se cierra (antes la marca solo frenaba lo nuevo).
    const cerradas = tipo && (data as any).contact_wa_id
        ? await cerrarFilasDeContactoMarcado(schoolId, (data as any).contact_wa_id, tipo, tambienFamilia, req.user.id, req.log)
        : [];

    req.log?.info({ schoolId, conversationId, tipo, tambienFamilia, cerradas: cerradas.length },
        '[wa-admin] tipo de contacto marcado');
    return res.json({ ok: true, id: (data as any).id, contact_kind: (data as any).contact_kind,
                      tambien_familia: viejo ? undefined : tambienFamilia, filas_cerradas: cerradas.length });
});

/**
 * POST /api/v1/whatsapp/:schoolId/conversaciones/:conversationId/cerrar
 *
 * La escuela da la conversación por atendida sin responder (un "ok, gracias").
 * Si la familia vuelve a escribir, `wa_ingest_inbound_message` la reabre.
 * Idempotente: cerrar una ya cerrada devuelve 200.
 */
router.post('/:schoolId/conversaciones/:conversationId/cerrar', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const { schoolId, conversationId } = req.params as { schoolId: string; conversationId: string };
    if (!(await administraEstaEscuela(req.user.id, schoolId))) {
        return res.status(403).json({ error: 'Sin permiso sobre esta escuela' });
    }

    const { data, error } = await supabase
        .from('whatsapp_conversations')
        .update({ status: 'closed', unread_count: 0, updated_at: new Date().toISOString() })
        .eq('id', conversationId)
        .eq('school_id', schoolId)
        .select('id, status')
        .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: 'Conversacion no encontrada' });

    return res.json({ ok: true, id: (data as any).id, status: 'closed' });
});

/** GET /api/v1/whatsapp/:schoolId/conversaciones/:conversationId */
router.get('/:schoolId/conversaciones/:conversationId', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const { schoolId, conversationId } = req.params as { schoolId: string; conversationId: string };
    const userId = req.user.id;
    if (!(await administraEstaEscuela(userId, schoolId))) {
        return res.status(403).json({ error: 'Sin permiso sobre esta escuela' });
    }

    // El school_id va en el FILTRO, no solo en la autorizacion. Sin eso, un
    // admin de la escuela A podria leer el hilo de la escuela B pasando su
    // propio schoolId en la ruta y el id de la conversacion ajena.
    const { data: conv } = await supabase
        .from('whatsapp_conversations')
        .select('id, contact_wa_id, contact_name, identified, status, parent_id, last_inbound_at')
        .eq('id', conversationId)
        .eq('school_id', schoolId)
        .maybeSingle();
    if (!conv) return res.status(404).json({ error: 'Conversacion no encontrada' });

    // `payload` solo para saber si el mensaje trae un adjunto (y de qué tipo):
    // no viaja entero a la pantalla. El archivo se pide aparte, por el BFF
    // (GET …/mensajes/:id/media), porque la URL de Meta es privada.
    const { data: mensajesCrudos } = await supabase
        .from('whatsapp_messages')
        .select('id, direction, type, text_body, status, ai_generated, created_at, error_detail, payload')
        .eq('conversation_id', conversationId)
        .order('created_at');
    const mensajes = ((mensajesCrudos ?? []) as any[]).map(({ payload, ...m }) => ({ ...m, media: medioDelMensaje(m.type, payload) }));

    const { data: drafts } = await supabase
        .from('whatsapp_message_drafts')
        .select('id, proposed_text, edited_text, status, llm_provider, created_at')
        .eq('conversation_id', conversationId)
        .eq('status', 'pending')
        .order('created_at');

    const { disponible: tomaDisponible, tomas } = await tomasDe([conversationId]);

    return res.json({
        conversacion: {
            ...conv, ...estadoDeVentana((conv as any).last_inbound_at),
            toma: tomas.get(conversationId) ?? null,
        },
        toma_disponible: tomaDisponible,
        mensajes: mensajes ?? [],
        borradores: drafts ?? [],
    });
});

const RespuestaSchema = z.object({ texto: z.string().trim().min(1).max(4000) });

/** POST /api/v1/whatsapp/:schoolId/conversaciones/:conversationId/responder */
router.post('/:schoolId/conversaciones/:conversationId/responder', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const { schoolId, conversationId } = req.params as { schoolId: string; conversationId: string };
    const userId = req.user.id;
    if (!(await administraEstaEscuela(userId, schoolId))) {
        return res.status(403).json({ error: 'Sin permiso sobre esta escuela' });
    }

    const parsed = RespuestaSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Texto invalido' });

    const { data: conv } = await supabase
        .from('whatsapp_conversations')
        .select('id, contact_wa_id, last_inbound_at')
        .eq('id', conversationId)
        .eq('school_id', schoolId)
        .maybeSingle();
    if (!conv) return res.status(404).json({ error: 'Conversacion no encontrada' });

    // Se corta ACA, no en la pantalla. Una pestania abierta desde ayer, un
    // cliente viejo o una llamada directa a la API se saltarian el aviso
    // visual, y Meta devolveria un error que la escuela no sabe leer.
    const ventana = estadoDeVentana((conv as any).last_inbound_at);
    if (!ventana.ventana_abierta) {
        return res.status(409).json({
            error: 'ventana_cerrada',
            mensaje: 'Pasaron mas de 24 horas desde el ultimo mensaje de esta persona. '
                   + 'WhatsApp solo permite responder con una plantilla aprobada.',
            ...ventana,
        });
    }

    const integracion = await integracionParaEnviar(schoolId);
    if (!integracion) return res.status(409).json({ error: 'La escuela no tiene WhatsApp conectado' });

    // WhatsApp usa UN asterisco para negrita: quien escriba en Markdown desde
    // la pantalla veria los dos asteriscos literales del otro lado.
    const texto = aFormatoWhatsApp(parsed.data.texto);
    const enviado = await sendTextMessage(integracion, (conv as any).contact_wa_id, texto);
    if (!enviado.ok) {
        req.log?.warn({ schoolId, conversationId, error: enviado.error }, '[wa-admin] no se pudo responder');
        return res.status(502).json({ error: 'No se pudo enviar', detalle: enviado.error });
    }

    // Por la MISMA RPC que usa el bot. Insertar directo dejaria el mensaje con
    // otra forma y la escuela veria huecos en el hilo. `ai_generated: false` es
    // lo que distingue lo que escribio una persona.
    await supabase.rpc('wa_record_outbound_message', {
        p_conversation_id: conversationId,
        p_integration_id: integracion.id,
        p_wa_message_id: enviado.waMessageId || `local-${crypto.randomUUID()}`,
        p_type: 'text',
        p_text_body: texto,
        p_payload: { manual: true, por: userId },
        p_ai_generated: false,
        p_to_wa_id: (conv as any).contact_wa_id,
    });

    // Atendida por una persona: queda cerrada (= nada pendiente). Antes se
    // escribía status='active', que el CHECK de la tabla NO admite
    // (open|snoozed|closed): el UPDATE fallaba en silencio y por eso las 55
    // conversaciones de Dynasty seguían 'open' el 2026-10-03 aunque se hubieran
    // respondido. Si la familia vuelve a escribir, wa_ingest_inbound_message
    // la reabre a 'open'.
    const { error: errCierre } = await supabase.from('whatsapp_conversations')
        .update({ status: 'closed', assigned_to: userId, unread_count: 0, updated_at: new Date().toISOString() })
        .eq('id', conversationId)
        .eq('school_id', schoolId);
    if (errCierre) req.log?.warn({ conversationId, err: errCierre.message }, '[wa-admin] no se pudo cerrar tras responder');

    // Mejora 9: responder desde el buzón la TOMA por 2 h (además del silencio
    // de 15 min por humano). No acorta una toma más larga ya vigente. Si falta
    // la migración, se responde igual.
    const toma = await tomarConversacion(schoolId, conversationId, userId, HORAS_TOMADA_AL_RESPONDER,
        { soloExtender: true }).catch(() => null);
    if (toma && !toma.ok && toma.motivo !== 'no_disponible') {
        req.log?.warn({ conversationId, toma }, '[wa-admin] no se pudo tomar tras responder');
    }

    return res.status(201).json({ ok: true, toma: toma?.ok ? toma : null });
});

const TomarSchema = z.object({
    horas: z.number().int().min(1).max(HORAS_TOMADA_MAX).optional(),
}).strict();

/**
 * POST /api/v1/whatsapp/:schoolId/conversaciones/:conversationId/tomar
 *
 * Mejora 9: una persona toma la conversación y el asistente no escribe nada
 * automático hasta que la suelte o venza (`horas`, default 12 /
 * WHATSAPP_TOMADA_HORAS). La cola de comprobantes sigue aplicando, sin
 * escribirle a la familia (ver whatsapp-tomada.service). Tomar una ya tomada
 * por otra persona la reasigna a quien la toma (lo ve en el buzón).
 */
router.post('/:schoolId/conversaciones/:conversationId/tomar', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const { schoolId, conversationId } = req.params as { schoolId: string; conversationId: string };
    if (!(await administraEstaEscuela(req.user.id, schoolId))) {
        return res.status(403).json({ error: 'Sin permiso sobre esta escuela' });
    }
    const parsed = TomarSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
        return res.status(400).json({ error: 'datos_invalidos', details: parsed.error.issues });
    }

    const r = await tomarConversacion(schoolId, conversationId, req.user.id,
        parsed.data.horas ?? HORAS_TOMADA_DEFAULT);
    if (!r.ok) {
        if (r.motivo === 'no_encontrada') return res.status(404).json({ error: 'Conversacion no encontrada' });
        if (r.motivo === 'no_disponible') {
            return res.status(409).json({ error: 'toma_no_disponible',
                detalle: 'Falta aplicar la migración 20261006101521 (tomada_por / tomada_hasta).' });
        }
        return res.status(500).json({ error: r.detalle ?? 'No se pudo tomar' });
    }
    req.log?.info({ schoolId, conversationId, hasta: r.tomada_hasta }, '[wa-admin] conversación tomada');
    return res.json({ ok: true, tomada_por: r.tomada_por, tomada_hasta: r.tomada_hasta });
});

/** POST /api/v1/whatsapp/:schoolId/conversaciones/:conversationId/soltar — el bot vuelve a atender. */
router.post('/:schoolId/conversaciones/:conversationId/soltar', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const { schoolId, conversationId } = req.params as { schoolId: string; conversationId: string };
    if (!(await administraEstaEscuela(req.user.id, schoolId))) {
        return res.status(403).json({ error: 'Sin permiso sobre esta escuela' });
    }
    const r = await soltarConversacion(schoolId, conversationId);
    if (!r.ok) {
        if (r.motivo === 'no_encontrada') return res.status(404).json({ error: 'Conversacion no encontrada' });
        if (r.motivo === 'no_disponible') {
            return res.status(409).json({ error: 'toma_no_disponible',
                detalle: 'Falta aplicar la migración 20261006101521 (tomada_por / tomada_hasta).' });
        }
        return res.status(500).json({ error: r.detalle ?? 'No se pudo soltar' });
    }
    req.log?.info({ schoolId, conversationId }, '[wa-admin] conversación soltada');
    return res.json({ ok: true });
});

const AprobarSchema = z.object({
    // Si la escuela corrigio el borrador, se manda lo corregido. Se guardan los
    // dos: `proposed_text` es lo que dijo el modelo y `edited_text` lo que la
    // persona decidio enviar. Comparar los dos con el tiempo es lo unico que
    // dice si el bot esta mejorando o empeorando.
    texto: z.string().trim().min(1).max(4000).optional(),
});

/** POST /api/v1/whatsapp/:schoolId/borradores/:draftId/aprobar */
router.post('/:schoolId/borradores/:draftId/aprobar', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const { schoolId, draftId } = req.params as { schoolId: string; draftId: string };
    const userId = req.user.id;
    if (!(await administraEstaEscuela(userId, schoolId))) {
        return res.status(403).json({ error: 'Sin permiso sobre esta escuela' });
    }

    const parsed = AprobarSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: 'Texto invalido' });

    // El borrador se lee JUNTO con su conversacion y filtrando por escuela: sin
    // eso, un admin podria aprobar el borrador de otra escuela conociendo su id.
    const { data: draft } = await supabase
        .from('whatsapp_message_drafts')
        .select('id, status, proposed_text, conversation_id, tool_context, '
              + 'conversacion:whatsapp_conversations!inner(id, school_id, contact_wa_id, last_inbound_at)')
        .eq('id', draftId)
        .eq('whatsapp_conversations.school_id', schoolId)
        .maybeSingle();
    if (!draft) return res.status(404).json({ error: 'Borrador no encontrado' });

    // Dos personas mirando la misma bandeja aprueban el mismo borrador: el
    // segundo no debe enviar otra vez.
    if ((draft as any).status !== 'pending') {
        return res.status(409).json({ error: 'Ese borrador ya fue resuelto' });
    }

    const conv = (draft as any).conversacion;
    const ventana = estadoDeVentana(conv.last_inbound_at);
    if (!ventana.ventana_abierta) {
        return res.status(409).json({
            error: 'ventana_cerrada',
            mensaje: 'Pasaron mas de 24 horas desde el ultimo mensaje de esta persona. '
                   + 'WhatsApp solo permite responder con una plantilla aprobada.',
            ...ventana,
        });
    }

    const integracion = await integracionParaEnviar(schoolId);
    if (!integracion) return res.status(409).json({ error: 'La escuela no tiene WhatsApp conectado' });

    const texto = aFormatoWhatsApp(parsed.data.texto ?? (draft as any).proposed_text);
    const enviado = await sendTextMessage(integracion, conv.contact_wa_id, texto);
    if (!enviado.ok) {
        req.log?.warn({ schoolId, draftId, error: enviado.error }, '[wa-admin] no se pudo enviar el borrador');
        return res.status(502).json({ error: 'No se pudo enviar', detalle: enviado.error });
    }

    // Se marca DESPUES de enviar. Al reves, un fallo de red dejaria el borrador
    // como enviado sin que el padre haya recibido nada.
    await supabase.from('whatsapp_message_drafts').update({
        status: 'sent',
        edited_text: parsed.data.texto ?? null,
        approved_by: userId,
        approved_at: new Date().toISOString(),
        sent_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
    }).eq('id', draftId);

    // `ai_generated` en true: lo escribio el modelo aunque lo haya aprobado una
    // persona. Si la escuela lo corrigio, deja de serlo.
    await supabase.rpc('wa_record_outbound_message', {
        p_conversation_id: (draft as any).conversation_id,
        p_integration_id: integracion.id,
        p_wa_message_id: enviado.waMessageId || `local-${crypto.randomUUID()}`,
        p_type: 'text',
        p_text_body: texto,
        // El `step` del borrador viaja al saliente: el bot decide con él si la
        // pregunta de consentimiento quedó abierta, si un aviso ya salió en la
        // ventana, etc. Sin esto, en modo asistido todo borrador aprobado era
        // un saliente «sin paso» y esas reglas no lo veían (2026-10-06).
        p_payload: {
            draft_id: draftId, aprobado_por: userId, editado: Boolean(parsed.data.texto),
            ...((draft as any).tool_context?.step ? { step: (draft as any).tool_context.step } : {}),
        },
        p_ai_generated: !parsed.data.texto,
        p_to_wa_id: conv.contact_wa_id,
    });

    // Mismo arreglo que en /responder: 'active' violaba el CHECK y no cerraba nada.
    const { error: errCierre } = await supabase.from('whatsapp_conversations')
        .update({ status: 'closed', unread_count: 0, updated_at: new Date().toISOString() })
        .eq('id', (draft as any).conversation_id)
        .eq('school_id', schoolId);
    if (errCierre) req.log?.warn({ draftId, err: errCierre.message }, '[wa-admin] no se pudo cerrar tras aprobar');

    return res.status(201).json({ ok: true });
});

/** POST /api/v1/whatsapp/:schoolId/borradores/:draftId/descartar */
router.post('/:schoolId/borradores/:draftId/descartar', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const { schoolId, draftId } = req.params as { schoolId: string; draftId: string };
    const userId = req.user.id;
    if (!(await administraEstaEscuela(userId, schoolId))) {
        return res.status(403).json({ error: 'Sin permiso sobre esta escuela' });
    }

    const { data: draft } = await supabase
        .from('whatsapp_message_drafts')
        .select('id, status, conversacion:whatsapp_conversations!inner(school_id)')
        .eq('id', draftId)
        .eq('whatsapp_conversations.school_id', schoolId)
        .maybeSingle();
    if (!draft) return res.status(404).json({ error: 'Borrador no encontrado' });
    if ((draft as any).status !== 'pending') {
        return res.status(409).json({ error: 'Ese borrador ya fue resuelto' });
    }

    // No se borra: queda el rastro de que el modelo propuso algo y una persona
    // dijo que no. Es lo que permite medir cuanto se descarta.
    // 'rejected', no 'discarded': el CHECK de whatsapp_message_drafts solo
    // admite pending|approved|rejected|sent|expired (verificado en la base el
    // 2026-10-03). Con 'discarded' el UPDATE fallaba en silencio y el borrador
    // seguía 'pending' — parte de los 316 que no bajaban.
    const { error: errDescarte } = await supabase.from('whatsapp_message_drafts').update({
        status: 'rejected',
        approved_by: userId,
        approved_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
    }).eq('id', draftId).eq('status', 'pending');
    if (errDescarte) return res.status(500).json({ error: errDescarte.message });

    return res.json({ ok: true });
});

const ConectarSchema = z.object({
    code: z.string().trim().min(10).max(1000),
    sesion: z.object({
        event: z.string().optional(),
        waba_id: z.string().optional(),
        phone_number_id: z.string().optional(),
        business_id: z.string().optional(),
    }).nullable().optional(),
});

/**
 * POST /api/v1/whatsapp/:schoolId/conectar
 *
 * Cierra el alta que empezo el dialogo de Meta en el navegador. El `code` es de
 * un solo uso y vence en minutos: no se reintenta solo, y si falla la escuela
 * tiene que volver a pasar por el dialogo.
 */
router.post('/:schoolId/conectar', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const { schoolId } = req.params as { schoolId: string };
    const userId = req.user.id;
    if (!(await administraEstaEscuela(userId, schoolId))) {
        return res.status(403).json({ error: 'Sin permiso sobre esta escuela' });
    }

    const parsed = ConectarSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Datos de conexión inválidos' });

    const r = await conectarEscuela(schoolId, parsed.data.code, parsed.data.sesion ?? null, userId);

    if (!r.ok) {
        // El code NUNCA se registra, ni truncado: es una credencial de un solo
        // uso y los logs se leen en pantalla compartida.
        req.log?.warn({ schoolId, error: r.error }, '[wa-admin] alta fallida');
        const status = r.error === 'ya_conectada' || r.error === 'numero_ocupado' ? 409 : 502;
        return res.status(status).json({ error: r.error, detalle: r.detalle });
    }

    req.log?.info({ schoolId, integrationId: r.integrationId, coexistence: r.coexistence },
                  '[wa-admin] escuela conectada');
    return res.status(201).json({
        ok: true,
        display_phone_number: r.displayPhoneNumber,
        coexistence: r.coexistence,
    });
});

export default router;
