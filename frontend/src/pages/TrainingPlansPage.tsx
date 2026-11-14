import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useSchoolContext } from '@/hooks/useSchoolContext';
import { useActiveWorkPage } from '@/hooks/useActiveWorkPage';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { Plus, Calendar, Target, ClipboardList, Trash2, Activity, Users, Loader2, TrendingUp, Trophy, Star, Goal, IdCard, ClipboardCheck } from 'lucide-react';
import { SessionFormDialog } from '@/components/coach/SessionFormDialog';
import { MesocycleSection } from '@/components/coach/MesocycleSection';
import { WeekSessionsPanel } from '@/components/school/WeekSessionsPanel';
import { TeamPerformanceEntryModal } from '@/components/school/TeamPerformanceEntryModal';
import { FootballDashboardModal } from '@/components/school/FootballDashboardModal';
import { TacticalBoard } from '@/components/school/TacticalBoard';
import { PerformanceEntryModal } from '@/components/school/PerformanceEntryModal';
import { AthleteEvolutionModal } from '@/components/school/AthleteEvolutionModal';
import { PlayerCard } from '@/components/school/PlayerCard';
import { useTeamPerformanceRoster } from '@/hooks/usePerformanceData';
import type { RosterSubject } from '@/lib/school/performanceQueries';
import { useToast } from '@/hooks/use-toast';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { dayToLocalDate } from '@/lib/dateUtils';
import { fetchCoachTeams } from '@/lib/coachTeamScope';
import { teamBoardAccess } from '@/lib/sports/sportCatalog';

export default function TrainingPlansPage() {
  const { user } = useAuth();
  const { schoolId, activeBranchId, currentUserRole } = useSchoolContext();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  useActiveWorkPage();

  // training_plans_delete (RLS) excluye a 'coach' -- puede crear/editar
  // sesiones pero no borrarlas. Sin este gate, un coach ve el botón de
  // borrar y se encuentra con un error de permisos al apretarlo.
  const DELETE_SESSION_ROLES = ['owner', 'admin', 'staff', 'school_admin', 'super_admin'];
  const canDeleteSessions = DELETE_SESSION_ROLES.includes(currentUserRole || '');

  // «Planear» / «Crear el plan» desde Sesiones V2 llegan con ?equipo=&fecha=
  // (B6): se abre ya en ese equipo y en la semana de ese día.
  const [searchParams] = useSearchParams();
  const equipoPedido = searchParams.get('equipo');
  const fechaPedida = /^\d{4}-\d{2}-\d{2}$/.test(searchParams.get('fecha') ?? '') ? searchParams.get('fecha') : null;

  const [filterType, setFilterType] = useState<'teams' | 'plans'>('teams');
  const [selectedTeamId, setSelectedTeamId] = useState<string>(equipoPedido ?? '');
  const [selectedPlanId, setSelectedPlanId] = useState<string>('');

  const [dialogOpen, setDialogOpen] = useState(false);
  const [performanceDialogOpen, setPerformanceDialogOpen] = useState(false);
  const [footballDialogOpen, setFootballDialogOpen] = useState(false);
  const [individualStudent, setIndividualStudent] = useState<any>(null);
  const [evolutionStudent, setEvolutionStudent] = useState<any>(null);
  const [cardSubject, setCardSubject] = useState<RosterSubject | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [editingSession, setEditingSession] = useState<any>(null);
  // Tablero táctico por bloque de sesión -- ver openBlockTacticalBoard() más
  // abajo. sourceId es el id PROPIO del bloque (no el de la sesión): los
  // bloques hoy viven como objetos sin id dentro de session_blocks (jsonb),
  // así que uno se genera y se persiste la primera vez que el coach abre el
  // tablero de ESE bloque -- match_lineups.source_id es un uuid polimórfico
  // sin FK real a ninguna tabla, así que un uuid propio del bloque (nunca
  // usado en otro lado) sirve igual sin necesitar ninguna migración.
  const [tacticalBlock, setTacticalBlock] = useState<{
    sessionId: string; blockId: string; blockName: string; sessionLabel: string;
  } | null>(null);

  // Fetch teams
  const { data: teams } = useQuery({
    queryKey: ['coach-teams', user?.id, schoolId, activeBranchId, currentUserRole],
    queryFn: async () => {
      if (!user?.id || !schoolId) return [];

      const { data: staffData } = await supabase
        .from('school_staff')
        .select('id')
        .eq('coach_auth_id', user.id)
        .eq('school_id', schoolId)
        .maybeSingle();
      const staffId = staffData?.id;

      const { data: teamsData, error } = await (supabase
        .from('teams')
        .select('id, name, coach_id, age_group, sport, sport_modality, branch_id, image_url, team_coaches(coach_id)')
        .eq('school_id', schoolId) as any);

      if (error) throw error;

      const isAdminRole = ['owner', 'admin', 'school_admin', 'school', 'super_admin'].includes(currentUserRole || '');

      let filteredTeams = teamsData || [];

      if (isAdminRole) {
        if (activeBranchId) {
          filteredTeams = filteredTeams.filter((t: any) => t.branch_id === activeBranchId || !t.branch_id);
        }
      } else if (currentUserRole === 'coach') {
        filteredTeams = filteredTeams.filter((team: any) => {
          const isDirectCoach = team.coach_id === user.id || (staffId && team.coach_id === staffId);
          const isAssignedInTable = team.team_coaches?.some(
            (tc: any) => tc.coach_id === user.id || (staffId && tc.coach_id === staffId)
          );
          return isDirectCoach || isAssignedInTable;
        });
      } else {
        filteredTeams = [];
      }

      return filteredTeams.sort((a: any, b: any) => a.name.localeCompare(b.name));
    },
    enabled: !!user?.id && !!schoolId,
  });

  // Fetch offering plans
  const { data: offeringPlans } = useQuery({
    queryKey: ['school-offering-plans', schoolId, currentUserRole],
    queryFn: async () => {
      if (!schoolId) return [];
      const { data, error } = await (supabase as any)
        .from('offering_plans')
        .select('id, name, is_active, offering_id')
        .eq('school_id', schoolId)
        .eq('is_active', true)
        .order('name');
      if (error) throw error;
      const planes = (data || []) as { id: string; name: string; is_active: boolean; offering_id: string | null }[];
      if (currentUserRole !== 'coach') return planes;
      // El coach ve solo los planes de las disciplinas que tiene asignadas
      // (offering_coaches) — mismo criterio con que el BFF le deja tomar
      // asistencia de un plan. Antes veía el roster de cualquier plan.
      const { staffId } = await fetchCoachTeams(schoolId);
      if (!staffId) return [];
      const { data: asignadas } = await (supabase as any)
        .from('offering_coaches')
        .select('offering_id')
        .eq('coach_id', staffId);
      const propias = new Set(((asignadas ?? []) as { offering_id: string }[]).map((a) => a.offering_id));
      return planes.filter((p) => p.offering_id && propias.has(p.offering_id));
    },
    enabled: !!schoolId,
  });

  // Fetch active roster for the team or plan
  // El owner/admin ve todos los equipos; el panel semanal solo tiene sentido
  // para él (el coach ya ve las suyas al elegir su equipo).
  const isAdminRole = ['owner', 'admin', 'school_admin', 'school', 'super_admin'].includes(currentUserRole || '');

  const activeId = filterType === 'teams' ? selectedTeamId : selectedPlanId;
  const { data: roster = [], isLoading: loadingRoster } = useQuery<any[]>({
    queryKey: ['performance-roster-list', filterType, activeId],
    queryFn: async () => {
      if (!activeId || !schoolId) return [];
      const { data, error } = await (supabase as any)
        .from('school_athletes')
        .select('id, full_name, athlete_type, enrolled_team_id, offering_plan_id')
        .eq('school_id', schoolId)
        .eq('is_active', true)
        .eq(filterType === 'teams' ? 'enrolled_team_id' : 'offering_plan_id', activeId);

      if (error) throw error;
      return (data || []).sort((a: any, b: any) => a.full_name.localeCompare(b.full_name));
    },
    enabled: !!activeId && !!schoolId,
  });

  // P1 (tablero táctico/spec fútbol §4): mismo roster de métricas que ya usan
  // TacticalBoard/TeamPerformanceEntryModal -- se reusa acá para "ver tarjeta"
  // desde la lista de deportistas, sin inventar una fuente de datos nueva.
  const { data: performanceRoster } = useTeamPerformanceRoster({
    team_id: filterType === 'teams' ? selectedTeamId : undefined,
    offering_plan_id: filterType === 'plans' ? selectedPlanId : undefined,
  });
  const performanceSubjectById = new Map((performanceRoster?.subjects ?? []).map((s) => [s.subject_id, s]));

  // ¿El equipo tiene un mesociclo? Mismo queryKey y misma lógica que usa
  // MesocycleSection internamente — React Query comparte el fetch, no lo
  // duplica, así que las dos consultas tienen que ser idénticas o una
  // sobrescribe el cache de la otra según cuál monte primero. Sirve para no
  // mostrar la lista plana de sesiones dos veces (una agrupada por semana,
  // otra suelta) cuando sí hay mesociclo. No filtra por fecha — el más
  // reciente del equipo, igual que MesocycleSection.
  const { data: currentMesocycle } = useQuery({
    queryKey: ['mesocycle-current', selectedTeamId],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from('training_mesocycles')
        .select('*')
        .eq('team_id', selectedTeamId)
        .order('starts_on', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
    enabled: filterType === 'teams' && !!selectedTeamId,
  });

  // Fetch training sessions (only for teams)
  const { data: sessions, isLoading } = useQuery({
    queryKey: ['training-sessions', selectedTeamId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('training_sessions')
        .select('*')
        .eq('team_id', selectedTeamId)
        .order('session_date', { ascending: false });
      if (error) throw error;
      return data;
    },
    enabled: filterType === 'teams' && !!selectedTeamId,
  });

  // Create session mutation
  const createMutation = useMutation({
    mutationFn: async (input: any) => {
      // school_id es NOT NULL con RLS que lo exige (deriva sin versionar
      // encontrada y documentada el 25-sep, migración
      // 20260925135425) — sin esto el INSERT rompe con 403 para cualquiera.
      const { data, error } = await supabase
        .from('training_sessions')
        .insert({ ...input, school_id: schoolId })
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['training-sessions', selectedTeamId] });
      toast({ title: '✅ Sesión creada', description: 'La sesión de entrenamiento se ha guardado' });
    },
    onError: (error: any) => {
      toast({ title: 'Error', description: error.message, variant: 'destructive' });
    },
  });

  // Update session mutation
  const updateMutation = useMutation({
    mutationFn: async ({ id, ...input }: any) => {
      const { data, error } = await supabase
        .from('training_sessions')
        .update(input)
        .eq('id', id)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['training-sessions', selectedTeamId] });
      toast({ title: '✅ Sesión actualizada', description: 'La sesión de entrenamiento se ha actualizado' });
      setEditingSession(null);
    },
    onError: (error: any) => {
      toast({ title: 'Error', description: error.message, variant: 'destructive' });
    },
  });

  // Delete session mutation
  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from('training_sessions')
        .delete()
        .eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['training-sessions', selectedTeamId] });
      toast({ title: 'Sesión eliminada' });
      setDeleteId(null);
    },
  });

  const selectedName = filterType === 'teams'
    ? (teams?.find((t: any) => t.id === selectedTeamId)?.name || 'Equipo')
    : (offeringPlans?.find((p: any) => p.id === selectedPlanId)?.name || 'Plan');

  /** Abre el tablero táctico para UN bloque de una sesión ya guardada. Si el
   *  bloque todavía no tiene id propio (todos los creados antes de esta
   *  función, y cualquiera armado sin pasar por acá), se le asigna uno y se
   *  persiste ANTES de abrir el tablero -- sin eso, cada apertura generaría
   *  un id distinto y el tablero nunca encontraría lo guardado la vez
   *  anterior. Update silencioso (sin mutation/toast de "sesión
   *  actualizada"): es un detalle interno, no una edición que el coach pidió. */
  const openBlockTacticalBoard = async (session: any, block: any, index: number) => {
    let blockId: string | undefined = block.id;
    if (!blockId) {
      blockId = crypto.randomUUID();
      const nextBlocks = (Array.isArray(session.session_blocks) ? session.session_blocks : []).slice();
      nextBlocks[index] = { ...nextBlocks[index], id: blockId };
      const { error } = await supabase
        .from('training_sessions')
        .update({ session_blocks: nextBlocks })
        .eq('id', session.id);
      if (error) {
        toast({ title: 'No se pudo abrir el tablero táctico', description: error.message, variant: 'destructive' });
        return;
      }
      queryClient.invalidateQueries({ queryKey: ['training-sessions', selectedTeamId] });
    }
    setTacticalBlock({
      sessionId: session.id,
      blockId,
      blockName: block.name || 'Bloque',
      sessionLabel: new Date(session.session_date + 'T12:00:00').toLocaleDateString('es-CO', { day: 'numeric', month: 'long' }),
    });
  };

  const selectedTeam = teams?.find((t: any) => t.id === selectedTeamId);
  // D3 (docs/specs/pizarra-multideporte-3d-ia.md): la pizarra, sus jugadas y
  // la biblioteca se abren a todo deporte de pizarra completa (fútbol 11/7/5,
  // futsal, voleibol, baloncesto, balonmano); lo futbolero de verdad
  // (panorama «Fútbol», principios de juego, evaluación) sigue con isFootball.
  const boardAccess = selectedTeam ? teamBoardAccess(selectedTeam) : null;
  const isFootballTeam = !!boardAccess?.isFootball;
  const teamHasBoard = !!boardAccess?.hasTacticalBoard;
  // Filtro inicial de la Biblioteca de ejercicios (deporte de la pizarra).
  const teamSport = boardAccess?.sport;

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Métricas y Rendimiento</h1>
          <p className="text-muted-foreground mt-1">
            {isAdminRole
              ? 'Sesiones y evaluaciones de los equipos de la escuela'
              : 'Planifica y gestiona tus sesiones y evaluaciones de rendimiento'}
          </p>
        </div>
        {/* Dueño/admin: solo mira (spec rediseno-seguimiento-deportivo F4). Planificar
            y evaluar es del entrenador; el resumen por entrenador vive en
            Seguimiento deportivo. */}
        {isAdminRole && (
          <Button asChild variant="outline" className="gap-2">
            <Link to="/seguimiento-deportivo">
              <ClipboardCheck className="w-4 h-4" />
              Seguimiento deportivo
            </Link>
          </Button>
        )}
        {/* Con mesociclo activo la sesión se crea SIEMPRE desde un día
            (MesocycleSection → "Crear sesión" por día) para que quede
            enganchada (training_microcycle_days.session_id). Este botón
            insertaba en training_sessions sin ligar nada: con mesociclo
            activo la lista plana está oculta y MesocycleSection solo
            muestra sesiones enganchadas, así que lo creado acá quedaba
            guardado pero invisible en toda la UI (bug real, ver migración
            20260918124721). */}
        {!isAdminRole && filterType === 'teams' && selectedTeamId && !currentMesocycle && (
          <Button className="gap-2" onClick={() => { setEditingSession(null); setDialogOpen(true); }}>
            <Plus className="w-4 h-4" />
            Crear Sesión
          </Button>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Sección Izquierda: Selectores + Planes (Col 1 y 2) */}
        <div className="lg:col-span-2 space-y-6">
          {/* Owner/admin: todas las sesiones de la semana, de todos los
              equipos, con su entrenador. Un clic lleva al equipo. */}
          {isAdminRole && schoolId && (
            <WeekSessionsPanel
              schoolId={schoolId}
              teams={(teams as any[]) || []}
              onSelectTeam={(teamId) => { setFilterType('teams'); setSelectedTeamId(teamId); }}
            />
          )}

          <Card className="border-border/40 bg-background/50 backdrop-blur-sm shadow-sm">
            <CardHeader className="pb-3">
              <CardTitle className="text-base font-bold">Panel de Selección</CardTitle>
              <CardDescription>Escoge el grupo de deportistas a visualizar</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Tabs
                value={filterType}
                onValueChange={(val) => {
                  setFilterType(val as 'teams' | 'plans');
                }}
                className="w-full"
              >
                <TabsList className="grid w-full grid-cols-2">
                  <TabsTrigger value="teams" className="font-semibold">👥 Equipos</TabsTrigger>
                  <TabsTrigger value="plans" className="font-semibold">🎟️ Planes</TabsTrigger>
                </TabsList>
              </Tabs>

              {filterType === 'teams' ? (
                <div className="space-y-1.5">
                  <Select value={selectedTeamId} onValueChange={setSelectedTeamId}>
                    <SelectTrigger className="w-full bg-background">
                      <SelectValue placeholder={isAdminRole ? 'Selecciona un equipo' : 'Selecciona tu equipo'} />
                    </SelectTrigger>
                    <SelectContent>
                      {teams?.map((team) => (
                        <SelectItem key={team.id} value={team.id}>
                          {team.name} - {team.age_group || team.sport}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : (
                <div className="space-y-1.5">
                  <Select value={selectedPlanId} onValueChange={setSelectedPlanId}>
                    <SelectTrigger className="w-full bg-background">
                      <SelectValue placeholder={isAdminRole ? 'Selecciona un plan' : 'Selecciona tu plan'} />
                    </SelectTrigger>
                    <SelectContent>
                      {offeringPlans?.map((plan) => (
                        <SelectItem key={plan.id} value={plan.id}>
                          {plan.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Mesociclo — planificación mensual, agrupa la lista de sesiones por semana */}
          {filterType === 'teams' && selectedTeamId && schoolId && (
            <MesocycleSection
              teamId={selectedTeamId}
              schoolId={schoolId}
              roster={roster}
              sessions={sessions || []}
              isFootball={isFootballTeam}
              hasTacticalBoard={teamHasBoard}
              teamSport={teamSport}
              teamName={selectedName}
              onEditSession={(session) => { setEditingSession(session); setDialogOpen(true); }}
              fechaFoco={selectedTeamId === equipoPedido ? fechaPedida : null}
            />
          )}

          {/* Listado de Sesiones de Entrenamiento — solo suelto cuando NO hay
              mesociclo activo; si lo hay, MesocycleSection ya las agrupa por semana */}
          {filterType === 'teams' && selectedTeamId && !currentMesocycle && (
            <div className="space-y-4">
              {isLoading && <LoadingSpinner text="Cargando sesiones..." />}

              {sessions && sessions.length > 0 && sessions.map((session: any) => {
                const drills = Array.isArray(session.drills) ? session.drills : [];
                const blocks = Array.isArray(session.session_blocks) ? session.session_blocks : [];
                const evaluation = session.evaluation || null;

                return (
                  <Card key={session.id} className="hover:shadow-lg transition-shadow">
                    <CardHeader>
                      <div className="flex items-start justify-between">
                        <div className="space-y-1">
                          <div className="flex items-center gap-2">
                            <Calendar className="w-5 h-5 text-primary" />
                            <CardTitle className="text-lg">
                              {dayToLocalDate(session.session_date).toLocaleDateString('es-CO', {
                                weekday: 'long',
                                day: 'numeric',
                                month: 'long',
                                year: 'numeric',
                              })}
                            </CardTitle>
                          </div>
                          <div className="flex items-center gap-2 text-sm text-muted-foreground">
                            <Target className="w-4 h-4" />
                            <span>{session.objectives}</span>
                          </div>
                        </div>
                        <div className="flex gap-2">
                          <Button variant="outline" size="sm" onClick={() => { setEditingSession(session); setDialogOpen(true); }}>Editar</Button>
                          {canDeleteSessions && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setDeleteId(session.id)}
                            >
                              <Trash2 className="h-4 w-4 text-destructive" />
                            </Button>
                          )}
                        </div>
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      {session.game_principles && (
                        <div>
                          <Badge variant="secondary" className="mb-2">Principios de Juego</Badge>
                          <p className="text-sm text-muted-foreground">{session.game_principles}</p>
                        </div>
                      )}

                      {session.warmup && (
                        <div>
                          <Badge variant="secondary" className="mb-2">Calentamiento</Badge>
                          <p className="text-sm text-muted-foreground">{session.warmup}</p>
                        </div>
                      )}

                      {blocks.length > 0 && (
                        <div>
                          <h4 className="font-semibold mb-3 flex items-center gap-2">
                            <ClipboardList className="w-4 h-4" />
                            Bloques de la Sesión
                          </h4>
                          <div className="space-y-3">
                            {blocks.map((block: any, index: number) => (
                              <div key={block.id || index} className="p-3 rounded-lg border bg-muted/50 dark:bg-muted/30 space-y-1">
                                <div className="flex items-start justify-between gap-2">
                                  <p className="font-medium">{block.name}</p>
                                  <div className="flex items-center gap-2 shrink-0">
                                    {block.minutes && (
                                      <Badge variant="outline">{block.minutes} min</Badge>
                                    )}
                                    {teamHasBoard && (
                                      <Button
                                        variant="outline"
                                        size="sm"
                                        className="h-7 gap-1 text-xs"
                                        onClick={() => openBlockTacticalBoard(session, block, index)}
                                      >
                                        <Goal className="h-3.5 w-3.5" /> Tablero táctico
                                      </Button>
                                    )}
                                  </div>
                                </div>
                                {block.activity && (
                                  <p className="text-sm text-muted-foreground">{block.activity}</p>
                                )}
                                {block.objective && (
                                  <p className="text-sm text-muted-foreground">Objetivo: {block.objective}</p>
                                )}
                                {block.description && (
                                  <p className="text-sm text-muted-foreground italic">{block.description}</p>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {drills.length > 0 && (
                        <div>
                          <h4 className="font-semibold mb-3 flex items-center gap-2">
                            <ClipboardList className="w-4 h-4" />
                            Ejercicios
                          </h4>
                          <div className="space-y-3">
                            {drills.map((drill: any, index: number) => (
                              <div key={index} className="p-3 rounded-lg border bg-muted/50 dark:bg-muted/30">
                                <div className="flex items-start justify-between">
                                  <div>
                                    <p className="font-medium">{drill.name}</p>
                                    {drill.focus && (
                                      <p className="text-sm text-muted-foreground mt-1">
                                        Enfoque: {drill.focus}
                                      </p>
                                    )}
                                  </div>
                                  {drill.duration && (
                                    <Badge variant="outline">{drill.duration}</Badge>
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {session.materials && (
                        <div>
                          <h4 className="font-semibold mb-2">Materiales</h4>
                          <p className="text-sm text-muted-foreground">{session.materials}</p>
                        </div>
                      )}

                      {session.notes && (
                        <div className="pt-3 border-t">
                          <h4 className="font-semibold mb-2">Notas</h4>
                          <p className="text-sm text-muted-foreground italic">{session.notes}</p>
                        </div>
                      )}

                      {evaluation && (
                        <div className="rounded-lg border bg-muted/30 dark:bg-muted/10 p-3 space-y-2.5">
                          <h4 className="font-semibold flex items-center gap-2">
                            <Star className="w-4 h-4" />
                            Evaluación de la Sesión
                          </h4>

                          <div className="flex flex-wrap items-center gap-3">
                            {evaluation.objectives_met && (
                              <Badge
                                variant="outline"
                                className={
                                  evaluation.objectives_met === 'si'
                                    ? 'text-green-600 dark:text-green-400 bg-green-500/10 border-green-500/25'
                                    : evaluation.objectives_met === 'parcial'
                                    ? 'text-amber-600 dark:text-amber-400 bg-amber-500/10 border-amber-500/25'
                                    : 'text-red-600 dark:text-red-400 bg-red-500/10 border-red-500/25'
                                }
                              >
                                Objetivos: {evaluation.objectives_met === 'si' ? 'Cumplidos' : evaluation.objectives_met === 'parcial' ? 'Parcial' : 'No cumplidos'}
                              </Badge>
                            )}

                            {evaluation.team_rating && (
                              <div className="flex items-center gap-1">
                                {[1, 2, 3, 4, 5].map((n) => (
                                  <Star
                                    key={n}
                                    className={`h-4 w-4 ${
                                      evaluation.team_rating >= n
                                        ? 'fill-amber-500 text-amber-500 dark:fill-amber-400 dark:text-amber-400'
                                        : 'text-muted-foreground/30'
                                    }`}
                                  />
                                ))}
                              </div>
                            )}
                          </div>

                          {evaluation.highlights && (
                            <p className="text-sm text-muted-foreground">
                              <span className="font-medium text-foreground">Destacado: </span>
                              {evaluation.highlights}
                            </p>
                          )}
                          {evaluation.improvements && (
                            <p className="text-sm text-muted-foreground">
                              <span className="font-medium text-foreground">A mejorar: </span>
                              {evaluation.improvements}
                            </p>
                          )}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                );
              })}

              {sessions && sessions.length === 0 && !isLoading && (
                <Card>
                  <CardContent className="pt-6 text-center">
                    <ClipboardList className="w-12 h-12 mx-auto mb-4 text-muted-foreground" />
                    <h3 className="text-lg font-semibold mb-2">No hay sesiones aún</h3>
                    <p className="text-muted-foreground mb-4">
                      {isAdminRole
                        ? 'El entrenador todavía no ha cargado sesiones para este equipo.'
                        : 'Crea tu primera sesión de entrenamiento'}
                    </p>
                    {!isAdminRole && (
                      <Button className="gap-2" onClick={() => { setEditingSession(null); setDialogOpen(true); }}>
                        <Plus className="w-4 h-4" />
                        Crear Primera Sesión
                      </Button>
                    )}
                  </CardContent>
                </Card>
              )}
            </div>
          )}



          {filterType === 'plans' && selectedPlanId && (
            <Card className="border-border/40 bg-background/50 backdrop-blur-sm shadow-sm">
              <CardContent className="pt-6 text-center">
                <ClipboardList className="w-12 h-12 mx-auto mb-4 text-muted-foreground opacity-40" />
                <h3 className="text-lg font-semibold mb-2">Sesiones de Entrenamiento</h3>
                <p className="text-muted-foreground text-sm max-w-md mx-auto">
                  Las sesiones de entrenamiento se organizan por Equipos.
                  Para planificar, selecciona la pestaña de <strong>Equipos</strong>.
                  {isAdminRole
                    ? 'En el panel de la derecha están las tarjetas y la evolución de los deportistas de este Plan.'
                    : 'Usa el panel de la derecha para evaluar el rendimiento de los deportistas de este Plan.'}
                </p>
              </CardContent>
            </Card>
          )}

          {!activeId && (
            <Card>
              <CardContent className="pt-6 text-center">
                <ClipboardList className="w-12 h-12 mx-auto mb-4 text-muted-foreground opacity-40" />
                <h3 className="text-lg font-semibold mb-2">Selecciona un grupo</h3>
                <p className="text-muted-foreground">
                  Elige un {filterType === 'teams' ? 'equipo' : 'plan de oferta'} del menú para comenzar
                </p>
              </CardContent>
            </Card>
          )}
        </div>

        {/* Sección Derecha: Roster de Estudiantes & Botones de Evaluación */}
        <div className="space-y-6">
          {activeId && (
            <Card className="border-border/40 bg-background/50 backdrop-blur-sm shadow-sm overflow-hidden flex flex-col">
              <CardHeader className="pb-3 border-b border-border/40 bg-muted/20">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-3">
                    {filterType === 'teams' && (() => {
                      const selectedTeam = teams?.find((t: any) => t.id === selectedTeamId);
                      return selectedTeam?.image_url ? (
                        <img 
                          src={selectedTeam.image_url} 
                          alt={selectedTeam.name} 
                          className="w-10 h-10 rounded-full object-cover border border-border/50 bg-background shadow-sm shrink-0" 
                        />
                      ) : null;
                    })()}
                    <div>
                      <CardTitle className="text-base font-bold flex items-center gap-2">
                        <Users className="w-4 h-4 text-primary" />
                        Roster ({roster.length})
                      </CardTitle>
                      <CardDescription className="truncate max-w-[200px]">
                        {selectedName}
                      </CardDescription>
                    </div>
                  </div>
                  {!isAdminRole && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8 gap-1.5 shrink-0"
                      onClick={() => setPerformanceDialogOpen(true)}
                      disabled={roster.length === 0}
                    >
                      <Activity className="w-3.5 h-3.5" />
                      Evaluar Lote
                    </Button>
                  )}
                  {(() => {
                    return filterType === 'teams' && isFootballTeam && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8 gap-1.5 shrink-0"
                        onClick={() => setFootballDialogOpen(true)}
                      >
                        <Trophy className="w-3.5 h-3.5" />
                        Fútbol
                      </Button>
                    );
                  })()}
                </div>
              </CardHeader>
              <CardContent className="p-3 flex-1">
                {loadingRoster ? (
                  <div className="flex flex-col items-center justify-center py-10 gap-2">
                    <Loader2 className="h-4 w-4 animate-spin text-primary" />
                    <span className="text-xs text-muted-foreground">Cargando deportistas...</span>
                  </div>
                ) : roster.length === 0 ? (
                  <div className="text-center py-10 text-muted-foreground italic text-xs">
                    Sin deportistas activos inscritos en este {filterType === 'teams' ? 'equipo' : 'plan'}.
                  </div>
                ) : (
                  <div className="space-y-2 max-h-[500px] overflow-y-auto pr-1">
                    {roster.map((student) => (
                      <div
                        key={student.id}
                        className="flex flex-col gap-1.5 p-2 rounded-lg border bg-card/60 hover:bg-accent/40 transition-colors"
                      >
                        {/* El nombre va en su propia línea: la columna es angosta y los
                            tres botones lo dejaban en "A…", sin saber a quién se evalúa. */}
                        <div className="flex items-center gap-2 min-w-0">
                          <p className="text-sm font-semibold leading-snug break-words" title={student.full_name}>
                            {student.full_name}
                          </p>
                          {student.athlete_type === 'adult' && (
                            <Badge variant="outline" className="text-[9px] h-3.5 py-0 px-1 shrink-0">
                              Adulto
                            </Badge>
                          )}
                        </div>
                        <div className="flex flex-wrap items-center gap-1 -ml-2">
                          {performanceSubjectById.get(student.id) && (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 text-muted-foreground hover:text-primary hover:bg-primary/10 px-2 gap-1"
                              onClick={() => setCardSubject(performanceSubjectById.get(student.id) ?? null)}
                            >
                              <IdCard className="w-3.5 h-3.5" />
                              Tarjeta
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 text-muted-foreground hover:text-primary hover:bg-primary/10 px-2 gap-1"
                            onClick={() => setEvolutionStudent(student)}
                          >
                            <TrendingUp className="w-3.5 h-3.5" />
                            Evolución
                          </Button>
                          {!isAdminRole && (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 text-primary hover:text-primary hover:bg-primary/10 px-2 gap-1"
                              onClick={() => setIndividualStudent(student)}
                            >
                              <Activity className="w-3.5 h-3.5" />
                              Evaluar
                            </Button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      {filterType === 'teams' && selectedTeamId && (
        <SessionFormDialog
          open={dialogOpen}
          onOpenChange={(open) => {
            setDialogOpen(open);
            if (!open) setEditingSession(null);
          }}
          onSubmit={(data) =>
            editingSession
              ? updateMutation.mutate({ id: editingSession.id, ...data })
              : createMutation.mutate(data)
          }
          teamId={selectedTeamId}
          teamName={selectedName}
          isFootball={isFootballTeam}
          hasTacticalBoard={teamHasBoard}
          teamSport={teamSport}
          session={editingSession}
          isLoading={createMutation.isPending || updateMutation.isPending}
        />
      )}



      {activeId && (
        <TeamPerformanceEntryModal
          open={performanceDialogOpen}
          onClose={() => setPerformanceDialogOpen(false)}
          teamId={filterType === 'teams' ? selectedTeamId : undefined}
          offeringPlanId={filterType === 'plans' ? selectedPlanId : undefined}
          teamName={selectedName}
          teamImageUrl={filterType === 'teams' ? teams?.find((t: any) => t.id === selectedTeamId)?.image_url : undefined}
        />
      )}

      {footballDialogOpen && filterType === 'teams' && selectedTeamId && (
        <FootballDashboardModal
          open={footballDialogOpen}
          onClose={() => setFootballDialogOpen(false)}
          teamId={selectedTeamId}
          teamName={selectedName}
        />
      )}

      {tacticalBlock && filterType === 'teams' && selectedTeamId && (
        <TacticalBoard
          open={!!tacticalBlock}
          onClose={() => setTacticalBlock(null)}
          teamId={selectedTeamId}
          teamName={selectedName}
          sourceType="training_session"
          sourceId={tacticalBlock.blockId}
          contextLabel={`Entrenamiento ${tacticalBlock.sessionLabel} — ${tacticalBlock.blockName}`}
        />
      )}

      {individualStudent && (
        <PerformanceEntryModal
          open={!!individualStudent}
          onClose={() => setIndividualStudent(null)}
          subjectType={individualStudent.athlete_type === 'adult' ? 'profile' : (individualStudent.athlete_type === 'child' ? 'child' : 'unregistered')}
          subjectId={individualStudent.id}
          subjectName={individualStudent.full_name}
        />
      )}

      {evolutionStudent && (
        <AthleteEvolutionModal
          open={!!evolutionStudent}
          onClose={() => setEvolutionStudent(null)}
          subjectType={evolutionStudent.athlete_type === 'adult' ? 'profile' : (evolutionStudent.athlete_type === 'child' ? 'child' : 'unregistered')}
          subjectId={evolutionStudent.id}
          subjectName={evolutionStudent.full_name}
        />
      )}

      {cardSubject && performanceRoster && (
        <PlayerCard
          open={!!cardSubject}
          onClose={() => setCardSubject(null)}
          subject={cardSubject}
          metrics={performanceRoster.metrics}
          latestValues={performanceRoster.latest_values}
        />
      )}

      <AlertDialog open={!!deleteId} onOpenChange={() => setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Eliminar sesión?</AlertDialogTitle>
            <AlertDialogDescription>
              Esta acción no se puede deshacer.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction 
              onClick={() => deleteId && deleteMutation.mutate(deleteId)}
              className="bg-destructive text-destructive-foreground"
            >
              Eliminar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
