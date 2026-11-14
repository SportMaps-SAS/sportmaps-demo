/** Insignia «Soportes X/7» y el interruptor del filtro «Faltan soportes». */
import { FileCheck2, FileWarning } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { textoInsignia, type DeportistaSoportes } from '@/lib/api/soportes';

export function SoportesInsignia({ d, className = '' }: { d: DeportistaSoportes | undefined | null; className?: string }) {
  if (!d) return null;
  const texto = textoInsignia(d);
  const completo = d.complete;
  return (
    <Badge
      variant="outline"
      className={`gap-1 py-0 h-5 text-[10px] ${
        completo
          ? 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-500/40 dark:bg-emerald-950/20 dark:text-emerald-400'
          : 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-500/40 dark:bg-amber-950/20 dark:text-amber-400'
      } ${className}`}
      aria-label={completo ? `${texto}: completos` : `${texto}: faltan ${d.missing.length}`}
      title={completo ? 'Tiene todos los soportes' : `Faltan ${d.missing.length} soporte(s)`}
    >
      {completo ? <FileCheck2 className="h-2.5 w-2.5" aria-hidden /> : <FileWarning className="h-2.5 w-2.5" aria-hidden />}
      {texto}
    </Badge>
  );
}

export function SoportesFiltroToggle({
  activo, onChange, faltan,
}: { activo: boolean; onChange: (v: boolean) => void; faltan: number }) {
  return (
    <Button
      type="button"
      variant={activo ? 'default' : 'outline'}
      size="sm"
      onClick={() => onChange(!activo)}
      aria-pressed={activo}
      className="gap-1.5 sm:self-center"
    >
      <FileWarning className="h-4 w-4" aria-hidden />
      Faltan soportes{faltan > 0 ? ` (${faltan})` : ''}
    </Button>
  );
}
