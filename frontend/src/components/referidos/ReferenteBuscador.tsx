/**
 * Buscador de «quién refirió»: familias y deportistas de la escuela, o texto
 * libre si no está. Es solo la selección; registrar el referido es otro paso.
 */
import { useEffect, useState } from 'react';
import { Loader2, Search, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { studentsAPI } from '@/lib/api/students';
import type { ReferenteElegido } from '@/lib/api/referidos';

interface Candidato {
  id: string;
  full_name: string;
  enrollment_id?: string | null;
  team_name?: string | null;
  parent_name?: string | null;
}

/** Del resultado de la búsqueda a lo que se envía al BFF. */
export function referenteDesdeCandidato(c: Candidato): ReferenteElegido {
  return c.enrollment_id
    ? { enrollmentId: c.enrollment_id, nombre: c.full_name }
    // Sin inscripción activa no hay dónde aplicar el descuento: queda como texto
    // hasta que la administración lo vincule.
    : { texto: c.full_name, nombre: c.full_name };
}

export function ReferenteBuscador({
  schoolId, valor, onChange, etiqueta = '¿Quién lo refirió? (opcional)', idCampo = 'referente-buscar', excluirEnrollmentId,
}: {
  schoolId: string;
  valor: ReferenteElegido | null;
  onChange: (v: ReferenteElegido | null) => void;
  etiqueta?: string;
  idCampo?: string;
  excluirEnrollmentId?: string | null;
}) {
  const [termino, setTermino] = useState('');
  const [resultados, setResultados] = useState<Candidato[]>([]);
  const [buscando, setBuscando] = useState(false);
  const [falloBusqueda, setFalloBusqueda] = useState(false);

  useEffect(() => {
    const t = termino.trim();
    if (t.length < 2) { setResultados([]); setFalloBusqueda(false); return; }
    let vivo = true;
    setBuscando(true);
    const h = setTimeout(async () => {
      try {
        const rows = (await studentsAPI.searchAthletes(schoolId, t)) as unknown as Candidato[];
        if (vivo) { setResultados((rows ?? []).filter((r) => !excluirEnrollmentId || r.enrollment_id !== excluirEnrollmentId).slice(0, 8)); setFalloBusqueda(false); }
      } catch {
        if (vivo) { setResultados([]); setFalloBusqueda(true); }
      } finally {
        if (vivo) setBuscando(false);
      }
    }, 300);
    return () => { vivo = false; clearTimeout(h); };
  }, [termino, schoolId, excluirEnrollmentId]);

  if (valor) {
    return (
      <div className="space-y-1.5">
        <label className="text-sm font-medium">{etiqueta}</label>
        <div className="flex items-center justify-between gap-2 rounded-md border bg-muted/30 px-3 py-2" data-testid="referente-elegido">
          <span className="text-sm min-w-0 break-words">
            {valor.nombre}
            {!valor.enrollmentId && !valor.profileId && (
              <span className="block text-xs text-muted-foreground">Queda sin confirmar hasta que la administración lo vincule.</span>
            )}
          </span>
          <Button type="button" variant="ghost" size="sm" onClick={() => onChange(null)} aria-label="Quitar a quien lo refirió" className="shrink-0">
            <X className="h-4 w-4" aria-hidden />
          </Button>
        </div>
      </div>
    );
  }

  const t = termino.trim();
  return (
    <div className="space-y-1.5">
      <label htmlFor={idCampo} className="text-sm font-medium">{etiqueta}</label>
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" aria-hidden />
        <Input
          id={idCampo}
          value={termino}
          onChange={(e) => setTermino(e.target.value)}
          placeholder="Nombre de la familia o del deportista"
          className="pl-9"
          autoComplete="off"
        />
        {buscando && <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin" aria-label="Buscando" />}
      </div>
      {t.length >= 2 && !buscando && (
        <ul className="rounded-md border divide-y max-h-56 overflow-y-auto" role="listbox" aria-label="Resultados">
          {resultados.map((c) => (
            <li key={`${c.id}-${c.enrollment_id ?? ''}`}>
              <button
                type="button"
                role="option"
                aria-selected={false}
                onClick={() => { onChange(referenteDesdeCandidato(c)); setTermino(''); }}
                className="w-full px-3 py-2 text-left text-sm hover:bg-muted/60"
              >
                <span className="block font-medium break-words">{c.full_name}</span>
                {(c.team_name || c.parent_name) && (
                  <span className="block text-xs text-muted-foreground">{[c.team_name, c.parent_name && `Acudiente: ${c.parent_name}`].filter(Boolean).join(' · ')}</span>
                )}
              </button>
            </li>
          ))}
          {resultados.length === 0 && (
            <li className="px-3 py-2 text-xs text-muted-foreground">
              {falloBusqueda ? 'No se pudo buscar ahora.' : 'No encontramos a nadie con ese nombre en la escuela.'}
            </li>
          )}
          <li>
            <button
              type="button"
              onClick={() => { onChange({ texto: t, nombre: t }); setTermino(''); }}
              className="w-full px-3 py-2 text-left text-sm text-primary hover:bg-muted/60"
            >
              Usar «{t}» como texto (no está en la escuela)
            </button>
          </li>
        </ul>
      )}
    </div>
  );
}
