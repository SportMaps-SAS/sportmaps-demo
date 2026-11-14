/**
 * Datos del Inicio del acudiente (V2). Solo lecturas que ya hacen las pantallas
 * del acudiente, sin endpoints nuevos:
 *  - Hijos: `children` por `parent_id` (como MyChildrenPage), con su equipo
 *    (inscripción activa primero, si no `children.team_id`), profe y horario
 *    (`teams.schedule`, el mismo que lee el bot y HorariosDeEntrenamiento).
 *  - Cobros: `payments` en pending/overdue/partial (= `debe_pagarse`). Los ve el
 *    PAGADOR: los suyos por `parent_id` y, de sus hijos, solo los que no tienen
 *    pagador. Un cobro de mi hijo que paga otro acudiente no es mío.
 *  - Frase del profe: último informe mensual publicado (`athlete_reports`, RLS
 *    athlete_reports_select_family), `coach_note` o la nota del equipo.
 *
 * Si falla la lectura de hijos o de cobros, la query falla entera: la pantalla
 * muestra error, NUNCA «todo al día» (UX-2). El informe es opcional: si falla,
 * la tarjeta sale sin frase.
 */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { calcEarlyPaymentDiscount, modoProntoPago } from '@/lib/earlyPaymentDiscount';
import { isOneTimeCategory } from '@/lib/payment-accounts';
import { ESTADOS_QUE_SE_DEBEN, fotoDeVerdad, leerFranjas, type Cobro, type Hijo } from './parentHomeLogic';

export interface ParentHomeData {
  hijos: Hijo[];
  cobros: Cobro[];
}

type CoachRow = { full_name: string | null };
type TeamRow = {
  name: string | null;
  schedule: unknown;
  location: string | null;
  coach: CoachRow | CoachRow[] | null;
};
type ChildRow = {
  id: string;
  full_name: string | null;
  avatar_url: string | null;
  eps_name: string | null;
  schools: { name: string | null } | { name: string | null }[] | null;
  teams: TeamRow | TeamRow[] | null;
  enrollments: { status: string | null; created_at: string | null; teams: TeamRow | TeamRow[] | null }[] | null;
};
type InformeRow = {
  subject_id: string;
  coach_note: string | null;
  team_notes: { body?: string | null }[] | null;
};
type Resultado<T> = { data: T | null; error: unknown };

const uno = <T,>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? v[0] ?? null : v ?? null);

export const parentHomeQueryKey = (userId: string | undefined) => ['parent-home-v2', userId];

// Tablas/joins fuera del types.ts generado (athlete_reports, alias de joins):
// se leen sin tipar y se validan con los tipos de arriba.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const desde = (tabla: string) => (supabase as any).from(tabla);

/**
 * Pronto pago, con la misma regla que Pagos (MyPaymentsPage): solo mensualidad,
 * dentro de la ventana de la escuela y sin un cobro anterior sin pagar del mismo
 * hijo; si la base ya lo congeló, manda ese valor. Si la configuración no carga,
 * no se descuenta nada (se muestra el valor completo, nunca de menos).
 */
async function aplicarProntoPago(cobros: Cobro[]): Promise<void> {
  const escuelas = [...new Set(cobros.map((c) => c.school_id).filter(Boolean))] as string[];
  if (escuelas.length === 0) return;
  const { data } = (await desde('school_settings')
    .select('school_id, early_payment_discount_enabled, early_payment_discount_days, early_payment_discount_percentage, early_payment_discount_mode')
    .in('school_id', escuelas)) as Resultado<{
      school_id: string; early_payment_discount_enabled: boolean | null;
      early_payment_discount_days: number | null; early_payment_discount_percentage: number | null; early_payment_discount_mode?: string | null;
    }[]>;
  const config = new Map((data ?? []).map((s) => [s.school_id, {
    enabled: !!s.early_payment_discount_enabled,
    days: s.early_payment_discount_days || 5,
    percentage: s.early_payment_discount_percentage || 0,
    mode: modoProntoPago(s.early_payment_discount_mode),
  }]));
  const sinPagar = cobros.filter((c) => ['pending', 'overdue', 'partial'].includes(c.status));
  for (const c of cobros) {
    const cfg = isOneTimeCategory(c.payment_category) || !c.school_id
      ? { enabled: false, days: 5, percentage: 0 }
      : config.get(c.school_id) ?? { enabled: false, days: 5, percentage: 0 };
    const quien = c.child_id ?? c.parent_id;
    const anterior = sinPagar.some((o) => o.school_id === c.school_id && (o.child_id ?? o.parent_id) === quien
      && !!o.created_at && !!c.created_at && o.created_at < c.created_at);
    c.pronto_pago = calcEarlyPaymentDiscount(Number(c.amount || 0), {
      createdAt: c.created_at ?? new Date().toISOString(),
      config: cfg,
      hasEarlierUnpaid: anterior,
      alreadyAppliedAmount: c.early_payment_discount_applied ?? null,
    }).discountAmount;
  }
}

export async function cargarInicioAcudiente(userId: string): Promise<ParentHomeData> {
  const { data: rows, error: childrenError } = (await desde('children')
    .select(`
      id, full_name, avatar_url, eps_name,
      schools!children_school_id_fkey(name),
      teams!team_id(name, schedule, location, coach:coach_id(full_name)),
      enrollments(
        status, created_at,
        teams!enrollments_team_id_fkey(name, schedule, location, coach:coach_id(full_name))
      )
    `)
    .eq('parent_id', userId)
    .order('created_at', { ascending: true })) as Resultado<ChildRow[]>;
  if (childrenError) throw childrenError;

  // Dedupe por id (los JOIN a teams por dos caminos pueden repetir filas).
  const vistos = new Set<string>();
  const childRows = (rows ?? []).filter((c) => (vistos.has(c.id) ? false : (vistos.add(c.id), true)));
  const childIds = childRows.map((c) => c.id);

  const cobrosQuery = desde('payments')
    .select('id, amount, amount_paid, status, child_id, parent_id, due_date, period_year, period_month, concept, payment_category, school_id, created_at, early_payment_discount_applied')
    .in('status', [...ESTADOS_QUE_SE_DEBEN])
    .order('due_date', { ascending: true });
  const { data: cobros, error: cobrosError } = (await (childIds.length > 0
    // Mismo criterio que Pagos (MyPaymentsPage) y que la RLS «Payments: select parent»:
    // lo que pago yo + todo cobro de mis hijos. Si Inicio usara otro, podría decir
    // «Todo al día» mientras Pagos muestra deuda.
    ? cobrosQuery.or(`parent_id.eq.${userId},child_id.in.(${childIds.join(',')})`)
    : cobrosQuery.eq('parent_id', userId))) as Resultado<Cobro[]>;
  if (cobrosError) throw cobrosError;
  await aplicarProntoPago(cobros ?? []);

  // Frase del profe: opcional.
  const frasePorHijo = new Map<string, string>();
  if (childIds.length > 0) {
    try {
      const { data: informes, error } = (await desde('athlete_reports')
        .select('subject_id, period_year, period_month, coach_note:snapshot->>coach_note, team_notes:snapshot->team_notes')
        .eq('subject_type', 'child')
        .in('subject_id', childIds)
        .eq('status', 'publicado')
        .order('period_year', { ascending: false })
        .order('period_month', { ascending: false })) as Resultado<InformeRow[]>;
      if (!error) {
        for (const r of informes ?? []) {
          if (frasePorHijo.has(r.subject_id)) continue;
          const notaEquipo = Array.isArray(r.team_notes) ? r.team_notes.find((n) => n?.body?.trim())?.body : null;
          const frase = (r.coach_note && String(r.coach_note).trim()) || (notaEquipo && String(notaEquipo).trim()) || '';
          // Solo el informe más reciente cuenta: si no trae frase, no se busca una vieja.
          frasePorHijo.set(r.subject_id, frase);
        }
      }
    } catch {
      /* sin informe no hay frase; la tarjeta sale igual */
    }
  }

  const hijos: Hijo[] = childRows.map((c) => {
    const inscripcionActiva = (c.enrollments ?? [])
      .filter((e) => e.status === 'active' && uno(e.teams))
      .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')))[0];
    const team = inscripcionActiva ? uno(inscripcionActiva.teams) : uno(c.teams);
    const coach = uno(team?.coach ?? null);
    return {
      id: c.id,
      nombre: c.full_name ?? '',
      avatarUrl: fotoDeVerdad(c.avatar_url),
      equipo: team?.name ?? null,
      profe: coach?.full_name ?? null,
      lugar: team?.location ?? null,
      franjas: leerFranjas(team?.schedule),
      eps: c.eps_name ?? null,
      fraseProfe: frasePorHijo.get(c.id) || null,
      escuela: uno(c.schools)?.name ?? null,
    };
  });

  return { hijos, cobros: cobros ?? [] };
}

export function useParentHomeData(userId: string | undefined) {
  return useQuery({
    queryKey: parentHomeQueryKey(userId),
    queryFn: () => cargarInicioAcudiente(userId!),
    enabled: !!userId,
  });
}
