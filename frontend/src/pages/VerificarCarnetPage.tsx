/**
 * /verificar-carnet — página PÚBLICA (sin sesión) para digitar el código
 * impreso en el carnet (`SM-AAAA-NNNNN`). Acepta `?codigo=` para llegar ya
 * con el código escrito.
 */
import { useSearchParams } from 'react-router-dom';
import { IdCard } from 'lucide-react';
import { VerificarPorCodigo } from '@/components/cards/VerificarPorCodigo';

export default function VerificarCarnetPage() {
  const [params] = useSearchParams();
  const codigo = params.get('codigo') ?? '';
  return (
    <div className="flex min-h-screen flex-col items-center bg-slate-100 px-4 py-10">
      <div className="w-full max-w-sm space-y-5">
        <header className="space-y-2 text-center">
          <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <IdCard className="h-6 w-6" aria-hidden="true" />
          </span>
          <h1 className="text-2xl font-bold text-gray-900">Verificar un carnet</h1>
          <p className="text-sm text-muted-foreground">
            Escribe el código que está impreso en el carnet. Te decimos si es válido y de qué club es.
          </p>
        </header>
        <div className="rounded-2xl border bg-white p-4">
          <VerificarPorCodigo codigoInicial={codigo} />
        </div>
        <p className="text-center text-xs text-muted-foreground">
          Para ver el carnet completo, escanea el código QR con la cámara del celular.
        </p>
      </div>
    </div>
  );
}
