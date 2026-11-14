/**
 * Cobro de la clase de prueba (mig. 20261029215003).
 *
 * El pago queda en `payments` amarrado al prospecto (`signup_lead_id`,
 * categoría `clase_prueba`): cuenta como ingreso, no da vigencia ni mora. Al
 * completar el alta del prospecto pasa solo al estado de cuenta del deportista.
 * El valor lo pone la escuela en Clase de prueba → Configurar.
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export type MetodoPagoClasePrueba = 'cash' | 'transfer' | 'card' | 'other';

export const METODOS_PAGO_CLASE_PRUEBA: { value: MetodoPagoClasePrueba; label: string }[] = [
  { value: 'cash', label: 'Efectivo' },
  { value: 'transfer', label: 'Transferencia' },
  { value: 'card', label: 'Tarjeta' },
  { value: 'other', label: 'Otro' },
];

export interface PagoClasePrueba {
  id: string;
  monto: number;
  metodo: MetodoPagoClasePrueba | string;
  fecha: string | null;
  estado: string;
}

export interface CobroClasePrueba {
  id: string;
  full_name: string;
  guardian_name: string | null;
  phone: string | null;
  status: 'new' | 'contacted' | 'converted' | 'discarded';
  created_at: string;
  canal: string;
  asistencia: 'asistio' | 'no_vino' | null;
  fecha_clase: string | null;
  pago: PagoClasePrueba | null;
}

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await (supabase as any).rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}

const keyCobros = (schoolId: string | null | undefined) => ['clase-prueba-cobros', schoolId];
const keyValor = (schoolId: string | null | undefined) => ['clase-prueba-valor', schoolId];

export function useCobrosClasePrueba(schoolId: string | null | undefined, enabled = true) {
  const qc = useQueryClient();

  const query = useQuery({
    queryKey: keyCobros(schoolId),
    enabled: !!schoolId && enabled,
    queryFn: () => rpc<{ valor: number | null; prospectos: CobroClasePrueba[] }>(
      'listar_cobros_clase_prueba', { p_school_id: schoolId }),
  });

  const registrar = useMutation({
    mutationFn: (p: { leadId: string; monto: number; metodo: MetodoPagoClasePrueba; referencia?: string | null }) =>
      rpc<{ ok: boolean; payment_id: string }>('registrar_pago_clase_prueba', {
        p_lead_id: p.leadId,
        p_monto: p.monto,
        p_metodo: p.metodo,
        p_referencia: p.referencia?.trim() || null,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keyCobros(schoolId) }),
  });

  return {
    valor: query.data?.valor ?? null,
    prospectos: query.data?.prospectos ?? [],
    isLoading: query.isLoading,
    error: query.error as Error | null,
    registrar,
  };
}

/** Valor de la clase de prueba (solo admin: la policy de la tabla es de admin). */
export function useValorClasePrueba(schoolId: string | null | undefined, enabled = true) {
  const qc = useQueryClient();

  const query = useQuery({
    queryKey: keyValor(schoolId),
    enabled: !!schoolId && enabled,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from('school_trial_class_settings')
        .select('trial_price')
        .eq('school_id', schoolId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return (data?.trial_price ?? null) as number | null;
    },
  });

  const guardar = useMutation({
    mutationFn: (valor: number | null) =>
      rpc<{ ok: boolean; valor: number | null }>('guardar_valor_clase_prueba', {
        p_school_id: schoolId,
        p_valor: valor,
      }),
    onSuccess: (r) => {
      qc.setQueryData(keyValor(schoolId), r.valor ?? null);
      qc.invalidateQueries({ queryKey: keyCobros(schoolId) });
    },
  });

  return { valor: query.data ?? null, isLoading: query.isLoading, guardar };
}
