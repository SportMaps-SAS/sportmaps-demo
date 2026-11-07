/**
 * Altas del entrenador en la V2: inscribir deportistas en su equipo, crear uno
 * nuevo y crear un equipo. SOLO en escuelas que lo activaron:
 *
 *   · Inscribir / Nuevo deportista → `coach_can_create_athletes` (Carmel).
 *   · Crear equipo                 → `coach_can_create_teams`    (Carmel).
 *
 * Por qué existe (Carmel, 2026-11-07): la V2 del entrenador (10-25) cambió
 * /teams por CoachTeamsV2, que no traía ninguno de los tres botones. Los
 * permisos seguían prendidos en la base y el BFF los seguía aceptando, pero el
 * profe ya no tenía por dónde llegar: «Mis deportistas» quedó escondido detrás
 * de «Ver ficha», y en un equipo vacío no hay ficha que abrir.
 *
 * Reutiliza los mismos modales de la pantalla clásica (EnrollTeamStudentModal,
 * CreateChildModal, CreateTeamModal): el gate real sigue en el BFF y en RLS.
 * Se cargan perezosos y solo al abrirlos, para no engordar la V2 de todos.
 */
import { lazy, Suspense, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Plus, UserPlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useEntitlements } from '@/hooks/useEntitlements';

const EnrollTeamStudentModal = lazy(() =>
  import('@/components/teams/EnrollTeamStudentModal').then((m) => ({ default: m.EnrollTeamStudentModal })));
const CreateChildModal = lazy(() =>
  import('@/components/students/CreateChildModal').then((m) => ({ default: m.CreateChildModal })));
const CreateTeamModal = lazy(() =>
  import('@/components/teams/CreateTeamModal').then((m) => ({ default: m.CreateTeamModal })));

/** Tras inscribir o crear: listas de equipos y deportistas de la V2 (y la clásica). */
function useRefrescarEquipos() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['coach-v2'] });
    void qc.invalidateQueries({ queryKey: ['coach-teams'] });
  };
}

interface EquipoAlta {
  id: string;
  nombre: string;
  deporte?: string | null;
  deportistas?: number;
}

/**
 * «Inscribir deportistas» (los que ya están en la escuela) y «Nuevo
 * deportista» (ficha nueva, ya con este equipo elegido). Nada si la escuela no
 * lo activó.
 */
export function BotonesAltaDeportista({ schoolId, equipo, className }: { schoolId: string; equipo: EquipoAlta; className?: string }) {
  const puede = useEntitlements().coachCanCreateAthletes === true;
  const refrescar = useRefrescarEquipos();
  const [inscribir, setInscribir] = useState(false);
  const [nuevo, setNuevo] = useState(false);
  if (!puede) return null;

  return (
    <div className={cn('grid grid-cols-2 gap-2', className)} data-testid="altas-deportista">
      <Button variant="outline" className="min-h-touch rounded-xl text-sm font-semibold" onClick={() => setInscribir(true)}>
        <UserPlus className="mr-1.5 h-4 w-4" aria-hidden /> Inscribir deportistas
      </Button>
      <Button variant="outline" className="min-h-touch rounded-xl text-sm font-semibold" onClick={() => setNuevo(true)}>
        <Plus className="mr-1.5 h-4 w-4" aria-hidden /> Nuevo deportista
      </Button>

      {inscribir && (
        <Suspense fallback={null}>
          <EnrollTeamStudentModal
            open
            onClose={() => { setInscribir(false); refrescar(); }}
            onSuccess={refrescar}
            team={{ id: equipo.id, name: equipo.nombre, sport: equipo.deporte ?? undefined, current_students: equipo.deportistas, school_id: schoolId }}
          />
        </Suspense>
      )}
      {nuevo && (
        <Suspense fallback={null}>
          <CreateChildModal
            open
            onClose={() => setNuevo(false)}
            onSuccess={() => { setNuevo(false); refrescar(); }}
            schoolId={schoolId}
            defaultTeamId={equipo.id}
            // El coach no exonera cobros ni usa hermanos (el BFF también lo frena).
            canWaiveFees={false}
          />
        </Suspense>
      )}
    </div>
  );
}

/** «Crear equipo». Nada si la escuela no lo activó. */
export function BotonCrearEquipo({ schoolId, branchId, className }: { schoolId: string; branchId?: string | null; className?: string }) {
  const puede = useEntitlements().coachCanCreateTeams === true;
  const refrescar = useRefrescarEquipos();
  const [abierto, setAbierto] = useState(false);
  if (!puede) return null;

  return (
    <>
      <Button className={cn('min-h-touch rounded-xl text-sm font-semibold', className)} onClick={() => setAbierto(true)} data-testid="crear-equipo">
        <Plus className="mr-1.5 h-4 w-4" aria-hidden /> Crear equipo
      </Button>
      {abierto && (
        <Suspense fallback={null}>
          <CreateTeamModal
            open
            onClose={() => setAbierto(false)}
            onSuccess={() => { setAbierto(false); refrescar(); }}
            schoolId={schoolId}
            branchId={branchId}
          />
        </Suspense>
      )}
    </>
  );
}
