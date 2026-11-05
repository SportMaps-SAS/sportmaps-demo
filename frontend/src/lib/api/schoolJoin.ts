/**
 * Llamadas del «Código de escuela» (migración 20261026132948).
 * `(supabase.rpc as any)`: los types no se regeneran con esta migración.
 * Todas van con el JWT del usuario: la autorización vive en cada RPC.
 */
import { supabase } from '@/integrations/supabase/client';
import { bffClient } from '@/lib/api/bffClient';
import type { ForWhom, JoinRequestRow } from '@/lib/schoolJoinCode';

const rpc = (fn: string, args?: Record<string, unknown>) => (supabase.rpc as any)(fn, args);

async function call<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await rpc(fn, args);
  if (error) throw new Error(error.message || 'Error inesperado');
  return data as T;
}

export interface JoinCodePreview {
  ok: boolean;
  reason?: 'not_found' | 'rate_limited';
  message?: string;
  code?: string;
  school_id?: string;
  school_name?: string;
  logo_url?: string | null;
  city?: string | null;
  already_member?: boolean;
  pending_requests?: number;
}

export interface SubmitJoinResult {
  ok: boolean;
  reason?: 'not_found' | 'rate_limited';
  message?: string;
  request_id?: string;
  school_name?: string;
}

/** Candidato de ficha precargada (migración 20261105124322). Sin datos de contacto. */
export interface FichaCandidata {
  ficha_id: string;
  source: 'unregistered_athlete' | 'children';
  tipo: 'menor' | 'adulto';
  nombre: string;
  team_name: string | null;
  email_match: boolean;
  puede_reclamar: boolean;
}

export interface ReclamarFichaResult {
  ok: boolean;
  school_id: string;
  school_name: string;
  kind: 'child' | 'self';
  child_id: string | null;
  athlete_name: string;
}

export interface MyJoinStatus {
  has_school: boolean;
  requests: Array<{
    id: string;
    status: JoinRequestRow['status'];
    for_whom: ForWhom;
    athlete_name: string;
    created_at: string;
    resolved_at: string | null;
    reject_reason: string | null;
    school_name: string;
    logo_url: string | null;
    team_name: string | null;
  }>;
}

export interface ResolveResult {
  request_id: string;
  status: 'assigned' | 'linked' | 'rejected';
  for_whom?: ForWhom;
  school_id: string;
  child_id?: string | null;
  user_id?: string | null;
  team_id?: string | null;
  branch_id?: string | null;
  athlete_name?: string;
  needs_enrollment: boolean;
}

export interface SchoolJoinCodeInfo {
  code: string;
  uses_count: number;
  created_at: string;
}

export const schoolJoinApi = {
  preview: (code: string) => call<JoinCodePreview>('preview_school_join_code', { p_code: code }),

  submit: (p: { code: string; forWhom: ForWhom; name: string; birthDate: string; category: string | null }) =>
    call<SubmitJoinResult>('submit_school_join_request', {
      p_code: p.code,
      p_for_whom: p.forWhom,
      p_name: p.name,
      p_birth_date: p.birthDate,
      p_category: p.category,
    }),

  /** Busca la ficha que la escuela ya cargó: por documento y/o por el correo confirmado de la cuenta. */
  buscarFicha: (code: string, doc: string | null) =>
    call<FichaCandidata[]>('buscar_ficha_por_codigo', { p_code: code, p_doc: doc }),

  /** Adopta la ficha. Menor: documento o correo del acudiente. Adulto: solo correo igual al de la ficha. */
  reclamarFicha: (p: { code: string; fichaId: string; source: FichaCandidata['source']; doc: string | null }) =>
    call<ReclamarFichaResult>('reclamar_ficha_por_codigo', {
      p_code: p.code, p_ficha_id: p.fichaId, p_source: p.source, p_doc: p.doc,
    }),

  cancel: (requestId: string) => call<unknown>('cancel_school_join_request', { p_request_id: requestId }),

  myStatus: () => call<MyJoinStatus>('my_school_join_status'),

  list: (schoolId: string) =>
    call<JoinRequestRow[]>('list_school_join_requests', { p_school_id: schoolId, p_include_resolved: false }),

  resolve: (p: {
    requestId: string;
    action: 'assign' | 'link' | 'reject';
    teamId?: string | null;
    branchId?: string | null;
    childId?: string | null;
    reason?: string | null;
  }) =>
    call<ResolveResult>('resolve_school_join_request', {
      p_request_id: p.requestId,
      p_action: p.action,
      p_team_id: p.teamId ?? null,
      p_branch_id: p.branchId ?? null,
      p_child_id: p.childId ?? null,
      p_reason: p.reason ?? null,
    }),

  confirmEnrollment: (requestId: string) =>
    call<{ request_id: string; enrollment_id: string | null }>('confirm_school_join_request_enrollment', {
      p_request_id: requestId,
    }),

  getCode: (schoolId: string) => call<SchoolJoinCodeInfo>('get_school_join_code', { p_school_id: schoolId }),

  rotateCode: (schoolId: string) => call<SchoolJoinCodeInfo>('rotate_school_join_code', { p_school_id: schoolId }),

  /** El MISMO alta de «Agregar atleta» (BFF → create_enrollment_with_payments). */
  enrollViaCreateOne: (schoolId: string, payload: Record<string, unknown>) =>
    bffClient.post('/api/v1/students/create-one', payload, { 'x-school-id': schoolId }),
};
