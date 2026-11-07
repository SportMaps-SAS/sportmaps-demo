/**
 * Equipos › Deportistas. Lista con buscador; al tocar a alguien se abren tres
 * acciones: Escribir al acudiente (WhatsApp), Felicitar (si existe give_kudos)
 * y Ver ficha.
 *
 * Pago (decisión 5): solo el chip «Al día · Pendiente · Vencido» de la RPC
 * `team_payment_status`. Sin la RPC, o si la escuela oculta lo financiero al
 * profe (coach_hide_financial_info), no hay chip. Nunca montos ni conceptos.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { MessageCircle, Search, Star, IdCard } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle,
} from '@/components/ui/drawer';
import { cn } from '@/lib/utils';
import { useEntitlements } from '@/hooks/useEntitlements';
import { useSchoolAthleteAvailability } from '@/hooks/useSchoolAthleteAvailability';
import { AVAILABILITY_LABEL, AVAILABILITY_TONE } from '@/lib/clinical/labels';
import type { SchoolAthleteAvailability } from '@/lib/clinical/types';
import { InlineError, SectionSkeleton, EmptyNote } from '@/components/parent/v2/hijos/parts';
import {
  ETIQUETA_PAGO,
  estadoPagoDe,
  iniciales,
  primerNombre,
  whatsappAcudiente,
  type Deportista,
  type EstadoPago,
  type RutasCoachV2,
} from '../coachV2Logic';
import { useDeportistasEquipo, useEstadoPagoEquipo } from '../useCoachV2Data';
import type { ObjetivoFelicitar } from '../felicitar';
import { BotonesAltaDeportista } from './AltasDelProfe';

const TONO_PAGO: Record<EstadoPago, string> = {
  al_dia: 'bg-primary/10 text-primary',
  pendiente: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300',
  vencido: 'bg-red-100 text-red-800 dark:bg-red-950/60 dark:text-red-300',
};

export function ChipPago({ estado }: { estado: EstadoPago }) {
  return (
    <span data-testid="chip-pago" className={cn('shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold', TONO_PAGO[estado])}>
      {ETIQUETA_PAGO[estado]}
    </span>
  );
}

function ChipSalud({ a }: { a: SchoolAthleteAvailability }) {
  if (a.availability_status === 'disponible') return null;
  const txt = a.restrictions ? `${AVAILABILITY_LABEL[a.availability_status]}: ${a.restrictions}` : AVAILABILITY_LABEL[a.availability_status];
  return (
    <span className={cn('max-w-40 shrink-0 truncate rounded-full border px-2 py-1 text-xs font-semibold', AVAILABILITY_TONE[a.availability_status])} title={txt}>
      {txt}
    </span>
  );
}

interface Props {
  schoolId: string;
  teamId: string;
  nombreProfe?: string | null;
  puedeFelicitar: boolean;
  felicitados: Set<string>;
  onFelicitar: (o: ObjetivoFelicitar) => void;
  rutas: RutasCoachV2;
  /** Nombre, deporte y conteo del equipo: para «Inscribir deportistas» (si la escuela lo activó). */
  equipo?: { nombre: string; deporte?: string | null; deportistas?: number };
}

export function DeportistasTab({ schoolId, teamId, nombreProfe, puedeFelicitar, felicitados, onFelicitar, rutas, equipo }: Props) {
  const { coachHideFinancialInfo, coachCanCreateAthletes } = useEntitlements();
  // Inscribir / Nuevo deportista: solo si la escuela lo activó (coach_can_create_athletes, Carmel).
  const puedeAlta = coachCanCreateAthletes === true;
  const altas = <BotonesAltaDeportista schoolId={schoolId} equipo={{ id: teamId, nombre: equipo?.nombre ?? 'Equipo', deporte: equipo?.deporte, deportistas: equipo?.deportistas }} />;
  const deportistas = useDeportistasEquipo(schoolId, teamId);
  const pago = useEstadoPagoEquipo(teamId, !coachHideFinancialInfo);
  const salud = useSchoolAthleteAvailability(schoolId);
  const [q, setQ] = useState('');
  const [abierto, setAbierto] = useState<string | null>(null);
  const [ficha, setFicha] = useState<Deportista | null>(null);

  const mapaPago = !coachHideFinancialInfo && pago.data?.disponible ? pago.data.mapa : null;
  const saludDe = (d: Deportista) => (d.tipo === 'child' ? salud.byChildId.get(d.id) : salud.byProfileId.get(d.userId ?? d.id)) ?? null;

  const lista = useMemo(() => {
    const t = q.trim().toLowerCase();
    const todos = deportistas.data ?? [];
    return t ? todos.filter((d) => d.nombre.toLowerCase().includes(t)) : todos;
  }, [deportistas.data, q]);

  if (deportistas.isLoading) return <SectionSkeleton rows={6} label="Cargando deportistas" />;
  if (deportistas.isError) return <InlineError message="No pudimos traer a los deportistas del equipo." onRetry={() => deportistas.refetch()} />;
  if ((deportistas.data ?? []).length === 0) {
    return puedeAlta ? (
      <div className="flex flex-col gap-3">
        <EmptyNote>Este equipo todavía no tiene deportistas. Inscribe a los que ya están en la escuela o crea uno nuevo.</EmptyNote>
        {altas}
      </div>
    ) : (
      <EmptyNote>Este equipo todavía no tiene deportistas activos. La escuela los inscribe.</EmptyNote>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {altas}
      <label className="relative block">
        <span className="sr-only">Buscar deportista</span>
        <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Buscar deportista"
          className="h-12 rounded-xl pl-10"
        />
      </label>

      {!coachHideFinancialInfo && pago.isError && (
        <p className="px-1 text-xs text-muted-foreground" data-testid="aviso-pago">No pudimos cargar el estado de pago.</p>
      )}
      {lista.length === 0 ? (
        <EmptyNote>Nadie con «{q}» en este equipo.</EmptyNote>
      ) : (
        <ul className="overflow-hidden rounded-2xl border bg-card">
          {lista.map((d) => {
            const estado = estadoPagoDe(d, mapaPago);
            const s = saludDe(d);
            const open = abierto === d.id;
            const wa = whatsappAcudiente(d.telefonoAcudiente, d.nombre, nombreProfe);
            return (
              <li key={d.id} className="border-t first:border-t-0" data-testid="fila-deportista">
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() => setAbierto(open ? null : d.id)}
                  className={cn('flex min-h-14 w-full items-center gap-3 px-3.5 py-2 text-left', open ? 'bg-muted/50' : 'hover:bg-muted/40')}
                >
                  <Avatar className="h-9 w-9">
                    {d.avatarUrl && <AvatarImage src={d.avatarUrl} alt="" className="object-cover" />}
                    <AvatarFallback className="bg-primary/10 text-xs font-bold text-primary">{iniciales(d.nombre)}</AvatarFallback>
                  </Avatar>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-base">{d.nombre}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {d.tipo === 'child' ? (d.acudiente ? `Acudiente: ${d.acudiente}` : 'Sin acudiente registrado') : d.tipo === 'adult' ? 'Deportista adulto' : 'Sin cuenta todavía'}
                    </span>
                  </span>
                  {s && <ChipSalud a={s} />}
                  {estado && <ChipPago estado={estado} />}
                </button>
                {open && (
                  <div className="flex flex-wrap gap-2 bg-muted/50 px-3.5 pb-3 pl-14">
                    {wa ? (
                      <Button asChild variant="outline" className="min-h-touch rounded-xl text-sm">
                        <a href={wa} target="_blank" rel="noopener noreferrer">
                          <MessageCircle className="mr-1.5 h-4 w-4" aria-hidden />
                          {d.tipo === 'child' ? 'Escribir al acudiente' : 'Escribirle'}
                        </a>
                      </Button>
                    ) : (
                      <span className="flex min-h-touch items-center text-xs text-muted-foreground">Sin celular registrado</span>
                    )}
                    {puedeFelicitar && (
                      felicitados.has(d.id) || (d.userId && felicitados.has(d.userId)) ? (
                        <span className="flex min-h-touch items-center px-2 text-sm font-semibold text-primary">Felicitado hoy</span>
                      ) : (
                        <Button
                          variant="outline"
                          className="min-h-touch rounded-xl border-amber-300 bg-amber-50 text-sm font-semibold text-amber-800 hover:bg-amber-100 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-300"
                          onClick={() => onFelicitar({
                            clave: d.tipo === 'child' ? d.id : (d.userId ?? d.id),
                            nombre: d.nombre,
                            childId: d.tipo === 'child' ? d.id : null,
                            userId: d.tipo === 'adult' ? (d.userId ?? d.id) : null,
                            unregisteredId: d.tipo === 'unregistered' ? d.id : null,
                          })}
                        >
                          <Star className="mr-1.5 h-4 w-4" aria-hidden /> Felicitar
                        </Button>
                      )
                    )}
                    <Button variant="outline" className="min-h-touch rounded-xl text-sm" onClick={() => setFicha(d)}>
                      <IdCard className="mr-1.5 h-4 w-4" aria-hidden /> Ver ficha
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <p className="text-center text-xs text-muted-foreground">
        {mapaPago ? 'Solo ves si está al día; los valores los maneja la escuela.' : 'La ficha muestra contacto, salud y cómo va.'}
      </p>

      <Drawer open={!!ficha} onOpenChange={(o) => !o && setFicha(null)}>
        <DrawerContent className="max-h-sheet font-poppins">
          {ficha && (
            <div className="mx-auto flex w-full max-w-page-narrow flex-col gap-3 overflow-y-auto px-gutter pb-6">
              <DrawerHeader className="px-0 text-left">
                <DrawerTitle className="text-xl font-bold">{ficha.nombre}</DrawerTitle>
                <DrawerDescription className="text-xs">
                  {ficha.tipo === 'child' ? 'Menor de edad' : ficha.tipo === 'adult' ? 'Deportista adulto' : 'Sin cuenta todavía'}
                </DrawerDescription>
              </DrawerHeader>
              <dl className="divide-y overflow-hidden rounded-2xl border bg-card text-sm">
                <div className="flex min-h-touch items-center justify-between gap-3 px-4 py-2">
                  <dt className="text-muted-foreground">Acudiente</dt>
                  <dd className="text-right font-medium">{ficha.acudiente ?? '—'}</dd>
                </div>
                <div className="flex min-h-touch items-center justify-between gap-3 px-4 py-2">
                  <dt className="text-muted-foreground">Salud</dt>
                  <dd className="text-right font-medium">
                    {(() => {
                      const s = saludDe(ficha);
                      if (!s) return 'Sin avisos';
                      return s.restrictions ? `${AVAILABILITY_LABEL[s.availability_status]} · ${s.restrictions}` : AVAILABILITY_LABEL[s.availability_status];
                    })()}
                  </dd>
                </div>
                {(() => {
                  const e = estadoPagoDe(ficha, mapaPago);
                  return e ? (
                    <div className="flex min-h-touch items-center justify-between gap-3 px-4 py-2">
                      <dt className="text-muted-foreground">Pagos</dt>
                      <dd><ChipPago estado={e} /></dd>
                    </div>
                  ) : null;
                })()}
              </dl>
              {(() => {
                const wa = whatsappAcudiente(ficha.telefonoAcudiente, ficha.nombre, nombreProfe);
                return wa ? (
                  <Button asChild className="h-12 rounded-2xl text-base font-semibold">
                    <a href={wa} target="_blank" rel="noopener noreferrer">
                      Escribir a {ficha.tipo === 'child' && ficha.acudiente ? primerNombre(ficha.acudiente) : primerNombre(ficha.nombre)} por WhatsApp
                    </a>
                  </Button>
                ) : null;
              })()}
              <Button asChild variant="outline" className="h-12 rounded-2xl">
                <Link to={rutas.misDeportistas}>Ver todo en Mis deportistas</Link>
              </Button>
            </div>
          )}
        </DrawerContent>
      </Drawer>
    </div>
  );
}
