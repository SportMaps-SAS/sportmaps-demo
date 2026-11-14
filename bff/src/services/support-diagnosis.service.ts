/**
 * support-diagnosis.service — El diagnóstico de "¿por qué esta persona no puede
 * entrar?" en un solo lugar (F0 de `docs/specs/consola-de-soporte-super-admin.md`).
 *
 * Se construye UNA vez y sirve a tres consumidores:
 *
 *     buildUserState() ──┬─ panel del super_admin   (GET /admin/support/user-state)
 *                        ├─ contexto del bot        (tool get_my_state, S1)
 *                        └─ autoservicio del user   ("¿por qué no puedo entrar?")
 *
 * Por eso vive en services/ y no dentro del router: el bot lo va a llamar con
 * `scope: 'self'`, que recorta los bloques a lo que el propio usuario puede ver.
 *
 * READ-ONLY. Este módulo NO escribe absolutamente nada. Las acciones (reenviar
 * enlace, confirmar correo, contraseña temporal) son F1/F2 y viven aparte,
 * detrás de motivo obligatorio y auditoría.
 *
 * La lógica de duplicidad es la de `scripts/check-duplicate-identity.mjs`:
 * se rastrea por documento / teléfono / fecha de nacimiento, NUNCA por nombre
 * ("Dai Vázquez" no matchea con "DAIMARIS VASQUEZ PEREZ").
 */

import { supabase, supabaseUrl, supabaseServiceKey } from '../config/supabase';

// ─── Tipos de salida ──────────────────────────────────────────────────────────

export type VerdictLevel = 'ok' | 'warn' | 'error';

export interface UserStateVerdict {
    level: VerdictLevel;
    /** Una línea, en español, apta para mostrar tal cual. */
    headline: string;
    /** Hallazgos concretos que sustentan el veredicto. */
    findings: string[];
    /** Acción sugerida (la UI la resalta; las demás quedan en segundo plano). */
    recommendedAction:
        | 'ninguna'
        | 'confirmar_correo'
        | 'reenviar_enlace'
        | 'revisar_correo_similar'
        | 'revincular_escuela'
        | 'fusionar_identidades'
        | 'revisar_cobros';
}

export interface UserStateAccess {
    found: boolean;
    userId: string | null;
    email: string | null;
    emailConfirmedAt: string | null;
    lastSignInAt: string | null;
    bannedUntil: string | null;
    /** Vacío ⇒ solo password. Con 'google' ⇒ pedirle contraseña es un callejón sin salida. */
    providers: string[];
    recoverySentAt: string | null;
    createdAt: string | null;
    /** Más de una cuenta de auth para la misma persona: está entrando a la que no es. */
    otherAuthAccounts: Array<{ id: string; email: string | null; lastSignInAt: string | null }>;
    /** Un typo en el correo no se arregla con un reset. */
    similarEmails: Array<{ source: 'profiles' | 'invitations' | 'children'; email: string; label: string | null }>;
}

export interface UserStateMembership {
    profile: { id: string; fullName: string | null; email: string | null; phone: string | null; role: string | null; docNumber: string | null; dateOfBirth: string | null } | null;
    schoolMembers: Array<{ id: string; schoolId: string; schoolName: string | null; role: string; status: string; joinedAt: string | null }>;
    enrollments: Array<{ id: string; schoolId: string; schoolName: string | null; subject: string; teamId: string | null; monthlyFee: number | null; status: string; createdAt: string | null }>;
    invitations: Array<{ id: string; schoolId: string; schoolName: string | null; email: string; status: string; roleToAssign: string | null; childName: string | null; monthlyFee: number | null; createdAt: string | null; expiresAt: string | null }>;
    /** La vista que la escuela realmente ve y factura. */
    schoolAthletes: Array<{ id: string; schoolId: string; fullName: string | null; isActive: boolean | null; enrollmentStatus: string | null; teamId: string | null; priceMonthly: number | null }>;
}

export interface UserStateDuplicity {
    unregisteredAthletes: Array<{ id: string; schoolId: string; fullName: string | null; docNumber: string | null; isActive: boolean | null; linkedProfileId: string | null }>;
    children: Array<{ id: string; fullName: string | null; parentId: string | null; parentEmailTemp: string | null; docNumber: string | null; schoolId: string | null }>;
    activeEnrollmentCount: number;
    /** Inscripciones activas del MISMO sujeto, escuela y equipo: eso sí es un duplicado. Dos equipos o dos hijos no lo son. */
    repeatedEnrollmentGroups: number;
    /** Cobros mismo mes + mismo monto + misma escuela. */
    duplicatePaymentGroups: Array<{ schoolId: string; period: string; amount: number; paymentIds: string[] }>;
    /** Cobros de menor sin pagador → el papá ve "No tienes permiso para pagar". */
    paymentsWithoutPayer: number;
}

export interface UserState {
    query: { email: string | null; userId: string | null };
    access: UserStateAccess;
    membership: UserStateMembership;
    duplicity: UserStateDuplicity;
    verdict: UserStateVerdict;
    generatedAt: string;
}

// ─── Acceso al Admin API de auth ──────────────────────────────────────────────
// supabase-js no expone un lookup de usuario por email, así que vamos al
// endpoint REST igual que hace scripts/check-duplicate-identity.mjs.

const AUTH_BASE = `${supabaseUrl.replace(/\/$/, '')}/auth/v1/admin`;
const AUTH_HEADERS = { apikey: supabaseServiceKey, Authorization: `Bearer ${supabaseServiceKey}` };

interface AuthUserRow {
    id: string;
    email: string | null;
    email_confirmed_at: string | null;
    last_sign_in_at: string | null;
    banned_until: string | null;
    recovery_sent_at: string | null;
    created_at: string | null;
    identities?: Array<{ provider: string }>;
}

async function findAuthUsersByEmail(email: string): Promise<AuthUserRow[]> {
    const res = await fetch(`${AUTH_BASE}/users?filter=${encodeURIComponent(email)}&per_page=20`, {
        headers: AUTH_HEADERS,
    });
    if (!res.ok) return [];
    const json: any = await res.json();
    return (json?.users || []) as AuthUserRow[];
}

async function findAuthUserById(userId: string): Promise<AuthUserRow | null> {
    const res = await fetch(`${AUTH_BASE}/users/${userId}`, { headers: AUTH_HEADERS });
    if (!res.ok) return null;
    return (await res.json()) as AuthUserRow;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const uniq = <T,>(a: T[]): T[] => [...new Set(a)];
const CANCELLED = new Set(['cancelled', 'canceled', 'void', 'voided']);

/** Nombres de escuela en un solo viaje, para no hacer N+1 en cada bloque. */
async function resolveSchoolNames(ids: string[]): Promise<Record<string, string>> {
    const clean = uniq(ids.filter(Boolean));
    if (!clean.length) return {};
    const { data } = await supabase.from('schools').select('id, name').in('id', clean);
    const map: Record<string, string> = {};
    (data || []).forEach((s: any) => { map[s.id] = s.name; });
    return map;
}

/**
 * Correos parecidos: la causa de bloqueo que ningún reset arregla.
 * Se busca por la parte local del correo (antes de la @) para pillar tanto
 * el typo de dominio (gmial.com) como el alias (+admin).
 */
async function findSimilarEmails(email: string, exactUserEmail: string | null): Promise<UserStateAccess['similarEmails']> {
    const local = email.split('@')[0];
    // Un stem demasiado corto trae media base; con <4 caracteres no vale la pena.
    if (local.length < 4) return [];
    const stem = local.slice(0, Math.max(4, Math.floor(local.length * 0.7)));
    const out: UserStateAccess['similarEmails'] = [];

    const [profs, invs, kids] = await Promise.all([
        supabase.from('profiles').select('email, full_name').ilike('email', `${stem}%`).limit(10),
        supabase.from('invitations').select('email, status').ilike('email', `${stem}%`).limit(10),
        supabase.from('children').select('parent_email_temp, full_name').ilike('parent_email_temp', `${stem}%`).limit(10),
    ]);

    for (const p of (profs.data || []) as any[]) {
        if (p.email && p.email.toLowerCase() !== email && p.email.toLowerCase() !== exactUserEmail) {
            out.push({ source: 'profiles', email: p.email, label: p.full_name ?? null });
        }
    }
    for (const i of (invs.data || []) as any[]) {
        if (i.email && i.email.toLowerCase() !== email && i.email.toLowerCase() !== exactUserEmail) {
            out.push({ source: 'invitations', email: i.email, label: i.status ?? null });
        }
    }
    for (const k of (kids.data || []) as any[]) {
        const e = k.parent_email_temp;
        if (e && e.toLowerCase() !== email && e.toLowerCase() !== exactUserEmail) {
            out.push({ source: 'children', email: e, label: k.full_name ?? null });
        }
    }
    return out;
}

// ─── Entrada principal ────────────────────────────────────────────────────────

export interface BuildUserStateParams {
    email?: string | null;
    userId?: string | null;
    /**
     * 'admin' → todos los bloques (consola del super_admin).
     * 'self'  → el usuario preguntando por sí mismo (tool `get_my_state` del bot).
     *           Se omiten las señales de otras identidades: no tiene por qué ver
     *           correos parecidos de terceros ni cuentas ajenas.
     */
    scope?: 'admin' | 'self';
}

export async function buildUserState(params: BuildUserStateParams): Promise<UserState> {
    const email = (params.email || '').trim().toLowerCase() || null;
    const scope = params.scope ?? 'admin';
    let userId = (params.userId || '').trim() || null;

    // ── Bloque A: acceso ──────────────────────────────────────────────────────
    let authUser: AuthUserRow | null = null;
    let otherAuth: AuthUserRow[] = [];

    if (userId) {
        authUser = await findAuthUserById(userId);
    }
    if (!authUser && email) {
        const hits = await findAuthUsersByEmail(email);
        // El `filter` del Admin API es un LIKE: preferimos la coincidencia exacta.
        authUser = hits.find(u => (u.email || '').toLowerCase() === email) || hits[0] || null;
        otherAuth = hits.filter(u => u.id !== authUser?.id);
    }
    if (authUser) userId = authUser.id;

    const access: UserStateAccess = {
        found: !!authUser,
        userId: authUser?.id ?? null,
        email: authUser?.email ?? email,
        emailConfirmedAt: authUser?.email_confirmed_at ?? null,
        lastSignInAt: authUser?.last_sign_in_at ?? null,
        bannedUntil: authUser?.banned_until ?? null,
        providers: uniq((authUser?.identities || []).map(i => i.provider)),
        recoverySentAt: authUser?.recovery_sent_at ?? null,
        createdAt: authUser?.created_at ?? null,
        otherAuthAccounts: scope === 'admin'
            ? otherAuth.map(u => ({ id: u.id, email: u.email, lastSignInAt: u.last_sign_in_at }))
            : [],
        similarEmails: [],
    };

    if (scope === 'admin' && email) {
        access.similarEmails = await findSimilarEmails(email, (authUser?.email || '').toLowerCase() || null);
    }

    // ── Bloque B: pertenencia ─────────────────────────────────────────────────
    // OJO: en `profiles` la columna es `document_number`; en `unregistered_athletes`
    // y `children` es `doc_number`. No son la misma y confundirlas devuelve 400.
    const PROFILE_COLS = 'id, full_name, email, phone, role, document_number, date_of_birth';
    const profileQuery = userId
        ? supabase.from('profiles').select(PROFILE_COLS).eq('id', userId).maybeSingle()
        : email
        ? supabase.from('profiles').select(PROFILE_COLS).ilike('email', email).maybeSingle()
        : null;

    const profileRow: any = profileQuery ? (await profileQuery).data : null;
    const profileId: string | null = profileRow?.id ?? userId ?? null;

    const [membersRes, enrByUserRes, invRes, uaRes, kidsRes] = await Promise.all([
        profileId
            ? supabase.from('school_members').select('id, school_id, role, status, joined_at').eq('profile_id', profileId)
            : Promise.resolve({ data: [] as any[] }),
        profileId
            ? supabase.from('enrollments').select('id, school_id, user_id, child_id, unregistered_athlete_id, team_id, monthly_fee, status, created_at').eq('user_id', profileId)
            : Promise.resolve({ data: [] as any[] }),
        email
            ? supabase.from('invitations').select('id, school_id, email, status, role_to_assign, child_name, monthly_fee, created_at, expires_at').ilike('email', email).order('created_at', { ascending: false })
            : Promise.resolve({ data: [] as any[] }),
        // Registro precargado por la escuela: la mitad "no registrada" de un duplicado.
        buildUnregisteredQuery(email, profileId, profileRow),
        // Menores: por el correo temporal del acudiente o por parent_id.
        buildChildrenQuery(email, profileId),
    ]);

    const unregistered = (uaRes as any).data || [];
    const children = (kidsRes as any).data || [];

    // Inscripciones de las OTRAS dos superficies de sujeto (menor / precargado).
    // Van aparte porque PostgREST no acepta `.in()` sobre columnas distintas en
    // una sola llamada sin construir un `or=` a mano.
    const uaIds = unregistered.map((u: any) => u.id);
    const kidIds = children.map((k: any) => k.id);
    const [enrByUaRes, enrByKidRes] = await Promise.all([
        uaIds.length
            ? supabase.from('enrollments').select('id, school_id, user_id, child_id, unregistered_athlete_id, team_id, monthly_fee, status, created_at').in('unregistered_athlete_id', uaIds)
            : Promise.resolve({ data: [] as any[] }),
        kidIds.length
            ? supabase.from('enrollments').select('id, school_id, user_id, child_id, unregistered_athlete_id, team_id, monthly_fee, status, created_at').in('child_id', kidIds)
            : Promise.resolve({ data: [] as any[] }),
    ]);

    const allEnrollments: any[] = [
        ...((enrByUserRes as any).data || []),
        ...((enrByUaRes as any).data || []),
        ...((enrByKidRes as any).data || []),
    ];

    const members: any[] = (membersRes as any).data || [];
    const invitations: any[] = (invRes as any).data || [];

    const schoolAthletesRes = profileId
        ? await supabase
              .from('school_athletes')
              .select('id, school_id, full_name, user_id, team_id, is_active, enrollment_status, price_monthly')
              .eq('user_id', profileId)
        : { data: [] as any[] };
    const schoolAthletes: any[] = (schoolAthletesRes as any).data || [];

    const schoolNames = await resolveSchoolNames([
        ...members.map(m => m.school_id),
        ...allEnrollments.map(e => e.school_id),
        ...invitations.map(i => i.school_id),
    ]);

    const membership: UserStateMembership = {
        profile: profileRow
            ? {
                  id: profileRow.id,
                  fullName: profileRow.full_name ?? null,
                  email: profileRow.email ?? null,
                  phone: profileRow.phone ?? null,
                  role: profileRow.role ?? null,
                  docNumber: profileRow.document_number ?? null,
                  dateOfBirth: profileRow.date_of_birth ?? null,
              }
            : null,
        schoolMembers: members.map(m => ({
            id: m.id,
            schoolId: m.school_id,
            schoolName: schoolNames[m.school_id] ?? null,
            role: m.role,
            status: m.status,
            joinedAt: m.joined_at ?? null,
        })),
        enrollments: allEnrollments.map(e => ({
            id: e.id,
            schoolId: e.school_id,
            schoolName: schoolNames[e.school_id] ?? null,
            subject: e.user_id ? 'adulto' : e.child_id ? 'menor' : e.unregistered_athlete_id ? 'precargado' : 'sin sujeto',
            teamId: e.team_id ?? null,
            monthlyFee: e.monthly_fee ?? null,
            status: e.status,
            createdAt: e.created_at ?? null,
        })),
        invitations: invitations.map(i => ({
            id: i.id,
            schoolId: i.school_id,
            schoolName: schoolNames[i.school_id] ?? null,
            email: i.email,
            status: i.status,
            roleToAssign: i.role_to_assign ?? null,
            childName: i.child_name ?? null,
            monthlyFee: i.monthly_fee ?? null,
            createdAt: i.created_at ?? null,
            expiresAt: i.expires_at ?? null,
        })),
        schoolAthletes: schoolAthletes.map(s => ({
            id: s.id,
            schoolId: s.school_id,
            fullName: s.full_name ?? null,
            isActive: s.is_active ?? null,
            enrollmentStatus: s.enrollment_status ?? null,
            teamId: s.team_id ?? null,
            priceMonthly: s.price_monthly ?? null,
        })),
    };

    // ── Bloque C: duplicidad ──────────────────────────────────────────────────
    const payments = await fetchPayments(profileId, uaIds, kidIds);

    const byPeriod: Record<string, any[]> = {};
    for (const p of payments) {
        if (CANCELLED.has(String(p.status))) continue;
        const key = `${p.school_id}|${String(p.due_date || '').slice(0, 7)}|${p.amount}`;
        (byPeriod[key] ||= []).push(p);
    }
    const duplicatePaymentGroups = Object.entries(byPeriod)
        .filter(([, rows]) => rows.length > 1)
        .map(([key, rows]) => {
            const [schoolId, period, amount] = key.split('|');
            return { schoolId, period, amount: Number(amount), paymentIds: rows.map(r => r.id) };
        });

    const duplicity: UserStateDuplicity = {
        unregisteredAthletes: unregistered.map((u: any) => ({
            id: u.id,
            schoolId: u.school_id,
            fullName: u.full_name ?? null,
            docNumber: u.doc_number ?? null,
            isActive: u.is_active ?? null,
            linkedProfileId: u.linked_profile_id ?? null,
        })),
        children: children.map((k: any) => ({
            id: k.id,
            fullName: k.full_name ?? null,
            parentId: k.parent_id ?? null,
            parentEmailTemp: k.parent_email_temp ?? null,
            docNumber: k.doc_number ?? null,
            schoolId: k.school_id ?? null,
        })),
        activeEnrollmentCount: allEnrollments.filter(e => e.status === 'active').length,
        repeatedEnrollmentGroups: (() => {
            const groups: Record<string, number> = {};
            for (const e of allEnrollments) {
                if (e.status !== 'active') continue;
                const subject = e.user_id || e.child_id || e.unregistered_athlete_id || e.id;
                const key = `${subject}|${e.school_id}|${e.team_id ?? ''}`;
                groups[key] = (groups[key] || 0) + 1;
            }
            return Object.values(groups).filter(n => n > 1).length;
        })(),
        duplicatePaymentGroups,
        paymentsWithoutPayer: payments.filter(
            p => !p.parent_id && p.child_id && ['pending', 'overdue'].includes(String(p.status)),
        ).length,
    };

    // ── Bloque D: veredicto ───────────────────────────────────────────────────
    return {
        query: { email, userId: params.userId?.trim() || null },
        access,
        membership,
        duplicity,
        verdict: buildVerdict(access, membership, duplicity),
        generatedAt: new Date().toISOString(),
    };
}

// ─── Consultas auxiliares ─────────────────────────────────────────────────────

function buildUnregisteredQuery(email: string | null, profileId: string | null, profileRow: any) {
    // Rastreo por documento / teléfono / correo — nunca por nombre.
    const filters: string[] = [];
    if (email) filters.push(`email.ilike.${email}`);
    if (profileId) filters.push(`linked_profile_id.eq.${profileId}`);
    // profiles.document_number ↔ unregistered_athletes.doc_number
    if (profileRow?.document_number) filters.push(`doc_number.eq.${profileRow.document_number}`);
    if (profileRow?.phone) {
        const tail = String(profileRow.phone).replace(/\D/g, '').slice(-10);
        if (tail.length >= 7) filters.push(`phone.ilike.*${tail}*`);
    }
    if (!filters.length) return Promise.resolve({ data: [] as any[] });

    return supabase
        .from('unregistered_athletes')
        .select('id, school_id, full_name, doc_number, email, phone, is_active, linked_profile_id')
        .or(filters.join(','));
}

function buildChildrenQuery(email: string | null, profileId: string | null) {
    const filters: string[] = [];
    if (email) filters.push(`parent_email_temp.ilike.${email}`);
    if (profileId) filters.push(`parent_id.eq.${profileId}`);
    if (!filters.length) return Promise.resolve({ data: [] as any[] });

    return supabase
        .from('children')
        .select('id, full_name, parent_id, parent_email_temp, doc_number, school_id')
        .or(filters.join(','));
}

async function fetchPayments(profileId: string | null, uaIds: string[], kidIds: string[]): Promise<any[]> {
    const cols = 'id, school_id, user_id, child_id, unregistered_athlete_id, status, amount, due_date, parent_id';
    const queries = [
        profileId ? supabase.from('payments').select(cols).eq('user_id', profileId) : null,
        uaIds.length ? supabase.from('payments').select(cols).in('unregistered_athlete_id', uaIds) : null,
        kidIds.length ? supabase.from('payments').select(cols).in('child_id', kidIds) : null,
    ].filter(Boolean) as any[];

    if (!queries.length) return [];
    const results = await Promise.all(queries);

    // Un mismo cobro puede llegar por dos rutas (user_id + child_id): deduplicar
    // por id o el detector de duplicados se dispara solo.
    const seen = new Set<string>();
    const out: any[] = [];
    for (const r of results) {
        for (const p of (r.data || [])) {
            if (seen.has(p.id)) continue;
            seen.add(p.id);
            out.push(p);
        }
    }
    return out;
}

// ─── Bloque D: el veredicto en una línea ──────────────────────────────────────
//
// El orden importa: se responde primero lo que BLOQUEA el acceso, y solo después
// lo que ensucia los datos. En el incidente que originó la spec el veredicto
// correcto era "no hagas nada, ya está adentro" — y eso es lo que debe salir
// cuando no hay ningún bloqueo real.

function buildVerdict(
    access: UserStateAccess,
    membership: UserStateMembership,
    duplicity: UserStateDuplicity,
): UserStateVerdict {
    const findings: string[] = [];

    if (!access.found) {
        return {
            level: 'error',
            headline: '❌ No existe cuenta de acceso con ese correo',
            findings: access.similarEmails.length
                ? [`Hay ${access.similarEmails.length} correo(s) parecido(s) en la base — puede ser un typo al registrarse.`]
                : ['No hay usuario en auth con ese correo ni con ese id.'],
            recommendedAction: access.similarEmails.length ? 'revisar_correo_similar' : 'ninguna',
        };
    }

    // ── Bloqueos duros de acceso ──
    if (access.bannedUntil && new Date(access.bannedUntil).getTime() > Date.now()) {
        findings.push(`Cuenta bloqueada administrativamente hasta ${access.bannedUntil}.`);
        return { level: 'error', headline: '❌ Cuenta bloqueada', findings, recommendedAction: 'ninguna' };
    }

    if (!access.emailConfirmedAt) {
        findings.push('El correo nunca se confirmó: el login lo rechaza aunque la contraseña sea correcta.');
        if (access.providers.includes('google')) {
            findings.push('Tiene proveedor Google: entrar con "Continuar con Google" también destraba la cuenta.');
        }
        return { level: 'error', headline: '❌ Correo sin confirmar', findings, recommendedAction: 'confirmar_correo' };
    }

    // ── Señales de identidad partida ──
    const orphanUnregistered = duplicity.unregisteredAthletes.filter(u => u.isActive && !u.linkedProfileId);
    const splitIdentity = orphanUnregistered.length > 0 && !!membership.profile;
    const activeSchoolAthletesBySchool: Record<string, number> = {};
    for (const s of membership.schoolAthletes) {
        if (s.isActive) activeSchoolAthletesBySchool[s.schoolId] = (activeSchoolAthletesBySchool[s.schoolId] || 0) + 1;
    }
    const duplicatedInView = Object.values(activeSchoolAthletesBySchool).some(n => n > 1);

    if (splitIdentity || duplicatedInView || duplicity.repeatedEnrollmentGroups > 0) {
        if (splitIdentity) {
            findings.push(`${orphanUnregistered.length} registro(s) precargado(s) activo(s) y sin vincular, existiendo ya un perfil: la misma persona está dos veces y ambas son facturables.`);
        }
        if (duplicity.repeatedEnrollmentGroups > 0) {
            findings.push(`${duplicity.repeatedEnrollmentGroups} inscripción(es) activa(s) repetida(s) en la misma escuela y el mismo equipo — cada una genera cobro.`);
        }
        if (duplicatedInView) {
            findings.push('La vista school_athletes lo trae más de una vez en la misma escuela.');
        }
        if (duplicity.duplicatePaymentGroups.length) {
            findings.push(`${duplicity.duplicatePaymentGroups.length} grupo(s) de cobros con mismo mes, monto y escuela.`);
        }
        findings.push('Sobrevive siempre la identidad adulta: es la única que puede entrar, pagar y recibir avisos.');
        return { level: 'warn', headline: '⚠️ Identidad partida en dos', findings, recommendedAction: 'fusionar_identidades' };
    }

    // ── Invitación consumida sin membresía real ──
    const acceptedInvites = membership.invitations.filter(i => i.status === 'accepted');
    const hasMembership = membership.schoolMembers.some(m => m.status === 'active') || membership.enrollments.some(e => e.status === 'active');

    if (acceptedInvites.length && !hasMembership) {
        findings.push('Hay invitación en estado accepted pero ninguna membresía ni inscripción activa.');
        findings.push('Reusar ese enlace NO sirve: accept_invitation_pro hace RETURN true sin hacer nada cuando la invitación ya está accepted.');
        return { level: 'error', headline: '❌ Invitación consumida sin quedar inscrito', findings, recommendedAction: 'revincular_escuela' };
    }

    // ── Señales blandas ──
    if (duplicity.paymentsWithoutPayer > 0) {
        findings.push(`${duplicity.paymentsWithoutPayer} cobro(s) de menor sin parent_id: el acudiente verá "No tienes permiso para pagar".`);
    }
    if (duplicity.duplicatePaymentGroups.length) {
        findings.push(`${duplicity.duplicatePaymentGroups.length} grupo(s) de cobros con mismo mes, monto y escuela.`);
    }
    if (access.otherAuthAccounts.length) {
        findings.push(`Existen ${access.otherAuthAccounts.length} cuenta(s) de auth más con correo parecido: puede estar entrando a la equivocada.`);
    }
    if (access.similarEmails.length) {
        findings.push(`${access.similarEmails.length} correo(s) parecido(s) en profiles/invitations/children.`);
    }

    if (duplicity.paymentsWithoutPayer > 0 || duplicity.duplicatePaymentGroups.length) {
        return { level: 'warn', headline: '⚠️ Puede entrar, pero sus cobros tienen problemas', findings, recommendedAction: 'revisar_cobros' };
    }

    if (!hasMembership) {
        findings.push('La cuenta funciona pero no está inscrita en ninguna escuela.');
        return { level: 'warn', headline: '⚠️ Puede entrar pero no está inscrito', findings, recommendedAction: 'ninguna' };
    }

    // ── Todo bien ──
    if (access.lastSignInAt) {
        findings.push(`Último ingreso: ${access.lastSignInAt}. La contraseña sirve; no hay nada que restablecer.`);
    } else {
        findings.push('Nunca ha iniciado sesión: la cuenta está lista pero la persona no ha entrado todavía.');
        if (access.providers.includes('google')) {
            findings.push('Tiene Google vinculado: pedirle una contraseña es un callejón sin salida, debe usar "Continuar con Google".');
        }
    }
    const school = membership.schoolMembers.find(m => m.status === 'active')?.schoolName
        ?? membership.enrollments.find(e => e.status === 'active')?.schoolName;
    if (school) findings.push(`Inscripción activa en ${school}.`);

    return {
        level: 'ok',
        headline: '✅ Puede entrar y está inscrito',
        findings,
        recommendedAction: access.lastSignInAt ? 'ninguna' : 'reenviar_enlace',
    };
}
