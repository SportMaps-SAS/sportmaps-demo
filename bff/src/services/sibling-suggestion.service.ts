/**
 * Sugerencia de hermano en el alta de menor (F2 hermanos, acudiente sin cuenta).
 *
 * Un menor cuyo acudiente aún no tiene cuenta nace sin `parent_id`, así que el
 * sistema no lo agrupa con sus hermanos y el descuento no sale. Aquí se PROPONE
 * al hermano comparando el correo o el teléfono del acudiente con los de los
 * menores ya inscritos (children.parent_email_temp / parent_phone_temp) de la
 * MISMA escuela. Solo propone: nunca vincula. El vínculo lo confirma el admin
 * marcando «¿Tiene un hermano inscrito?» y viaja por sibling_of_child_id.
 *
 * Reglas:
 *   · Solo cuentan menores activos con una inscripción activa en la escuela.
 *   · Correo: minúsculas y sin espacios. Teléfono: solo dígitos, últimos 10
 *     (así 573124208761 y 312 420 8761 son el mismo número).
 *   · Si los candidatos pertenecen a MÁS de una familia (mismo correo
 *     compartido por familias distintas) se devuelven todos pero sin
 *     `suggested_child_id`: el staff decide, nada se pre-marca.
 */
import { supabase } from '../config/supabase';

export interface SiblingCandidateRow {
    id: string;
    full_name: string;
    is_active?: boolean | null;
    parent_id?: string | null;
    parent_name_temp?: string | null;
    parent_email_temp?: string | null;
    parent_phone_temp?: string | null;
}

export type SiblingMatchBy = 'email' | 'phone';

export interface SiblingSuggestionItem {
    child_id: string;
    full_name: string;
    matched_by: SiblingMatchBy[];
}

export interface SiblingSuggestion {
    /** Hermano propuesto (null si no hay candidato o si hay más de una familia). */
    suggested_child_id: string | null;
    suggested_name: string | null;
    matched_by: SiblingMatchBy[];
    /** Hay candidatos de más de una familia: no se pre-marca nada. */
    ambiguous: boolean;
    candidates: SiblingSuggestionItem[];
}

export interface SiblingContact {
    email?: string | null;
    phone?: string | null;
}

export function normalizeEmail(v: string | null | undefined): string | null {
    const e = String(v ?? '').trim().toLowerCase();
    return /^[^\s@,()]+@[^\s@,()]+\.[^\s@,()]+$/.test(e) ? e : null;
}

export function normalizePhone(v: string | null | undefined): string | null {
    const d = String(v ?? '').replace(/\D/g, '');
    return d.length >= 10 ? d.slice(-10) : null;
}

const normName = (v: string | null | undefined): string =>
    String(v ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Misma familia = mismo parent_id; sin cuenta, mismo nombre de acudiente. */
function familyKey(r: SiblingCandidateRow): string {
    if (r.parent_id) return `p:${r.parent_id}`;
    return `n:${normName(r.parent_name_temp) || 'sin-nombre'}`;
}

/** Núcleo puro (sin base de datos): decide a quién proponer. */
export function pickSiblingSuggestion(
    rows: SiblingCandidateRow[],
    activeEnrollmentChildIds: ReadonlySet<string>,
    contact: SiblingContact,
    excludeChildId?: string | null,
): SiblingSuggestion {
    const email = normalizeEmail(contact.email);
    const phone = normalizePhone(contact.phone);
    const empty: SiblingSuggestion = { suggested_child_id: null, suggested_name: null, matched_by: [], ambiguous: false, candidates: [] };
    if (!email && !phone) return empty;

    const matched: Array<{ row: SiblingCandidateRow; by: SiblingMatchBy[] }> = [];
    for (const r of rows) {
        if (r.id === excludeChildId) continue;
        if (r.is_active === false) continue;
        if (!activeEnrollmentChildIds.has(r.id)) continue;
        const by: SiblingMatchBy[] = [];
        if (email && normalizeEmail(r.parent_email_temp) === email) by.push('email');
        if (phone && normalizePhone(r.parent_phone_temp) === phone) by.push('phone');
        if (by.length) matched.push({ row: r, by });
    }
    if (!matched.length) return empty;

    const families = new Set(matched.map(m => familyKey(m.row)));
    const candidates = matched.map(m => ({ child_id: m.row.id, full_name: m.row.full_name, matched_by: m.by }));
    if (families.size > 1) {
        return { ...empty, ambiguous: true, candidates };
    }
    const first = matched[0];
    return {
        suggested_child_id: first.row.id,
        suggested_name: first.row.full_name,
        matched_by: first.by,
        ambiguous: false,
        candidates,
    };
}

/** Lee candidatos de la escuela y propone hermano. Falla en silencio (es informativo). */
export async function suggestSibling(
    schoolId: string,
    contact: SiblingContact,
    excludeChildId?: string | null,
): Promise<SiblingSuggestion | null> {
    const email = normalizeEmail(contact.email);
    const phone = normalizePhone(contact.phone);
    if (!schoolId || (!email && !phone)) return null;
    try {
        const filters: string[] = [];
        if (email) filters.push(`parent_email_temp.ilike.${email}`);
        if (phone) filters.push(`parent_phone_temp.like.%${phone}%`);
        const { data: rows, error } = await supabase
            .from('children')
            .select('id, full_name, is_active, parent_id, parent_name_temp, parent_email_temp, parent_phone_temp')
            .eq('school_id', schoolId)
            .eq('is_active', true)
            .or(filters.join(','))
            .limit(50);
        if (error || !rows?.length) return null;
        const ids = (rows as SiblingCandidateRow[]).map(r => r.id);
        const { data: enr } = await supabase
            .from('enrollments')
            .select('child_id')
            .eq('school_id', schoolId)
            .eq('status', 'active')
            .in('child_id', ids);
        const active = new Set<string>((enr ?? []).map((e: any) => e.child_id as string));
        const out = pickSiblingSuggestion(rows as SiblingCandidateRow[], active, { email, phone }, excludeChildId);
        return out.candidates.length ? out : null;
    } catch {
        return null;
    }
}

export interface SiblingQuote { pct: number; rank: number; amount: number }

/**
 * Cotiza el descuento por hermanos con la RPC viva (sibling_discount_quote).
 * null = sin descuento (1.er hijo, escuela sin descuento, cuota manual o falla).
 */
export async function quoteSiblingDiscount(
    schoolId: string,
    p: { childId?: string | null; siblingOfChildId?: string | null; fee: number },
): Promise<SiblingQuote | null> {
    if (!p.childId && !p.siblingOfChildId) return null;
    try {
        const { data, error } = await supabase.rpc('sibling_discount_quote', {
            p_school_id: schoolId,
            p_child_id: p.childId ?? null,
            p_sibling_of: p.siblingOfChildId ?? null,
            p_enrollment_id: null,
        });
        if (error || !data) return null;
        const pct = Number((data as any).pct) || 0;
        const rank = Number((data as any).rank) || 1;
        if (pct <= 0 || !(p.fee > 0)) return null;
        return { pct, rank, amount: Math.round(p.fee * pct / 100) };
    } catch {
        return null;
    }
}
