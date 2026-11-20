/**
 * PorClasificarCard — comprobantes de WhatsApp con plata que el asistente no supo a qué cobro iban.
 *
 * Antes se quedaban en la «Bandeja» de WhatsApp, donde marcarlos resueltos no cambiaba ningún pago. Ahora
 * viven aquí, en Cobros, con lo que se sabe de cada uno, y la escuela decide:
 *   · «Crear cobro»      → servicio nuevo del catálogo (clínica, vacacional…): el cobro lo crea la base con el
 *                           precio del catálogo y el comprobante queda «En revisión».
 *   · «Aplicar a un cobro» → a un cobro abierto que ya existe; el comprobante queda «En revisión».
 *   · «Descartar»         → no es nuestro / repetido, con motivo.
 * NADA se aprueba aquí: la aprobación sigue siendo la de siempre, en «Cobros por Aprobar».
 *
 * Spec: docs/specs/whatsapp-comprobantes-nunca-en-la-bandeja.md. No pinta nada si no hay comprobantes (o si la
 * migración aún no está aplicada).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { bffClient } from '@/lib/api/bffClient';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
    Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { FileText, Inbox, Loader2 } from 'lucide-react';

export interface FilaPorClasificar {
    id: string;
    contacto: string | null;
    contacto_nombre: string | null;
    monto: number;
    referencia: string | null;
    fecha_comprobante: string | null;
    banco: string | null;
    etiqueta: string;
    propuesta: { detalle?: string | null; texto?: string | null; pagador?: string | null } | null;
    created_at: string;
    archivo_url: string | null;
    /** Nombre de la conversación de WhatsApp de ese contacto, si la hay. */
    chat_nombre?: string | null;
    /** Ficha de prospecto de la escuela con ese teléfono, si la hay. */
    prospecto?: { id: string; nombre: string } | null;
}
export interface ServicioDelCatalogo {
    id: string; nombre: string; tipo: string; precio: number; precio_afiliado: number | null;
    permite_abono: boolean; abono_minimo_pct: number | null;
    opciones: { clave: string; etiqueta: string; precio: number }[];
}
interface Dueno { tipo: 'child' | 'unregistered' | 'lead' | 'user'; id: string; nombre: string; detalle: string }
interface CobroAbierto { id: string; concepto: string; monto: number; estado: string; vence: string | null }

export const ETIQUETA_DE: Record<string, string> = {
    abono_de_cobro: 'Posible abono', saldo_de_cobro: 'Posible saldo', servicio_nuevo: 'Servicio nuevo',
    inscripcion: 'Inscripción', clase_de_prueba: 'Clase de prueba', articulo: 'Artículo / uniforme',
    mensualidad: 'Mensualidad', exceso: 'Pagó de más', repetido: 'Posible repetido',
    por_identificar: 'Sin identificar', fuera_de_sportmaps: 'Fuera de SportMaps', otro: 'Por revisar',
};

const cop = (n: number) => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n);

export function diasEsperando(creado: string, ahora = Date.now()): number {
    return Math.max(0, Math.floor((ahora - new Date(creado).getTime()) / 86_400_000));
}

/**
 * Quién mandó el comprobante: el nombre que haya (fila → chat → prospecto → pagador leído) y el contacto COMPLETO.
 * Antes salía «Sin nombre · ···0145»: con cuatro dígitos la escuela no podía buscar el chat ni distinguir dos
 * contactos que terminan igual (Monster, 2026-11-20). Un contacto sin teléfono (usuario de Meta, alias «wau-…»)
 * no tiene número que mostrar.
 */
export function quienEnvio(f: Pick<FilaPorClasificar, 'contacto' | 'contacto_nombre' | 'chat_nombre' | 'prospecto' | 'propuesta'>): {
    nombre: string; telefono: string | null; enlace: string | null; esProspecto: boolean;
} {
    const limpio = (s: string | null | undefined) => String(s ?? '').trim();
    const nombre = limpio(f.contacto_nombre) || limpio(f.chat_nombre) || limpio(f.prospecto?.nombre) || limpio(f.propuesta?.pagador) || 'Sin nombre';
    const digitos = /^\d{10,15}$/.test(limpio(f.contacto)) ? limpio(f.contacto) : null;
    const telefono = !digitos ? null
        : digitos.length === 12 && digitos.startsWith('57')
            ? `+57 ${digitos.slice(2, 5)} ${digitos.slice(5, 8)} ${digitos.slice(8)}`
            : `+${digitos}`;
    return { nombre, telefono, enlace: digitos ? `https://wa.me/${digitos}` : null, esProspecto: !!f.prospecto };
}

/** Lo que se le explica a la escuela cuando la base no creó el cobro. */
export function explicarErrorDeCreacion(e: { error?: string; precio?: number | null; abono_minimo?: number | null }, monto: number): string {
    switch (e.error) {
        case 'monto_no_coincide':
            return `El comprobante es de ${cop(monto)} y el precio del catálogo hoy es ${e.precio != null ? cop(e.precio) : 'otro'}`
                + (e.abono_minimo != null ? ` (abono mínimo ${cop(e.abono_minimo)})` : '')
                + '. Aplícalo a un cobro que ya exista o regístralo en Pagos.';
        case 'ya_tiene_cobro': return 'Esa persona ya tiene un cobro de este servicio. Usa «Aplicar a un cobro».';
        case 'sin_cupos': return 'El servicio ya no tiene cupos.';
        case 'opcion_requerida': return 'Este servicio tiene opciones: elige una.';
        case 'opcion_invalida': return 'La opción elegida no existe.';
        case 'item_vencido': return 'El servicio ya venció.';
        case 'referencia_ya_usada': return 'Esa referencia de banco ya está en otro pago: este comprobante es un repetido.';
        case 'sin_lectura': return 'El comprobante no tiene lectura guardada: regístralo a mano en Pagos.';
        default: return 'No se pudo crear el cobro.';
    }
}

export function PorClasificarCard({ schoolId, onCambio }: { schoolId: string; onCambio?: () => void }) {
    const { toast } = useToast();
    const [filas, setFilas] = useState<FilaPorClasificar[]>([]);
    const [servicios, setServicios] = useState<ServicioDelCatalogo[]>([]);
    const [cargando, setCargando] = useState(true);
    const [crear, setCrear] = useState<FilaPorClasificar | null>(null);
    const [aplicar, setAplicar] = useState<FilaPorClasificar | null>(null);
    const [descartar, setDescartar] = useState<FilaPorClasificar | null>(null);

    const cargar = useCallback(async () => {
        try {
            const r = await bffClient.get<{ filas: FilaPorClasificar[]; servicios: ServicioDelCatalogo[] }>(
                `/api/v1/whatsapp/${schoolId}/por-clasificar`);
            setFilas(r.filas ?? []); setServicios(r.servicios ?? []);
        } catch {
            setFilas([]); // sin permiso o sin migración: la tarjeta no aparece
        } finally { setCargando(false); }
    }, [schoolId]);

    useEffect(() => { void cargar(); }, [cargar]);

    const alResolver = async (titulo: string) => {
        toast({ title: titulo });
        await cargar();
        onCambio?.();
    };

    if (cargando || filas.length === 0) return null;
    const total = filas.reduce((s, f) => s + Number(f.monto), 0);

    return (
        <>
            <Card className="mb-4 border-orange-300 bg-orange-50/10" data-testid="por-clasificar">
                <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-base sm:text-lg">
                        <Inbox className="h-5 w-5 text-orange-600 shrink-0" />
                        Comprobantes por clasificar
                        <Badge variant="secondary">{filas.length}</Badge>
                        <span className="text-sm font-normal text-muted-foreground">{cop(total)}</span>
                    </CardTitle>
                    <CardDescription>
                        Llegaron por WhatsApp con plata y el asistente no supo a qué cobro van. Decide tú: nada se aprueba solo.
                        Lo que crees o apliques aquí queda en «Cobros por Aprobar».
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-2">
                    {filas.map((f) => {
                        const dias = diasEsperando(f.created_at);
                        const quien = quienEnvio(f);
                        return (
                            <div key={f.id} className="flex flex-col gap-3 rounded-lg border bg-background p-3 sm:flex-row sm:items-center" data-testid={`pc-${f.id}`}>
                                {f.archivo_url ? (
                                    <a href={f.archivo_url} target="_blank" rel="noreferrer" aria-label="Ver comprobante" className="shrink-0">
                                        <img src={f.archivo_url} alt="Comprobante" className="h-16 w-16 rounded object-cover border" loading="lazy" />
                                    </a>
                                ) : (
                                    <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded border bg-muted"><FileText className="h-6 w-6 text-muted-foreground" /></div>
                                )}
                                <div className="min-w-0 flex-1 space-y-1">
                                    <div className="flex flex-wrap items-center gap-2">
                                        <span className="font-semibold">{cop(Number(f.monto))}</span>
                                        <Badge variant="outline">{ETIQUETA_DE[f.etiqueta] ?? 'Por revisar'}</Badge>
                                        {dias >= 1 && <span className={`text-xs ${dias >= 2 ? 'text-red-600 font-medium' : 'text-muted-foreground'}`}>hace {dias} {dias === 1 ? 'día' : 'días'}</span>}
                                    </div>
                                    <div className="text-xs text-muted-foreground">
                                        <span className="font-medium text-foreground">{quien.nombre}</span>
                                        {quien.esProspecto ? ' (prospecto)' : ''}
                                        {quien.telefono && quien.enlace ? (
                                            <> · <a href={quien.enlace} target="_blank" rel="noreferrer" className="underline underline-offset-2" aria-label={`Abrir el chat de WhatsApp de ${quien.telefono}`}>{quien.telefono}</a></>
                                        ) : f.contacto ? ' · sin teléfono (usuario de WhatsApp)' : ''}
                                        {f.referencia ? ` · ref. ${f.referencia}` : ''}
                                        {f.fecha_comprobante ? ` · ${f.fecha_comprobante}` : ''}
                                        {f.banco ? ` · ${f.banco}` : ''}
                                    </div>
                                    {(f.propuesta?.texto || f.propuesta?.detalle) && (
                                        <div className="line-clamp-2 text-xs italic text-muted-foreground">{f.propuesta?.texto || f.propuesta?.detalle}</div>
                                    )}
                                </div>
                                <div className="flex flex-wrap gap-2 sm:justify-end">
                                    <Button size="sm" variant={f.etiqueta === 'servicio_nuevo' ? 'default' : 'outline'} onClick={() => setCrear(f)}>Crear cobro</Button>
                                    <Button size="sm" variant="outline" onClick={() => setAplicar(f)}>Aplicar a un cobro</Button>
                                    <Button size="sm" variant="ghost" onClick={() => setDescartar(f)}>Descartar</Button>
                                </div>
                            </div>
                        );
                    })}
                </CardContent>
            </Card>

            {crear && (
                <CrearCobroDialog schoolId={schoolId} fila={crear} servicios={servicios}
                    onClose={() => setCrear(null)}
                    onListo={async () => { setCrear(null); await alResolver('Cobro creado: el comprobante quedó en «Cobros por Aprobar»'); }} />
            )}
            {aplicar && (
                <AplicarDialog schoolId={schoolId} fila={aplicar}
                    onClose={() => setAplicar(null)}
                    onListo={async () => { setAplicar(null); await alResolver('Comprobante aplicado: quedó en «Cobros por Aprobar»'); }} />
            )}
            {descartar && (
                <DescartarDialog fila={descartar}
                    onClose={() => setDescartar(null)}
                    onListo={async () => { setDescartar(null); await alResolver('Comprobante descartado'); }} />
            )}
        </>
    );
}

// ── Crear cobro de un servicio del catálogo ─────────────────────────────────

function CrearCobroDialog({ schoolId, fila, servicios, onClose, onListo }: {
    schoolId: string; fila: FilaPorClasificar; servicios: ServicioDelCatalogo[];
    onClose: () => void; onListo: () => void | Promise<void>;
}) {
    const [servicioId, setServicioId] = useState<string>('');
    const [opcion, setOpcion] = useState<string>('');
    // Si el contacto ya tiene ficha de prospecto, la búsqueda arranca con su nombre (se puede cambiar).
    const [q, setQ] = useState(fila.prospecto?.nombre ?? '');
    const [resultados, setResultados] = useState<Dueno[]>([]);
    const [dueno, setDueno] = useState<Dueno | null>(null);
    const [enviando, setEnviando] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const servicio = servicios.find((s) => s.id === servicioId) ?? null;
    const monto = Number(fila.monto);
    const temporizador = useRef<ReturnType<typeof setTimeout>>();

    useEffect(() => {
        clearTimeout(temporizador.current);
        if (q.trim().length < 2) { setResultados([]); return; }
        temporizador.current = setTimeout(async () => {
            try {
                const r = await bffClient.get<{ resultados: { tipo: Dueno['tipo']; id: string; nombre: string; detalle: string }[] }>(
                    `/api/v1/whatsapp/${schoolId}/por-clasificar/duenos?q=${encodeURIComponent(q.trim())}`);
                setResultados(r.resultados ?? []);
            } catch { setResultados([]); }
        }, 250);
        return () => clearTimeout(temporizador.current);
    }, [q, schoolId]);

    const confirmar = async () => {
        if (!servicio || !dueno) return;
        setEnviando(true); setError(null);
        try {
            await bffClient.post(`/api/v1/whatsapp/${schoolId}/por-clasificar/${fila.id}/crear-servicio`, {
                item_id: servicio.id, ...(opcion ? { opcion } : {}), dueno: { tipo: dueno.tipo, id: dueno.id },
            });
            await onListo();
        } catch (e: any) {
            setError(explicarErrorDeCreacion(e?.body ?? e?.data ?? { error: e?.code ?? e?.message }, monto));
        } finally { setEnviando(false); }
    };

    const puedeConfirmar = !!servicio && !!dueno && (servicio.opciones.length === 0 || !!opcion);

    return (
        <Dialog open onOpenChange={(o) => !o && onClose()}>
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle>Crear cobro desde este comprobante</DialogTitle>
                    <DialogDescription>
                        Comprobante de {cop(monto)}{fila.referencia ? ` · ref. ${fila.referencia}` : ''}. El cobro se crea con el precio del catálogo
                        y el comprobante queda «En revisión»: tú lo apruebas después.
                    </DialogDescription>
                </DialogHeader>
                <div className="space-y-4">
                    <div className="space-y-2">
                        <Label>Servicio</Label>
                        <div className="grid gap-2">
                            {servicios.map((s) => (
                                <button type="button" key={s.id} onClick={() => { setServicioId(s.id); setOpcion(''); }}
                                    className={`rounded-lg border p-2 text-left text-sm ${servicioId === s.id ? 'border-primary bg-primary/5' : ''}`}>
                                    <div className="font-medium">{s.nombre}</div>
                                    <div className="text-xs text-muted-foreground">
                                        {s.opciones.length ? `desde ${cop(Math.min(...s.opciones.map((o) => o.precio)))}` : cop(s.precio)}
                                        {s.precio_afiliado != null && !s.opciones.length ? ` · afiliados ${cop(s.precio_afiliado)}` : ''}
                                        {s.permite_abono && s.abono_minimo_pct ? ` · abono desde ${s.abono_minimo_pct} %` : ''}
                                    </div>
                                </button>
                            ))}
                            {servicios.length === 0 && <p className="text-sm text-muted-foreground">No hay servicios activos en el catálogo.</p>}
                        </div>
                    </div>
                    {servicio && servicio.opciones.length > 0 && (
                        <div className="space-y-2">
                            <Label>Opción</Label>
                            <div className="flex flex-wrap gap-2">
                                {servicio.opciones.map((o) => (
                                    <Button key={o.clave} type="button" size="sm" variant={opcion === o.clave ? 'default' : 'outline'} onClick={() => setOpcion(o.clave)}>
                                        {o.etiqueta} · {cop(o.precio)}
                                    </Button>
                                ))}
                            </div>
                        </div>
                    )}
                    <div className="space-y-2">
                        <Label htmlFor="pc-dueno">¿De quién es? (deportista o prospecto)</Label>
                        <Input id="pc-dueno" value={q} onChange={(e) => { setQ(e.target.value); setDueno(null); }} placeholder="Escribe al menos 2 letras del nombre" />
                        {dueno ? (
                            <p className="text-sm">Elegido: <b>{dueno.nombre}</b> <span className="text-muted-foreground">({dueno.detalle})</span></p>
                        ) : resultados.length > 0 ? (
                            <div className="max-h-40 space-y-1 overflow-auto rounded border p-1">
                                {resultados.map((r) => (
                                    <button type="button" key={`${r.tipo}-${r.id}`} onClick={() => setDueno(r)} className="flex w-full justify-between rounded px-2 py-1 text-left text-sm hover:bg-muted">
                                        <span>{r.nombre}</span><span className="text-xs text-muted-foreground">{r.detalle}</span>
                                    </button>
                                ))}
                            </div>
                        ) : q.trim().length >= 2 ? (
                            <p className="text-xs text-muted-foreground">Sin resultados. Si no está en la plataforma, regístralo en Pagos.</p>
                        ) : null}
                    </div>
                    {error && <p role="alert" className="rounded border border-red-300 bg-red-50 p-2 text-sm text-red-700">{error}</p>}
                </div>
                <DialogFooter>
                    <Button variant="ghost" onClick={onClose} disabled={enviando}>Cancelar</Button>
                    <Button onClick={confirmar} disabled={!puedeConfirmar || enviando}>
                        {enviando && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Crear cobro y dejarlo en revisión
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

// ── Aplicar a un cobro abierto ──────────────────────────────────────────────

function AplicarDialog({ schoolId, fila, onClose, onListo }: {
    schoolId: string; fila: FilaPorClasificar; onClose: () => void; onListo: () => void | Promise<void>;
}) {
    const [q, setQ] = useState('');
    const [resultados, setResultados] = useState<CobroAbierto[]>([]);
    const [elegido, setElegido] = useState<CobroAbierto | null>(null);
    const [enviando, setEnviando] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const temporizador = useRef<ReturnType<typeof setTimeout>>();

    useEffect(() => {
        clearTimeout(temporizador.current);
        if (q.trim().length < 2) { setResultados([]); return; }
        temporizador.current = setTimeout(async () => {
            try {
                const r = await bffClient.get<{ resultados: CobroAbierto[] }>(
                    `/api/v1/whatsapp/${schoolId}/por-clasificar/cobros-abiertos?q=${encodeURIComponent(q.trim())}`);
                setResultados(r.resultados ?? []);
            } catch { setResultados([]); }
        }, 250);
        return () => clearTimeout(temporizador.current);
    }, [q, schoolId]);

    const confirmar = async () => {
        if (!elegido) return;
        setEnviando(true); setError(null);
        try {
            await bffClient.post(`/api/v1/whatsapp/${schoolId}/por-clasificar/${fila.id}/aplicar`, { payment_id: elegido.id });
            await onListo();
        } catch (e: any) {
            setError(explicarErrorDeCreacion(e?.body ?? e?.data ?? { error: e?.code ?? e?.message }, Number(fila.monto)));
        } finally { setEnviando(false); }
    };

    return (
        <Dialog open onOpenChange={(o) => !o && onClose()}>
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle>Aplicar a un cobro</DialogTitle>
                    <DialogDescription>
                        Comprobante de {cop(Number(fila.monto))}. Busca el cobro por el nombre del deportista o el concepto; el comprobante queda
                        «En revisión» en ese cobro y tú decides si es abono o pago completo al aprobarlo.
                    </DialogDescription>
                </DialogHeader>
                <div className="space-y-3">
                    <Input value={q} onChange={(e) => { setQ(e.target.value); setElegido(null); }} placeholder="Ej.: Mariana, Mensualidad noviembre, Clínica…" aria-label="Buscar cobro" />
                    {elegido ? (
                        <p className="text-sm">Elegido: <b>{elegido.concepto}</b> · {cop(elegido.monto)}</p>
                    ) : resultados.length > 0 ? (
                        <div className="max-h-52 space-y-1 overflow-auto rounded border p-1">
                            {resultados.map((c) => (
                                <button type="button" key={c.id} onClick={() => setElegido(c)} className="flex w-full justify-between gap-3 rounded px-2 py-1 text-left text-sm hover:bg-muted">
                                    <span className="truncate">{c.concepto}</span>
                                    <span className="shrink-0 text-xs text-muted-foreground">{cop(c.monto)}{c.estado === 'partial' ? ' · con abono' : ''}</span>
                                </button>
                            ))}
                        </div>
                    ) : q.trim().length >= 2 ? (
                        <p className="text-xs text-muted-foreground">No hay cobros abiertos con ese texto.</p>
                    ) : null}
                    {error && <p role="alert" className="rounded border border-red-300 bg-red-50 p-2 text-sm text-red-700">{error}</p>}
                </div>
                <DialogFooter>
                    <Button variant="ghost" onClick={onClose} disabled={enviando}>Cancelar</Button>
                    <Button onClick={confirmar} disabled={!elegido || enviando}>
                        {enviando && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Aplicar y dejar en revisión
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

// ── Descartar ───────────────────────────────────────────────────────────────

const MOTIVOS_RAPIDOS = ['No es un pago de la escuela', 'Repetido (ya está aplicado)', 'Ya lo registré en Pagos', 'Pago por fuera de la escuela'];

function DescartarDialog({ fila, onClose, onListo }: { fila: FilaPorClasificar; onClose: () => void; onListo: () => void | Promise<void> }) {
    const [motivo, setMotivo] = useState('');
    const [enviando, setEnviando] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const confirmar = async () => {
        setEnviando(true); setError(null);
        try {
            const { data, error: e } = await supabase.rpc('wa_comprobante_por_clasificar_descartar' as any, { p_id: fila.id, p_motivo: motivo.trim() });
            if (e) throw e;
            if (!(data as any)?.ok) throw new Error((data as any)?.codigo ?? 'no_se_pudo');
            await onListo();
        } catch (e: any) {
            setError(e?.message === 'ya_cerrado' ? 'Este comprobante ya estaba cerrado.' : 'No se pudo descartar. Intenta de nuevo.');
        } finally { setEnviando(false); }
    };

    return (
        <Dialog open onOpenChange={(o) => !o && onClose()}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Descartar comprobante</DialogTitle>
                    <DialogDescription>{cop(Number(fila.monto))}{fila.referencia ? ` · ref. ${fila.referencia}` : ''}. No toca ningún pago; queda el motivo.</DialogDescription>
                </DialogHeader>
                <div className="space-y-3">
                    <div className="flex flex-wrap gap-2">
                        {MOTIVOS_RAPIDOS.map((m) => <Button key={m} type="button" size="sm" variant="outline" onClick={() => setMotivo(m)}>{m}</Button>)}
                    </div>
                    <Label htmlFor="pc-motivo">Motivo</Label>
                    <Textarea id="pc-motivo" value={motivo} onChange={(e) => setMotivo(e.target.value)} rows={2} maxLength={200} />
                    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
                </div>
                <DialogFooter>
                    <Button variant="ghost" onClick={onClose} disabled={enviando}>Cancelar</Button>
                    <Button variant="destructive" onClick={confirmar} disabled={motivo.trim().length < 3 || enviando}>
                        {enviando && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Descartar
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
