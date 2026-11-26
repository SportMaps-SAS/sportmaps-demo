/**
 * Arriba de la pantalla: «Así se ve el carnet de tus deportistas» (carnet 3D con un
 * deportista de ejemplo) + «Identidad del club» y «Datos del carnet».
 * Sin complemento Marca propia (D3): diseño base de SportMaps y llamado a activarlo.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AthleteCard3D } from '@/components/cards/AthleteCard3D';
import { IdentidadClubDialog } from '@/components/cards/IdentidadClubDialog';
import { supabase } from '@/integrations/supabase/client';
import { useSchoolContext } from '@/hooks/useSchoolContext';
import { resolverIdentidad, type BrandingSettingsCarnet } from '@/lib/cards/clubIdentity';
import { deportistaDeEjemplo } from '@/lib/cards/carnetsV2Model';
import { DatosCarnetDialog } from './DatosCarnetDialog';

type Escuela = { name: string; logo_url: string | null; branding_settings: BrandingSettingsCarnet | null };

export function CarnetClubPreview({ schoolId, mostrarDatos }: { schoolId: string; mostrarDatos: boolean }) {
  const { refreshSchoolBranding } = useSchoolContext();
  const [escuela, setEscuela] = useState<Escuela | null>(null);
  const [identidadAbierta, setIdentidadAbierta] = useState(false);
  const [datosAbierto, setDatosAbierto] = useState(false);

  const cargar = useCallback(async () => {
    const { data } = await supabase.from('schools').select('name, logo_url, branding_settings').eq('id', schoolId).maybeSingle();
    setEscuela((data as Escuela | null) ?? { name: '', logo_url: null, branding_settings: null });
  }, [schoolId]);

  useEffect(() => { void cargar(); }, [cargar]);

  const datos = useMemo(
    () => (escuela ? deportistaDeEjemplo(resolverIdentidad(escuela, true)) : null),
    [escuela],
  );

  return (
    <section aria-labelledby="carnet-club-titulo" className="flex flex-col gap-3 rounded-2xl border bg-card p-3.5">
      <h2 id="carnet-club-titulo" className="text-[17px] font-semibold leading-snug">Así se ve el carnet de tus deportistas</h2>

      <div className="flex min-h-[300px] items-center justify-center">
        {!datos ? (
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-label="Cargando el carnet" />
        ) : (
          <AthleteCard3D datos={datos} modo="interactivo" ancho={216} />
        )}
      </div>


      <div className={mostrarDatos ? 'grid grid-cols-2 gap-2' : 'grid grid-cols-1 gap-2'}>
        <Button className="min-h-12 rounded-xl" onClick={() => setIdentidadAbierta(true)}>Identidad del club</Button>
        {mostrarDatos && (
          <Button variant="outline" className="min-h-12 rounded-xl" onClick={() => setDatosAbierto(true)}>Datos del carnet</Button>
        )}
      </div>

      <IdentidadClubDialog
        schoolId={schoolId}
        open={identidadAbierta}
        onOpenChange={setIdentidadAbierta}
        onGuardado={() => { void cargar(); void refreshSchoolBranding(); }}
        renderVistaPrevia={(identidad) => <AthleteCard3D datos={deportistaDeEjemplo(identidad)} modo="interactivo" ancho={200} />}
      />
      {mostrarDatos && <DatosCarnetDialog schoolId={schoolId} open={datosAbierto} onOpenChange={setDatosAbierto} />}
    </section>
  );
}
