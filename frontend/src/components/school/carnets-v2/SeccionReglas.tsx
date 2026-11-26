/** Sección «Al escanear el carnet»: abre «Reglas para entrar» (F5). */
import { useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ReglasParaEntrar } from '@/components/cards/ReglasParaEntrar';
import { FilaV2, PuntosSemaforo, SeccionV2 } from './SeccionV2';

export function SeccionReglas({ schoolId }: { schoolId: string }) {
  const [abierta, setAbierta] = useState(false);
  return (
    <SeccionV2 titulo="Al escanear el carnet" id="sec-reglas">
      <FilaV2
        titulo="Reglas para entrar"
        detalle="Lo que se revisa cuando el club escanea el carnet"
        icono={<PuntosSemaforo />}
        onClick={() => setAbierta(true)}
      />
      <Dialog open={abierta} onOpenChange={setAbierta}>
        <DialogContent className="max-h-[90vh] max-w-md overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Reglas para entrar</DialogTitle>
            <DialogDescription>
              Cuando alguien del club escanea el carnet, ve en vivo si el deportista puede entrar. Elige qué se revisa.
            </DialogDescription>
          </DialogHeader>
          <ReglasParaEntrar schoolId={schoolId} />
        </DialogContent>
      </Dialog>
    </SeccionV2>
  );
}
