/**
 * Clase de prueba — configuración única por canal y prospectos de la pestaña
 * «Clase de prueba» de Deportistas (mig. 20261026155701).
 *
 * Los prospectos viven en `school_signup_leads` (WhatsApp, formulario y
 * registro rápido en la escuela); no son deportistas hasta completar el alta.
 * Los cupos del bot son `school_trial_slots` (RPC de 20260825151250).
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { faltaEnLaBase } from '@/lib/esquemaPendiente';

export interface ConfigClasePrueba {
  enabled: boolean;
  presencial_enabled: boolean;
  whatsapp_enabled: boolean;
  self_service_enabled: boolean;
  cupos_desde_entrenamientos: boolean;
  indicaciones: string | null;
  slug: string | null;
  es_admin: boolean;
}

export type CanalProspecto = 'presencial' | 'whatsapp' | 'formulario';

export interface ProspectoClasePrueba {
  id: string;
  full_name: string;
  guardian_name: string | null;
  phone: string;
  email: string | null;
  gender: string | null;
  birth_date: string | null;
  notes: string | null;
  status: 'new' | 'contacted';
  created_at: string;
  canal: CanalProspecto | string;
  asistencia: 'asistio' | 'no_vino' | null;
  fecha_clase: string | null;
  cupo_label: string | null;
  cupo_hora: string | null;
  // Embudo del bot (mig. embudo_y_agenda_clase_prueba: `listar_clase_prueba` solo
  // AGREGA estas claves). Opcionales: sin la migración no llegan y la fila se ve
  // como siempre. Ver ProspectoDetalleEmbudo.
  /** Sede elegida en el chat (school_branches.name). */
  sede?: string | null;
  /** Grupo de la franja (teams.name). */
  grupo?: string | null;
  /** Profe del grupo. */
  profe?: string | null;
  /** Respuestas del embudo (posición, trayectoria y su detalle…). */
  respuestas?: Record<string, unknown> | null;
  /** 'separado' = eligió horario y falta el comprobante; 'agendada' = clase confirmada. */
  estado_cupo?: 'separado' | 'agendada' | null;
  /** Hasta cuándo se le guarda el cupo separado. */
  separado_hasta?: string | null;
  /** Franja del cupo separado (la agendada sigue en fecha_clase / cupo_hora). */
  separado_fecha?: string | null;
  separado_hora?: string | null;
  separado_label?: string | null;
  sede_id?: string | null;
  grupo_id?: string | null;
  /** Pago de la clase (payments.signup_lead_id). `awaiting_approval` = comprobante en revisión. */
  pago?: { monto?: number | null; estado?: string | null; metodo?: string | null; fecha?: string | null } | null;
}

export interface CupoClasePrueba {
  id: string;
  team_id: string | null;
  label: string;
  slot_date: string;
  start_time: string;
  end_time: string | null;
  location: string | null;
  max_capacity: number;
  reserved_count: number;
  is_open: boolean;
}

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await (supabase as any).rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}

export function useConfigClasePrueba(schoolId: string | null | undefined) {
  const qc = useQueryClient();
  const key = ['clase-prueba-config', schoolId];

  const query = useQuery({
    queryKey: key,
    enabled: !!schoolId,
    queryFn: () => rpc<ConfigClasePrueba>('obtener_config_clase_prueba', { p_school_id: schoolId }),
  });

  const guardar = useMutation({
    mutationFn: (cambios: Partial<Pick<ConfigClasePrueba,
      'enabled' | 'presencial_enabled' | 'whatsapp_enabled' | 'cupos_desde_entrenamientos' | 'indicaciones'>>) =>
      rpc<ConfigClasePrueba>('guardar_config_clase_prueba', {
        p_school_id: schoolId,
        p_enabled: cambios.enabled ?? null,
        p_presencial_enabled: cambios.presencial_enabled ?? null,
        p_whatsapp_enabled: cambios.whatsapp_enabled ?? null,
        p_cupos_desde_entrenamientos: cambios.cupos_desde_entrenamientos ?? null,
        p_indicaciones: cambios.indicaciones ?? null,
      }),
    onSuccess: (data) => {
      qc.setQueryData(key, data);
      // El switch general también lo lee la config de Instalaciones.
      qc.invalidateQueries({ queryKey: ['trial-class-settings'] });
    },
  });

  return { config: query.data, isLoading: query.isLoading, guardar };
}

export function useProspectosClasePrueba(schoolId: string | null | undefined) {
  const qc = useQueryClient();
  const key = ['clase-prueba-prospectos', schoolId];
  const refrescar = () => qc.invalidateQueries({ queryKey: key });

  const query = useQuery({
    queryKey: key,
    enabled: !!schoolId,
    queryFn: () => rpc<ProspectoClasePrueba[]>('listar_clase_prueba', { p_school_id: schoolId }),
  });

  const registrar = useMutation({
    mutationFn: (p: { acudiente: string; telefono: string; nombres: string[]; esAdulto: boolean }) =>
      rpc<{ ok: boolean; creados: number; actualizados: number }>('registrar_clase_prueba_rapida', {
        p_school_id: schoolId,
        p_acudiente: p.acudiente,
        p_telefono: p.telefono,
        p_nombres: p.nombres,
        p_es_adulto: p.esAdulto,
      }),
    onSuccess: refrescar,
  });

  const cerrar = useMutation({
    mutationFn: (p: { leadId: string; estado: 'converted' | 'discarded'; childId?: string | null; userId?: string | null; unregisteredId?: string | null }) =>
      rpc('cerrar_prospecto_clase_prueba', {
        p_lead_id: p.leadId,
        p_estado: p.estado,
        p_child_id: p.childId ?? null,
        p_user_id: p.userId ?? null,
        p_unregistered_id: p.unregisteredId ?? null,
      }),
    onSuccess: refrescar,
  });

  return { prospectos: query.data ?? [], isLoading: query.isLoading, error: query.error as Error | null, registrar, cerrar };
}

export function useCuposClasePrueba(schoolId: string | null | undefined, enabled = true) {
  const qc = useQueryClient();
  const key = ['clase-prueba-cupos', schoolId];
  const refrescar = () => qc.invalidateQueries({ queryKey: key });

  const query = useQuery({
    queryKey: key,
    enabled: !!schoolId && enabled,
    queryFn: () => rpc<CupoClasePrueba[]>('list_school_trial_slots', { p_school_id: schoolId }),
  });

  const crear = useMutation({
    mutationFn: (c: { label: string; fecha: string; inicio: string; fin: string | null; lugar: string | null; capacidad: number }) =>
      rpc('create_school_trial_slot', {
        p_school_id: schoolId,
        p_label: c.label,
        p_slot_date: c.fecha,
        p_start_time: c.inicio,
        p_end_time: c.fin,
        p_location: c.lugar,
        p_max_capacity: c.capacidad,
        p_team_id: null,
      }),
    onSuccess: refrescar,
  });

  const cerrar = useMutation({
    mutationFn: (slotId: string) => rpc('cerrar_cupo_clase_prueba', { p_slot_id: slotId }),
    onSuccess: refrescar,
  });

  return { cupos: query.data ?? [], isLoading: query.isLoading, crear, cerrar };
}

// ── Agenda de la clase de prueba del bot (mig. embudo_y_agenda_clase_prueba) ──

/**
 * Cómo agenda el bot la clase de prueba. Columnas nuevas de
 * `school_trial_class_settings`; todas en NULL/false = el comportamiento de hoy.
 *  · nombre_clase: cómo la llama el bot («clase de prueba» o «clase de cortesía»; NULL = cortesía).
 *  · dias_semana: días con clase de prueba, 0 = domingo … 6 = sábado (igual que teams.schedule). NULL = todos.
 *  · separar_horas: horas que se guarda el cupo mientras llega el comprobante (1–72). NULL = el bot no separa cupos.
 *  · cupos_por_sesion: cupos de clase de prueba por entreno (1–500). NULL = sin límite.
 *  · avisar_entrenador: aviso al profe del grupo cuando se agenda.
 */
export interface AgendaClasePrueba {
  nombre_clase: 'cortesia' | 'prueba' | null;
  dias_semana: number[] | null;
  separar_horas: number | null;
  cupos_por_sesion: number | null;
  avisar_entrenador: boolean;
}

export const AGENDA_POR_DEFECTO: AgendaClasePrueba = {
  nombre_clase: null, dias_semana: null, separar_horas: null, cupos_por_sesion: null, avisar_entrenador: false,
};

const entero = (v: unknown, min: number, max: number): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
};

/** Fila de la base → agenda (lo que no se entiende queda como hoy). */
export function leerAgenda(raw: unknown): AgendaClasePrueba {
  if (!raw || typeof raw !== 'object') return AGENDA_POR_DEFECTO;
  const r = raw as Record<string, unknown>;
  const dias = Array.isArray(r.dias_semana)
    ? [...new Set((r.dias_semana as unknown[]).map((d) => entero(d, 0, 6)).filter((d): d is number => d != null))].sort((a, b) => a - b)
    : null;
  return {
    nombre_clase: r.nombre_clase === 'prueba' || r.nombre_clase === 'cortesia' ? r.nombre_clase : null,
    dias_semana: dias && dias.length > 0 && dias.length < 7 ? dias : null,
    separar_horas: entero(r.separar_horas, 1, 72),
    cupos_por_sesion: entero(r.cupos_por_sesion, 1, 500),
    avisar_entrenador: r.avisar_entrenador === true,
  };
}

/**
 * Lee la agenda con la RLS (la tabla solo tiene policy de SELECT, para la
 * administración) y la guarda con la RPC `guardar_ajustes_clase_prueba(p_school_id,
 * p_ajustes jsonb)` (mig. 20261030123543), que cambia solo las claves que llegan.
 * Se mandan las cinco y NULL significa «como hoy» (todos los días, sin separar,
 * sin límite). Sin las columnas, `disponible` es false y la pantalla no muestra
 * la sección; sin la RPC, el guardado dice «todavía no está activa».
 */
export function useAgendaClasePrueba(schoolId: string | null | undefined, enabled = true) {
  const qc = useQueryClient();
  const key = ['clase-prueba-agenda', schoolId];

  const query = useQuery({
    queryKey: key,
    enabled: !!schoolId && enabled,
    queryFn: async (): Promise<{ disponible: boolean; agenda: AgendaClasePrueba }> => {
      const { data, error, status } = await (supabase as any)
        .from('school_trial_class_settings')
        .select('nombre_clase, dias_semana, separar_horas, cupos_por_sesion, avisar_entrenador')
        .eq('school_id', schoolId)
        .maybeSingle();
      if (error) {
        if (faltaEnLaBase(error, status)) return { disponible: false, agenda: AGENDA_POR_DEFECTO };
        throw new Error(error.message);
      }
      return { disponible: true, agenda: leerAgenda(data) };
    },
  });

  const guardar = useMutation({
    mutationFn: async (a: AgendaClasePrueba) => {
      const { error, status } = await (supabase as any).rpc('guardar_ajustes_clase_prueba', {
        p_school_id: schoolId,
        p_ajustes: {
          nombre_clase: a.nombre_clase,
          dias_semana: a.dias_semana,
          separar_horas: a.separar_horas,
          cupos_por_sesion: a.cupos_por_sesion,
          avisar_entrenador: a.avisar_entrenador,
        },
      });
      if (error) {
        if (faltaEnLaBase(error, status)) throw new Error('Esta opción todavía no está activa.');
        if (error.code === '42501') throw new Error('Solo la administración de la escuela cambia esto.');
        throw new Error('No se pudo guardar. Revisa los datos e inténtalo otra vez.');
      }
      return a;
    },
    onSuccess: (a) => qc.setQueryData(key, { disponible: true, agenda: a }),
  });

  return {
    disponible: query.data?.disponible === true,
    agenda: query.data?.agenda ?? AGENDA_POR_DEFECTO,
    isLoading: query.isLoading,
    guardar,
  };
}
