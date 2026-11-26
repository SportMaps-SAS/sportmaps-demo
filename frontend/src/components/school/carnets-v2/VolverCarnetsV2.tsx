import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';

/**
 * Enlace de regreso a la pantalla V2 «Carnets, constancias y QR». Lo llevan las
 * pantallas V1 (carnets, constancias, plantillas, QR de inscripción), que ya no
 * están en el menú y se abren desde la V2: sin esto no había cómo volver.
 */
export function VolverCarnetsV2({ className = '' }: { className?: string }) {
  return (
    <Link
      to="/carnets-constancias"
      className={`inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground ${className}`}
    >
      <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Carnets, constancias y QR
    </Link>
  );
}
