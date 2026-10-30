/**
 * Los horarios de entrenamiento que el bot le dice a las familias.
 *
 * POR QUÉ EXISTE
 *
 * «¿A qué hora entrena mi hijo?» es la pregunta más frecuente de todas, y hasta
 * hoy no había NINGUNA pantalla donde cargar la respuesta: `teams.schedule`
 * existe desde siempre y ningún formulario escribía ahí. De 368 escuelas, 28
 * equipos tenían horario y casi todos eran datos sembrados de la demo.
 *
 * Los de Dynasty se cargaron con un script, transcribiendo a mano las piezas
 * gráficas que la escuela publicó. Eso no escala: esta pantalla es para que la
 * escuela número tres no dependa de que alguien le transcriba imágenes.
 *
 * LO QUE EL BOT HACE CON ESTO
 *
 * Un grupo sin horario NO se inventa: el bot responde «ese horario no lo tengo,
 * la escuela te lo confirma». Por eso la pantalla muestra cuáles faltan — no
 * para regañar, sino porque cada uno que falta es una pregunta que le va a
 * llegar a la escuela igual.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import {
    Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Clock, Plus, Trash2, Loader2, AlertTriangle, Check } from 'lucide-react';
import { faltaEnLaBase } from '@/lib/esquemaPendiente';

/** `day` sigue a Date.getDay(): 0 = domingo. */
interface Franja {
    day: number;
    time: string;
    end: string;
    place?: string;
    /** Subgrupo, cuando un equipo se divide y el sistema no lo modela aparte. */
    group?: string;
}

interface Equipo {
    id: string;
    name: string;
    student_count: number | null;
    franjas: Franja[];
    /** false = no recibe atletas nuevos. Los inscritos siguen igual. */
    admite_nuevos: boolean;
    nota_admision: string;
    /**
     * false = el bot no agenda clases de prueba en este grupo (mig.
     * embudo_y_agenda_clase_prueba). Distinto de `admite_nuevos`: Monster recibe
     * nuevos en Competencia, pero la clase de prueba va siempre a Proyección.
     */
    recibe_clase_prueba: boolean;
}

const DIAS = [
    { v: 1, n: 'Lunes' }, { v: 2, n: 'Martes' }, { v: 3, n: 'Miércoles' },
    { v: 4, n: 'Jueves' }, { v: 5, n: 'Viernes' }, { v: 6, n: 'Sábado' },
    { v: 0, n: 'Domingo' },
];
const nombreDia = (d: number) => DIAS.find((x) => x.v === d)?.n ?? '';

/** Ordena como se lee una semana, con el domingo al final y no al principio. */
const ordenSemana = (a: Franja, b: Franja) =>
    ((a.day === 0 ? 7 : a.day) - (b.day === 0 ? 7 : b.day)) || a.time.localeCompare(b.time);

function leerFranjas(raw: unknown): Franja[] {
    let v: unknown = raw;
    if (typeof raw === 'string') {
        try { v = JSON.parse(raw); } catch { return []; }
    }
    if (!Array.isArray(v)) return [];
    return v
        .filter((f: any) => f && typeof f.day === 'number' && f.time)
        .map((f: any) => ({
            day: f.day, time: String(f.time), end: String(f.end ?? ''),
            place: f.place ? String(f.place) : undefined,
            group: f.group ? String(f.group) : undefined,
        }));
}

export function HorariosDeEntrenamiento({ schoolId }: { schoolId: string }) {
    const { toast } = useToast();
    const [equipos, setEquipos] = useState<Equipo[]>([]);
    const [sedes, setSedes] = useState<string[]>([]);
    // La columna `teams.recibe_clase_prueba` puede no existir todavía: sin ella,
    // el interruptor no se muestra y se guarda lo de siempre.
    const [conClasePrueba, setConClasePrueba] = useState(false);
    const [cargando, setCargando] = useState(true);
    const [guardando, setGuardando] = useState<string | null>(null);

    const cargar = useCallback(async () => {
        setCargando(true);
        const columnas = 'id, name, schedule, student_count, admite_nuevos, nota_admision';
        const leerEquipos = (cols: string) => (supabase.from('teams') as any)
            .select(cols).eq('school_id', schoolId).order('name');
        const [primera, { data: br }] = await Promise.all([
            leerEquipos(`${columnas}, recibe_clase_prueba`),
            supabase.from('school_branches').select('name').eq('school_id', schoolId),
        ]);
        let eq = primera.data;
        const conColumna = !faltaEnLaBase(primera.error, primera.status);
        if (!conColumna) eq = (await leerEquipos(columnas)).data;
        setConClasePrueba(conColumna && !primera.error);
        setEquipos(((eq ?? []) as any[]).map((t) => ({
            id: t.id, name: t.name, student_count: t.student_count,
            franjas: leerFranjas(t.schedule).sort(ordenSemana),
            admite_nuevos: t.admite_nuevos !== false,
            nota_admision: t.nota_admision ?? '',
            recibe_clase_prueba: t.recibe_clase_prueba !== false,
        })));
        setSedes(((br ?? []) as any[]).map((b) => String(b.name)).filter(Boolean));
        setCargando(false);
    }, [schoolId]);

    useEffect(() => { void cargar(); }, [cargar]);

    const sinHorario = useMemo(() => equipos.filter((e) => !e.franjas.length), [equipos]);

    function editar(equipoId: string, fn: (f: Franja[]) => Franja[]) {
        setEquipos((prev) => prev.map((e) => e.id === equipoId ? { ...e, franjas: fn(e.franjas) } : e));
    }

    async function guardar(equipo: Equipo) {
        // Una franja que termina antes de empezar deja al bot diciendo un
        // disparate con total seguridad. Se corta acá, no al leerla.
        const mala = equipo.franjas.find((f) => !f.time || !f.end || f.end <= f.time);
        if (mala) {
            toast({
                title: 'Revisa las horas',
                description: `El ${nombreDia(mala.day).toLowerCase()} termina antes o al mismo tiempo que empieza.`,
                variant: 'destructive',
            });
            return;
        }

        setGuardando(equipo.id);
        // `recibe_clase_prueba` todavía no está en types.ts: por eso el `as any`.
        const { error } = await (supabase.from('teams') as any)
            .update({
                schedule: equipo.franjas.sort(ordenSemana) as any,
                admite_nuevos: equipo.admite_nuevos,
                nota_admision: equipo.nota_admision.trim() || null,
                ...(conClasePrueba ? { recibe_clase_prueba: equipo.recibe_clase_prueba } : {}),
            })
            .eq('id', equipo.id);
        setGuardando(null);

        if (error) {
            toast({ title: 'No se pudo guardar', description: error.message, variant: 'destructive' });
            return;
        }
        toast({ title: `${equipo.name} actualizado`, description: 'El bot ya responde con este horario.' });
    }

    if (cargando) {
        return <div className="flex items-center gap-2 py-10 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Cargando equipos…
        </div>;
    }

    return (
        <div className="space-y-4">
            <Card>
                <CardHeader className="pb-3">
                    <CardTitle className="flex items-center gap-2 text-base">
                        <Clock className="h-4 w-4" /> Horarios de entrenamiento
                    </CardTitle>
                    <CardDescription>
                        Es lo que el bot le responde a las familias cuando preguntan a qué hora
                        entrena su hijo. Un grupo sin horario no se inventa: el bot dice que no
                        lo tiene y la pregunta les llega a ustedes.
                    </CardDescription>
                </CardHeader>
                {sinHorario.length > 0 && (
                    <CardContent className="pt-0">
                        <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm dark:border-amber-900/50 dark:bg-amber-950/30">
                            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                            <div>
                                <span className="font-medium">
                                    {sinHorario.length} {sinHorario.length === 1 ? 'grupo' : 'grupos'} sin horario:
                                </span>{' '}
                                {sinHorario.map((e) => e.name).join(', ')}
                            </div>
                        </div>
                    </CardContent>
                )}
            </Card>

            {equipos.map((equipo) => (
                <Card key={equipo.id}>
                    <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0 pb-3">
                        <div className="min-w-0">
                            <CardTitle className="truncate text-base">{equipo.name}</CardTitle>
                            <CardDescription>
                                {equipo.student_count ?? 0} atletas
                                {equipo.franjas.length === 0 && ' · sin horario'}
                                {!equipo.admite_nuevos && ' · no recibe nuevos'}
                                {conClasePrueba && !equipo.recibe_clase_prueba && ' · sin clases de prueba'}
                            </CardDescription>
                        </div>
                        <Button
                            size="sm"
                            onClick={() => void guardar(equipo)}
                            disabled={guardando === equipo.id}
                        >
                            {guardando === equipo.id
                                ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                                : <Check className="mr-1 h-3.5 w-3.5" />}
                            Guardar
                        </Button>
                    </CardHeader>

                    <CardContent className="space-y-3">
                        {/* Cerrar admisiones NO es dar de baja: los inscritos siguen
                            exactamente igual. Es lo que permite decir «esta categoria no
                            la ofertamos este ano» sin romperle la inscripcion a nadie. */}
                        <div className="flex flex-wrap items-center gap-3 rounded-md border p-3">
                            <Switch
                                id={`admite-${equipo.id}`}
                                checked={equipo.admite_nuevos}
                                onCheckedChange={(v) => setEquipos((prev) => prev.map((e) =>
                                    e.id === equipo.id ? { ...e, admite_nuevos: v } : e))}
                            />
                            <Label htmlFor={`admite-${equipo.id}`} className="cursor-pointer">
                                Recibe atletas nuevos
                            </Label>
                            {!equipo.admite_nuevos && (
                                <Input
                                    className="min-w-[16rem] flex-1"
                                    placeholder="Qué responder a quien pregunte por este grupo"
                                    value={equipo.nota_admision}
                                    onChange={(e) => setEquipos((prev) => prev.map((x) =>
                                        x.id === equipo.id ? { ...x, nota_admision: e.target.value } : x))}
                                />
                            )}
                        </div>
                        {/* La clase de prueba del bot solo se agenda en los grupos con esto
                            prendido (p. ej. solo los de Proyección). Nace prendido. */}
                        {conClasePrueba && (
                            <div className="flex flex-wrap items-center gap-3 rounded-md border p-3">
                                <Switch
                                    id={`clase-prueba-${equipo.id}`}
                                    checked={equipo.recibe_clase_prueba}
                                    onCheckedChange={(v) => setEquipos((prev) => prev.map((e) =>
                                        e.id === equipo.id ? { ...e, recibe_clase_prueba: v } : e))}
                                />
                                <Label htmlFor={`clase-prueba-${equipo.id}`} className="cursor-pointer">
                                    Recibe clases de prueba
                                </Label>
                                <span className="text-xs text-muted-foreground">
                                    Apagado, el bot no agenda clases de prueba en este grupo.
                                </span>
                            </div>
                        )}
                        {equipo.franjas.map((f, i) => (
                            <div key={i} className="flex flex-wrap items-end gap-2 rounded-md border p-3">
                                <div className="w-full sm:w-36">
                                    <Label className="text-xs">Día</Label>
                                    <Select
                                        value={String(f.day)}
                                        onValueChange={(v) => editar(equipo.id, (fr) =>
                                            fr.map((x, j) => j === i ? { ...x, day: Number(v) } : x))}
                                    >
                                        <SelectTrigger><SelectValue /></SelectTrigger>
                                        <SelectContent>
                                            {DIAS.map((d) => (
                                                <SelectItem key={d.v} value={String(d.v)}>{d.n}</SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </div>

                                <div className="w-[7.5rem]">
                                    <Label className="text-xs">Desde</Label>
                                    <Input
                                        type="time" value={f.time}
                                        onChange={(e) => editar(equipo.id, (fr) =>
                                            fr.map((x, j) => j === i ? { ...x, time: e.target.value } : x))}
                                    />
                                </div>

                                <div className="w-[7.5rem]">
                                    <Label className="text-xs">Hasta</Label>
                                    <Input
                                        type="time" value={f.end}
                                        onChange={(e) => editar(equipo.id, (fr) =>
                                            fr.map((x, j) => j === i ? { ...x, end: e.target.value } : x))}
                                    />
                                </div>

                                {/* La sede va POR FRANJA, no por equipo: hay grupos que rotan entre
                                    tres canchas dentro de la misma semana. */}
                                <div className="min-w-[10rem] flex-1">
                                    <Label className="text-xs">Sede</Label>
                                    <Input
                                        list={`sedes-${equipo.id}`}
                                        placeholder="Dónde entrenan ese día"
                                        value={f.place ?? ''}
                                        onChange={(e) => editar(equipo.id, (fr) =>
                                            fr.map((x, j) => j === i ? { ...x, place: e.target.value } : x))}
                                    />
                                    <datalist id={`sedes-${equipo.id}`}>
                                        {sedes.map((s) => <option key={s} value={s} />)}
                                    </datalist>
                                </div>

                                {/* Para los equipos que la escuela divide pero el sistema no:
                                    «Origen» y «Evolución» dentro del mismo Intermedio. Si se
                                    llena, el bot agrupa el horario por subgrupo. */}
                                <div className="min-w-[8rem] flex-1">
                                    <Label className="text-xs">Subgrupo (opcional)</Label>
                                    <Input
                                        placeholder="Origen, Selección…"
                                        value={f.group ?? ''}
                                        onChange={(e) => editar(equipo.id, (fr) =>
                                            fr.map((x, j) => j === i ? { ...x, group: e.target.value } : x))}
                                    />
                                </div>

                                <Button
                                    variant="ghost" size="icon"
                                    aria-label={`Quitar ${nombreDia(f.day)}`}
                                    onClick={() => editar(equipo.id, (fr) => fr.filter((_, j) => j !== i))}
                                >
                                    <Trash2 className="h-4 w-4 text-destructive" />
                                </Button>
                            </div>
                        ))}

                        <Button
                            variant="outline" size="sm"
                            onClick={() => editar(equipo.id, (fr) => [
                                ...fr, { day: 1, time: '16:00', end: '18:00', place: sedes[0] ?? '' },
                            ])}
                        >
                            <Plus className="mr-1 h-3.5 w-3.5" /> Agregar día
                        </Button>

                        {equipo.franjas.length > 0 && (
                            <div className="flex flex-wrap gap-1.5 pt-1">
                                {equipo.franjas.slice().sort(ordenSemana).map((f, i) => (
                                    <Badge key={i} variant="secondary" className="font-normal">
                                        {f.group ? `${f.group} · ` : ''}{nombreDia(f.day)} {f.time}–{f.end}
                                        {f.place ? ` (${f.place})` : ''}
                                    </Badge>
                                ))}
                            </div>
                        )}
                    </CardContent>
                </Card>
            ))}
        </div>
    );
}
