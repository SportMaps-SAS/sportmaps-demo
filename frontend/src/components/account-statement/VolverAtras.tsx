/**
 * «Volver» de una pantalla interna que se abre desde otra (el estado de cuenta
 * de un deportista, que se abre desde el Ciclo de Mes, desde Deportistas…).
 *
 * Regresa a la pantalla anterior de la app. Si se llegó directo (un enlace, una
 * pestaña nueva) y no hay historial dentro de la app, va a `destino`.
 * `location.key === 'default'` es la señal de React Router de «primera entrada
 * de la sesión»: más fiable que `window.history.length`, que también cuenta
 * lo que pasó fuera de la app.
 */
import { useLocation, useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';

export interface VolverAtrasProps {
  /** A dónde ir si no hay pantalla anterior dentro de la app. */
  destino: string;
  /** «Volver» por defecto; p. ej. «Volver a Pagos». */
  etiqueta?: string;
}

export function VolverAtras({ destino, etiqueta = 'Volver' }: VolverAtrasProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const volver = () => {
    if (location.key !== 'default') navigate(-1);
    else navigate(destino);
  };
  return (
    <button
      type="button"
      onClick={volver}
      className="mb-3 inline-flex min-h-touch items-center gap-2 rounded-lg pr-3 text-sm font-medium text-muted-foreground hover:text-foreground print:hidden"
    >
      <ArrowLeft className="h-4 w-4" aria-hidden="true" />
      {etiqueta}
    </button>
  );
}
