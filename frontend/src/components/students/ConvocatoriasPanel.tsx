import { Fragment, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  AlertTriangle, CalendarDays, ChevronDown, ChevronUp, Download, Loader2, MessageCircle, MessagesSquare, RotateCw, Search,
} from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { whatsappLink } from '@/lib/clinical/family-extra';
import { cn } from '@/lib/utils';
import { useInscripcionesConvocatoria } from '@/hooks/useInscripcionesConvocatoria';
import {
  COLUMNAS_EXCEL, ESTADOS, FILTROS_INICIALES, agruparConvocatorias, estadoDe, etiquetaEstado, fechaInscripcion,
  hojasExcel, nombreArchivoExcel, pesos, porcentajeDescuento, resumenPorConvocatoria, textoFechas, textoTrayectoria,
  tieneDescuento, type EstadoInscripcion, type FiltroEstado, type Filtros, type GrupoConvocatoria,
  type InscripcionConvocatoria,
} from './convocatoriasModel';

const COLOR_ESTADO: Record<EstadoInscripcion, string> = {
  pendiente: 'border-amber-300 bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800',
  confirmada: 'border-sky-300 bg-sky-50 text-sky-800 dark:bg-sky-950/40 dark:text-sky-300 dark:border-sky-800',
  pagada: 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800',
  descartada: 'border-border bg-muted text-muted-foreground',
};

const FILTRO_ESTADO_OPCIONES: { value: FiltroEstado; label: string }[] = [
  { value: 'activas', label: 'Todas menos descartadas' },
  { value: 'pendiente', label: 'Pendientes' },
  { value: 'confirmada', label: 'Confirmadas' },
  { value: 'pagada', label: 'Pagadas' },
  { value: 'descartada', label: 'Descartadas' },
  { value: 'todas', label: 'Todas (con descartadas)' },
];

const TODAS = '__todas__';

const contar = (n: number, uno: string, varios: string) => `${n} ${n === 1 ? uno : varios}`;

interface Props {
  schoolId: string;
}

/**
 * Pestaña «Convocatorias» de Deportistas: inscripciones que llegan por
 * WhatsApp a cada convocatoria, agrupadas y numeradas por orden de llegada
 * (igual que el Excel que lleva la escuela). No son deportistas todavía.
 */
export function ConvocatoriasPanel({ schoolId }: Props) {
  const { toast } = useToast();
  const navigate = useNavigate();
  const { inscripciones, isLoading, error, refetch, marcar } = useInscripcionesConvocatoria(schoolId);
  const [filtros, setFiltros] = useState<Filtros>(FILTROS_INICIALES);
  const [abiertas, setAbiertas] = useState<Set<string>>(new Set());
  const [descargando, setDescargando] = useState(false);

  const resumen = useMemo(() => resumenPorConvocatoria(inscripciones), [inscripciones]);
  const grupos = useMemo(() => agruparConvocatorias(inscripciones, filtros), [inscripciones, filtros]);
  const visibles = grupos.reduce((n, g) => n + g.filas.length, 0);
  const hayFiltros = filtros.convocatoria !== null || filtros.estado !== 'activas' || filtros.busqueda.trim() !== '';

  const alternar = (id: string) => setAbiertas((prev) => {
    const s = new Set(prev);
    if (s.has(id)) s.delete(id); else s.add(id);
    return s;
  });

  const cambiarEstado = (i: InscripcionConvocatoria, estado: EstadoInscripcion) => {
    if (estado === estadoDe(i)) return;
    marcar.mutate({ leadId: i.id, estado, nota: i.nota_escuela ?? null }, {
      onSuccess: () => toast({
        title: 'Estado actualizado',
        description: `${i.deportista ?? 'Inscripción'} quedó como «${etiquetaEstado(estado)}».`,
      }),
      onError: (e: Error) => toast({ title: 'No se pudo cambiar el estado', description: e.message, variant: 'destructive' }),
    });
  };

  const guardarNota = (i: InscripcionConvocatoria, nota: string) => {
    // Vacía = '' (la base la borra); null significaría «no cambiar».
    marcar.mutate({ leadId: i.id, estado: estadoDe(i), nota: nota.trim() }, {
      onSuccess: () => toast({ title: 'Nota guardada' }),
      onError: (e: Error) => toast({ title: 'No se pudo guardar la nota', description: e.message, variant: 'destructive' }),
    });
  };

  const verChat = (i: InscripcionConvocatoria) => {
    if (i.conversation_id) navigate(`/whatsapp?tab=conversaciones&conversacion=${encodeURIComponent(i.conversation_id)}`);
  };

  const descargarExcel = async () => {
    if (visibles === 0) return;
    setDescargando(true);
    try {
      // exceljs se carga solo al descargar (no infla el bundle de la página).
      const { downloadWorkbook } = await import('@/lib/export/xlsx');
      const hojas = hojasExcel(grupos).map((h) => ({ ...h, columns: COLUMNAS_EXCEL }));
      await downloadWorkbook(hojas, nombreArchivoExcel());
    } catch (e) {
      toast({ title: 'No se pudo generar el Excel', description: (e as Error).message, variant: 'destructive' });
    } finally {
      setDescargando(false);
    }
  };

  const enMarcha = (id: string) => marcar.isPending && marcar.variables?.leadId === id;

  return (
    <Card>
      <CardHeader className="pb-3 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center gap-2 justify-between">
          <p className="text-sm text-muted-foreground">
            Inscripciones a las convocatorias que llegan por WhatsApp, en orden de llegada. No son deportistas todavía.
          </p>
          <Button size="sm" variant="outline" onClick={descargarExcel} disabled={descargando || visibles === 0}
            title={visibles === 0 ? 'No hay inscripciones con estos filtros' : 'Descarga lo que ves en pantalla'}>
            {descargando ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Download className="h-4 w-4 mr-1.5" />}
            Descargar Excel
          </Button>
        </div>

        {resumen.length > 0 && (
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {resumen.map((r) => {
              const activa = filtros.convocatoria === r.convocatoria;
              return (
                <button key={r.convocatoria} type="button"
                  onClick={() => setFiltros((f) => ({ ...f, convocatoria: activa ? null : r.convocatoria }))}
                  className={cn(
                    'text-left rounded-lg border p-3 transition-colors hover:bg-muted/60',
                    activa && 'border-primary ring-1 ring-primary bg-primary/5',
                  )}
                  aria-pressed={activa}>
                  <p className="font-semibold text-sm leading-tight">{r.convocatoria}</p>
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    <Badge variant="outline" className={cn('text-[11px]', COLOR_ESTADO.pendiente)}>{contar(r.pendiente, 'pendiente', 'pendientes')}</Badge>
                    <Badge variant="outline" className={cn('text-[11px]', COLOR_ESTADO.confirmada)}>{contar(r.confirmada, 'confirmada', 'confirmadas')}</Badge>
                    <Badge variant="outline" className={cn('text-[11px]', COLOR_ESTADO.pagada)}>{contar(r.pagada, 'pagada', 'pagadas')}</Badge>
                  </div>
                  {r.descartada > 0 && (
                    <p className="text-[11px] text-muted-foreground mt-1.5">{contar(r.descartada, 'descartada', 'descartadas')}{filtros.estado === 'activas' ? ' (ocultas)' : ''}</p>
                  )}
                </button>
              );
            })}
          </div>
        )}

        <div className="flex flex-col md:flex-row gap-2">
          <Select value={filtros.convocatoria ?? TODAS}
            onValueChange={(v) => setFiltros((f) => ({ ...f, convocatoria: v === TODAS ? null : v }))}>
            <SelectTrigger className="md:w-64" aria-label="Convocatoria"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={TODAS}>Todas las convocatorias</SelectItem>
              {resumen.map((r) => <SelectItem key={r.convocatoria} value={r.convocatoria}>{r.convocatoria}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={filtros.estado} onValueChange={(v) => setFiltros((f) => ({ ...f, estado: v as FiltroEstado }))}>
            <SelectTrigger className="md:w-56" aria-label="Estado"><SelectValue /></SelectTrigger>
            <SelectContent>
              {FILTRO_ESTADO_OPCIONES.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
            </SelectContent>
          </Select>
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground h-4 w-4" />
            <Input placeholder="Buscar por nombre o teléfono..." value={filtros.busqueda}
              onChange={(e) => setFiltros((f) => ({ ...f, busqueda: e.target.value }))} className="pl-10" />
          </div>
        </div>
      </CardHeader>

      <CardContent>
        {isLoading ? (
          <div className="flex justify-center py-10"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
        ) : error ? (
          // Error de carga ≠ «sin inscripciones»: no dar falsa tranquilidad.
          <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm flex flex-col sm:flex-row sm:items-center gap-3">
            <AlertTriangle className="h-5 w-5 text-destructive shrink-0" />
            <div className="flex-1">
              <p className="font-medium text-destructive">No se pudieron cargar las inscripciones.</p>
              <p className="text-muted-foreground">Esto <strong>no</strong> significa que no haya inscripciones. Revisa tu conexión e inténtalo de nuevo.</p>
            </div>
            <Button size="sm" variant="outline" onClick={() => refetch()}><RotateCw className="h-4 w-4 mr-1.5" /> Reintentar</Button>
          </div>
        ) : inscripciones.length === 0 ? (
          <p className="text-sm text-muted-foreground py-10 text-center">Todavía no hay inscripciones a convocatorias.</p>
        ) : grupos.length === 0 ? (
          <div className="py-10 text-center space-y-2">
            <p className="text-sm text-muted-foreground">Ninguna inscripción coincide con los filtros.</p>
            {hayFiltros && <Button size="sm" variant="ghost" onClick={() => setFiltros(FILTROS_INICIALES)}>Quitar filtros</Button>}
          </div>
        ) : (
          <div className="space-y-6">
            {grupos.map((g) => (
              <GrupoView key={g.convocatoria} grupo={g} abiertas={abiertas} onAlternar={alternar}
                onEstado={cambiarEstado} onNota={guardarNota} onVerChat={verChat} enMarcha={enMarcha} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

interface GrupoProps {
  grupo: GrupoConvocatoria;
  abiertas: Set<string>;
  onAlternar: (id: string) => void;
  onEstado: (i: InscripcionConvocatoria, e: EstadoInscripcion) => void;
  onNota: (i: InscripcionConvocatoria, nota: string) => void;
  onVerChat: (i: InscripcionConvocatoria) => void;
  enMarcha: (id: string) => boolean;
}

function GrupoView({ grupo, abiertas, onAlternar, onEstado, onNota, onVerChat, enMarcha }: GrupoProps) {
  return (
    <section className="rounded-lg border">
      <header className="px-4 py-3 border-b bg-muted/40 rounded-t-lg">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h3 className="font-semibold">{grupo.convocatoria}</h3>
          <span className="text-sm text-muted-foreground">
            {grupo.filas.length} {grupo.filas.length === 1 ? 'inscripción' : 'inscripciones'}
          </span>
        </div>
        {grupo.fechasComunes && (
          <p className="text-xs text-muted-foreground mt-1 flex items-start gap-1.5">
            <CalendarDays className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <span>Fechas: {textoFechas(grupo.fechasComunes)}</span>
          </p>
        )}
      </header>

      {/* Escritorio: tabla tipo Excel */}
      <div className="hidden md:block overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10 text-right">#</TableHead>
              <TableHead className="whitespace-nowrap">Fecha de inscripción</TableHead>
              <TableHead>Deportista</TableHead>
              <TableHead className="whitespace-nowrap">Año nac.</TableHead>
              <TableHead>Género</TableHead>
              <TableHead>Trayectoria</TableHead>
              <TableHead>Teléfono</TableHead>
              <TableHead className="text-right">Valor</TableHead>
              <TableHead className="w-40">Estado</TableHead>
              <TableHead className="w-28" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {grupo.filas.map(({ numero, inscripcion: i }) => {
              const abierta = abiertas.has(i.id);
              return (
                <Fragment key={i.id}>
                  <TableRow className={cn(estadoDe(i) === 'descartada' && 'opacity-60')}>
                    <TableCell className="text-right font-mono text-muted-foreground">{numero}</TableCell>
                    <TableCell className="whitespace-nowrap tabular-nums">{fechaInscripcion(i.created_at)}</TableCell>
                    <TableCell>
                      <p className="font-medium">{i.deportista ?? '—'}</p>
                      {(i.acudiente || i.contacto) && (
                        <p className="text-xs text-muted-foreground">Acudiente: {i.acudiente ?? i.contacto}</p>
                      )}
                    </TableCell>
                    <TableCell className="tabular-nums">{i.anio_nacimiento ?? '—'}</TableCell>
                    <TableCell>{i.genero ?? '—'}</TableCell>
                    <TableCell><Trayectoria i={i} /></TableCell>
                    <TableCell><Telefono telefono={i.telefono} /></TableCell>
                    <TableCell className="text-right"><Valor i={i} /></TableCell>
                    <TableCell><SelectEstado i={i} onEstado={onEstado} cargando={enMarcha(i.id)} /></TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        {i.conversation_id && (
                          <Button size="sm" variant="ghost" onClick={() => onVerChat(i)} title="Ver chat">
                            <MessagesSquare className="h-4 w-4" /><span className="sr-only">Ver chat</span>
                          </Button>
                        )}
                        <Button size="sm" variant="ghost" onClick={() => onAlternar(i.id)} aria-expanded={abierta}
                          title={abierta ? 'Ocultar detalle' : 'Ver detalle'}>
                          {abierta ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                          <span className="sr-only">Detalle</span>
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                  {abierta && (
                    <TableRow className="bg-muted/20 hover:bg-muted/20">
                      <TableCell />
                      <TableCell colSpan={9}>
                        <Detalle i={i} mostrarFechas={!grupo.fechasComunes} onNota={onNota} guardando={enMarcha(i.id)} />
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {/* Móvil: tarjetas con los mismos datos */}
      <ul className="md:hidden divide-y">
        {grupo.filas.map(({ numero, inscripcion: i }) => {
          const abierta = abiertas.has(i.id);
          return (
            <li key={i.id} className={cn('p-3 space-y-2', estadoDe(i) === 'descartada' && 'opacity-60')}>
              <div className="flex items-start gap-3">
                <span className="font-mono text-sm text-muted-foreground w-6 text-right shrink-0">{numero}</span>
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-sm">{i.deportista ?? '—'}</p>
                  <p className="text-xs text-muted-foreground">Inscrito {fechaInscripcion(i.created_at)}</p>
                </div>
                <Valor i={i} />
              </div>
              <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs pl-9">
                <dt className="text-muted-foreground">Año nac.</dt><dd>{i.anio_nacimiento ?? '—'}</dd>
                <dt className="text-muted-foreground">Género</dt><dd>{i.genero ?? '—'}</dd>
                <dt className="text-muted-foreground">Trayectoria</dt><dd><Trayectoria i={i} /></dd>
                {(i.acudiente || i.contacto) && (<><dt className="text-muted-foreground">Acudiente</dt><dd>{i.acudiente ?? i.contacto}</dd></>)}
                <dt className="text-muted-foreground">Teléfono</dt><dd><Telefono telefono={i.telefono} /></dd>
              </dl>
              <div className="flex gap-2 pl-9">
                <div className="flex-1"><SelectEstado i={i} onEstado={onEstado} cargando={enMarcha(i.id)} /></div>
                {i.conversation_id && (
                  <Button size="sm" variant="outline" onClick={() => onVerChat(i)}>
                    <MessagesSquare className="h-4 w-4 mr-1" /> Ver chat
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => onAlternar(i.id)} aria-expanded={abierta}>
                  {abierta ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                  <span className="sr-only">Detalle</span>
                </Button>
              </div>
              {abierta && (
                <div className="pl-9">
                  <Detalle i={i} mostrarFechas={!grupo.fechasComunes} onNota={onNota} guardando={enMarcha(i.id)} />
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Trayectoria({ i }: { i: InscripcionConvocatoria }) {
  const t = textoTrayectoria(i.trayectoria);
  if (!t) return <span className="text-muted-foreground">—</span>;
  if (!i.detalle) return <span>{t}</span>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="cursor-help">
          {t}
          <span className="block text-xs text-muted-foreground max-w-[12rem] truncate">{i.detalle}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">{i.detalle}</TooltipContent>
    </Tooltip>
  );
}

function Telefono({ telefono }: { telefono: string | null }) {
  if (!telefono) return <span className="text-muted-foreground">—</span>;
  const wa = whatsappLink(telefono);
  if (!wa) return <span className="tabular-nums">{telefono}</span>;
  return (
    <a href={wa} target="_blank" rel="noreferrer"
      className="inline-flex items-center gap-1 tabular-nums text-emerald-700 hover:underline dark:text-emerald-400">
      <MessageCircle className="h-3.5 w-3.5" />{telefono}
    </a>
  );
}

function Valor({ i }: { i: InscripcionConvocatoria }) {
  if (i.valor == null && i.valor_con_descuento == null) return <span className="text-muted-foreground">—</span>;
  if (!tieneDescuento(i)) return <span className="tabular-nums whitespace-nowrap">{pesos(i.valor)}</span>;
  const pct = porcentajeDescuento(i);
  return (
    <div className="text-right whitespace-nowrap">
      {i.valor != null && <p className="text-xs text-muted-foreground line-through tabular-nums">{pesos(i.valor)}</p>}
      <p className="font-semibold tabular-nums">{pesos(i.valor_con_descuento)}</p>
      {pct != null && <Badge variant="secondary" className="text-[10px] mt-0.5">Black Friday −{pct} %</Badge>}
    </div>
  );
}

function SelectEstado({ i, onEstado, cargando }: {
  i: InscripcionConvocatoria; onEstado: (i: InscripcionConvocatoria, e: EstadoInscripcion) => void; cargando: boolean;
}) {
  const e = estadoDe(i);
  return (
    <Select value={e} onValueChange={(v) => onEstado(i, v as EstadoInscripcion)} disabled={cargando}>
      <SelectTrigger className={cn('h-8 text-xs border', COLOR_ESTADO[e])} aria-label={`Estado de ${i.deportista ?? 'la inscripción'}`}>
        {cargando ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <SelectValue />}
      </SelectTrigger>
      <SelectContent>
        {ESTADOS.map((s) => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

function Detalle({ i, mostrarFechas, onNota, guardando }: {
  i: InscripcionConvocatoria; mostrarFechas: boolean; onNota: (i: InscripcionConvocatoria, nota: string) => void; guardando: boolean;
}) {
  const [nota, setNota] = useState(i.nota_escuela ?? '');
  const cambio = nota.trim() !== (i.nota_escuela ?? '').trim();
  return (
    <div className="space-y-3 text-sm py-1">
      <dl className="grid sm:grid-cols-[10rem_1fr] gap-x-3 gap-y-1">
        {i.sede && (<><dt className="text-muted-foreground">Sede</dt><dd>{i.sede}</dd></>)}
        {mostrarFechas && (i.fechas?.length ?? 0) > 0 && (
          <><dt className="text-muted-foreground">Fechas de la convocatoria</dt><dd>{textoFechas(i.fechas)}</dd></>
        )}
        {i.detalle && (<><dt className="text-muted-foreground">Trayectoria</dt><dd>{i.detalle}</dd></>)}
        {i.notas && (<><dt className="text-muted-foreground">Lo que dijo en el chat</dt><dd className="whitespace-pre-wrap">{i.notas}</dd></>)}
      </dl>
      <div className="space-y-1.5 max-w-xl">
        <label className="text-xs font-medium text-muted-foreground" htmlFor={`nota-${i.id}`}>Nota de la escuela</label>
        <Textarea id={`nota-${i.id}`} value={nota} onChange={(e) => setNota(e.target.value)} rows={2}
          placeholder="Ej.: llamó para confirmar, trae uniforme..." />
        <Button size="sm" variant="outline" disabled={!cambio || guardando} onClick={() => onNota(i, nota)}>
          {guardando && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />} Guardar nota
        </Button>
      </div>
    </div>
  );
}
