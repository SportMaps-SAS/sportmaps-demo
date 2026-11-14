/**
 * whatsapp-plan-y-plazos — el ÚNICO punto de entrada que usa el bot para dos cosas
 * de la oleada 2 (docs/specs/campanas-descuento-referidos-y-plazos-por-whatsapp.md §5 y §6):
 *
 *   · pagar por plazos             → whatsapp-plazos.ts
 *   · pausar / retirar / reactivar → whatsapp-plan-pausa-retiro.ts
 *
 * Primero continúa el paso a paso que esté abierto (el último saliente del bot es del
 * flujo); si no hay, mira si el mensaje arranca uno. Solo para la persona IDENTIFICADA
 * (`parentId`), nunca en modo discreto, y solo en escuelas con la función prendida
 * (plazos: `payment_agreements_enabled`; plan: `pause_enabled`). Con la función apagada
 * devuelve false y el turno sigue exactamente como antes.
 *
 * Nunca lanza: una falla no deja a la familia sin respuesta (devuelve false y sigue el bot).
 * Los puertos por defecto leen con service_role pero SIEMPRE acotados a la persona
 * identificada; las RPC vuelven a comprobar la titularidad.
 */

import { supabase } from '../config/supabase';
import type { FilaReciente } from './whatsapp-reglas-turno';
import { estadoAbierto, haVencido, type EstadoPlan } from './whatsapp-plan-comun';
import {
    iniciarPlazos, continuarPlazos, pideAcuerdoDePago,
    type PuertoPlazos, type EnviarPlan, type EscalarPlan,
} from './whatsapp-plazos';
import {
    iniciarPlan, continuarPlan, intencionDePlan,
    type PuertoPlan, type InscripcionPlan, type SolicitudMia,
} from './whatsapp-plan-pausa-retiro';
import {
    topesDeEscuela, previsualizar, solicitar as solicitarAcuerdo, hoyBogota, type CobroAbierto,
} from './acuerdos-de-pago.service';
import { pedirPausa, pedirRetiro, pedirReactivacion, cancelarSolicitud, listarMias } from './retiro-y-pausa.service';

export type { EnviarPlan, EscalarPlan, EstadoPlan };

export interface TurnoPlanYPlazos {
    schoolId: string;
    /** Perfil de la persona IDENTIFICADA. Sin él, no se hace nada. */
    parentId: string | null | undefined;
    texto: string;
    /** Los mensajes de la ráfaga (para leer la intención); si no, el texto. */
    rafaga?: string | null;
    botonId: string | null;
    recientes: FilaReciente[];
    discreto?: boolean;
}

export interface Puertos extends PuertoPlazos, PuertoPlan {}

// ─── Puertos por defecto (base) ──────────────────────────────────────────────

const db = supabase as any;

async function hijosDe(parentId: string): Promise<string[]> {
    const { data, error } = await db.from('children').select('id').eq('parent_id', parentId);
    if (error) throw new Error(`children: ${error.message}`);
    return ((data as any[]) ?? []).map((h) => String(h.id));
}

async function cobrosAbiertos(schoolId: string, parentId: string): Promise<CobroAbierto[]> {
    const childIds = await hijosDe(parentId);
    const filtro = [`parent_id.eq.${parentId}`, `user_id.eq.${parentId}`,
        childIds.length ? `child_id.in.(${childIds.join(',')})` : null].filter(Boolean).join(',');
    const { data, error } = await db.from('payments')
        .select('id, concept, due_date, amount, amount_paid, status')
        .eq('school_id', schoolId).in('status', ['pending', 'overdue', 'partial']).or(filtro)
        .order('due_date', { ascending: true }).limit(50);
    if (error) throw new Error(`payments: ${error.message}`);
    const cobros: CobroAbierto[] = ((data as any[]) ?? [])
        .map((p) => ({
            id: String(p.id), concept: p.concept ?? null, due_date: String(p.due_date).slice(0, 10),
            saldo: Math.max(Number(p.amount) - Number(p.amount_paid ?? 0), 0), status: String(p.status),
        }))
        .filter((p) => p.saldo > 0);
    if (!cobros.length) return cobros;
    // Los que ya están en un acuerdo vivo no se vuelven a plazar.
    const { data: enAcuerdo, error: ea } = await db.from('payment_agreement_payments')
        .select('payment_id, payment_agreements!inner(status)')
        .in('payment_id', cobros.map((c) => c.id)).in('payment_agreements.status', ['solicitado', 'activo']);
    if (ea) return cobros; // sin la migración o sin permiso: la RPC es la que manda
    const ocupados = new Set(((enAcuerdo as any[]) ?? []).map((r) => String(r.payment_id)));
    return cobros.filter((c) => !ocupados.has(c.id));
}

async function inscripciones(schoolId: string, parentId: string): Promise<InscripcionPlan[]> {
    const { data: hijos, error: eh } = await db.from('children').select('id, full_name, is_active').eq('parent_id', parentId);
    if (eh) throw new Error(`children: ${eh.message}`);
    const hijosPropios = ((hijos as any[]) ?? []).filter((h) => h.is_active !== false);
    const childIds = hijosPropios.map((h) => String(h.id));
    const filtro = childIds.length ? `user_id.eq.${parentId},child_id.in.(${childIds.join(',')})` : `user_id.eq.${parentId}`;
    const { data, error } = await db.from('enrollments')
        .select('id, child_id, user_id, team_id, status, paused_reason, created_at')
        .eq('school_id', schoolId).in('status', ['active', 'cancelled']).or(filtro)
        .order('created_at', { ascending: false }).limit(40);
    if (error) throw new Error(`enrollments: ${error.message}`);

    // Mismo criterio de titularidad que el servicio: con child_id manda el acudiente del menor.
    const filas = ((data as any[]) ?? []).filter((e) => (e.child_id ? childIds.includes(String(e.child_id)) : e.user_id === parentId));
    const equipos = [...new Set(filas.map((e) => e.team_id).filter(Boolean))] as string[];
    const nombresEquipo = new Map<string, string>();
    if (equipos.length) {
        const { data: t } = await db.from('teams').select('id, name').in('id', equipos);
        for (const r of (t as any[]) ?? []) nombresEquipo.set(String(r.id), String(r.name ?? ''));
    }
    let nombreAdulto = '';
    if (filas.some((e) => !e.child_id)) {
        const { data: p } = await db.from('profiles').select('full_name').eq('id', parentId).maybeSingle();
        nombreAdulto = String((p as any)?.full_name ?? '');
    }
    // Una por deportista: la más reciente. Si tiene una activa, esa gana sobre una retirada vieja.
    const porSujeto = new Map<string, InscripcionPlan>();
    for (const e of filas) {
        const clave = e.child_id ? `c:${e.child_id}` : `u:${e.user_id}`;
        const estado: InscripcionPlan['estado'] = e.status === 'cancelled' ? 'retirada' : e.paused_reason ? 'en_pausa' : 'activa';
        const previa = porSujeto.get(clave);
        if (previa && (previa.estado !== 'retirada' || estado === 'retirada')) continue;
        const hijo = e.child_id ? hijosPropios.find((h) => String(h.id) === String(e.child_id)) : null;
        porSujeto.set(clave, {
            id: String(e.id), estado,
            nombre: String(hijo?.full_name ?? nombreAdulto ?? ''),
            equipo: e.team_id ? (nombresEquipo.get(String(e.team_id)) || null) : null,
        });
    }
    return [...porSujeto.values()];
}

export const puertosPorDefecto: Puertos = {
    topes: (schoolId) => topesDeEscuela(schoolId),
    cobrosAbiertos,
    proponer: (p) => previsualizar(db, { schoolId: p.schoolId, paymentIds: p.paymentIds, cuotas: p.cuotas, fechas: p.fechas }),
    solicitar: (p) => solicitarAcuerdo(db, p),
    async habilitada(schoolId) {
        const { data, error } = await db.from('school_settings').select('pause_enabled').eq('school_id', schoolId).maybeSingle();
        if (error) return false;
        return (data as any)?.pause_enabled === true;
    },
    inscripciones,
    pedirPausa: (parentId, i) => pedirPausa({ actorId: parentId, canal: 'whatsapp' }, i) as any,
    pedirRetiro: (parentId, i) => pedirRetiro({ actorId: parentId, canal: 'whatsapp' }, i) as any,
    pedirReactivacion: (parentId, i) => pedirReactivacion({ actorId: parentId, canal: 'whatsapp' }, i) as any,
    cancelar: (parentId, tipo, id) => cancelarSolicitud({ actorId: parentId, canal: 'whatsapp' }, tipo, id) as any,
    async mias(parentId) {
        const l = await listarMias(parentId);
        return l.map((s): SolicitudMia => ({
            id: s.id, tipo: s.tipo, school_id: s.school_id, estado: s.estado, atleta_nombre: s.atleta_nombre,
            desde: s.desde, hasta: s.hasta, creada_at: s.creada_at,
        }));
    },
    hoy: () => hoyBogota(),
    ahora: () => Date.now(),
};

// ─── Entrada ─────────────────────────────────────────────────────────────────

export async function atenderPlanYPlazos(
    t: TurnoPlanYPlazos,
    enviar: EnviarPlan,
    escalar: EscalarPlan,
    puerto: Puertos = puertosPorDefecto,
): Promise<boolean> {
    try {
        const parentId = t.parentId;
        if (!parentId || t.discreto) return false;
        const texto = (t.texto || '').trim();
        const fuente = (t.rafaga || texto).trim();
        const ahora = puerto.ahora();
        const deps = { enviar, escalar };

        // 1) ¿Hay un paso a paso abierto?
        const abierto = estadoAbierto(t.recientes);
        if (abierto) {
            const vencido = haVencido(abierto.enviadoMs, ahora);
            const ctx = { schoolId: t.schoolId, parentId, texto, botonId: t.botonId };
            const ok = abierto.estado.paso.startsWith('plazos_')
                ? await continuarPlazos(ctx, { puerto, ...deps }, abierto.estado, vencido)
                : await continuarPlan(ctx, { puerto, ...deps }, abierto.estado, vencido);
            if (ok) return true;
        }

        // 2) ¿El mensaje arranca uno? (un botón nunca arranca nada)
        if (t.botonId || !fuente) return false;
        const ctx = { schoolId: t.schoolId, parentId, texto: fuente, botonId: null };
        if (pideAcuerdoDePago(fuente)) {
            if (await iniciarPlazos(ctx, { puerto, ...deps })) return true;
        }
        const intencion = intencionDePlan(fuente, puerto.hoy());
        if (intencion && await iniciarPlan(ctx, { puerto, ...deps }, intencion)) return true;
        return false;
    } catch (e: any) {
        console.warn('[whatsapp-plan-y-plazos] falló; sigue el bot', { err: e?.message });
        return false;
    }
}
