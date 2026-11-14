/**
 * /children — «Hijos» del acudiente, rediseño V2 (tablero AcuHijos).
 *
 * La pantalla en sí vive en components/parent/v2/hijos/HijosV2.tsx; aquí
 * quedan la carga de los hijos, la invitación pendiente y los diálogos que ya
 * existían (agregar, corregir datos, subir documentos, pausa).
 *
 * Las rutas viejas (/academic-progress, /parent-attendance,
 * /children/:id/reports, /children/:id/post-entreno-informe,
 * /children/:id/partidos) siguen vivas: las pestañas enlazan a esos detalles.
 */
import { useState, type ComponentProps } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/common/ErrorState';
import { Plus, School, Users } from 'lucide-react';
import { AddChildDialog } from '@/components/children/AddChildDialog';
import { EditChildDialog } from '@/components/children/EditChildDialog';
import { UploadChildDocumentsDialog } from '@/components/children/UploadChildDocumentsDialog';
import { BloqueFamiliaHijo } from '@/components/familia/FamiliaBloques';
import { HijosV2 } from '@/components/parent/v2/hijos/HijosV2';
import { SectionSkeleton } from '@/components/parent/v2/hijos/parts';
import type { Hijo } from '@/components/parent/v2/hijos/hijosUtils';
import { JoinSchoolCodeBanner } from '@/components/school-join/JoinSchoolCodeBanner';

interface InvitacionPendiente {
  id: string;
  child_name: string | null;
  schools: { name: string | null } | null;
}

export default function MyChildrenPage() {
  const { user } = useAuth();
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [editingChild, setEditingChild] = useState<Hijo | null>(null);
  const [uploadingDocsFor, setUploadingDocsFor] = useState<Hijo | null>(null);

  const { data: children, isLoading, error, refetch } = useQuery({
    queryKey: ['children', user?.id],
    queryFn: async () => {
      // Todos los embeds van con la FK explícita: una tabla puente nueva entre
      // children y schools/teams (school_sibling_links) vuelve ambiguo un
      // embed sin `!fkey` y PostgREST responde PGRST201 (pasó el 2026-10-14).
      const { data, error } = await supabase
        .from('children')
        .select(`
          *,
          schools!children_school_id_fkey(name),
          teams!children_team_id_fkey(
            name, sport, level,
            coach:coach_id(full_name)
          ),
          enrollments!enrollments_child_id_fkey(
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

      // Deduplicar por child.id (los JOINs a teams vía children.team_id y
      // enrollments.team_id pueden repetir filas).
      const seen = new Set<string>();
      return ((data || []) as unknown as Hijo[]).filter((child) => {
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
  // para el mismo deportista (la ficha de la escuela y la del acudiente).
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

  const invitaciones = (pendingInvitations || []) as unknown as InvitacionPendiente[];
  const invitacionPendiente = invitaciones[0];

  // Nombres que el acudiente NO puede volver a crear: los hijos que ya tiene y
  // los que vienen en invitaciones sin aceptar.
  const nombresTomados = [
    ...(children || []).map((c) => c.full_name),
    ...invitaciones.map((i) => i.child_name),
  ].filter(Boolean) as string[];

  const hijos = children || [];

  return (
    <div className="mx-auto w-full max-w-page-narrow space-y-4 animate-in fade-in duration-500">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium text-muted-foreground">Tus hijos</p>
        <Button variant="ghost" className="min-h-touch" onClick={() => setShowAddDialog(true)}>
          <Plus className="mr-1 h-4 w-4" aria-hidden="true" />
          Agregar hijo
        </Button>
      </div>

      {/* Sin escuela: unirse con el código de la escuela (spec codigo-de-escuela). */}
      <JoinSchoolCodeBanner />

      {invitacionPendiente && (
        <div className="flex items-start gap-3 rounded-2xl border border-primary/30 bg-primary/5 p-4 text-sm">
          <School className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
          <div>
            <p className="font-semibold">
              {invitacionPendiente.schools?.name || 'Tu escuela'} ya cargó a
              {invitacionPendiente.child_name ? ` ${invitacionPendiente.child_name}` : ' tu hijo'}
            </p>
            <p className="mt-1 text-muted-foreground">
              Acepta la invitación desde tu inicio y aparecerá aquí con su plan y su equipo.
              No lo registres a mano: quedaría duplicado. Si tienes <strong>otro</strong> hijo
              que la escuela no cargó, ese sí puedes agregarlo.
            </p>
            <Button asChild variant="outline" className="mt-3 min-h-touch">
              <Link to="/dashboard">Ir a aceptar la invitación</Link>
            </Button>
          </div>
        </div>
      )}

      {isLoading ? (
        <SectionSkeleton rows={4} label="Cargando tus hijos" />
      ) : error ? (
        <ErrorState
          title="No pudimos cargar a tus hijos"
          message="Hubo un problema al traer la información. Intenta de nuevo."
          onRetry={() => refetch()}
        />
      ) : hijos.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed px-4 py-10 text-center">
          <Users className="h-10 w-10 text-muted-foreground opacity-40" aria-hidden="true" />
          <p className="font-medium">Todavía no tienes hijos registrados.</p>
          <p className="max-w-prose-ui text-sm text-muted-foreground">
            Si la escuela ya te invitó, acepta la invitación desde tu inicio. Si no, regístralo tú.
          </p>
          <Button className="min-h-touch" onClick={() => setShowAddDialog(true)}>
            <Plus className="mr-1 h-4 w-4" aria-hidden="true" />
            Registrar a mi hijo
          </Button>
        </div>
      ) : (
        <HijosV2
          hijos={hijos}
          onEdit={setEditingChild}
          onUploadDocs={setUploadingDocsFor}
          // Pausa / retiro / reactivación del plan (BFF /plan-requests) y soportes del
          // deportista. Cada bloque se oculta solo si la escuela no tiene la función.
          fichaExtra={(hijo) => <BloqueFamiliaHijo hijo={hijo} />}
        />
      )}

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
          child={editingChild as ComponentProps<typeof EditChildDialog>['child']}
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
