/**
 * Comprobantes «Por clasificar» — lo que el bot no pudo aplicar solo y la escuela decide desde Cobros.
 *
 *   GET   /api/v1/whatsapp/:schoolId/por-clasificar                     → abiertos + catálogo de servicios
 *   GET   /api/v1/whatsapp/:schoolId/por-clasificar/duenos?q=           → deportistas / prospectos para asignar
 *   GET   /api/v1/whatsapp/:schoolId/por-clasificar/cobros-abiertos?q=  → cobros donde aplicarlo
 *   POST  /api/v1/whatsapp/:schoolId/por-clasificar/:id/aplicar         { payment_id }
 *   POST  /api/v1/whatsapp/:schoolId/por-clasificar/:id/crear-servicio  { item_id, opcion?, dueno:{tipo,id} }
 *
 * Descartar NO pasa por acá: lo hace el frontend con la RPC `wa_comprobante_por_clasificar_descartar`
 * (gate adentro, con la sesión de la persona).
 *
 * Spec: docs/specs/whatsapp-comprobantes-nunca-en-la-bandeja.md (fases 2 y 3). Migración 20261118124124.
 *
 * Reglas:
 *  · Solo administración de ESA escuela (`administraEstaEscuela`); la fila y el cobro son de esa escuela.
 *  · NADA se aprueba: el comprobante queda en el cobro «En revisión» (`estamparComprobante`, el mismo
 *    camino del bot: veredicto, antiduplicado) y la escuela lo aprueba en Pagos como cualquier otro.
 *  · No se le escribe a la familia.
 *  · «Crear desde aquí» (servicio nuevo): el cobro lo crea la base con el precio del catálogo
 *    (`wa_crear_cobro_desde_comprobante`); si el monto no cuadra, no crea nada y se explica por qué.
 */

import { Router, Response } from 'express';
import { z } from 'zod';
import { supabase } from '../config/supabase';
import { requireAuth, type AuthenticatedRequest } from '../middlewares/authMiddleware';
import { administraEstaEscuela } from './whatsapp-admin.routes';
import { estamparComprobante } from '../jobs/whatsapp-queue.job';
import { anularCobroCreado, crearCobroDesdeComprobante } from '../services/wa-cobro-desde-comprobante.service';
import type { PagoPendiente } from '../services/whatsapp-receipt-matching.service';

const router = Router();

const BUCKET_COMPROBANTES = 'payment-receipts';
const TTL_MINIATURA_SEG = 15 * 60;
const UUID = z.string().uuid();

const esTablaInexistente = (e: { code?: string; message?: string } | null | undefined) =>
    !!e && (e.code === '42P01' || e.code === 'PGRST205' || /does not exist|schema cache/i.test(e.message ?? ''));

/** Escapa lo que va dentro de un `ilike` para que «%» o «_» del usuario no sean comodines. */
const paraIlike = (q: string) => q.replace(/[\\%_]/g, (c) => `\\${c}`).slice(0, 60);

async function filaPorClasificar(schoolId: string, id: string) {
    const { data, error } = await supabase.from('wa_comprobantes_por_clasificar')
        .select('id, school_id, queue_id, monto, referencia, fecha_comprobante, storage_path, contacto, estado, etiqueta')
        .eq('id', id).eq('school_id', schoolId).maybeSingle();
    return { fila: (data ?? null) as any, error };
}

/** La lectura del OCR que la cola ya guardó (sha incluido): no se vuelve a leer nada. */
async function lecturaDeLaCola(queueId: string, schoolId: string) {
    const { data } = await supabase.from('whatsapp_inbound_queue')
        .select('pregunta_ocr, storage_path').eq('id', queueId).eq('school_id', schoolId).maybeSingle();
    const po = (data as any)?.pregunta_ocr as { ocr?: any; sha?: string; storagePath?: string } | null;
    if (!po?.ocr || typeof po.sha !== 'string') return null;
    return { ocr: po.ocr, sha: po.sha, storagePath: po.storagePath ?? (data as any)?.storage_path ?? null };
}

// ── GET — abiertos + servicios del catálogo ─────────────────────────────────
router.get('/:schoolId/por-clasificar', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const { schoolId } = req.params as { schoolId: string };
    if (!(await administraEstaEscuela(req.user.id, schoolId))) return res.status(403).json({ error: 'forbidden' });

    const { data, error } = await supabase.from('wa_comprobantes_por_clasificar')
        .select('id, queue_id, contacto, contacto_nombre, monto, referencia, fecha_comprobante, banco, destino, storage_path, etiqueta, propuesta, motivo_bot, created_at')
        .eq('school_id', schoolId).eq('estado', 'por_clasificar')
        .order('created_at', { ascending: true }).limit(200);
    if (error) {
        // La migración aún no está aplicada: la pantalla no muestra nada en vez de romperse.
        if (esTablaInexistente(error)) return res.json({ filas: [], servicios: [], migracion_pendiente: true });
        return res.status(500).json({ error: error.message });
    }
    const filas = (data ?? []) as any[];

    const rutas = [...new Set(filas.map((f) => f.storage_path).filter(Boolean))] as string[];
    const urlPorRuta = new Map<string, string>();
    if (rutas.length) {
        try {
            const { data: firmadas } = await supabase.storage.from(BUCKET_COMPROBANTES).createSignedUrls(rutas, TTL_MINIATURA_SEG);
            for (const d of (firmadas ?? []) as any[]) if (d?.path && d?.signedUrl) urlPorRuta.set(d.path, d.signedUrl);
        } catch (err: any) {
            req.log?.warn({ schoolId, err: err?.message || err }, '[wa-por-clasificar] no se pudieron firmar las miniaturas');
        }
    }

    // Servicios del catálogo donde se puede crear el cobro desde aquí (activos, sin evento, no vencidos).
    const { data: items } = await supabase.from('school_tournament_items')
        .select('id, name, kind, price, precio_afiliado, allow_installments, abono_minimo_pct, opciones, ends_at, starts_at')
        .eq('school_id', schoolId).eq('active', true).is('event_id', null).order('name');
    const ahora = Date.now();
    const servicios = ((items ?? []) as any[])
        .filter((i) => { const f = i.ends_at ?? i.starts_at; return !f || new Date(f).getTime() > ahora; })
        .map((i) => ({
            id: i.id, nombre: i.name, tipo: i.kind, precio: Number(i.price), precio_afiliado: i.precio_afiliado != null ? Number(i.precio_afiliado) : null,
            permite_abono: !!i.allow_installments, abono_minimo_pct: i.abono_minimo_pct ?? null,
            opciones: Array.isArray(i.opciones)
                ? i.opciones.map((o: any) => ({ clave: o.clave, etiqueta: o.etiqueta ?? o.clave, precio: Number(o.precio) }))
                : [],
        }));

    return res.json({
        filas: filas.map((f) => ({ ...f, archivo_url: f.storage_path ? urlPorRuta.get(f.storage_path) ?? null : null })),
        servicios,
    });
});

// ── GET /duenos?q= — a quién asignar el pago (servicio nuevo) ───────────────
router.get('/:schoolId/por-clasificar/duenos', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const { schoolId } = req.params as { schoolId: string };
    if (!(await administraEstaEscuela(req.user.id, schoolId))) return res.status(403).json({ error: 'forbidden' });
    const q = String(req.query.q ?? '').trim();
    if (q.length < 2) return res.json({ resultados: [] });
    const patron = `%${paraIlike(q)}%`;

    const [hijos, sinCuenta, leads] = await Promise.all([
        supabase.from('children').select('id, full_name').eq('school_id', schoolId).eq('is_active', true).ilike('full_name', patron).order('full_name').limit(8),
        supabase.from('unregistered_athletes').select('id, full_name').eq('school_id', schoolId).eq('is_active', true).ilike('full_name', patron).order('full_name').limit(8),
        supabase.from('school_signup_leads').select('id, full_name, status').eq('school_id', schoolId).neq('status', 'discarded').ilike('full_name', patron).order('full_name').limit(8),
    ]);
    const resultados = [
        ...((hijos.data ?? []) as any[]).map((r) => ({ tipo: 'child', id: r.id, nombre: r.full_name, detalle: 'Deportista' })),
        ...((sinCuenta.data ?? []) as any[]).map((r) => ({ tipo: 'unregistered', id: r.id, nombre: r.full_name, detalle: 'Deportista (sin cuenta)' })),
        ...((leads.data ?? []) as any[]).map((r) => ({ tipo: 'lead', id: r.id, nombre: r.full_name, detalle: 'Prospecto' })),
    ];
    return res.json({ resultados });
});

// ── GET /cobros-abiertos?q= — dónde aplicarlo ───────────────────────────────
router.get('/:schoolId/por-clasificar/cobros-abiertos', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const { schoolId } = req.params as { schoolId: string };
    if (!(await administraEstaEscuela(req.user.id, schoolId))) return res.status(403).json({ error: 'forbidden' });
    const q = String(req.query.q ?? '').trim();
    if (q.length < 2) return res.json({ resultados: [] });

    const { data, error } = await supabase.from('payments')
        .select('id, concept, amount, status, due_date')
        .eq('school_id', schoolId).in('status', ['pending', 'overdue', 'partial'])
        .ilike('concept', `%${paraIlike(q)}%`).order('due_date', { ascending: true }).limit(15);
    if (error) return res.status(500).json({ error: error.message });
    return res.json({
        resultados: ((data ?? []) as any[]).map((p) => ({
            id: p.id, concepto: p.concept, monto: Number(p.amount), estado: p.status, vence: p.due_date,
        })),
    });
});

// ── POST /:id/aplicar — a un cobro que ya existe ────────────────────────────
const AplicarSchema = z.object({ payment_id: UUID });

router.post('/:schoolId/por-clasificar/:id/aplicar', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const { schoolId, id } = req.params as { schoolId: string; id: string };
    if (!(await administraEstaEscuela(req.user.id, schoolId))) return res.status(403).json({ error: 'forbidden' });
    const parsed = AplicarSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'datos_invalidos', details: parsed.error.issues });

    const { fila, error } = await filaPorClasificar(schoolId, id);
    if (error) return res.status(500).json({ error: error.message });
    if (!fila) return res.status(404).json({ error: 'no_encontrada' });
    if (fila.estado !== 'por_clasificar') return res.status(409).json({ error: 'ya_cerrada', estado: fila.estado });

    const { data: pago } = await supabase.from('payments')
        .select('id, amount, concept, due_date, child_id, status, payment_category')
        .eq('id', parsed.data.payment_id).eq('school_id', schoolId).maybeSingle();
    if (!pago) return res.status(404).json({ error: 'cobro_no_encontrado' });
    if (!['pending', 'overdue', 'partial'].includes((pago as any).status)) {
        return res.status(409).json({ error: 'cobro_no_abierto', estado: (pago as any).status });
    }

    const lectura = await lecturaDeLaCola(fila.queue_id, schoolId);
    if (!lectura) return res.status(422).json({ error: 'sin_lectura', detalle: 'El comprobante no tiene lectura guardada: se aplica a mano en Pagos.' });

    const pendiente: PagoPendiente = {
        id: (pago as any).id, amount: Number((pago as any).amount), concept: (pago as any).concept ?? null,
        due_date: (pago as any).due_date ?? null, child_id: (pago as any).child_id ?? null, atleta: null,
        categoria: (pago as any).payment_category ?? null,
    };
    const r = await estamparComprobante(
        { schoolId, storagePath: lectura.storagePath ?? fila.storage_path, sha: lectura.sha, ocr: lectura.ocr, log: req.log as any, queueId: fila.queue_id },
        pendiente, Number(fila.monto), { estados: ['pending', 'overdue', 'partial'] },
    );
    if (!r.ok) {
        if (r.duplicado) return res.status(409).json({ error: 'referencia_ya_usada', pago: r.yaAplicado ?? null });
        return res.status(500).json({ error: r.error });
    }

    const { data: cierre } = await supabase.rpc('wa_comprobante_por_clasificar_aplicar', {
        p_id: id, p_payment_id: (pago as any).id, p_resolucion: 'aplicado_a_cobro_existente', p_por: req.user.id,
    });
    req.log?.info({ schoolId, id, paymentId: (pago as any).id, por: req.user.id, cierre }, '[wa-por-clasificar] aplicado a un cobro');
    return res.json({ ok: true, payment_id: (pago as any).id, veredicto: r.veredicto.verdict });
});

// ── POST /:id/crear-servicio — cobro nuevo de un servicio del catálogo ──────
const CrearServicioSchema = z.object({
    item_id: UUID,
    opcion: z.string().trim().min(1).max(30).optional(),
    dueno: z.object({ tipo: z.enum(['child', 'unregistered', 'lead', 'user']), id: UUID }),
});

router.post('/:schoolId/por-clasificar/:id/crear-servicio', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const { schoolId, id } = req.params as { schoolId: string; id: string };
    if (!(await administraEstaEscuela(req.user.id, schoolId))) return res.status(403).json({ error: 'forbidden' });
    const parsed = CrearServicioSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'datos_invalidos', details: parsed.error.issues });
    const { item_id, opcion, dueno } = parsed.data;

    const { fila, error } = await filaPorClasificar(schoolId, id);
    if (error) return res.status(500).json({ error: error.message });
    if (!fila) return res.status(404).json({ error: 'no_encontrada' });
    if (fila.estado !== 'por_clasificar') return res.status(409).json({ error: 'ya_cerrada', estado: fila.estado });

    const { data: item } = await supabase.from('school_tournament_items')
        .select('id, kind, name').eq('id', item_id).eq('school_id', schoolId).maybeSingle();
    if (!item) return res.status(404).json({ error: 'servicio_no_encontrado' });

    const lectura = await lecturaDeLaCola(fila.queue_id, schoolId);
    if (!lectura) return res.status(422).json({ error: 'sin_lectura', detalle: 'El comprobante no tiene lectura guardada: se registra a mano en Pagos.' });

    // La base crea el cobro con el precio del catálogo (idempotente por fila de la cola). Si el monto no
    // cuadra, no crea nada y devolvemos lo que esperaba para que la escuela decida.
    const cobro = await crearCobroDesdeComprobante({
        schoolId, queueId: fila.queue_id, categoria: (item as any).kind, monto: Number(fila.monto),
        fuente: 'tournament_item', fuenteId: item_id, opcion: opcion ?? null, concepto: null, telefono: fila.contacto ?? null,
        ...(dueno.tipo === 'child' ? { childId: dueno.id }
            : dueno.tipo === 'unregistered' ? { unregisteredId: dueno.id }
            : dueno.tipo === 'lead' ? { leadId: dueno.id } : { userId: dueno.id }),
    });
    if (!cobro.ok) {
        const estado = ['monto_no_coincide', 'ya_tiene_cobro', 'sin_cupos', 'opcion_requerida', 'opcion_invalida', 'item_vencido'].includes(cobro.codigo) ? 422 : 400;
        return res.status(estado).json({ error: cobro.codigo, precio: cobro.precio ?? null, abono_minimo: cobro.abonoMinimo ?? null, payment_id: cobro.paymentId ?? null });
    }

    const pendiente: PagoPendiente = {
        id: cobro.paymentId, amount: cobro.precio, concept: cobro.concepto ?? (item as any).name, due_date: null,
        child_id: dueno.tipo === 'child' ? dueno.id : null, atleta: null, categoria: (item as any).kind,
    };
    const r = await estamparComprobante(
        { schoolId, storagePath: lectura.storagePath ?? fila.storage_path, sha: lectura.sha, ocr: lectura.ocr, log: req.log as any, queueId: fila.queue_id },
        pendiente, cobro.esAbono ? Number(fila.monto) : undefined,
    );
    if (!r.ok) {
        // Lo recién creado no se queda huérfano: se anula (solo si lo creó el asistente y nadie lo tocó).
        if (!cobro.yaExistia) await anularCobroCreado(cobro.paymentId);
        if (r.duplicado) return res.status(409).json({ error: 'referencia_ya_usada', pago: r.yaAplicado ?? null });
        return res.status(500).json({ error: r.error });
    }

    await supabase.rpc('wa_comprobante_por_clasificar_aplicar', {
        p_id: id, p_payment_id: cobro.paymentId, p_resolucion: 'cobro_de_servicio_creado', p_por: req.user.id,
    });
    req.log?.info({ schoolId, id, paymentId: cobro.paymentId, item: item_id, abono: cobro.esAbono, por: req.user.id }, '[wa-por-clasificar] cobro de servicio creado');
    return res.json({ ok: true, payment_id: cobro.paymentId, es_abono: cobro.esAbono, veredicto: r.veredicto.verdict });
});

export default router;
