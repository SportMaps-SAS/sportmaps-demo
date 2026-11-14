/**
 * Secciones de la ficha del deportista (administración): soportes y «referido
 * por». Un solo punto de enganche en SchoolStudentsManagementPage. Con la
 * función apagada (soportes sin `activo`, campaña apagada y sin referente) no
 * pinta nada.
 */
import { ReferidoFicha } from '@/components/referidos/ReferidoFicha';
import { SoportesFicha } from '@/components/soportes/SoportesFicha';
import { tipoSujetoDeAtleta } from '@/lib/api/soportes';

export function FichaDeportistaExtras({
  schoolId, athleteId, athleteType, enrollmentId, puedeAdministrar,
}: {
  schoolId: string;
  athleteId: string;
  athleteType: 'child' | 'adult' | 'unregistered';
  enrollmentId?: string | null;
  puedeAdministrar: boolean;
}) {
  if (!puedeAdministrar) return null;
  return (
    <>
      <SoportesFicha schoolId={schoolId} tipoSujeto={tipoSujetoDeAtleta(athleteType)} sujetoId={athleteId} />
      <ReferidoFicha schoolId={schoolId} enrollmentId={enrollmentId} puedeEditar />
    </>
  );
}
