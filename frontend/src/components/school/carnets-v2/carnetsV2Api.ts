/**
 * Lecturas y escrituras de la pantalla V2 «Carnets, constancias y QR».
 * Mismas RPCs que las pantallas V1 (SchoolCardsAdminPage, SchoolCertificatesAdminPage,
 * SchoolJoinQRsPage); aquí solo se juntan para no repetirlas en cada sección.
 */
import { supabase } from '@/integrations/supabase/client';
import { bffClient } from '@/lib/api/bffClient';
import { fraseFaltantes } from '@/lib/constancias';
import type { CardData } from '@/components/cards/AthleteIdCard';
import type { CarnetEmitido, DeportistaCarnet } from '@/lib/cards/carnetsV2Model';

const CHUNK = 500;

export interface Equipo { id: string; name: string }

export interface ResumenCarnets {
  conCarnet: number;
  total: number;
  sinCarnet: number;
  noEmitibles: number;
  equipos: Equipo[];
}

/** Cobertura y catálogo de equipos (una sola llamada liviana, p_limit 1). */
export async function cargarResumenCarnets(schoolId: string): Promise<ResumenCarnets> {
  const { data, error } = await supabase.rpc('list_school_athletes_for_card_issue_v2' as any, {
    p_school_id: schoolId, p_search: null, p_team_id: null, p_branch_id: null,
    p_card_filter: 'all', p_limit: 1, p_offset: 0,
  });
  if (error) throw error;
  const d = data as any;
  return {
    conCarnet: Number(d?.with_card ?? 0),
    total: Number(d?.total_scope ?? 0),
    sinCarnet: Number(d?.without_card ?? 0),
    noEmitibles: Number(d?.not_issuable ?? 0),
    equipos: (d?.teams ?? []) as Equipo[],
  };
}

/** Todos los deportistas de un equipo (o de la escuela si teamId es null). */
export async function cargarDeportistas(
  schoolId: string,
  teamId: string | null,
  filtro: 'all' | 'with' | 'without' = 'all',
): Promise<DeportistaCarnet[]> {
  const out: DeportistaCarnet[] = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await supabase.rpc('list_school_athletes_for_card_issue_v2' as any, {
      p_school_id: schoolId, p_search: null, p_team_id: teamId, p_branch_id: null,
      p_card_filter: filtro, p_limit: CHUNK, p_offset: offset,
    });
    if (error) throw error;
    const rows = ((data as any)?.rows ?? []) as DeportistaCarnet[];
    out.push(...rows);
    const total = Number((data as any)?.total ?? 0);
    offset += CHUNK;
    if (out.length >= total || rows.length === 0) break;
  }
  return out;
}

/** Agrega el código SM-… (columna `codigo`, la RPC del listado aún no lo trae). */
async function conCodigos(rows: CarnetEmitido[]): Promise<CarnetEmitido[]> {
  if (rows.length === 0) return rows;
  const { data, error } = await (supabase.from('athlete_id_cards' as any) as any)
    .select('id, codigo')
    .in('id', rows.map((r) => r.id));
  if (error || !data) return rows;
  const porId = new Map<string, string | null>((data as { id: string; codigo: string | null }[]).map((r) => [r.id, r.codigo]));
  return rows.map((r) => ({ ...r, codigo: porId.get(r.id) ?? r.codigo ?? null }));
}

export async function cargarEmitidos(
  schoolId: string,
  opts: { search: string | null; offset: number; limit: number },
): Promise<{ rows: CarnetEmitido[]; total: number }> {
  const { data, error } = await supabase.rpc('list_athlete_id_cards' as any, {
    p_school_id: schoolId, p_status: null, p_search: opts.search, p_limit: opts.limit, p_offset: opts.offset,
  });
  if (error) throw error;
  const rows = ((data as any)?.rows ?? []) as CarnetEmitido[];
  return { rows: await conCodigos(rows), total: Number((data as any)?.total ?? 0) };
}

export async function cargarCarnetsVigentes(schoolId: string): Promise<CarnetEmitido[]> {
  const out: CarnetEmitido[] = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await supabase.rpc('list_athlete_id_cards' as any, {
      p_school_id: schoolId, p_status: 'active', p_search: null, p_limit: CHUNK, p_offset: offset,
    });
    if (error) throw error;
    const rows = ((data as any)?.rows ?? []) as CarnetEmitido[];
    out.push(...rows);
    const total = Number((data as any)?.total ?? 0);
    offset += CHUNK;
    if (out.length >= total || rows.length === 0) break;
  }
  return out;
}

/** Datos completos de cada carnet para el PDF clásico (de a 6 en paralelo, como V1). */
export async function cargarDatosParaPdf(
  carnets: CarnetEmitido[],
  onEach?: () => void,
): Promise<{ data: CardData; token: string }[]> {
  const out: ({ data: CardData; token: string } | null)[] = new Array(carnets.length).fill(null);
  let next = 0;
  async function worker() {
    while (next < carnets.length) {
      const i = next++;
      const { data } = await supabase.rpc('verify_athlete_id_card_public' as any, { p_qr_token: carnets[i].qr_token });
      if (data && (data as CardData).found && (data as CardData).status === 'active') {
        out[i] = { data: data as CardData, token: carnets[i].qr_token };
      }
      onEach?.();
    }
  }
  await Promise.all(Array.from({ length: Math.min(6, carnets.length) }, worker));
  return out.filter((x): x is { data: CardData; token: string } => !!x);
}

export interface PlantillaCarnet { id: string; name: string; is_default: boolean; show_fields: Record<string, boolean> | null }

export async function cargarPlantillasCarnet(schoolId: string): Promise<PlantillaCarnet[]> {
  const { data, error } = await supabase
    .from('athlete_id_card_templates')
    .select('id, name, is_default, show_fields')
    .eq('school_id', schoolId)
    .eq('active', true)
    .order('is_default', { ascending: false });
  if (error) throw error;
  return ((data as any[]) ?? []) as PlantillaCarnet[];
}

/**
 * Guarda los «Datos que salen en el carnet» en la plantilla predeterminada.
 * Sin plantilla, crea una predeterminada que solo fija los campos: el diseño
 * queda en los valores por defecto de la tabla (diseño base).
 */
export async function guardarCamposCarnet(
  schoolId: string,
  plantillaId: string | null,
  campos: Record<string, boolean>,
): Promise<void> {
  if (plantillaId) {
    const { error } = await supabase.from('athlete_id_card_templates').update({ show_fields: campos } as any).eq('id', plantillaId);
    if (error) throw error;
    return;
  }
  const { error } = await supabase.from('athlete_id_card_templates').insert({
    school_id: schoolId, name: 'Predeterminada', show_fields: campos, is_default: true, active: true,
  } as any);
  if (error) throw error;
}

// ─── Constancias ──────────────────────────────────────────────────────────

export interface ConstanciaFila {
  id: string;
  folio: string;
  kind: string;
  title: string;
  status: string;
  athlete_name: string;
  template_name: string;
  requested_by_name: string | null;
  created_by_school: boolean;
  created_at: string;
}

export async function cargarPorAprobar(schoolId: string): Promise<{ rows: ConstanciaFila[]; total: number }> {
  const { data, error } = await supabase.rpc('list_athlete_certificates' as any, {
    p_school_id: schoolId, p_status: 'pending_review', p_kind: null, p_search: null, p_limit: 20, p_offset: 0,
  });
  if (error) throw error;
  const d = data as any;
  return { rows: (d?.rows ?? []) as ConstanciaFila[], total: Number(d?.counts?.pending_review ?? d?.total ?? 0) };
}

export interface PlantillaConstancia { id: string; name: string; kind: string; is_default: boolean }

export async function cargarPlantillasConstancia(schoolId: string): Promise<PlantillaConstancia[]> {
  const { data, error } = await supabase
    .from('school_certificate_templates' as any)
    .select('id, name, kind, is_default')
    .eq('school_id', schoolId)
    .eq('active', true)
    .order('is_default', { ascending: false })
    .order('name');
  if (error) throw error;
  return ((data as any[]) ?? []) as PlantillaConstancia[];
}

/** Genera el PDF de una constancia (BFF) y devuelve el aviso de datos faltantes. */
export async function generarPdfConstancia(id: string): Promise<string> {
  const res = await bffClient.post<any>(`/api/v1/certificates/${id}/generate-pdf`, { actualizar_datos: false });
  if (!res?.ok) throw new Error(res?.error || 'pdf_failed');
  const faltan = fraseFaltantes(res.faltantes);
  const firma = res.firma_omitida ? ' La imagen de la firma no se pudo usar; revísala en la plantilla.' : '';
  return `${faltan ? `${faltan} Complétalos en la ficha del deportista.` : ''}${firma}`.trim();
}

// ─── QR de inscripción ────────────────────────────────────────────────────

export interface QrInscripcion {
  id: string;
  slug: string;
  name: string;
  target_type: string;
  active: boolean;
  scan_count: number;
  signup_count: number;
}

export async function cargarQrs(schoolId: string): Promise<QrInscripcion[]> {
  const { data, error } = await supabase.rpc('list_school_join_qrs' as any, {
    p_school_id: schoolId, p_active: null, p_search: null,
  });
  if (error) throw error;
  return ((data as any[]) ?? []) as QrInscripcion[];
}
