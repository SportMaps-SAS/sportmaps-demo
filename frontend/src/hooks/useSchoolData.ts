import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useSchoolContext } from '@/hooks/useSchoolContext';
import { useToast } from '@/hooks/use-toast';
import { bffClient } from '@/lib/api/bffClient';
import { camposUbicacion, type UbicacionCancha } from '@/components/school/canchaUbicacion';

// Types for staff and facilities
interface Staff {
  id: string;
  school_id: string;
  full_name: string;
  email: string;
  phone: string | null;
  /** @deprecated usar `sports` — se mantiene sincronizado con sports[0] desde el BFF. */
  specialty: string | null;
  sports: string[] | null;
  /** 1=Principiante, 2=Intermedio, 3=Avanzado, 4=Elite/Alto rendimiento. */
  taught_levels: number[] | null;
  branch_id: string | null;
  certifications: string[] | null;
  status: string;
  created_at: string;
  updated_at: string;
}

interface Facility {
  id: string;
  school_id: string;
  name: string;
  type: string;
  capacity: number;
  description: string | null;
  min_booking_advance_hours: number | null;
  min_cancellation_hours: number | null;
  /** Cómo llegar (mig. embudo_y_agenda_clase_prueba); no llegan sin la migración. */
  address?: string | null;
  maps_url?: string | null;
  indicaciones?: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

interface StaffInput {
  full_name: string;
  email: string;
  phone?: string;
  sports?: string[];
  taught_levels?: number[];
  branch_id?: string | null;
  certifications?: string[];
  status?: string;
  /** Solo en creación: dispara la invitación de acceso (no se manda al BFF). */
  send_invitation?: boolean;
}

interface FacilityInput extends UbicacionCancha {
  name: string;
  type: string;
  capacity: number;
  description?: string;
  min_booking_advance_hours?: number;
  min_cancellation_hours?: number;
}

export function useSchoolStaff() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { schoolId } = useSchoolContext();

  // Fetch staff
  const { data: staff, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: ['school-staff', schoolId],
    queryFn: async () => {
      const res = await bffClient.get<Staff[]>('/api/v1/school-staff');
      return res;
    },
    enabled: !!schoolId,
  });
  
  // Create staff
  //
  // Contratar son dos cosas distintas: la fila en school_staff (registro interno)
  // y la invitación de acceso. Si la invitación falla, el entrenador YA quedó
  // contratado, así que el error no puede tumbar la mutación — se reporta en el
  // toast y la invitación se puede reenviar desde Invitaciones. Si rechazáramos,
  // el modal seguiría abierto y el usuario crearía un duplicado.
  const createMutation = useMutation({
    mutationFn: async ({ send_invitation, ...staffInput }: StaffInput & { send_invitation?: boolean }) => {
      const staff = await bffClient.post<Staff>('/api/v1/school-staff', staffInput);

      if (!send_invitation) return { staff, invitation: null as null | { sent: boolean; message?: string } };

      try {
        // El RPC resuelve la escuela con auth.uid(), por eso se llama desde el
        // cliente y no desde el BFF (que usa service key). Reutiliza la pendiente
        // si ya existía. `p_child_name` es el campo que la plantilla de correo
        // usa como nombre del entrenador.
        // Hay que pasar las 9 claves: create_invitation tiene dos overloads (8 y 9
        // parámetros) y con un subconjunto PostgREST no sabe cuál elegir
        // ("Could not choose the best candidate function"). p_unregistered_athlete_id
        // es la que desambigua, porque la firma de 8 no la acepta.
        const { data: inviteId, error } = await (supabase.rpc as any)('create_invitation', {
          p_email: staffInput.email,
          p_role: 'coach',
          p_child_name: staffInput.full_name,
          p_team_id: null,
          p_monthly_fee: null,
          p_parent_phone: staffInput.phone || null,
          p_branch_id: staffInput.branch_id || null,
          p_offering_plan_id: null,
          p_unregistered_athlete_id: null,
        });
        if (error) throw error;
        if (!inviteId) throw new Error('No se pudo crear la invitación');

        // Un solo destinatario, pero por el BFF: trae reintentos ante 429 y deja
        // registro en email_sends.
        const send = await bffClient.post<{ sent: number; failed: number; message: string }>(
          '/api/v1/invitations/bulk-send',
          { invitation_ids: [inviteId] }
        );
        return { staff, invitation: { sent: send.sent > 0, message: send.message } };
      } catch (err: any) {
        return { staff, invitation: { sent: false, message: err?.message || 'Error enviando la invitación' } };
      }
    },
    onSuccess: ({ staff, invitation }) => {
      queryClient.invalidateQueries({ queryKey: ['school-staff', schoolId] });
      queryClient.invalidateQueries({ queryKey: ['invitations'] });

      if (invitation && !invitation.sent) {
        toast({
          title: '⚠️ Contratado, pero sin invitación',
          description: `${staff.full_name} quedó en tu staff. El correo no salió (${invitation.message}). Reenvíalo desde Invitaciones.`,
          variant: 'destructive',
        });
        return;
      }

      toast({
        title: '✅ Entrenador contratado',
        description: invitation
          ? `Le enviamos la invitación a ${staff.email} para activar su cuenta`
          : 'Registro interno: aún no tiene acceso a la plataforma',
      });
    },
    onError: (error: any) => {
      toast({ title: 'Error', description: error.message, variant: 'destructive' });
    },
  });
  
  // Update staff
  const updateMutation = useMutation({
    // send_invitation es una bandera de UI: no existe como columna.
    mutationFn: ({ id, send_invitation: _ignored, ...input }: StaffInput & { id: string }) =>
      bffClient.patch<Staff>(`/api/v1/school-staff/${id}`, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['school-staff', schoolId] });
      toast({ title: '✅ Entrenador actualizado' });
    },
    onError: (error: any) => {
      toast({ title: 'Error', description: error.message, variant: 'destructive' });
    },
  });
  
  // Delete staff
  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      bffClient.delete<{ success: boolean }>(`/api/v1/school-staff/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['school-staff', schoolId] });
      toast({ title: 'Entrenador eliminado' });
    },
    onError: (error: any) => {
      toast({ title: 'Error', description: error.message, variant: 'destructive' });
    },
  });

  return {
    staff: staff || [],
    isLoading,
    isFetching,
    error,
    schoolId,
    refetch,
    createStaff: createMutation.mutate,
    updateStaff: updateMutation.mutate,
    deleteStaff: deleteMutation.mutate,
    // Variantes await-ables: el formulario necesita saber si el guardado falló
    // para no cerrarse y perder lo que el usuario escribió.
    createStaffAsync: createMutation.mutateAsync,
    updateStaffAsync: updateMutation.mutateAsync,
    isCreating: createMutation.isPending,
    isSaving: createMutation.isPending || updateMutation.isPending,
  };
}

export function useSchoolFacilities() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { schoolId } = useSchoolContext();

  // Fetch facilities
  const { data: facilities, isLoading, error, refetch } = useQuery({
    queryKey: ['school-facilities', schoolId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('facilities')
        .select('*')
        .eq('school_id', schoolId)
        .order('created_at', { ascending: false });

      if (error) throw error;
      return data as unknown as Facility[];
    },
    enabled: !!schoolId,
  });

  // Create facility
  const createMutation = useMutation({
    mutationFn: async (input: FacilityInput) => {
      const fila = {
        school_id: schoolId,
        name: input.name,
        type: input.type,
        capacity: input.capacity,
        description: input.description || null,
        min_booking_advance_hours: input.min_booking_advance_hours ?? 0,
        min_cancellation_hours: input.min_cancellation_hours ?? 0,
      };
      const { data, error } = await supabase
        .from('facilities')
        // «Cómo llegar» solo si el formulario lo mostró (la base ya tiene las
        // columnas); todavía no están en types.ts.
        .insert({ ...fila, ...camposUbicacion(input) } as typeof fila)
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onMutate: async (newFacility) => {
      // Cancel any outgoing refetches (so they don't overwrite our optimistic update)
      await queryClient.cancelQueries({ queryKey: ['school-facilities', schoolId] });

      // Snapshot the previous value
      const previousFacilities = queryClient.getQueryData(['school-facilities', schoolId]);

      // Optimistically update to the new value
      queryClient.setQueryData(['school-facilities', schoolId], (old: Facility[] | undefined) => {
        const optimisticFacility = {
          id: `temp-${Date.now()}`,
          school_id: schoolId!,
          ...newFacility,
          status: 'available',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        } as Facility;
        return [optimisticFacility, ...(old || [])];
      });

      // Return a context object with the snapshotted value
      return { previousFacilities };
    },
    onSuccess: (data) => {
      // No need to setQueryData here, we will invalidate
      toast({ title: '✅ Instalación creada', description: 'La instalación se ha registrado correctamente' });
    },
    onError: (err, newFacility, context) => {
      // Rollback to the previous value
      queryClient.setQueryData(['school-facilities', schoolId], context?.previousFacilities);
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    },
    onSettled: () => {
      // Always refetch after error or success:
      queryClient.invalidateQueries({ queryKey: ['school-facilities', schoolId] });
    },
  });

  // Update facility
  const updateMutation = useMutation({
    mutationFn: async ({ id, ...input }: FacilityInput & { id: string }) => {
      const cambios = {
        name: input.name,
        type: input.type,
        capacity: input.capacity,
        description: input.description || null,
        min_booking_advance_hours: input.min_booking_advance_hours ?? 0,
        min_cancellation_hours: input.min_cancellation_hours ?? 0,
      };
      const { data, error } = await supabase
        .from('facilities')
        .update({ ...cambios, ...camposUbicacion(input) } as typeof cambios)
        .eq('id', id)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['school-facilities', schoolId] });
      toast({ title: '✅ Instalación actualizada' });
    },
    onError: (error: any) => {
      toast({ title: 'Error', description: error.message, variant: 'destructive' });
    },
  });

  // Delete facility
  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from('facilities')
        .delete()
        .eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['school-facilities', schoolId] });
      toast({ title: 'Instalación eliminada' });
    },
    onError: (error: any) => {
      toast({ title: 'Error', description: error.message, variant: 'destructive' });
    },
  });

  return {
    facilities: facilities || [],
    isLoading,
    error,
    schoolId,
    refetch,
    createFacility: createMutation.mutate,
    updateFacility: updateMutation.mutate,
    deleteFacility: deleteMutation.mutate,
    isCreating: createMutation.isPending,
    isUpdating: updateMutation.isPending,
  };
}

export function useCoachData() {
  const { user } = useAuth();
  const { schoolId } = useSchoolContext();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Fetch coach's teams
  const { data: teams, isLoading: teamsLoading } = useQuery({
    queryKey: ['coach-teams', user?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('teams')
        .select('*')
        .eq('coach_id', user?.id)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data;
    },
    enabled: !!user?.id,
  });

  // Fetch training sessions for a specific team
  const fetchTrainingPlans = async (teamId: string) => {
    const { data, error } = await supabase
      .from('training_sessions')
      .select('*')
      .eq('team_id', teamId)
      .order('session_date', { ascending: false });
    if (error) throw error;
    return data;
  };

  // Create training session
  const createTrainingPlan = useMutation({
    mutationFn: async (input: {
      team_id: string;
      session_date: string;
      objectives: string;
      warmup?: string;
      drills?: any[];
      materials?: string;
      notes?: string;
    }) => {
      // school_id es NOT NULL en training_sessions (mig 20260925135425) y el
      // schoolId del contexto puede ser null: sin escuela activa no hay dónde
      // guardar la sesión. Esto también destraba el tsc del pre-commit.
      if (!schoolId) throw new Error('No hay una escuela activa para guardar la sesión.');
      const { data, error } = await supabase
        .from('training_sessions')
        .insert({ ...input, school_id: schoolId })
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['training-sessions', variables.team_id] });
      toast({ title: '✅ Sesión creada', description: 'La sesión de entrenamiento se ha guardado' });
    },
    onError: (error: any) => {
      toast({ title: 'Error', description: error.message, variant: 'destructive' });
    },
  });

  // Fetch match results for a specific team
  const fetchMatchResults = async (teamId: string) => {
    const { data, error } = await supabase
      .from('match_results')
      .select('*')
      .eq('team_id', teamId)
      .order('match_date', { ascending: false });
    if (error) throw error;
    return data;
  };

  // Create match result
  const createMatchResult = useMutation({
    mutationFn: async (input: {
      team_id: string;
      match_date: string;
      opponent: string;
      home_score: number;
      away_score: number;
      is_home: boolean;
      match_type: string;
      notes?: string;
    }) => {
      // match_results.school_id es NOT NULL desde 20260926131340. El trigger
      // trg_match_results_fill_school lo reescribe desde el equipo, pero el
      // tipo generado no ve triggers: se envía el de la escuela activa.
      if (!schoolId) throw new Error('No hay una escuela activa para guardar el partido.');
      const { data, error } = await supabase
        .from('match_results')
        .insert({ ...input, school_id: schoolId })
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['match-results', variables.team_id] });
      toast({ title: '✅ Resultado registrado', description: 'El resultado del partido se ha guardado' });
    },
    onError: (error: any) => {
      toast({ title: 'Error', description: error.message, variant: 'destructive' });
    },
  });

  return {
    teams: teams || [],
    teamsLoading,
    fetchTrainingPlans,
    createTrainingPlan: createTrainingPlan.mutate,
    isCreatingPlan: createTrainingPlan.isPending,
    fetchMatchResults,
    createMatchResult: createMatchResult.mutate,
    isCreatingResult: createMatchResult.isPending,
  };
}
