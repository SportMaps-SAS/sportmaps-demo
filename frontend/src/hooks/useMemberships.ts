import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useSchoolContext } from '@/hooks/useSchoolContext';
import { toast } from '@/hooks/use-toast';

// ============================================================================
// Membresías del club (CAR-4)
//
// Membresías que el socio paga EN EL CLUB, no por SportMaps. Acá no hay montos
// ni cartera: es un hecho declarado que la escuela registra a mano, por CSV, y
// más adelante por API.
//
// ── Lo que hay que entender antes de tocar esto ─────────────────────────────
// `status` es la fuente de verdad y NO se deriva de `valid_until`. La fecha no
// vence sola a propósito: el dato viene del sistema del club y puede llegar
// rezagado, así que un vencimiento automático crea «suspendidos fantasma» —
// socios al día a los que la app les niega el acceso porque el archivo llegó
// tarde. Por eso la RPC devuelve `fecha_vencida` por separado: sirve para
// AVISAR que hay que revisar el dato, no para decidir.
//
// ── El cruce con el listado de atletas ──────────────────────────────────────
// Verificado contra la base: `school_athletes.id` ES el id del sujeto en los
// tres casos —children.id para un menor, profiles.id para un adulto,
// unregistered_athletes.id para uno sin cuenta—, así que alcanza una sola llave
// para cruzar. Lo que cambia por tipo es a CUÁL columna se escribe.
// ============================================================================

export type EstadoMembresia = 'active' | 'expired' | 'suspended';
export type TipoAtleta = 'child' | 'adult' | 'unregistered';

export interface Membresia {
    id: string;
    sujeto_tipo: 'usuario' | 'menor' | 'sin_cuenta';
    sujeto_id: string;
    nombre: string | null;
    documento: string | null;
    status: EstadoMembresia;
    valid_from: string | null;
    valid_until: string | null;
    /** `valid_until` ya pasó. Informativo: no cambia `status`. */
    fecha_vencida: boolean;
    source: 'manual' | 'import' | 'api';
    external_ref: string | null;
    notes: string | null;
    updated_at: string;
}

export interface GuardarMembresia {
    sujetoId: string;
    tipoAtleta: TipoAtleta;
    status: EstadoMembresia;
    validFrom?: string | null;
    validUntil?: string | null;
    source?: 'manual' | 'import' | 'api';
    externalRef?: string | null;
    notes?: string | null;
}

/** A qué columna del sujeto le corresponde cada tipo de atleta. */
function columnaDelSujeto(tipo: TipoAtleta, id: string) {
    if (tipo === 'adult') return { p_user_id: id, p_child_id: null, p_unregistered_athlete_id: null };
    if (tipo === 'child') return { p_user_id: null, p_child_id: id, p_unregistered_athlete_id: null };
    return { p_user_id: null, p_child_id: null, p_unregistered_athlete_id: id };
}

export function useMemberships(schoolIdOverride?: string | null) {
    const { schoolId: schoolIdCtx } = useSchoolContext();
    const schoolId = schoolIdOverride ?? schoolIdCtx;
    const qc = useQueryClient();
    const key = ['memberships', schoolId];

    const query = useQuery({
        queryKey: key,
        queryFn: async (): Promise<Membresia[]> => {
            const { data, error } = await supabase.rpc('school_memberships_listado' as any, {
                p_school_id: schoolId,
            });
            if (error) throw error;
            return (data ?? []) as Membresia[];
        },
        enabled: !!schoolId,
        staleTime: 2 * 60 * 1000,
    });

    const guardar = useMutation({
        mutationFn: async (v: GuardarMembresia) => {
            const { data, error } = await supabase.rpc('school_set_membership' as any, {
                p_school_id: schoolId,
                p_status: v.status,
                ...columnaDelSujeto(v.tipoAtleta, v.sujetoId),
                p_valid_from: v.validFrom ?? null,
                p_valid_until: v.validUntil ?? null,
                p_source: v.source ?? 'manual',
                p_external_ref: v.externalRef ?? null,
                p_notes: v.notes ?? null,
            });
            if (error) throw error;
            return data;
        },
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: key });
            toast({ title: 'Membresía guardada' });
        },
        onError: (e: any) => {
            toast({
                title: 'No se pudo guardar la membresía',
                // El mensaje de la RPC es específico y accionable («ese menor no
                // pertenece a esta escuela», «indicá exactamente UN sujeto»): se
                // muestra tal cual en vez de un genérico.
                description: e?.message ?? 'Error desconocido',
                variant: 'destructive',
            });
        },
    });

    /**
     * Guarda muchas de una pasada, para la carga por CSV. Se hace en serie y no
     * con Promise.all: son upserts sobre la misma tabla y una ráfaga en paralelo
     * solo se pelea consigo misma por los índices únicos. Devuelve el detalle
     * fila por fila para poder mostrar qué entró y qué no.
     */
    const guardarLote = useMutation({
        mutationFn: async (filas: GuardarMembresia[]) => {
            const resultado: { fila: number; ok: boolean; error?: string }[] = [];
            for (let i = 0; i < filas.length; i++) {
                const v = filas[i];
                const { error } = await supabase.rpc('school_set_membership' as any, {
                    p_school_id: schoolId,
                    p_status: v.status,
                    ...columnaDelSujeto(v.tipoAtleta, v.sujetoId),
                    p_valid_from: v.validFrom ?? null,
                    p_valid_until: v.validUntil ?? null,
                    p_source: v.source ?? 'import',
                    p_external_ref: v.externalRef ?? null,
                    p_notes: v.notes ?? null,
                });
                resultado.push({ fila: i + 1, ok: !error, error: error?.message });
            }
            return resultado;
        },
        onSuccess: (resultado) => {
            qc.invalidateQueries({ queryKey: key });
            const ok = resultado.filter((r) => r.ok).length;
            const fallaron = resultado.length - ok;
            toast({
                title: `${ok} membresía(s) cargada(s)`,
                description: fallaron > 0 ? `${fallaron} no se pudieron cargar. Revisa el detalle.` : undefined,
                variant: fallaron > 0 ? 'destructive' : undefined,
            });
        },
    });

    const membresias = query.data ?? [];

    /** Por `sujeto_id`, que es el `id` del listado de atletas. */
    const porSujeto = new Map(membresias.map((m) => [m.sujeto_id, m]));

    return {
        membresias,
        porSujeto,
        activas: membresias.filter((m) => m.status === 'active').length,
        /** Declaradas activas pero con la fecha ya pasada: hay que revisar el dato. */
        aRevisar: membresias.filter((m) => m.status === 'active' && m.fecha_vencida),
        guardar,
        guardarLote,
        isLoading: query.isLoading,
        error: query.error as Error | null,
    };
}
