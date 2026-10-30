/**
 * Datos de «Mi semana» del profe (pestaña Semana de Sesiones V2).
 *
 *  · Ajustes: `team_schedule_exceptions` directo con la RLS (lee cualquier
 *    miembro de la escuela; escribe la administración o el coach de ESE equipo,
 *    helper `puede_editar_semana_equipo`). Insert / update / delete.
 *  · «Repetir los ajustes de la semana pasada»: RPC `repetir_semana_equipo`
 *    (transaccional, una por equipo).
 *  · Clases de prueba de la semana: RPC `clases_prueba_semana` (el coach ve solo
 *    las de sus equipos; sin teléfono) y `marcar_clase_prueba_entrenador`.
 *  · Después de cada cambio, POST fire-and-forget al BFF para que los cupos de
 *    clase de prueba del bot sigan la semana del profe
 *    (`/:schoolId/cortesias/sincronizar-franjas`, solo corre si la escuela
 *    tiene cupos desde los entrenamientos).
 *
 * Si la migración todavía no está aplicada (tabla o RPC inexistente),
 * `disponible` / `clasesDisponibles` quedan en false y la pantalla se ve como
 * siempre: sin botones de ajuste ni clases de prueba. Nunca muestra ese error.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { bffClient } from '@/lib/api/bffClient';
import { useAuth } from '@/contexts/AuthContext';
import { useSchoolContext } from '@/hooks/useSchoolContext';
import { faltaEnLaBase, faltaLaColumna } from '@/lib/esquemaPendiente';
import { sumarDias } from '../asistenciaModel';
import {
  errorDeAccion, filaDeAccion, leerAjustes, leerClasesPruebaSemana, mensajeDeError, planRepetir,
  type AccionAjuste, type AjusteSemana, type ClasePruebaSemana,
} from './semanaAjustesModel';

/* eslint-disable @typescript-eslint/no-explicit-any -- tabla y RPC nuevas, todavía fuera de types.ts */

/** `error` viene cuando ok es false (sin `strict` no hay narrowing por el literal). */
export interface ResultadoAccion { ok: boolean; error?: string }
export interface ResultadoRepetir extends ResultadoAccion { copiadas?: number }

export const CLAVE_AJUSTES = 'semana-ajustes';

/**
 * `team_schedule_exceptions.motivo` no está en la migración 20261030123543: el
 * primer intento con motivo falla (PGRST204), se guarda sin él y no se vuelve a
 * mandar en la sesión. Si la columna se agrega después, el motivo se guarda solo.
 */
let sinColumnaMotivo = false;
export function _olvidarColumnaMotivo() { sinColumnaMotivo = false; }
export const CLAVE_CLASES = 'semana-clases-prueba';

export function useSemanaAjustes({ teamIds, lunes }: { teamIds: string[]; lunes: string }) {
  const { user } = useAuth();
  const { schoolId } = useSchoolContext();
  const qc = useQueryClient();
  const [guardando, setGuardando] = useState(false);
  // La semana anterior también: «Repetir» necesita saber qué hubo.
  const desde = sumarDias(lunes, -7);
  const hasta = sumarDias(lunes, 6);

  const ajustesQ = useQuery({
    queryKey: [CLAVE_AJUSTES, schoolId, teamIds.join(','), desde, hasta],
    enabled: !!schoolId && teamIds.length > 0,
    staleTime: 60_000,
    queryFn: async (): Promise<{ disponible: boolean; ajustes: AjusteSemana[] }> => {
      const { data, error, status } = await (supabase as any)
        .from('team_schedule_exceptions')
        .select('*')
        .in('team_id', teamIds)
        .gte('fecha', desde)
        .lte('fecha', hasta)
        .limit(500);
      if (error) {
        if (faltaEnLaBase(error, status)) return { disponible: false, ajustes: [] };
        throw new Error(error.message);
      }
      return { disponible: true, ajustes: leerAjustes(data) };
    },
  });

  const clasesQ = useQuery({
    queryKey: [CLAVE_CLASES, schoolId, lunes],
    enabled: !!schoolId && teamIds.length > 0,
    staleTime: 60_000,
    queryFn: async (): Promise<{ disponible: boolean; clases: ClasePruebaSemana[] }> => {
      const { data, error, status } = await (supabase as any).rpc('clases_prueba_semana', {
        p_school_id: schoolId, p_desde: lunes, p_hasta: sumarDias(lunes, 6),
      });
      if (error) {
        // Sin la RPC o sin permiso: no hay chips de clase de prueba, y ya.
        if (faltaEnLaBase(error, status) || error.code === '42501') return { disponible: false, clases: [] };
        throw new Error(error.message);
      }
      const mios = new Set(teamIds);
      return { disponible: true, clases: leerClasesPruebaSemana(data).filter((c) => !!c.teamId && mios.has(c.teamId)) };
    },
  });

  // Equipos de la escuela para «Grupo recomendado» (solo si hay clases de prueba).
  const hayClases = (clasesQ.data?.clases.length ?? 0) > 0;
  const equiposEscuelaQ = useQuery({
    queryKey: ['semana-equipos-escuela', schoolId],
    enabled: !!schoolId && hayClases,
    staleTime: 10 * 60_000,
    queryFn: async (): Promise<{ id: string; name: string }[]> => {
      const { data, error } = await (supabase as any).from('teams').select('id, name').eq('school_id', schoolId).order('name');
      if (error) return [];
      return (data ?? []) as { id: string; name: string }[];
    },
  });

  /** Los cupos de clase de prueba del bot siguen la semana del profe. No espera ni avisa. */
  const sincronizar = (teamId: string) => {
    if (!schoolId) return;
    void bffClient.post(`/api/v1/whatsapp/${schoolId}/cortesias/sincronizar-franjas`, { teamId }).catch(() => undefined);
  };

  const refrescar = () => qc.invalidateQueries({ queryKey: [CLAVE_AJUSTES] });

  async function aplicar(accion: AccionAjuste): Promise<ResultadoAccion> {
    const err = errorDeAccion(accion);
    if (err) return { ok: false, error: err };
    if (!schoolId || !user?.id) return { ok: false, error: 'No hay sesión activa.' };
    setGuardando(true);
    try {
      let error: any = null;
      let data: unknown[] | null = null;
      if (accion.tipo === 'deshacer') {
        ({ data, error } = await (supabase as any).from('team_schedule_exceptions').delete().in('id', accion.ajusteIds).select('id'));
      } else {
        const fila = filaDeAccion(accion, { schoolId, userId: user.id });
        if (sinColumnaMotivo) delete fila.motivo;
        const ajusteId = accion.tipo === 'cancelar' ? undefined : accion.ajusteId;
        const escribir = (f: typeof fila) => (ajusteId
          ? (supabase as any).from('team_schedule_exceptions')
            .update({ hora_inicio: f.hora_inicio, hora_fin: f.hora_fin, lugar: f.lugar, updated_at: new Date().toISOString() })
            .eq('id', ajusteId)
          : (supabase as any).from('team_schedule_exceptions').insert(f)
        ).select('id');
        ({ data, error } = await escribir(fila));
        // `motivo` es opcional: si la base todavía no tiene la columna, se guarda sin él.
        if (error && fila.motivo && faltaLaColumna(error, 'motivo')) {
          sinColumnaMotivo = true;
          const sinMotivo = { ...fila };
          delete sinMotivo.motivo;
          ({ data, error } = await escribir(sinMotivo));
        }
      }
      if (error) return { ok: false, error: mensajeDeError(error) };
      // La RLS no da error en un UPDATE/DELETE que no le toca: devuelve 0 filas.
      if (!data || data.length === 0) return { ok: false, error: mensajeDeError({ code: '42501' }) };
      await refrescar();
      sincronizar(accion.teamId);
      return { ok: true };
    } catch {
      return { ok: false, error: mensajeDeError(null) };
    } finally {
      setGuardando(false);
    }
  }

  const ajustes = ajustesQ.data?.ajustes ?? [];
  const repetirPlan = planRepetir(ajustes, lunes, teamIds);

  /** Copia los ajustes de la semana pasada a esta (una RPC por equipo). */
  async function repetir(): Promise<ResultadoRepetir> {
    const equipos = [...repetirPlan.porEquipo.keys()];
    if (equipos.length === 0) return { ok: true, copiadas: 0 };
    setGuardando(true);
    try {
      const res = await Promise.all(equipos.map((teamId) =>
        (supabase as any).rpc('repetir_semana_equipo', { p_team_id: teamId, p_lunes: lunes })));
      const conError = res.find((r: any) => r.error);
      if (conError) {
        if (faltaEnLaBase(conError.error, conError.status)) return { ok: false, error: 'Esta opción todavía no está activa.' };
        return { ok: false, error: mensajeDeError(conError.error) };
      }
      const copiadas = res.reduce((n: number, r: any) => n + (Number(r.data?.copiadas) || 0), 0);
      await refrescar();
      equipos.forEach(sincronizar);
      return { ok: true, copiadas };
    } catch {
      return { ok: false, error: mensajeDeError(null) };
    } finally {
      setGuardando(false);
    }
  }

  /** [Asistió] / [No vino] y «Grupo recomendado» de una clase de prueba. */
  async function marcar(p: { leadId: string; asistencia: 'asistio' | 'no_vino' | null; teamRecomendado?: string | null }): Promise<ResultadoAccion> {
    setGuardando(true);
    try {
      const { error } = await (supabase as any).rpc('marcar_clase_prueba_entrenador', {
        p_lead_id: p.leadId, p_asistencia: p.asistencia, p_team_recomendado: p.teamRecomendado ?? null,
      });
      if (error) {
        if (faltaEnLaBase(error)) return { ok: false, error: 'Esta opción todavía no está activa.' };
        const msg = String(error.message ?? '');
        if (error.code === '42501') return { ok: false, error: 'Esta clase de prueba no es de tus equipos.' };
        if (msg.includes('SIN_CLASE_AGENDADA')) return { ok: false, error: 'La clase todavía no está confirmada (falta el pago).' };
        if (msg.includes('PROSPECTO_DESCARTADO')) return { ok: false, error: 'La escuela ya descartó a este interesado.' };
        if (msg.includes('EQUIPO_INVALIDO')) return { ok: false, error: 'Ese grupo no es de esta escuela.' };
        return { ok: false, error: mensajeDeError(error) };
      }
      await qc.invalidateQueries({ queryKey: [CLAVE_CLASES] });
      return { ok: true };
    } catch {
      return { ok: false, error: mensajeDeError(null) };
    } finally {
      setGuardando(false);
    }
  }

  return {
    /** false = la tabla no existe todavía: la pestaña se ve como siempre. */
    disponible: ajustesQ.data?.disponible === true,
    ajustes,
    repetirPlan,
    clases: clasesQ.data?.clases ?? [],
    clasesDisponibles: clasesQ.data?.disponible === true,
    equiposEscuela: equiposEscuelaQ.data ?? [],
    guardando,
    aplicar,
    repetir,
    marcar,
  };
}
