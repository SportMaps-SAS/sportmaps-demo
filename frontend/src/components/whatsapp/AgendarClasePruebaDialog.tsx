/**
 * AgendarClasePruebaDialog — «Agendar» desde el buzón de WhatsApp.
 *
 * Deja a quien escribe con cupo de clase de prueba en un solo paso (y, si ya
 * pagó, con su pago), sin pasar por Deportistas ni SQL. Sirve también para
 * contactos con alias de Meta (sin teléfono): la RPC usa el id de WhatsApp de
 * la conversación como teléfono del prospecto.
 *
 * NO envía nada al contacto: al terminar deja el mensaje de confirmación en la
 * caja de texto del buzón para que la persona lo lea y lo mande.
 */
import { useEffect, useMemo, useState } from 'react';
import { useToast } from '@/hooks/use-toast';
import { useCuposClasePrueba, type CupoClasePrueba } from '@/hooks/useClasePrueba';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import {
    Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { CalendarPlus, Loader2 } from 'lucide-react';

const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

/** «sábado 14 de noviembre» — sin pasar por Date con zona: el día es el de la fecha escrita. */
export function fechaLegible(iso: string): string {
    const [a, m, d] = iso.slice(0, 10).split('-').map(Number);
    const dia = DIAS[new Date(Date.UTC(a, m - 1, d)).getUTCDay()];
    return `${dia} ${d} de ${MESES[m - 1]}`;
}

export function horaLegible(h: string | null): string {
    if (!h) return '';
    const [hh, mm] = h.split(':').map(Number);
    const ampm = hh >= 12 ? 'p. m.' : 'a. m.';
    const h12 = hh % 12 === 0 ? 12 : hh % 12;
    return `${h12}:${String(mm).padStart(2, '0')} ${ampm}`;
}

/** Cupos abiertos, de hoy en adelante y con espacio, del más próximo al más lejano. */
export function cuposAgendables(cupos: CupoClasePrueba[], hoy: string): CupoClasePrueba[] {
    return cupos
        .filter((c) => c.is_open && c.slot_date.slice(0, 10) >= hoy && c.reserved_count < c.max_capacity)
        .sort((a, b) => a.slot_date.localeCompare(b.slot_date) || a.start_time.localeCompare(b.start_time) || a.label.localeCompare(b.label));
}

export function mensajeDeConfirmacion(p: { acudiente: string; nombre: string; cupo: CupoClasePrueba; pagado: boolean }): string {
    const primero = (p.acudiente || '').trim().split(/\s+/)[0] || '';
    const hora = `${horaLegible(p.cupo.start_time)}${p.cupo.end_time ? ` a ${horaLegible(p.cupo.end_time)}` : ''}`;
    return [
        `Hola${primero ? ` ${primero}` : ''} 👋 Ya quedó agendada la clase de prueba de ${p.nombre.trim().split(/\s+/)[0]}:`,
        '',
        `📅 ${fechaLegible(p.cupo.slot_date)}`,
        `🕘 ${hora}`,
        ...(p.cupo.location ? [`📍 ${p.cupo.location}`] : []),
        `🏐 ${p.cupo.label}`,
        ...(p.pagado ? ['', 'El pago ya está registrado ✅'] : []),
        '',
        '¿Nos regalas un número de celular para enviarte los recordatorios?',
    ].join('\n');
}

export function AgendarClasePruebaDialog({
    schoolId, conversacionId, nombreInicial, abierto, onAbiertoChange, onHecho,
}: {
    schoolId: string;
    conversacionId: string | null;
    /** Nombre del contacto de la conversación (suele ser el del acudiente). */
    nombreInicial: string | null;
    abierto: boolean;
    onAbiertoChange: (v: boolean) => void;
    /** `mensaje` es el texto de confirmación para dejar en la caja del buzón. */
    onHecho: (r: { mensaje: string }) => void;
}) {
    const { toast } = useToast();
    const { cupos, isLoading } = useCuposClasePrueba(schoolId, abierto);
    const [nombre, setNombre] = useState('');
    const [nacimiento, setNacimiento] = useState('');
    const [genero, setGenero] = useState<'F' | 'M' | ''>('');
    const [acudiente, setAcudiente] = useState('');
    const [cupoId, setCupoId] = useState<string | null>(null);
    const [filtro, setFiltro] = useState('');
    const [conPago, setConPago] = useState(false);
    const [monto, setMonto] = useState('');
    const [metodo, setMetodo] = useState<'transfer' | 'cash' | 'card' | 'other'>('transfer');
    const [referencia, setReferencia] = useState('');
    const [guardando, setGuardando] = useState(false);

    useEffect(() => {
        if (!abierto) return;
        setNombre(''); setNacimiento(''); setGenero(''); setCupoId(null); setFiltro('');
        setConPago(false); setMonto(''); setMetodo('transfer'); setReferencia('');
        setAcudiente((nombreInicial ?? '').replace(/\s*\(@[^)]*\)\s*$/, '').trim());
    }, [abierto, nombreInicial]);

    const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
    const disponibles = useMemo(() => {
        const q = filtro.trim().toLowerCase();
        return cuposAgendables(cupos, hoy).filter((c) => !q
            || `${c.label} ${c.location ?? ''} ${fechaLegible(c.slot_date)}`.toLowerCase().includes(q));
    }, [cupos, hoy, filtro]);
    const elegido = cupos.find((c) => c.id === cupoId) ?? null;
    const montoNum = Number(monto.replace(/[^\d]/g, ''));
    const listo = !!nombre.trim() && !!elegido && (!conPago || montoNum > 0) && !guardando;

    const MENSAJES: Record<string, string> = {
        CUPO_LLENO: 'Ese cupo ya se llenó. Elige otro.',
        CUPO_NO_DISPONIBLE: 'Ese cupo ya no está disponible.',
        CLASE_PRUEBA_YA_PAGADA: 'Esta clase de prueba ya tiene un pago registrado.',
        NOMBRE_REQUERIDO: 'Escribe el nombre del deportista.',
    };

    const agendar = async () => {
        if (!conversacionId || !elegido) return;
        setGuardando(true);
        try {
            const { error: err } = await (supabase as any).rpc('agendar_clase_prueba_desde_chat', {
                p_conversation_id: conversacionId,
                p_slot_id: elegido.id,
                p_nombre: nombre.trim(),
                p_fecha_nacimiento: nacimiento || null,
                p_genero: genero || null,
                p_acudiente: acudiente.trim() || null,
                p_monto: conPago ? montoNum : null,
                p_metodo: conPago ? metodo : null,
                p_referencia: conPago ? (referencia.trim() || null) : null,
            });
            if (err) {
                const clave = Object.keys(MENSAJES).find((k) => String(err.message ?? '').includes(k));
                throw new Error(clave ? MENSAJES[clave] : (err.message ?? 'Error'));
            }
            toast({ title: 'Clase de prueba agendada', description: `${nombre.trim()} · ${fechaLegible(elegido.slot_date)}` });
            onHecho({ mensaje: mensajeDeConfirmacion({ acudiente, nombre, cupo: elegido, pagado: conPago }) });
            onAbiertoChange(false);
        } catch (e) {
            toast({ title: 'No se pudo agendar', description: e instanceof Error ? e.message : undefined, variant: 'destructive' });
        } finally {
            setGuardando(false);
        }
    };

    return (
        <Dialog open={abierto} onOpenChange={onAbiertoChange}>
            <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2"><CalendarPlus className="h-5 w-5" /> Agendar clase de prueba</DialogTitle>
                    <DialogDescription>
                        Deja el cupo asignado. No le escribe al contacto: el mensaje de confirmación queda en la caja de texto para que lo revises y lo envíes.
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-3">
                    <div className="grid grid-cols-2 gap-3">
                        <div className="col-span-2">
                            <Label htmlFor="ag-nombre">Deportista</Label>
                            <Input id="ag-nombre" value={nombre} onChange={(e) => setNombre(e.target.value)} placeholder="Nombre completo" />
                        </div>
                        <div>
                            <Label htmlFor="ag-nac">Fecha de nacimiento</Label>
                            <Input id="ag-nac" type="date" value={nacimiento} onChange={(e) => setNacimiento(e.target.value)} />
                        </div>
                        <div>
                            <Label>Género</Label>
                            <div className="flex gap-2 mt-1">
                                <Button type="button" size="sm" variant={genero === 'F' ? 'default' : 'outline'} onClick={() => setGenero('F')}>Mujer</Button>
                                <Button type="button" size="sm" variant={genero === 'M' ? 'default' : 'outline'} onClick={() => setGenero('M')}>Hombre</Button>
                            </div>
                        </div>
                        <div className="col-span-2">
                            <Label htmlFor="ag-acu">Acudiente</Label>
                            <Input id="ag-acu" value={acudiente} onChange={(e) => setAcudiente(e.target.value)} />
                        </div>
                    </div>

                    <div>
                        <Label htmlFor="ag-filtro">Cupo</Label>
                        <Input id="ag-filtro" value={filtro} onChange={(e) => setFiltro(e.target.value)}
                               placeholder="Filtrar por grupo, sede o día (ej. sábado, U15, Suba)" />
                        <div className="mt-2 max-h-56 overflow-y-auto rounded-md border divide-y" role="listbox" aria-label="Cupos disponibles">
                            {isLoading && <p className="p-3 text-sm text-muted-foreground">Cargando cupos…</p>}
                            {!isLoading && disponibles.length === 0 && (
                                <p className="p-3 text-sm text-muted-foreground">No hay cupos abiertos con ese filtro (o solo el administrador puede verlos).</p>
                            )}
                            {disponibles.map((c) => (
                                <button key={c.id} type="button" role="option" aria-selected={c.id === cupoId}
                                        onClick={() => setCupoId(c.id)}
                                        className={`w-full text-left p-2.5 text-sm hover:bg-muted ${c.id === cupoId ? 'bg-primary/10' : ''}`}>
                                    <span className="font-medium">{fechaLegible(c.slot_date)} · {horaLegible(c.start_time)}</span>
                                    <span className="block text-muted-foreground">{c.label}{c.location ? ` — ${c.location}` : ''}</span>
                                </button>
                            ))}
                        </div>
                    </div>

                    <div className="rounded-md border p-3 space-y-2">
                        <label className="flex items-center gap-2 text-sm cursor-pointer">
                            <Checkbox checked={conPago} onCheckedChange={(v) => setConPago(v === true)} />
                            Ya pagó la clase de prueba
                        </label>
                        {conPago && (
                            <div className="grid grid-cols-2 gap-3">
                                <div>
                                    <Label htmlFor="ag-monto">Valor</Label>
                                    <Input id="ag-monto" inputMode="numeric" value={monto} onChange={(e) => setMonto(e.target.value)} placeholder="15000" />
                                </div>
                                <div>
                                    <Label htmlFor="ag-metodo">Medio</Label>
                                    <select id="ag-metodo" value={metodo} onChange={(e) => setMetodo(e.target.value as typeof metodo)}
                                            className="h-10 w-full rounded-md border bg-background px-2 text-sm">
                                        <option value="transfer">Transferencia / Nequi</option>
                                        <option value="cash">Efectivo</option>
                                        <option value="card">Tarjeta</option>
                                        <option value="other">Otro</option>
                                    </select>
                                </div>
                                <div className="col-span-2">
                                    <Label htmlFor="ag-ref">Referencia (opcional)</Label>
                                    <Input id="ag-ref" value={referencia} onChange={(e) => setReferencia(e.target.value)} />
                                </div>
                            </div>
                        )}
                    </div>
                </div>

                <DialogFooter>
                    <Button variant="outline" onClick={() => onAbiertoChange(false)} disabled={guardando}>Cancelar</Button>
                    <Button onClick={() => void agendar()} disabled={!listo}>
                        {guardando ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <CalendarPlus className="h-4 w-4 mr-1" />}
                        Agendar
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
