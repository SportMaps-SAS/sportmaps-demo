/**
 * Pantalla V2 del dueño «Carnets, constancias y QR» (spec docs/specs/carnet-3d-club.md §12;
 * lienzo DueCarnets / DuePCCarnets). Reemplaza en el menú las cuatro entradas V1
 * (Carnets Digitales, Plantillas de Carnets, Constancias, QR de Inscripción); las rutas V1
 * siguen vivas para lo avanzado y se enlazan desde aquí.
 *
 * Celular: una columna, el carnet arriba. Computador: secciones a la izquierda y el
 * carnet fijo a la derecha. Cada sección se oculta si su módulo está apagado.
 */
import { Loader2, Lock } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useSchoolContext } from '@/hooks/useSchoolContext';
import { useEntitlements } from '@/hooks/useEntitlements';
import { MODULE_CATALOG, type ModuleKey } from '@/config/module-catalog';
import { seccionesVisibles } from '@/lib/cards/carnetsV2Model';
import { CarnetClubPreview } from '@/components/school/carnets-v2/CarnetClubPreview';
import { SeccionCarnets } from '@/components/school/carnets-v2/SeccionCarnets';
import { SeccionConstancias } from '@/components/school/carnets-v2/SeccionConstancias';
import { SeccionQrInscripcion } from '@/components/school/carnets-v2/SeccionQrInscripcion';
import { SeccionReglas } from '@/components/school/carnets-v2/SeccionReglas';

export default function CarnetsConstanciasQRPage() {
  const { profile } = useAuth();
  const { schoolId, currentUserRole, loading: cargandoEscuela } = useSchoolContext();
  const { isLoading: cargandoPlan, hasAddon, isModuleEnabled } = useEntitlements();

  const moduloActivo = (k: ModuleKey) => {
    const def = MODULE_CATALOG[k];
    return (!def.addon || hasAddon(def.addon)) && isModuleEnabled(k);
  };
  const ver = seccionesVisibles(currentUserRole || profile?.role, moduloActivo);

  if (cargandoEscuela || cargandoPlan) {
    return (
      <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-label="Cargando" /></div>
    );
  }

  if (!schoolId) {
    return (
      <div className="mx-auto max-w-md px-4 py-16 text-center text-muted-foreground">
        Elige una escuela para ver sus carnets y constancias.
      </div>
    );
  }

  if (ver.ninguna) {
    return (
      <div className="mx-auto mt-8 max-w-md rounded-2xl border bg-card p-10 text-center">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10">
          <Lock className="h-7 w-7 text-primary" aria-hidden="true" />
        </div>
        <h1 className="text-xl font-bold">Carnets, constancias y QR</h1>
        <p className="mt-2 text-muted-foreground">
          Esta sección no está disponible para tu escuela. Si crees que es un error, contacta a soporte.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-4 md:px-8 md:py-8">
      <header className="mb-4 flex flex-col gap-1 md:mb-6">
        <span className="hidden text-xs text-muted-foreground md:block">Documentos e Identidad</span>
        <h1 className="text-[19px] font-bold leading-tight md:text-3xl md:tracking-tight">Carnets, constancias y QR</h1>
      </header>

      <div className="flex flex-col gap-3.5 lg:grid lg:grid-cols-[minmax(0,1fr)_380px] lg:items-start lg:gap-6">
        <aside className="lg:sticky lg:top-6 lg:col-start-2 lg:row-start-1">
          <CarnetClubPreview schoolId={schoolId} mostrarDatos={ver.carnets} />
        </aside>

        <div className="flex flex-col gap-3.5 lg:col-start-1 lg:row-start-1 xl:grid xl:grid-cols-2 xl:items-start xl:gap-4">
          {ver.carnets && <SeccionCarnets schoolId={schoolId} />}
          {ver.constancias && <SeccionConstancias schoolId={schoolId} />}
          {ver.carnets && <SeccionReglas schoolId={schoolId} />}
          {ver.qr && <SeccionQrInscripcion schoolId={schoolId} />}
        </div>
      </div>
    </div>
  );
}
