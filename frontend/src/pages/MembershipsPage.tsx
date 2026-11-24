import { useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Loader2, Upload, AlertTriangle, Search, IdCard } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useSchoolContext } from '@/hooks/useSchoolContext';
import { MembershipBadge } from '@/components/memberships/MembershipBadge';
import {
    useMemberships,
    type EstadoMembresia,
    type TipoAtleta,
    type GuardarMembresia,
} from '@/hooks/useMemberships';

// ============================================================================
// Membresías del club (CAR-4)
//
// Para clubes que cobran la membresía POR FUERA de SportMaps. Acá no se cobra
// nada: se registra si el socio está al día, para que el resto de la app lo
// pueda mostrar.
//
// Tiene pantalla propia y no vive dentro del listado de atletas porque cargar
// membresías es un trabajo distinto de administrar atletas — se hace de a
// tandas, normalmente contra un archivo que manda el club. El estado sí se ve
// en el listado de atletas, con la misma insignia.
//
// ── La regla que no hay que romper ──────────────────────────────────────────
// `valid_until` NO vence solo. El dato viene del sistema del club y puede llegar
// rezagado, así que un vencimiento automático crearía suspendidos fantasma. Lo
// que hace esta pantalla cuando la fecha pasó y el estado sigue activo es
// AVISAR, no corregir.
// ============================================================================

interface FilaAtleta {
    id: string;
    full_name: string;
    athlete_type: TipoAtleta | null;
    user_id: string | null;
    parent_id: string | null;
    is_active: boolean | null;
    /**
     * El documento NO viene en `school_athletes`: la vista no lo expone. Se
     * resuelve aparte contra las tres tablas del sujeto, porque el archivo que
     * manda el club viene con cédulas y no con nuestros uuid — sin esto la carga
     * por archivo no cruza con nadie.
     */
    documento: string | null;
}

/** El tipo de atleta, con el mismo respaldo que usa el listado de atletas. */
function tipoDe(a: FilaAtleta): TipoAtleta {
    if (a.athlete_type) return a.athlete_type;
    if (a.parent_id) return 'child';
    if (a.user_id) return 'adult';
    return 'unregistered';
}

const ESTADOS: { valor: EstadoMembresia; texto: string }[] = [
    { valor: 'active', texto: 'Activa' },
    { valor: 'expired', texto: 'Vencida' },
    { valor: 'suspended', texto: 'Suspendida' },
];

export default function MembershipsPage() {
    const { schoolId } = useSchoolContext();
    const { membresias, porSujeto, activas, aRevisar, guardar, guardarLote, isLoading } = useMemberships();

    const [busqueda, setBusqueda] = useState('');
    const [filtro, setFiltro] = useState<'todos' | EstadoMembresia | 'sin'>('todos');
    const [editando, setEditando] = useState<FilaAtleta | null>(null);
    const [importAbierto, setImportAbierto] = useState(false);

    // Los atletas de la escuela. `school_athletes.id` es el id del sujeto de la
    // membresía en los tres casos (menor, adulto, sin cuenta), así que alcanza
    // esa llave para cruzar.
    const { data: atletas = [], isLoading: cargandoAtletas } = useQuery({
        queryKey: ['atletas-para-membresias', schoolId],
        queryFn: async (): Promise<FilaAtleta[]> => {
            const { data, error } = await supabase
                .from('school_athletes' as any)
                .select('id, full_name, athlete_type, user_id, parent_id, is_active')
                .eq('school_id', schoolId)
                .order('full_name');
            if (error) throw error;
            const base = (data ?? []) as unknown as Omit<FilaAtleta, 'documento'>[];

            // Los documentos, de las tres tablas del sujeto. `school_athletes` no
            // los expone y son la llave con la que viene el archivo del club.
            const docs = new Map<string, string>();
            const [menores, sinCuenta] = await Promise.all([
                supabase.from('children').select('id, doc_number').eq('school_id', schoolId),
                supabase.from('unregistered_athletes').select('id, doc_number').eq('school_id', schoolId),
            ]);
            for (const c of menores.data ?? []) if (c.doc_number) docs.set(c.id, c.doc_number);
            for (const u of sinCuenta.data ?? []) if (u.doc_number) docs.set(u.id, u.doc_number);

            // Los adultos guardan el suyo en `profiles`. Se piden solo los que hacen
            // falta. Si la RLS de profiles no los deja ver, quedan sin documento y la
            // carga por archivo cae al cruce por nombre — degrada, no rompe.
            const idsAdultos = base.filter((a) => a.athlete_type === 'adult').map((a) => a.id);
            if (idsAdultos.length > 0) {
                const { data: perfiles } = await supabase
                    .from('profiles').select('id, document_number').in('id', idsAdultos);
                for (const p of perfiles ?? []) if (p.document_number) docs.set(p.id, p.document_number);
            }

            return base.map((a) => ({ ...a, documento: docs.get(a.id) ?? null }));
        },
        enabled: !!schoolId,
    });

    const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

    const visibles = useMemo(() => {
        const q = norm(busqueda.trim());
        return atletas.filter((a) => {
            const m = porSujeto.get(a.id);
            if (filtro === 'sin' && m) return false;
            if (filtro !== 'todos' && filtro !== 'sin' && m?.status !== filtro) return false;
            if (!q) return true;
            return norm(a.full_name ?? '').includes(q) || norm(a.documento ?? m?.documento ?? '').includes(q);
        });
    }, [atletas, porSujeto, busqueda, filtro]);

    if (isLoading || cargandoAtletas) {
        return <div className="p-10 flex justify-center"><Loader2 className="h-5 w-5 animate-spin" /></div>;
    }

    return (
        <div className="container mx-auto p-6 space-y-6">
            <header className="flex flex-wrap items-start justify-between gap-4">
                <div>
                    <h1 className="text-3xl font-bold flex items-center gap-2">
                        <IdCard className="h-7 w-7 text-primary" />
                        Membresías
                    </h1>
                    <p className="text-muted-foreground text-sm mt-1 max-w-2xl">
                        Para clubes que cobran la membresía por fuera de SportMaps. Acá no se cobra nada:
                        se registra si el socio está al día. No genera cartera ni mora.
                    </p>
                </div>
                <Button variant="outline" onClick={() => setImportAbierto(true)}>
                    <Upload className="h-4 w-4 mr-2" /> Cargar desde archivo
                </Button>
            </header>

            <div className="grid gap-4 sm:grid-cols-3">
                <Card>
                    <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">Activas</CardTitle></CardHeader>
                    <CardContent><p className="text-2xl font-bold">{activas}</p></CardContent>
                </Card>
                <Card>
                    <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">Registradas</CardTitle></CardHeader>
                    <CardContent><p className="text-2xl font-bold">{membresias.length}<span className="text-sm font-normal text-muted-foreground"> de {atletas.length}</span></p></CardContent>
                </Card>
                <Card className={aRevisar.length ? 'border-amber-500/40' : undefined}>
                    <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">Por revisar</CardTitle></CardHeader>
                    <CardContent><p className="text-2xl font-bold">{aRevisar.length}</p></CardContent>
                </Card>
            </div>

            {aRevisar.length > 0 && (
                <Alert className="border-amber-500/40">
                    <AlertTriangle className="h-4 w-4" />
                    <AlertDescription className="text-sm">
                        <b>{aRevisar.length}</b> membresía(s) figuran como activas pero con la fecha ya
                        pasada. El estado <b>no se cambia solo</b>: el dato viene del club y puede llegar
                        rezagado, y darlas por vencidas automáticamente dejaría a socios al día sin
                        acceso. Confirma con el club y actualiza el estado a mano.
                    </AlertDescription>
                </Alert>
            )}

            <Card>
                <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
                    <CardTitle className="text-lg">Socios</CardTitle>
                    <div className="flex flex-wrap items-center gap-2">
                        <div className="relative">
                            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                            <Input
                                value={busqueda}
                                onChange={(e) => setBusqueda(e.target.value)}
                                placeholder="Nombre o documento"
                                className="pl-8 h-9 w-56"
                            />
                        </div>
                        <Select value={filtro} onValueChange={(v) => setFiltro(v as typeof filtro)}>
                            <SelectTrigger className="h-9 w-44"><SelectValue /></SelectTrigger>
                            <SelectContent>
                                <SelectItem value="todos">Todos</SelectItem>
                                <SelectItem value="sin">Sin membresía</SelectItem>
                                {ESTADOS.map((e) => (
                                    <SelectItem key={e.valor} value={e.valor}>{e.texto}</SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                </CardHeader>
                <CardContent>
                    {visibles.length === 0 ? (
                        <p className="text-sm text-muted-foreground py-8 text-center">
                            {atletas.length === 0
                                ? 'Todavía no hay atletas cargados en la escuela.'
                                : 'Ningún socio coincide con el filtro.'}
                        </p>
                    ) : (
                        <div className="overflow-x-auto">
                            <Table>
                                <TableHeader>
                                    <TableRow>
                                        <TableHead>Socio</TableHead>
                                        <TableHead>Documento</TableHead>
                                        <TableHead>Membresía</TableHead>
                                        <TableHead>Origen</TableHead>
                                        <TableHead className="text-right">Acción</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {visibles.map((a) => {
                                        const m = porSujeto.get(a.id);
                                        return (
                                            <TableRow key={a.id}>
                                                <TableCell className="font-medium">
                                                    {a.full_name}
                                                    {a.is_active === false && (
                                                        <span className="ml-2 text-[11px] text-muted-foreground">(inactivo)</span>
                                                    )}
                                                </TableCell>
                                                <TableCell className="text-sm text-muted-foreground">
                                                    {a.documento ?? m?.documento ?? '—'}
                                                </TableCell>
                                                <TableCell><MembershipBadge membresia={m} /></TableCell>
                                                <TableCell className="text-xs text-muted-foreground">
                                                    {m ? { manual: 'a mano', import: 'archivo', api: 'club' }[m.source] : '—'}
                                                </TableCell>
                                                <TableCell className="text-right">
                                                    <Button size="sm" variant="ghost" onClick={() => setEditando(a)}>
                                                        {m ? 'Editar' : 'Registrar'}
                                                    </Button>
                                                </TableCell>
                                            </TableRow>
                                        );
                                    })}
                                </TableBody>
                            </Table>
                        </div>
                    )}
                </CardContent>
            </Card>

            {editando && (
                <DialogoMembresia
                    atleta={editando}
                    membresia={porSujeto.get(editando.id)}
                    guardando={guardar.isPending}
                    onCerrar={() => setEditando(null)}
                    onGuardar={(v) => guardar.mutate(v, { onSuccess: () => setEditando(null) })}
                />
            )}

            <DialogoImportar
                abierto={importAbierto}
                atletas={atletas}
                cargando={guardarLote.isPending}
                onCerrar={() => setImportAbierto(false)}
                onCargar={(filas) => guardarLote.mutate(filas, { onSuccess: () => setImportAbierto(false) })}
            />
        </div>
    );
}

// ── Alta / edición de una membresía ─────────────────────────────────────────

function DialogoMembresia({
    atleta, membresia, guardando, onCerrar, onGuardar,
}: {
    atleta: FilaAtleta;
    membresia?: ReturnType<typeof useMemberships>['membresias'][number];
    guardando: boolean;
    onCerrar: () => void;
    onGuardar: (v: GuardarMembresia) => void;
}) {
    const [status, setStatus] = useState<EstadoMembresia>(membresia?.status ?? 'active');
    const [desde, setDesde] = useState(membresia?.valid_from ?? '');
    const [hasta, setHasta] = useState(membresia?.valid_until ?? '');
    const [ref, setRef] = useState(membresia?.external_ref ?? '');
    const [notas, setNotas] = useState(membresia?.notes ?? '');

    return (
        <Dialog open onOpenChange={(o) => !o && onCerrar()}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>{membresia ? 'Editar membresía' : 'Registrar membresía'}</DialogTitle>
                    <DialogDescription>{atleta.full_name}</DialogDescription>
                </DialogHeader>

                <div className="space-y-4">
                    <div className="space-y-2">
                        <Label>Estado</Label>
                        <Select value={status} onValueChange={(v) => setStatus(v as EstadoMembresia)}>
                            <SelectTrigger><SelectValue /></SelectTrigger>
                            <SelectContent>
                                {ESTADOS.map((e) => <SelectItem key={e.valor} value={e.valor}>{e.texto}</SelectItem>)}
                            </SelectContent>
                        </Select>
                        <p className="text-[11px] text-muted-foreground">
                            Es lo que la escuela declara. No se recalcula a partir de las fechas.
                        </p>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-2">
                            <Label>Desde</Label>
                            <Input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} />
                        </div>
                        <div className="space-y-2">
                            <Label>Hasta</Label>
                            <Input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} />
                        </div>
                    </div>

                    <div className="space-y-2">
                        <Label>Referencia del club</Label>
                        <Input
                            value={ref}
                            onChange={(e) => setRef(e.target.value)}
                            placeholder="El id o número de socio en el sistema del club"
                        />
                        <p className="text-[11px] text-muted-foreground">
                            Opcional, pero es lo que permitirá sincronizar automáticamente cuando
                            conectemos con el sistema del club.
                        </p>
                    </div>

                    <div className="space-y-2">
                        <Label>Notas</Label>
                        <Textarea value={notas} onChange={(e) => setNotas(e.target.value)} rows={2} />
                    </div>
                </div>

                <DialogFooter>
                    <Button variant="outline" onClick={onCerrar} disabled={guardando}>Cancelar</Button>
                    <Button
                        disabled={guardando}
                        onClick={() => onGuardar({
                            sujetoId: atleta.id,
                            tipoAtleta: tipoDe(atleta),
                            status,
                            validFrom: desde || null,
                            validUntil: hasta || null,
                            source: 'manual',
                            externalRef: ref.trim() || null,
                            notes: notas.trim() || null,
                        })}
                    >
                        {guardando ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Guardar'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

// ── Carga por archivo ───────────────────────────────────────────────────────

interface FilaCsv {
    linea: number;
    documento: string;
    estado: EstadoMembresia;
    desde: string | null;
    hasta: string | null;
    ref: string | null;
    atleta?: FilaAtleta;
    problema?: string;
}

const MAPA_ESTADO: Record<string, EstadoMembresia> = {
    activa: 'active', active: 'active', activo: 'active', 'al dia': 'active',
    vencida: 'expired', expired: 'expired', vencido: 'expired',
    suspendida: 'suspended', suspended: 'suspended', suspendido: 'suspended',
};

/** dd/mm/aaaa y aaaa-mm-dd, que es lo que sale de Excel según cómo esté la máquina. */
function aFecha(v: string): string | null {
    const t = v.trim();
    if (!t) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
    const m = t.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
    if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    return null;
}

function DialogoImportar({
    abierto, atletas, cargando, onCerrar, onCargar,
}: {
    abierto: boolean;
    atletas: FilaAtleta[];
    cargando: boolean;
    onCerrar: () => void;
    onCargar: (filas: GuardarMembresia[]) => void;
}) {
    const [texto, setTexto] = useState('');

    // El cruce es por documento, que es lo que trae el archivo del club — no
    // nuestros uuid. Se resuelve contra los atletas ya cargados; lo que no
    // aparece se reporta en vez de crearse, porque dar de alta gente a partir de
    // una planilla de membresías es otra decisión.
    const porDocumento = useMemo(() => {
        const m = new Map<string, FilaAtleta>();
        for (const a of atletas) {
            if (a.documento) m.set(a.documento.replace(/\D/g, ''), a);
        }
        return m;
    }, [atletas]);

    const porNombre = useMemo(() => {
        const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
        const m = new Map<string, FilaAtleta>();
        for (const a of atletas) if (a.full_name) m.set(norm(a.full_name), a);
        return m;
    }, [atletas]);

    const filas = useMemo<FilaCsv[]>(() => {
        const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
        const lineas = texto.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        const out: FilaCsv[] = [];

        for (let i = 0; i < lineas.length; i++) {
            const partes = lineas[i].split(/[;,\t]/).map((p) => p.trim());
            // Encabezado: se salta si la primera celda no parece un dato.
            if (i === 0 && /documento|nombre|socio|cedula/i.test(partes[0] ?? '')) continue;

            const [clave = '', estadoTxt = 'activa', desdeTxt = '', hastaTxt = '', refTxt = ''] = partes;
            const soloDigitos = clave.replace(/\D/g, '');
            const atleta = (soloDigitos && porDocumento.get(soloDigitos)) || porNombre.get(norm(clave));
            const estado = MAPA_ESTADO[norm(estadoTxt)];

            out.push({
                linea: i + 1,
                documento: clave,
                estado: estado ?? 'active',
                desde: aFecha(desdeTxt),
                hasta: aFecha(hastaTxt),
                ref: refTxt.trim() || null,
                atleta,
                problema: !clave ? 'fila vacía'
                    : !atleta ? 'no encontré a esa persona entre los atletas de la escuela'
                        : !estado && estadoTxt ? `estado «${estadoTxt}» no reconocido, se usa Activa`
                            : undefined,
            });
        }
        return out;
    }, [texto, porDocumento, porNombre]);

    const listas = filas.filter((f) => f.atleta);
    const conProblema = filas.filter((f) => !f.atleta);

    return (
        <Dialog open={abierto} onOpenChange={(o) => !o && onCerrar()}>
            <DialogContent className="sm:max-w-modal">
                <DialogHeader>
                    <DialogTitle>Cargar membresías desde archivo</DialogTitle>
                    <DialogDescription>
                        Pegá el contenido del archivo del club. Una línea por socio, separando con coma,
                        punto y coma o tabulación.
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-3">
                    <div className="rounded-lg border bg-muted/30 p-3 text-xs space-y-1">
                        <p className="font-medium">Orden de las columnas</p>
                        <code className="block">documento o nombre ; estado ; desde ; hasta ; referencia</code>
                        <p className="text-muted-foreground">
                            Solo la primera es obligatoria. Estado acepta activa / vencida / suspendida
                            (por defecto activa). Fechas en dd/mm/aaaa o aaaa-mm-dd. Si la primera línea
                            es un encabezado, se salta.
                        </p>
                    </div>

                    <Textarea
                        value={texto}
                        onChange={(e) => setTexto(e.target.value)}
                        rows={7}
                        className="font-mono text-xs"
                        placeholder={'1020304050;activa;01/01/2026;31/12/2026;SOC-1234\n1098765432;vencida;;30/06/2026;SOC-1235'}
                    />

                    {filas.length > 0 && (
                        <div className="space-y-2">
                            <div className="flex flex-wrap gap-2 text-xs">
                                <Badge variant="outline" className="bg-emerald-500/10 text-emerald-700 border-emerald-500/30">
                                    {listas.length} lista(s) para cargar
                                </Badge>
                                {conProblema.length > 0 && (
                                    <Badge variant="outline" className="bg-destructive/10 text-destructive border-destructive/30">
                                        {conProblema.length} sin resolver
                                    </Badge>
                                )}
                            </div>
                            {conProblema.length > 0 && (
                                <div className="max-h-32 overflow-y-auto rounded border p-2 space-y-1">
                                    {conProblema.slice(0, 20).map((f) => (
                                        <p key={f.linea} className="text-[11px] text-muted-foreground">
                                            línea {f.linea}: <b>{f.documento || '(vacía)'}</b> — {f.problema}
                                        </p>
                                    ))}
                                    {conProblema.length > 20 && (
                                        <p className="text-[11px] text-muted-foreground">
                                            …y {conProblema.length - 20} más.
                                        </p>
                                    )}
                                </div>
                            )}
                            <p className="text-[11px] text-muted-foreground">
                                Las que no se resuelven no se cargan y no se crea a nadie: dar de alta
                                personas desde una planilla de membresías es otra decisión, y se hace
                                desde el listado de atletas.
                            </p>
                        </div>
                    )}
                </div>

                <DialogFooter>
                    <Button variant="outline" onClick={onCerrar} disabled={cargando}>Cancelar</Button>
                    <Button
                        disabled={cargando || listas.length === 0}
                        onClick={() => onCargar(listas.map((f) => ({
                            sujetoId: f.atleta!.id,
                            tipoAtleta: tipoDe(f.atleta!),
                            status: f.estado,
                            validFrom: f.desde,
                            validUntil: f.hasta,
                            source: 'import' as const,
                            externalRef: f.ref,
                        })))}
                    >
                        {cargando
                            ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Cargando…</>
                            : `Cargar ${listas.length}`}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
