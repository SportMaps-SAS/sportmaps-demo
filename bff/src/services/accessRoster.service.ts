/**
 * «IDs del lector» (Control de acceso, F1): cruza lo que el lector reporta
 * (access_device_users: PIN, nombre, credenciales) con los deportistas de la escuela y
 * con el estado de cobro, y sugiere a quién asociar cada PIN por parecido de nombre.
 *
 * Solo lectura sobre la base: asociar un PIN usa POST /access/assign-user.
 * Los nombres que reporta el lector son datos de terceros: no se usan como identidad,
 * solo para SUGERIR; la asociación siempre la confirma una persona.
 */
import { supabase } from '../config/supabase';
import { FILTRO_SOLO_MENSUALIDAD } from './payment-accounts';
import { athleteKey } from '../utils/accessBlockMechanism';

// ─── Parecido de nombres (funciones puras) ───────────────────────────────────

const stripAccents = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');

/** «AtheneaCardona» → [athenea, cardona]; «Andrés Felipe R.» → [andres, felipe, r]. */
export function nameTokens(raw: string): string[] {
    const spaced = stripAccents(raw ?? '').replace(/([a-z])([A-Z])/g, '$1 $2');
    return spaced.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
}

function tokenScore(readerToken: string, athleteToken: string): number {
    if (readerToken === athleteToken) return 1;
    // Inicial: «R.» ~ «Rojas»
    if (readerToken.length === 1) return athleteToken.startsWith(readerToken) ? 0.6 : 0;
    // Abreviatura o diminutivo razonable: «Vale» ~ «Valentina» (mínimo 3 letras)
    if (Math.min(readerToken.length, athleteToken.length) >= 3
        && (athleteToken.startsWith(readerToken) || readerToken.startsWith(athleteToken))) return 0.85;
    return 0;
}

/** 0–1: qué tanto el nombre del lector corresponde a un nombre completo de SportMaps. */
export function matchScore(readerName: string, fullName: string): number {
    const rt = nameTokens(readerName);
    const at = nameTokens(fullName);
    if (!rt.length || !at.length) return 0;

    let sum = 0;
    const used = new Set<number>();
    for (const r of rt) {
        let best = 0;
        let bestIdx = -1;
        at.forEach((a, i) => {
            if (used.has(i)) return;
            const s = tokenScore(r, a);
            if (s > best) { best = s; bestIdx = i; }
        });
        if (bestIdx >= 0) used.add(bestIdx);
        sum += best;
    }
    let score = sum / rt.length;
    // El primer nombre debe coincidir: «Julian G.» no puede sugerir a «Gabriel Julian».
    if (tokenScore(rt[0], at[0]) < 0.85) score *= 0.5;
    // Un solo nombre en el lector («Valentina») es muy poco para sugerir.
    if (rt.length === 1) score = Math.min(score, 0.6);
    return Math.round(score * 100) / 100;
}

export const SUGGESTION_MIN_SCORE = 0.75;
export const SUGGESTION_MIN_GAP = 0.1;

export interface AthleteRef { key: string; id: string; type: 'child' | 'unregistered' | 'adult'; name: string }
export interface Suggestion { athlete: AthleteRef; score: number }

/**
 * La mejor coincidencia, solo si es clara: puntaje mínimo Y sin empate con la siguiente.
 * Dos deportistas que se llaman igual (hay casos reales) NO producen sugerencia: sería
 * adivinar a quién abre la puerta ese PIN.
 */
export function pickSuggestion(readerName: string, candidates: AthleteRef[]): Suggestion | null {
    const scored = candidates
        .map(a => ({ athlete: a, score: matchScore(readerName, a.name) }))
        .filter(s => s.score >= SUGGESTION_MIN_SCORE)
        .sort((x, y) => y.score - x.score);
    if (!scored.length) return null;
    if (scored.length > 1 && scored[0].score - scored[1].score < SUGGESTION_MIN_GAP) return null;
    return scored[0];
}

// ─── Lista de IDs ────────────────────────────────────────────────────────────

export type RosterFilter = 'all' | 'sin' | 'aso' | 'mora';
export type RosterBilling = 'staff' | 'al_dia' | 'mora' | 'sin_inscripcion' | null;

export interface RosterRow {
    pin: number;
    reader_name: string;
    has_face: boolean;
    has_fingerprint: boolean;
    has_password: boolean;
    athlete: { id: string; type: AthleteRef['type'] | 'staff'; name: string } | null;
    billing: RosterBilling;
    suggestion: { id: string; type: AthleteRef['type']; name: string; score: number } | null;
}

export interface RosterResult {
    simulated: boolean;
    synced_at: string | null;
    summary: { total: number; associated: number; unassociated: number; overdue_associated: number; with_suggestion: number };
    rows: RosterRow[];
    page: number;
    page_size: number;
    total_filtered: number;
}

const STAFF_ROLES = ['owner', 'admin', 'school_admin', 'coach', 'staff'];

export async function isRosterEnabled(schoolId: string): Promise<boolean> {
    const { data, error } = await supabase
        .from('school_settings')
        .select('access_roster_enabled')
        .eq('school_id', schoolId)
        .maybeSingle();
    if (error) return false;
    return (data as any)?.access_roster_enabled === true;
}

export async function getAccessRoster(
    schoolId: string,
    opts: { filter: RosterFilter; q?: string; page: number; pageSize: number },
): Promise<RosterResult> {
    // Una sola pasada por tabla (sin N+1): la lista del lector y lo necesario para cruzarla.
    const [rosterQ, mapQ, childQ, unregQ, memberQ, enrQ, payQ] = await Promise.all([
        supabase.from('access_device_users')
            .select('zk_pin, reader_name, has_face, has_fingerprint, has_password, is_simulated, synced_at')
            .eq('school_id', schoolId).order('zk_pin').limit(5000),
        supabase.from('zk_user_mappings')
            .select('zk_pin, user_id, unregistered_athlete_id, child_id').eq('school_id', schoolId),
        supabase.from('children').select('id, full_name').eq('school_id', schoolId).eq('is_active', true),
        supabase.from('unregistered_athletes').select('id, full_name')
            .eq('school_id', schoolId).eq('is_active', true).is('linked_profile_id', null),
        supabase.from('school_members').select('profile_id, role').eq('school_id', schoolId).eq('status', 'active'),
        supabase.from('enrollments').select('child_id, user_id, unregistered_athlete_id')
            .eq('school_id', schoolId).eq('status', 'active'),
        supabase.from('payments').select('child_id, user_id, unregistered_athlete_id')
            .eq('school_id', schoolId).eq('status', 'overdue').or(FILTRO_SOLO_MENSUALIDAD),
    ]);
    for (const r of [rosterQ, mapQ, childQ, unregQ, memberQ, enrQ, payQ]) {
        if (r.error) throw new Error(r.error.message);
    }

    // Un PIN puede estar en varios lectores: se funde en una fila (credenciales con OR).
    const byPin = new Map<number, { reader_name: string; has_face: boolean; has_fingerprint: boolean; has_password: boolean }>();
    let simulated = false;
    let syncedAt: string | null = null;
    for (const u of (rosterQ.data ?? []) as any[]) {
        const prev = byPin.get(u.zk_pin);
        byPin.set(u.zk_pin, {
            reader_name: prev?.reader_name || u.reader_name || '',
            has_face: !!prev?.has_face || !!u.has_face,
            has_fingerprint: !!prev?.has_fingerprint || !!u.has_fingerprint,
            has_password: !!prev?.has_password || !!u.has_password,
        });
        if (u.is_simulated) simulated = true;
        if (!syncedAt || u.synced_at > syncedAt) syncedAt = u.synced_at;
    }

    const members = (memberQ.data ?? []) as any[];
    const memberRole = new Map<string, string>();
    const adultIds: string[] = [];
    for (const m of members) {
        memberRole.set(m.profile_id, m.role);
        if (m.role === 'athlete') adultIds.push(m.profile_id);
    }
    const mappings = (mapQ.data ?? []) as any[];
    const mappedUserIds = mappings.map(m => m.user_id).filter(Boolean) as string[];
    const profileIds = [...new Set([...adultIds, ...mappedUserIds])];
    const profileName = new Map<string, string>();
    if (profileIds.length) {
        const { data: profiles, error } = await supabase.from('profiles').select('id, full_name').in('id', profileIds);
        if (error) throw new Error(error.message);
        (profiles ?? []).forEach((p: any) => profileName.set(p.id, p.full_name ?? ''));
    }

    const athletes: AthleteRef[] = [];
    (childQ.data ?? []).forEach((c: any) => athletes.push({ key: `c:${c.id}`, id: c.id, type: 'child', name: c.full_name ?? '' }));
    (unregQ.data ?? []).forEach((u: any) => athletes.push({ key: `a:${u.id}`, id: u.id, type: 'unregistered', name: u.full_name ?? '' }));
    adultIds.forEach(id => athletes.push({ key: `u:${id}`, id, type: 'adult', name: profileName.get(id) ?? '' }));
    const athleteByKey = new Map(athletes.map(a => [a.key, a]));

    const enrolled = new Set(((enrQ.data ?? []) as any[]).map(e => athleteKey(e)).filter(Boolean) as string[]);
    const overdue = new Set(((payQ.data ?? []) as any[]).map(p => athleteKey(p)).filter(Boolean) as string[]);

    const mapByPin = new Map<number, any>(mappings.map(m => [m.zk_pin, m]));
    const mappedKeys = new Set<string>();
    mappings.forEach(m => { const k = athleteKey(m); if (k) mappedKeys.add(k); });
    const freeAthletes = athletes.filter(a => !mappedKeys.has(a.key));

    const all: RosterRow[] = [];
    for (const [pin, u] of [...byPin.entries()].sort((a, b) => a[0] - b[0])) {
        const m = mapByPin.get(pin);
        const key = m ? athleteKey(m) : null;
        let athlete: RosterRow['athlete'] = null;
        let billing: RosterBilling = null;
        let suggestion: RosterRow['suggestion'] = null;

        if (m && key) {
            const isStaff = !!m.user_id && STAFF_ROLES.includes(memberRole.get(m.user_id) ?? '');
            const ref = athleteByKey.get(key);
            const name = ref?.name
                || (m.user_id ? profileName.get(m.user_id) : '')
                || 'Asociado';
            athlete = {
                id: ref?.id ?? (m.child_id ?? m.user_id ?? m.unregistered_athlete_id),
                type: isStaff ? 'staff' : (ref?.type ?? (m.child_id ? 'child' : m.user_id ? 'adult' : 'unregistered')),
                name,
            };
            billing = isStaff ? 'staff' : overdue.has(key) ? 'mora' : enrolled.has(key) ? 'al_dia' : 'sin_inscripcion';
        } else {
            const s = pickSuggestion(u.reader_name, freeAthletes);
            if (s) suggestion = { id: s.athlete.id, type: s.athlete.type, name: s.athlete.name, score: s.score };
        }
        all.push({
            pin, reader_name: u.reader_name, has_face: u.has_face, has_fingerprint: u.has_fingerprint,
            has_password: u.has_password, athlete, billing, suggestion,
        });
    }

    const summary = {
        total: all.length,
        associated: all.filter(r => r.athlete).length,
        unassociated: all.filter(r => !r.athlete).length,
        overdue_associated: all.filter(r => r.billing === 'mora').length,
        with_suggestion: all.filter(r => r.suggestion).length,
    };

    const q = (opts.q ?? '').trim();
    const qTokens = nameTokens(q);
    const filtered = all.filter(r => {
        if (opts.filter === 'sin' && r.athlete) return false;
        if (opts.filter === 'aso' && !r.athlete) return false;
        if (opts.filter === 'mora' && r.billing !== 'mora') return false;
        if (!q) return true;
        if (/^\d+$/.test(q)) return String(r.pin).startsWith(q);
        const hay = nameTokens(`${r.reader_name} ${r.athlete?.name ?? ''} ${r.suggestion?.name ?? ''}`);
        return qTokens.every(t => hay.some(h => h.startsWith(t)));
    });

    const pageSize = Math.min(Math.max(opts.pageSize, 1), 200);
    const page = Math.max(opts.page, 1);
    return {
        simulated,
        synced_at: syncedAt,
        summary,
        rows: filtered.slice((page - 1) * pageSize, page * pageSize),
        page,
        page_size: pageSize,
        total_filtered: filtered.length,
    };
}
