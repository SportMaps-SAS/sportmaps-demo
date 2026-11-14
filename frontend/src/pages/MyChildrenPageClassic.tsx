// Versión anterior a la V2 del acudiente (commit c7d14d43), intacta. Solo se
// usa con VITE_ACUDIENTE_V2=false para volver atrás sin tocar código. Borrar
// cuando la V2 lleve un tiempo estable en producción.
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { ErrorState } from '@/components/common/ErrorState';
import { Plus, Calendar, User, AlertTriangle, School, Pencil, FileText, Trophy, BookOpen } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { AddChildDialog } from '@/components/children/AddChildDialog';
import { EditChildDialog } from '@/components/children/EditChildDialog';
import { UploadChildDocumentsDialog } from '@/components/children/UploadChildDocumentsDialog';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import { Badge } from '@/components/ui/badge';
import { MedicalAlertBadge } from '@/components/common/MedicalAlertBadge';
import RequestPauseDialog from '@/components/children/RequestPauseDialog';
import { ChildPauseSection } from '@/components/children/ChildPauseSection';
import { useParentPauseActions } from '@/hooks/usePauses';
import { JoinSchoolCodeBanner } from '@/components/school-join/JoinSchoolCodeBanner';

export default function MyChildrenPage() {
  const { user } = useAuth();
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [editingChild, setEditingChild] = useState<any | null>(null);
  const [uploadingDocsFor, setUploadingDocsFor] = useState<any | null>(null);

  // Pausa por vacaciones/lesión (spec §9.2). El gate por escuela lo resuelve
  // cada tarjeta con `usePauseConfig`, porque un acudiente puede tener hijos en
  // escuelas distintas y una puede tenerlo habilitado y la otra no.
  const [pausingChild, setPausingChild] = useState<{ child: any; enrollmentId: string; maxMonths: number } | null>(null);
  const { solicitar, retirar } = useParentPauseActions();



  const { data: children, isLoading, error, refetch } = useQuery({
    queryKey: ['children', user?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('children')
        .select(`
          *,
          schools!children_school_id_fkey(name),
          teams!team_id(
            name, sport, level,
            coach:coach_id(full_name)
          ),
          enrollments(
            id, status, team_id, offering_plan_id, offering_id,
            teams!enrollments_team_id_fkey(
              name, sport, level,
              coach:coach_id(full_name)
            ),
            offering_plans!offering_plan_id(
              name, price,
              offerings!offering_id(name)
            )
          )
        `)
        .eq('parent_id', user?.id)
        .order('created_at', { ascending: false });

      if (error) {
        console.error('Error fetching children:', error);
        throw error;
      }

      // Deduplicar por child.id (Supabase puede retornar duplicados
      // cuando hay JOINs a teams via children.team_id Y enrollments.team_id)
      const seen = new Set<string>();
      return (data || []).filter(child => {
        if (seen.has(child.id)) return false;
        seen.add(child.id);
        return true;
      });
    },
    enabled: !!user?.id,
  });

  // Con una invitación pendiente el hijo YA viene cargado por la academia, con
  // su plan y su equipo. Se puede agregar OTRO hijo distinto, pero no volver a
  // crear al que ya viene en la invitación: eso deja dos personas facturables
  // para el mismo atleta (la ficha de la escuela y la del acudiente).
  const { data: pendingInvitations } = useQuery({
    queryKey: ['my-invitations', user?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('invitations')
        .select('id, child_name, role_to_assign, schools(name)')
        .eq('email', user?.email ?? '')
        .eq('status', 'pending');
      if (error) throw error;
      return data || [];
    },
    enabled: !!user?.email,
  });

  const invitacionPendiente = (pendingInvitations || [])[0] as any;

  // Nombres que el acudiente NO puede volver a crear: los hijos que ya tiene y
  // los que vienen en invitaciones sin aceptar.
  const nombresTomados = [
    ...(children || []).map((c: any) => c.full_name),
    ...(pendingInvitations || []).map((i: any) => i.child_name),
  ].filter(Boolean) as string[];

  // Demo data only for demo users
  const displayChildren = children || [];

  if (isLoading) {
    return <LoadingSpinner fullScreen text="Cargando tus hijos..." />;
  }

  if (error) {
    return (
      <ErrorState
        title="Error al cargar tus hijos"
        message="Hubo un problema al recuperar la información. Por favor, intenta de nuevo."
        onRetry={() => refetch()}
      />
    );
  }

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Familia SportMaps</h1>
          <p className="text-muted-foreground mt-1">
            Gestión centralizada de tus hijos y su desarrollo deportivo
          </p>
        </div>
        <Button onClick={() => setShowAddDialog(true)} className="rounded-xl shadow-lg hover:shadow-primary/20 transition-all">
          <Plus className="w-4 h-4 mr-2" />
          Registrar Hijo
        </Button>
      </div>

      {/* Sin escuela: unirse con el código de la escuela (spec codigo-de-escuela). */}
      <JoinSchoolCodeBanner />

      {invitacionPendiente && (
        <Card className="border-primary/30 bg-primary/5 rounded-2xl">
          <CardContent className="flex items-start gap-3 pt-6">
            <School className="h-5 w-5 text-primary shrink-0 mt-0.5" />
            <div className="text-sm">
              <p className="font-semibold">
                {invitacionPendiente.schools?.name || 'Tu academia'} ya cargó a
                {invitacionPendiente.child_name ? ` ${invitacionPendiente.child_name}` : ' tu hijo'}
              </p>
              <p className="text-muted-foreground mt-1">
                Acepta la invitación desde tu inicio y aparecerá aquí con su plan y su equipo.
                No lo registres a mano: quedaría duplicado. Si tienes <strong>otro</strong> hijo
                que la academia no cargó, ese sí puedes agregarlo.
              </p>
              <Link to="/dashboard">
                <Button variant="outline" size="sm" className="mt-3 rounded-xl">
                  Ir a aceptar la invitación
                </Button>
              </Link>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        {displayChildren?.map((child: any) => (
          <Card key={child.id} className="group relative overflow-hidden border-border/50 hover:border-primary/30 hover:shadow-2xl hover:shadow-primary/5 transition-all duration-300 rounded-2xl">
            {/* Gradient Header Decoration */}
            <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-primary/40 via-primary to-primary/40 opacity-0 group-hover:opacity-100 transition-opacity" />
            
            <CardHeader className="pb-4 relative">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-4">
                  <div className="relative">
                    <Avatar className="w-16 h-16 border-2 border-background shadow-xl scale-100 group-hover:scale-105 transition-transform duration-500">
                      <AvatarImage src={child.avatar_url || ''} className="object-cover" />
                      <AvatarFallback className="bg-gradient-to-br from-primary to-primary/60 text-white font-bold text-xl">
                        {child.full_name.charAt(0)}
                      </AvatarFallback>
                    </Avatar>
                    <div className="absolute -bottom-1 -right-1 h-5 w-5 rounded-full bg-green-500 border-2 border-background shadow-sm" title="Activo" />
                  </div>
                  <div>
                    <CardTitle className="text-xl font-bold tracking-tight group-hover:text-primary transition-colors">{child.full_name}</CardTitle>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground mt-1 font-medium italic">
                      <Calendar className="h-3 w-3" />
                      {child.date_of_birth
                        ? new Date(child.date_of_birth + 'T00:00:00').toLocaleDateString('es-CO', {
                          year: 'numeric',
                          month: 'long',
                        })
                        : 'Sin fecha'}
                    </div>
                  </div>
                </div>
                
                <div className="flex flex-col items-end gap-2">
                  <MedicalAlertBadge medicalInfo={child.medical_info} />
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-muted-foreground hover:text-primary hover:bg-primary/10 rounded-full"
                    onClick={() => setEditingChild(child)}
                  >
                    <Pencil className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            </CardHeader>
            
            <CardContent className="space-y-5">
              {/* Información Académica/Equipo */}
              <div className="bg-muted/30 dark:bg-muted/10 rounded-xl p-3 border border-border/40">
                {(() => {
                  const enrollments = child.enrollments || [];
                  const activeEnrollment = enrollments.find((e: any) => 
                    ['active', 'activo'].includes(e.status?.toLowerCase())
                  );
                  
                  // Intentar obtener el equipo desde el enrollment o directamente del hijo
                  const team = activeEnrollment?.teams || child.teams;
                  const plan = !team ? activeEnrollment?.offering_plans : null;
                  const offering = plan?.offerings;

                  if (team) {
                    return (
                      <div className="space-y-2">
                        <div className="flex items-center gap-2 text-sm font-bold">
                          <School className="w-4 h-4 text-primary" />
                          <span>{team.name}</span>
                          <Badge variant="outline" className="text-[9px] py-0 h-4 border-primary/20 text-primary uppercase">
                            {team.level || 'General'}
                          </Badge>
                        </div>
                        <div className="grid grid-cols-2 gap-2 mt-2">
                          <div className="text-[10px] text-muted-foreground">
                            <p className="uppercase tracking-tighter font-bold">Deporte</p>
                            <p className="text-foreground font-medium">{team.sport || 'N/A'}</p>
                          </div>
                          <div className="text-[10px] text-muted-foreground">
                            <p className="uppercase tracking-tighter font-bold">Entrenador</p>
                            <p className="text-foreground font-medium text-truncate">{team.coach?.full_name?.split(' ')[0] || 'Asignando...'}</p>
                          </div>
                        </div>
                      </div>
                    );
                  }

                  if (plan) {
                    return (
                      <div className="space-y-2">
                        <div className="flex items-center gap-2 text-sm font-bold">
                          <School className="w-4 h-4 text-primary" />
                          <span>{offering?.name || 'Inscripción'}</span>
                        </div>
                        <p className="text-xs text-muted-foreground font-medium">{plan.name}</p>
                      </div>
                    );
                  }

                  return (
                    <div className="text-xs text-muted-foreground italic flex items-center gap-2">
                      <AlertTriangle className="h-3 w-3" />
                      No hay inscripciones activas
                    </div>
                  );
                })()}
              </div>

              <div className="space-y-3">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <Link to={`/academic-progress?childId=${child.id}`} className="flex-1">
                    <Button variant="outline" className="w-full h-11 rounded-xl border-border/60 hover:border-primary/40 hover:bg-primary/5 hover:text-primary transition-all group/btn shadow-sm font-bold text-xs uppercase tracking-wider">
                      <Trophy className="w-4 h-4 mr-2 group-hover/btn:scale-110 transition-transform" />
                      Progreso
                    </Button>
                  </Link>
                  <Link to={`/parent-attendance?childId=${child.id}`} className="flex-1">
                    <Button variant="outline" className="w-full h-11 rounded-xl border-border/60 hover:border-primary/40 hover:bg-primary/5 hover:text-primary transition-all group/btn shadow-sm font-bold text-xs uppercase tracking-wider">
                      <Calendar className="w-4 h-4 mr-2 group-hover/btn:scale-110 transition-transform" />
                      Asistencia
                    </Button>
                  </Link>
                  <Link to={`/children/${child.id}/partidos`} className="flex-1">
                    <Button variant="outline" className="w-full h-11 rounded-xl border-border/60 hover:border-primary/40 hover:bg-primary/5 hover:text-primary transition-all group/btn shadow-sm font-bold text-xs uppercase tracking-wider">
                      <FileText className="w-4 h-4 mr-2 group-hover/btn:scale-110 transition-transform" />
                      Partidos
                    </Button>
                  </Link>
                  <Link to={`/children/${child.id}/reports`} className="flex-1">
                    <Button variant="outline" className="w-full h-11 rounded-xl border-border/60 hover:border-primary/40 hover:bg-primary/5 hover:text-primary transition-all group/btn shadow-sm font-bold text-xs uppercase tracking-wider">
                      <BookOpen className="w-4 h-4 mr-2 group-hover/btn:scale-110 transition-transform" />
                      Informes
                    </Button>
                  </Link>
                </div>
                <div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full"
                    onClick={() => setUploadingDocsFor(child)}
                  >
                    <FileText className="w-4 h-4 mr-2" />
                    Subir documentos
                  </Button>
                </div>
                {/* Pausa por vacaciones/lesión. Se auto-oculta si la escuela no
                    la habilitó o si no hay inscripción activa. */}
                <ChildPauseSection
                  child={child}
                  enrollmentId={
                    (child.enrollments || []).find((e: any) =>
                      ['active', 'activo'].includes(e.status?.toLowerCase())
                    )?.id ?? null
                  }
                  onSolicitar={setPausingChild}
                  onRetirar={(requestId) => retirar.mutate(requestId)}
                  isRetiring={retirar.isPending}
                />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <RequestPauseDialog
        open={!!pausingChild}
        onOpenChange={(o) => { if (!o) setPausingChild(null); }}
        athleteName={pausingChild?.child?.full_name ?? ''}
        enrollmentId={pausingChild?.enrollmentId ?? null}
        maxMonths={pausingChild?.maxMonths}
        isSubmitting={solicitar.isPending}
        onSubmit={(args) => solicitar.mutate(args, { onSuccess: () => setPausingChild(null) })}
      />

      <AddChildDialog
        open={showAddDialog}
        onOpenChange={setShowAddDialog}
        onSuccess={refetch}
        nombresTomados={nombresTomados}
      />

      {editingChild && (
        <EditChildDialog
          open={!!editingChild}
          onOpenChange={(open) => !open && setEditingChild(null)}
          onSuccess={refetch}
          child={editingChild}
        />
      )}

      {uploadingDocsFor && (
        <UploadChildDocumentsDialog
          open={!!uploadingDocsFor}
          onOpenChange={(open) => !open && setUploadingDocsFor(null)}
          child={uploadingDocsFor}
        />
      )}
    </div>
  );
}
