/**
 * Configuración + informe de referidos juntos: el único punto de enganche en
 * la página de configuración de pagos (Pagos → Config).
 */
import { CampanaReferidosConfig } from './CampanaReferidosConfig';
import { InformeReferidos } from './InformeReferidos';

export function ReferidosPanel({
  schoolId, puedeCrear = false, puedeEditar = true,
}: { schoolId: string; puedeCrear?: boolean; puedeEditar?: boolean }) {
  return (
    <div className="space-y-4 md:col-span-2 empty:hidden">
      <CampanaReferidosConfig schoolId={schoolId} puedeCrear={puedeCrear} puedeEditar={puedeEditar} />
      <InformeReferidos schoolId={schoolId} />
    </div>
  );
}
