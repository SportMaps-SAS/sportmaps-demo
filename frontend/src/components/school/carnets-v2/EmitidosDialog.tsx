/**
 * «Ver emitidos · PDF por equipo»: carnets emitidos con su código SM-… y la descarga
 * del PDF por equipo con las plantillas clásicas (spec §11.1: el papel no es 3D).
 * Reutiliza exportCardsPdf de V1; revocar, reemitir y PNG siguen en la pantalla avanzada.
 */
import { useEffect, useMemo, useState } from 'react';
import { Download, ExternalLink, Loader2, Search } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { exportCardsPdf } from '@/lib/cards/cardExport';
import { slugifyFileName, type PdfLayoutMode } from '@/lib/cards/cardLayout';
import { carnetsDelEquipo, etiquetaEstadoCarnet, type CarnetEmitido } from '@/lib/cards/carnetsV2Model';
import { cargarCarnetsVigentes, cargarDatosParaPdf, cargarDeportistas, cargarEmitidos, type Equipo } from './carnetsV2Api';

const LIMITE = 30;
const TODOS = '__todos__';

const TONO: Record<string, string> = {
  active: 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-200',
  revoked: 'bg-muted text-muted-foreground',
  expired: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200',
};

function fecha(d: string) {
  return new Date(d).toLocaleDateString('es-CO', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function EmitidosDialog({
  schoolId, equipos, open, onOpenChange,
}: { schoolId: string; equipos: Equipo[]; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { toast } = useToast();
  const [busqueda, setBusqueda] = useState('');
  const [busquedaLista, setBusquedaLista] = useState('');
  const [filas, setFilas] = useState<CarnetEmitido[]>([]);
  const [total, setTotal] = useState(0);
  const [cargando, setCargando] = useState(false);
  const [cargandoMas, setCargandoMas] = useState(false);

  const [pdfEquipo, setPdfEquipo] = useState(TODOS);
  const [pdfModo, setPdfModo] = useState<PdfLayoutMode>('duplex');
  const [pdfOcupado, setPdfOcupado] = useState(false);
  const [pdfAvance, setPdfAvance] = useState<{ hechos: number; total: number } | null>(null);

  const origen = useMemo(() => (typeof window === 'undefined' ? '' : `${window.location.origin}/c`), []);

  useEffect(() => {
    const t = setTimeout(() => setBusquedaLista(busqueda.trim()), 350);
    return () => clearTimeout(t);
  }, [busqueda]);

  useEffect(() => {
    if (!open) return;
    let cancelado = false;
    setCargando(true);
    cargarEmitidos(schoolId, { search: busquedaLista || null, offset: 0, limit: LIMITE })
      .then((r) => { if (!cancelado) { setFilas(r.rows); setTotal(r.total); } })
      .catch(() => { if (!cancelado) { setFilas([]); setTotal(0); } })
      .finally(() => { if (!cancelado) setCargando(false); });
    return () => { cancelado = true; };
  }, [open, schoolId, busquedaLista]);

  async function cargarMas() {
    setCargandoMas(true);
    try {
      const r = await cargarEmitidos(schoolId, { search: busquedaLista || null, offset: filas.length, limit: LIMITE });
      setFilas((p) => [...p, ...r.rows]);
      setTotal(r.total);
    } catch {
      toast({ title: 'No se pudieron cargar más carnets', variant: 'destructive' });
    } finally {
      setCargandoMas(false);
    }
  }

  async function descargarPdf() {
    setPdfOcupado(true);
    setPdfAvance({ hechos: 0, total: 0 });
    try {
      const nombreEquipo = pdfEquipo === TODOS ? null : equipos.find((e) => e.id === pdfEquipo)?.name ?? null;
      let objetivo = await cargarCarnetsVigentes(schoolId);
      if (pdfEquipo !== TODOS) {
        const miembros = await cargarDeportistas(schoolId, pdfEquipo, 'with');
        objetivo = carnetsDelEquipo(objetivo, miembros.map((m) => m.athlete_id));
      }
      if (objetivo.length === 0) {
        toast({ title: 'Sin carnets vigentes', description: 'Ese equipo todavía no tiene carnets para imprimir.' });
        return;
      }
      let hechos = 0;
      setPdfAvance({ hechos: 0, total: objetivo.length });
      const datos = await cargarDatosParaPdf(objetivo, () => { hechos++; setPdfAvance({ hechos, total: objetivo.length }); });
      const slug = nombreEquipo ? slugifyFileName(nombreEquipo) : 'todos';
      const n = await exportCardsPdf(
        datos.map((d) => ({ data: d.data, publicUrl: `${origen}/${d.token}` })),
        {
          mode: pdfModo,
          cutMarks: true,
          fileName: `carnets-${slug}-${pdfModo === 'duplex' ? 'doble-cara' : 'frente-y-reverso'}.pdf`,
          onProgress: (h, t) => setPdfAvance({ hechos: h, total: t }),
        },
      );
      toast({ title: 'PDF listo', description: `${n} carnet(s) en tamaño real. Imprime al 100 %.` });
    } catch {
      toast({ title: 'No se pudo generar el PDF', description: 'Inténtalo de nuevo en un momento.', variant: 'destructive' });
    } finally {
      setPdfOcupado(false);
      setPdfAvance(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Carnets emitidos</DialogTitle>
          <DialogDescription>Cada carnet lleva su código. El QR abre la verificación en vivo.</DialogDescription>
        </DialogHeader>

        <section aria-labelledby="pdf-equipo-titulo" className="flex flex-col gap-2 rounded-2xl border p-3.5">
          <h3 id="pdf-equipo-titulo" className="text-sm font-semibold">Imprimir por equipo</h3>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="pdf-equipo" className="text-xs">Equipo</Label>
              <Select value={pdfEquipo} onValueChange={setPdfEquipo}>
                <SelectTrigger id="pdf-equipo" className="min-h-11"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={TODOS}>Todos los equipos</SelectItem>
                  {equipos.map((t) => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="pdf-modo" className="text-xs">Formato</Label>
              <Select value={pdfModo} onValueChange={(v) => setPdfModo(v as PdfLayoutMode)}>
                <SelectTrigger id="pdf-modo" className="min-h-11"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="duplex">Doble cara</SelectItem>
                  <SelectItem value="together">Frente y reverso juntos</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <Button variant="outline" onClick={descargarPdf} disabled={pdfOcupado} className="min-h-11 gap-2">
            {pdfOcupado ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            {pdfOcupado && pdfAvance?.total ? `Preparando ${pdfAvance.hechos} de ${pdfAvance.total}…` : 'Descargar PDF'}
          </Button>
        </section>

        <div className="relative">
          <Search className="absolute left-2.5 top-3 h-4 w-4 text-muted-foreground" aria-hidden="true" />
          <Input aria-label="Buscar deportista" placeholder="Buscar deportista…" className="min-h-11 pl-8" value={busqueda} onChange={(e) => setBusqueda(e.target.value)} />
        </div>

        {cargando ? (
          <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin" aria-label="Cargando" /></div>
        ) : filas.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {busquedaLista ? 'Ningún carnet coincide con la búsqueda.' : 'Todavía no hay carnets emitidos. Empieza con «Generar carnets».'}
          </p>
        ) : (
          <ul className="overflow-hidden rounded-2xl border">
            {filas.map((c) => (
              <li key={c.id} className="flex items-center gap-3 border-t px-3.5 py-2.5 first:border-t-0">
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-[15px] font-medium">{c.athlete_name}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    <span className="font-mono">{c.codigo || 'Sin código'}</span>
                    {c.team_name ? ` · ${c.team_name}` : ''} · vale hasta {fecha(c.valid_until)}
                  </span>
                </span>
                <Badge className={TONO[c.status] ?? ''}>{etiquetaEstadoCarnet(c.status)}</Badge>
                <Button asChild size="icon" variant="ghost" className="h-11 w-11 shrink-0">
                  <a href={`/c/${c.qr_token}`} target="_blank" rel="noopener noreferrer" aria-label={`Abrir el carnet de ${c.athlete_name}`}>
                    <ExternalLink className="h-4 w-4" />
                  </a>
                </Button>
              </li>
            ))}
          </ul>
        )}

        {!cargando && filas.length < total && (
          <Button variant="outline" onClick={cargarMas} disabled={cargandoMas} className="gap-2">
            {cargandoMas && <Loader2 className="h-4 w-4 animate-spin" />}
            Ver más ({total - filas.length})
          </Button>
        )}

        <Link to="/cards?tab=cards" className="text-center text-sm font-medium text-primary underline-offset-4 hover:underline">
          Anular, reemitir o descargar uno por uno
        </Link>
      </DialogContent>
    </Dialog>
  );
}
