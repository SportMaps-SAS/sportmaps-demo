/**
 * wa-concepto-esperado — el «motivo esperado» del próximo comprobante de un contacto.
 *
 * Cuando el bot le pide un pago a alguien («La clase de prueba vale $15.000…
 * mándame el comprobante por aquí»), quien escribe ese mensaje registra QUÉ
 * espera (`registrarConceptoEsperado`). El siguiente comprobante de ese número
 * toma ese motivo sin preguntar (plan B4 §3, docs/specs/whatsapp-monster-plan-B4.md).
 *
 * Vive en su tabla (`whatsapp_conceptos_esperados`, solo service_role) y no en
 * `whatsapp_conversation_flows` (uno por conversación: chocaría con la venta
 * abierta) ni en el payload del saliente (no registra consumo, no admite dos
 * esperados —hermanos, matrícula + uniformes— y en modo asistido puede ser un
 * borrador).
 *
 * Contrato con B2 (plan maestro §3, nombres exactos):
 *   registrarConceptoEsperado(schoolId, telefono, { motivo, monto?, leadId?, childId?, venceEn? })
 *
 * Nada lanza. Si la migración (M2) no está aplicada, registrar devuelve false
 * y leer devuelve [] — la cola sigue como hoy.
 */
import { supabase } from '../config/supabase';
import { esMotivo, type Motivo } from './motivos-de-cobro';

const TABLA = 'whatsapp_conceptos_esperados';
const COLUMNAS = 'id, school_id, telefono, motivo, monto, signup_lead_id, child_id, origen, vence_en, created_at';

/** Cuánto vale un esperado si quien lo registra no dice otra cosa (la ventana de servicio de Meta). */
export const HORAS_VIGENCIA_ESPERADO = 24;

export type OrigenEsperado = 'clase_prueba' | 'venta' | 'bot';

export interface ConceptoEsperado {
    id: string;
    schoolId: string;
    /** = `contact_wa_id` (solo dígitos, con indicativo). */
    telefono: string;
    motivo: Motivo;
    /** null = no se sabe el valor (lo decide el precio de la escuela). */
    monto: number | null;
    leadId: string | null;
    childId: string | null;
    origen: OrigenEsperado;
    venceEn: string;
    createdAt: string | null;
}

export interface NuevoConceptoEsperado {
    motivo: string;
    monto?: number | null;
    leadId?: string | null;
    childId?: string | null;
    /** Por defecto, dentro de 24 h. */
    venceEn?: Date | string | null;
}

/**
 * El teléfono como lo guarda la cola (`wa_phone_number` = `contact_wa_id`): solo
 * dígitos; un celular colombiano de 10 dígitos recibe el 57. null si no quedan
 * 10–15 dígitos. Pura.
 */
export function telefonoDeEsperado(t: string | null | undefined): string | null {
    const d = String(t ?? '').replace(/\D/g, '');
    const n = /^3\d{9}$/.test(d) ? `57${d}` : d;
    return /^[0-9]{10,15}$/.test(n) ? n : null;
}

const numONull = (v: unknown): number | null => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};

/** Fila de la tabla → ConceptoEsperado. null si viene rota. Pura. */
export function esperadoDesdeFila(f: Record<string, any> | null | undefined): ConceptoEsperado | null {
    if (!f || typeof f.id !== 'string' || !esMotivo(f.motivo)) return null;
    return {
        id: f.id,
        schoolId: String(f.school_id ?? ''),
        telefono: String(f.telefono ?? ''),
        motivo: f.motivo,
        monto: numONull(f.monto),
        leadId: typeof f.signup_lead_id === 'string' ? f.signup_lead_id : null,
        childId: typeof f.child_id === 'string' ? f.child_id : null,
        origen: f.origen === 'clase_prueba' || f.origen === 'venta' ? f.origen : 'bot',
        venceEn: String(f.vence_en ?? ''),
        createdAt: typeof f.created_at === 'string' ? f.created_at : null,
    };
}

/**
 * Registra (o renueva) lo que se espera del próximo comprobante de `telefono`.
 * Mismo escuela + teléfono + motivo + dueño sin consumir → se actualiza (monto y
 * vencimiento), no se duplica. Devuelve true si quedó guardado. Nunca lanza.
 */
export async function registrarConceptoEsperado(
    schoolId: string,
    telefono: string,
    c: NuevoConceptoEsperado,
): Promise<boolean> {
    try {
        const tel = telefonoDeEsperado(telefono);
        if (!schoolId || !tel || !c || !esMotivo(c.motivo)) return false;
        const monto = numONull(c.monto);
        if (monto !== null && !(monto > 0)) return false;
        const leadId = c.leadId || null;
        const childId = c.childId || null;
        if (leadId && childId) return false;

        const ahora = Date.now();
        const vence = c.venceEn ? new Date(c.venceEn).getTime() : ahora + HORAS_VIGENCIA_ESPERADO * 3600_000;
        if (!Number.isFinite(vence) || vence <= ahora) return false;
        const venceEn = new Date(vence).toISOString();

        // El índice único `uq_wa_conceptos_vivos` (20261030123549) admite UNO sin
        // consumir por escuela + teléfono + motivo + dueño, vencido o no: se
        // busca sin mirar el vencimiento y, si existe, se renueva.
        const actualizarPrevio = async (): Promise<boolean | null> => {
            let q = supabase.from(TABLA).select('id')
                .eq('school_id', schoolId).eq('telefono', tel).eq('motivo', c.motivo)
                .is('consumido_at', null);
            q = leadId ? q.eq('signup_lead_id', leadId) : q.is('signup_lead_id', null);
            q = childId ? q.eq('child_id', childId) : q.is('child_id', null);
            const { data: previo, error: errPrevio } = await q.limit(1).maybeSingle();
            if (errPrevio) {
                console.warn('[wa-esperado] no se pudo leer', { schoolId, code: errPrevio.code, msg: errPrevio.message });
                return false;
            }
            if (!(previo as any)?.id) return null;
            const { error } = await supabase.from(TABLA)
                .update({ monto, vence_en: venceEn, updated_at: new Date(ahora).toISOString() })
                .eq('id', (previo as any).id).is('consumido_at', null);
            return !error;
        };

        const previo = await actualizarPrevio();
        if (previo !== null) return previo;
        const { error } = await supabase.from(TABLA).insert({
            school_id: schoolId,
            telefono: tel,
            motivo: c.motivo,
            monto,
            signup_lead_id: leadId,
            child_id: childId,
            origen: c.motivo === 'clase_prueba' ? 'clase_prueba' : 'bot',
            vence_en: venceEn,
        });
        // Otro BFF lo insertó entre la lectura y el insert: se renueva el suyo.
        if (error?.code === '23505') return (await actualizarPrevio()) === true;
        if (error) console.warn('[wa-esperado] no se pudo registrar', { schoolId, code: error.code, msg: error.message });
        return !error;
    } catch (e: any) {
        console.warn('[wa-esperado] registrar lanzó', { schoolId, error: e?.message });
        return false;
    }
}

/** Los esperados vivos (sin consumir y sin vencer) de un contacto, del más nuevo al más viejo. Nunca lanza. */
export async function conceptosEsperadosDe(schoolId: string, telefono: string, ahora = Date.now()): Promise<ConceptoEsperado[]> {
    try {
        const tel = telefonoDeEsperado(telefono);
        if (!schoolId || !tel) return [];
        const { data, error } = await supabase.from(TABLA)
            .select(COLUMNAS)
            .eq('school_id', schoolId).eq('telefono', tel)
            .is('consumido_at', null)
            .gt('vence_en', new Date(ahora).toISOString())
            .order('created_at', { ascending: false })
            .limit(10);
        if (error || !Array.isArray(data)) return [];
        return (data as any[]).map(esperadoDesdeFila).filter((e): e is ConceptoEsperado => e !== null)
            // Defensa: la base ya filtró, pero un vencido nunca decide.
            .filter((e) => !e.venceEn || new Date(e.venceEn).getTime() > ahora);
    } catch {
        return [];
    }
}

/**
 * El esperado al que apunta un comprobante de `monto`. Pura.
 *  · Uno solo con ese monto (±$1) → ese.
 *  · Varios con ese monto y el MISMO motivo (hermanos: matrícula de los dos) →
 *    el motivo sin dueño (quien llama pregunta de cuál deportista es).
 *  · Ninguno con ese monto: si hay uno solo vivo, ese (quien llama decide si el
 *    monto distinto va a la escuela); si hay varios, null (puede ser la suma).
 */
export function elegirEsperado(lista: ConceptoEsperado[], monto: number | null): ConceptoEsperado | null {
    if (!lista.length) return null;
    const exactos = monto === null ? [] : lista.filter((e) => e.monto !== null && Math.abs(e.monto - monto) <= 1);
    if (exactos.length === 1) return exactos[0];
    if (exactos.length > 1) {
        if (!exactos.every((e) => e.motivo === exactos[0].motivo)) return null;
        const mismoLead = exactos.every((e) => e.leadId === exactos[0].leadId) ? exactos[0].leadId : null;
        const mismoNino = exactos.every((e) => e.childId === exactos[0].childId) ? exactos[0].childId : null;
        return { ...exactos[0], leadId: mismoLead, childId: mismoNino };
    }
    return lista.length === 1 ? lista[0] : null;
}

/**
 * Marca el esperado como usado por `paymentId`. UPDATE condicionado a
 * `consumido_at IS NULL`: entre los 3 BFF gana uno. true = lo consumió este.
 * Nunca lanza.
 */
export async function consumirEsperado(id: string, paymentId: string | null, queueId: string | null): Promise<boolean> {
    try {
        if (!id) return false;
        const ahora = new Date().toISOString();
        const { data, error } = await supabase.from(TABLA)
            .update({ consumido_at: ahora, payment_id: paymentId, queue_id: queueId, updated_at: ahora })
            .eq('id', id).is('consumido_at', null)
            .select('id');
        return !error && Array.isArray(data) && data.length > 0;
    } catch {
        return false;
    }
}
