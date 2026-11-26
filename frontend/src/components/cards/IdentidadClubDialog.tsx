/**
 * Ventana «Identidad del club» («Datos y marca» ampliada, carnet 3D F2).
 * Props: IdentidadClubDialogProps (lib/cards/contratos.ts). Celular primero:
 * una columna, vista previa abajo.
 */
import type { ReactNode } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { IdentidadClubDialogProps } from '@/lib/cards/contratos';
import type { ClubIdentidad } from '@/lib/cards/clubIdentity';
import { IdentidadClubEditor } from './IdentidadClubEditor';

export function IdentidadClubDialog({
  schoolId,
  open,
  onOpenChange,
  onGuardado,
  renderVistaPrevia,
}: IdentidadClubDialogProps & {
  /** Opcional (fuera del contrato): el carnet 3D para la vista previa. */
  renderVistaPrevia?: (identidad: ClubIdentidad) => ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92dvh] w-[calc(100vw-1.5rem)] max-w-lg overflow-y-auto p-4 sm:p-6">
        <DialogHeader>
          <DialogTitle>Identidad del club</DialogTitle>
          <DialogDescription>Colores y escudo que salen en el carnet.</DialogDescription>
        </DialogHeader>
        {open && (
          <IdentidadClubEditor
            schoolId={schoolId}
            onGuardado={onGuardado}
            renderVistaPrevia={renderVistaPrevia}
            compacto
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

export default IdentidadClubDialog;
