import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { PlayNotes, PlayVideo } from '@/lib/school/tacticalMedia';
import {
  getFootballLineups,
  getFootballLineup,
  saveFootballLineup,
  deleteFootballLineup,
  getFootballEvents,
  createFootballEvents,
  deleteFootballEvent,
  getFootballSeasonStats,
  getTournamentMatches,
  getTacticalPresets,
  createTacticalPreset,
  updateTacticalPreset,
  deleteTacticalPreset,
  type LineupSourceType,
  type EventSourceType,
  type LineupPlayerInput,
  type NewFootballMatchEvent,
  type TacticalSituation,
  type TacticalPresetSlot,
  type TacticalArrow,
} from '@/lib/school/footballQueries';
import type { TacticalFrame } from '@/lib/school/tacticalFrames';
import type { TacticalTeamsConfig } from '@/lib/school/tacticalTeams';

export function useFootballLineups(params: { team_id?: string; source_type?: LineupSourceType; source_id?: string }) {
  return useQuery({
    queryKey: ['football-lineups', params],
    queryFn: () => getFootballLineups(params),
    enabled: !!(params.team_id || params.source_id),
  });
}

export function useFootballLineup(id?: string) {
  return useQuery({
    queryKey: ['football-lineup', id],
    queryFn: () => getFootballLineup(id!),
    enabled: !!id,
  });
}

export function useSaveFootballLineup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: {
      team_id: string;
      source_type: LineupSourceType;
      source_id: string;
      formation?: string | null;
      players: LineupPlayerInput[];
      arrows?: TacticalArrow[];
      frames?: TacticalFrame[] | null;
      notes?: PlayNotes | null;
      videos?: PlayVideo[] | null;
      /** M6b: configuración de los equipos (null = aspecto de siempre). */
      teams?: TacticalTeamsConfig | null;
    }) => saveFootballLineup(payload),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['football-lineups'] });
      queryClient.invalidateQueries({ queryKey: ['football-season-stats', variables.team_id] });
    },
  });
}

export function useDeleteFootballLineup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteFootballLineup(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['football-lineups'] });
    },
  });
}

export function useFootballEvents(params: { team_id?: string; source_type?: EventSourceType; source_id?: string }) {
  return useQuery({
    queryKey: ['football-events', params],
    queryFn: () => getFootballEvents(params),
    enabled: !!(params.team_id || params.source_id),
  });
}

export function useCreateFootballEvents() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: {
      team_id: string;
      source_type: EventSourceType;
      source_id: string;
      events: NewFootballMatchEvent[];
    }) => createFootballEvents(payload),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['football-events'] });
      queryClient.invalidateQueries({ queryKey: ['football-season-stats', variables.team_id] });
    },
  });
}

export function useDeleteFootballEvent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteFootballEvent(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['football-events'] });
    },
  });
}

export function useFootballSeasonStats(teamId?: string) {
  return useQuery({
    queryKey: ['football-season-stats', teamId],
    queryFn: () => getFootballSeasonStats(teamId!),
    enabled: !!teamId,
  });
}

export function useTacticalPresets(params: { team_id?: string; situation?: TacticalSituation }) {
  return useQuery({
    queryKey: ['tactical-presets', params],
    queryFn: () => getTacticalPresets(params),
    enabled: !!params.team_id,
  });
}

export function useCreateTacticalPreset() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: { team_id: string; name: string; situation: TacticalSituation; slots: TacticalPresetSlot[]; arrows?: TacticalArrow[]; frames?: TacticalFrame[] | null; notes?: PlayNotes | null; videos?: PlayVideo[] | null; teams?: TacticalTeamsConfig | null }) =>
      createTacticalPreset(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tactical-presets'] });
    },
  });
}

/** El CRUD tenía create/read/delete pero nunca update -- "editar" una
 *  plantilla cargada siempre terminaba creando una nueva por POST. */
export function useUpdateTacticalPreset() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...payload }: { id: string; name?: string; situation?: TacticalSituation; slots?: TacticalPresetSlot[]; arrows?: TacticalArrow[]; frames?: TacticalFrame[] | null; notes?: PlayNotes | null; videos?: PlayVideo[] | null; teams?: TacticalTeamsConfig | null }) =>
      updateTacticalPreset(id, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tactical-presets'] });
    },
  });
}

export function useDeleteTacticalPreset() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteTacticalPreset(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tactical-presets'] });
    },
  });
}

export function useTournamentMatches(teamId?: string) {
  return useQuery({
    queryKey: ['tournament-matches', teamId],
    queryFn: () => getTournamentMatches(teamId!),
    enabled: !!teamId,
  });
}

// ─── Partidos propios del equipo (match_results) ───────────────────────────
// Lectura directa a Supabase, no BFF -- misma convención que el resto del
// frontend para GETs (frontend lee DB via SDK, escribe via BFF). Las
// escrituras de alineación/eventos sí van por BFF porque validan reglas de
// negocio (máximo 11 titulares, pertenencia del equipo a la escuela, etc).
export interface TeamMatch {
  id: string;
  opponent: string;
  home_score: number | null;
  away_score: number | null;
  is_home: boolean | null;
  match_date: string;
  match_type: string | null;
  notes: string | null;
}

export function useTeamMatches(teamId?: string) {
  return useQuery({
    queryKey: ['team-matches', teamId],
    queryFn: async (): Promise<TeamMatch[]> => {
      const { data, error } = await supabase
        .from('match_results')
        .select('id, opponent, home_score, away_score, is_home, match_date, match_type, notes')
        .eq('team_id', teamId!)
        .order('match_date', { ascending: false })
        .limit(30);
      if (error) throw error;
      return data ?? [];
    },
    enabled: !!teamId,
  });
}

export function useCreateTeamMatch() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: {
      team_id: string;
      // NOT NULL desde 20260926131340; el trigger trg_match_results_fill_school
      // lo reescribe desde team_id, pero el tipo generado no ve triggers.
      school_id: string;
      opponent: string;
      home_score: number | null;
      away_score: number | null;
      is_home: boolean;
      match_date: string;
      match_type: string;
      notes?: string;
    }) => {
      const { data, error } = await supabase
        .from('match_results')
        .insert(payload)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['team-matches', variables.team_id] });
    },
  });
}

export function useUpdateTeamMatch() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, team_id, ...input }: {
      id: string;
      team_id: string;
      opponent: string;
      home_score: number | null;
      away_score: number | null;
      is_home: boolean;
      match_date: string;
      match_type: string;
      notes?: string;
    }) => {
      const { data, error } = await supabase
        .from('match_results')
        .update(input)
        .eq('id', id)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['team-matches', variables.team_id] });
      queryClient.invalidateQueries({ queryKey: ['match-results', variables.team_id] });
    },
  });
}

export function useDeleteTeamMatch() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: { id: string; team_id: string }) => {
      const { error } = await supabase
        .from('match_results')
        .delete()
        .eq('id', payload.id);
      if (error) throw error;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['team-matches', variables.team_id] });
    },
  });
}
