/**
 * Pestaña «Hijos» del acudiente — rediseño V2 (tablero AcuHijos).
 *
 * Arriba: selector de hijo (solo con más de uno), avatar, nombre y
 * «Fútbol Sub 11 · 10 años · Profe Laura». Debajo, cuatro pestañas.
 * El hijo va en `?hijo=<id>` y la pestaña en `?tab=` para poder enlazar desde
 * Inicio (p. ej. /children?hijo=…&tab=asistencia).
 */
import type { ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { firstName, hijoSubtitle, initials, type Hijo } from './hijosUtils';
import { fotoDeVerdad } from '../parentHomeLogic';
import { ProgresoTab } from './ProgresoTab';
import { AsistenciaTab } from './AsistenciaTab';
import { InformesTab } from './InformesTab';
import { FichaSaludTab } from './FichaSaludTab';

export const HIJOS_TABS = [
  { value: 'progreso', label: 'Progreso', corto: 'Progreso' },
  { value: 'asistencia', label: 'Asistencia', corto: 'Asistencia' },
  { value: 'informes', label: 'Informes', corto: 'Informes' },
  // A 390 px «Ficha y salud» se cortaba («Ficha y salu…»): en celular dice «Ficha».
  { value: 'ficha', label: 'Ficha y salud', corto: 'Ficha' },
] as const;

export type HijosTab = (typeof HIJOS_TABS)[number]['value'];

const isTab = (v: string | null): v is HijosTab => HIJOS_TABS.some((t) => t.value === v);

interface Props {
  hijos: Hijo[];
  onEdit: (hijo: Hijo) => void;
  onUploadDocs: (hijo: Hijo) => void;
  /** Contenido extra al final de «Ficha y salud» para el hijo elegido. */
  fichaExtra?: (hijo: Hijo) => ReactNode;
}

export function HijosV2({ hijos, onEdit, onUploadDocs, fichaExtra }: Props) {
  const [params, setParams] = useSearchParams();
  const hijoParam = params.get('hijo') ?? params.get('childId');
  const tabParam = params.get('tab');

  const hijo = hijos.find((h) => h.id === hijoParam) ?? hijos[0];
  const tab: HijosTab = isTab(tabParam) ? tabParam : 'progreso';

  const update = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params);
    next.delete('childId');
    for (const [k, v] of Object.entries(patch)) next.set(k, v);
    setParams(next, { replace: true });
  };

  if (!hijo) return null;

  return (
    <div className="space-y-4">
      {hijos.length > 1 && (
        <div
          role="radiogroup"
          aria-label="Elige a tu hijo"
          className="flex gap-2 overflow-x-auto whitespace-nowrap scrollbar-none"
        >
          {hijos.map((h) => {
            const sel = h.id === hijo.id;
            return (
              <button
                key={h.id}
                type="button"
                role="radio"
                aria-checked={sel}
                onClick={() => update({ hijo: h.id })}
                className={cn(
                  'min-h-touch shrink-0 rounded-full border px-4 text-sm font-medium transition-colors motion-safe:active:scale-[0.97]',
                  sel
                    ? 'border-foreground bg-foreground text-background'
                    : 'border-border bg-card text-foreground hover:bg-muted',
                )}
              >
                {firstName(h.full_name)}
              </button>
            );
          })}
        </div>
      )}

      <div className="flex items-center gap-3">
        <Avatar className="h-14 w-14 shrink-0">
          {fotoDeVerdad(hijo.avatar_url) && (
            <AvatarImage src={fotoDeVerdad(hijo.avatar_url)!} alt="" className="object-cover" />
          )}
          <AvatarFallback className="bg-primary/10 text-base font-semibold text-primary">
            {initials(hijo.full_name)}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0">
          <h1 className="truncate text-xl font-semibold">{hijo.full_name}</h1>
          <p className="truncate text-sm text-muted-foreground">{hijoSubtitle(hijo) || 'Sin equipo asignado todavía'}</p>
        </div>
      </div>

      <Tabs value={tab} onValueChange={(v) => update({ tab: v })}>
        <TabsList className="h-tabs w-full justify-start md:h-10 md:w-auto">
          {HIJOS_TABS.map((t) => (
            <TabsTrigger key={t.value} value={t.value} aria-label={t.label} className="min-h-9 flex-1 px-2 md:flex-none md:px-3">
              <span className="md:hidden">{t.corto}</span>
              <span className="hidden md:inline">{t.label}</span>
            </TabsTrigger>
          ))}
        </TabsList>

        {/* `key` por hijo: al cambiar de hijo cada pestaña arranca limpia. */}
        <TabsContent value="progreso" className="mt-4">
          <ProgresoTab key={hijo.id} hijo={hijo} />
        </TabsContent>
        <TabsContent value="asistencia" className="mt-4">
          <AsistenciaTab key={hijo.id} hijo={hijo} />
        </TabsContent>
        <TabsContent value="informes" className="mt-4">
          <InformesTab key={hijo.id} hijo={hijo} />
        </TabsContent>
        <TabsContent value="ficha" className="mt-4">
          <FichaSaludTab
            key={hijo.id}
            hijo={hijo}
            onEdit={() => onEdit(hijo)}
            onUploadDocs={() => onUploadDocs(hijo)}
            extra={fichaExtra?.(hijo)}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
