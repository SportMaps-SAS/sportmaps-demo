/**
 * Informe Mensual del Atleta — tablero de la escuela.
 *
 * El ciclo entero en una pantalla: generar borradores → escribir la nota de cada
 * equipo → publicar el lote → enviar.
 *
 * Es deliberadamente operativa, no bonita: el objetivo es poder mandar el
 * informe hoy. El tablero de cobertura fino (F3) y la vista del padre (F4) son
 * fases siguientes de docs/specs/athlete-reports-module.md.
 */
import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import {
    Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { useSchoolContext } from '@/hooks/useSchoolContext';
import { useAuth } from '@/contexts/AuthContext';
import { bffClient } from '@/lib/api/bffClient';
import { supabase } from '@/integrations/supabase/client';
import { FileText, Send, Users, Loader2, CheckCircle2, AlertCircle } from 'lucide-react';
import { downloadAthleteReportPdf } from '@/lib/school/reportsQueries';
import { fetchCoachTeams } from '@/lib/coachTeamScope';

const MESES = [
    'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
    'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
];

interface ReportRow {
    id: string;
    subject_type: string;
    subject_id: string;
    team_id: string | null;
    status: string;
    scheduled_for: string;
    recipient_id: string | null;
    sent_at: string | null;
    viewed_at: string | null;
    teams: { name: string } | null;
    athlete_name: string;
    coach_note: string | null;
}

interface Resumen {
    total: number;
    borrador: number;
    listo: number;
    publicados: number;
    retenidos: number;
    enviados: number;
    leidos: number;
    sin_destinatario: number;
}

/**
 * Cobertura por equipo (RPC `report_coverage`, M4). Se calcula sobre los
 * INSCRITOS del mes, no sobre los informes que existen, así que es la única
 * fuente que puede contar a los atletas que NADIE midió — que son justo los que
 * hay que perseguir. `Resumen` cuenta filas ya creadas y por definición no los ve.
 */
interface Cobertura {
    team_id: string | null;
    team_name: string;
    total: number;
    listos: number;
    faltan_nota: number;
    publicados: number;
    leidos: number;
    sin_destinatario: number;
    sin_mediciones_con_asistencia: number;
    sin_actividad: number;
}

interface ReportsResponse {
    year: number;
    month: number;
    resumen: Resumen;
    cobertura: Cobertura[];
    release_by: 'school' | 'coach';
    reports: ReportRow[];
}

export default function MonthlyReportsPage() {
    const { schoolId } = useSchoolContext();
    const { profile } = useAuth();
    const { toast } = useToast();

    /**
     * Coach = autor, escuela = publica (D2). Son dos responsabilidades distintas
     * y un solo botón para ambas es el error que este módulo evita.
     *
     * Generar borradores y enviar son del admin: el BFF los limita a ADMIN_ROLES,
     * así que mostrarle esos botones al coach sería ofrecerle un 403. Publicar
     * depende de school_settings.reports_release_by, que se valida dentro de la
     * RPC — se le deja visible y la RPC decide.
     */
    const isCoach = profile?.role === 'coach';
    const queryClient = useQueryClient();

    const hoy = new Date();
    const [year, setYear] = useState(hoy.getFullYear());
    const [month, setMonth] = useState(hoy.getMonth() + 1);
    const [teamId, setTeamId] = useState<string>('');
    const [nota, setNota] = useState('');
    /** Informe cuya nota individual se está editando, y su texto. */
    const [notaIndividual, setNotaIndividual] = useState<{ id: string; texto: string } | null>(null);
    /** Informe YA PUBLICADO que se está corrigiendo (nota + motivo obligatorio). */
    const [corrigiendo, setCorrigiendo] = useState<{ id: string; texto: string; motivo: string } | null>(null);

    const periodo = { year, month };
    const claveInformes = ['monthly-reports', schoolId, year, month];

    /**
     * Un error del BFF trae `error`; si no, algo peor pasó y hay que mostrarlo igual.
     *
     * Va ARRIBA de las mutaciones a propósito. Los `onError: fallar(...)` la
     * INVOCAN al construir el objeto de opciones, no cuando el error ocurre, así
     * que declararla debajo la deja en zona muerta y el componente entero tira
     * `Cannot access 'fallar' before initialization` al montar. TypeScript no lo
     * atrapa y el build tampoco: solo se ve en el navegador.
     */
    const fallar = (titulo: string) => (err: any) =>
        toast({
            title: titulo,
            description: err?.message || 'Error inesperado',
            variant: 'destructive',
        });

    const { data: equipos } = useQuery({
        queryKey: ['teams-for-reports', schoolId, isCoach],
        enabled: !!schoolId,
        queryFn: async () => {
            const { data } = await supabase
                .from('teams')
                .select('id, name')
                .eq('school_id', schoolId)
                .order('name');
            const todos = (data ?? []) as { id: string; name: string }[];
            if (!isCoach) return todos;
            // El coach solo escribe la nota y previsualiza el informe de SUS
            // equipos (el BFF ahora responde 403 para los demás).
            const { teamIds } = await fetchCoachTeams(schoolId as string);
            const propios = new Set(teamIds);
            return todos.filter((t) => propios.has(t.id));
        },
    });

    /**
     * Quién libera y despacha. Lo decide CADA escuela: en Dynasty los entrenadores
     * están encima del día a día y les sirve mandarlo ellos; otra va a querer que
     * nada salga sin pasar por administración. Por eso vive en school_settings y
     * no en el código.
     *
     * El valor llega en el GET de informes, no de una consulta aparte: el coach
     * no puede leer school_settings por RLS, y necesita saberlo para que no se le
     * muestre un botón que le va a dar 403.
     */
    const cambiarLiberacion = useMutation({
        mutationFn: async (valor: 'school' | 'coach') => {
            const { error } = await supabase
                .from('school_settings')
                .upsert({ school_id: schoolId, reports_release_by: valor }, { onConflict: 'school_id' });
            if (error) throw error;
            return valor;
        },
        onSuccess: (valor) => {
            toast({
                title: valor === 'coach'
                    ? 'Los entrenadores publican y envían lo suyo'
                    : 'Solo la administración publica y envía',
                description: valor === 'coach'
                    ? 'Cada entrenador libera los informes de SUS equipos, no los del resto.'
                    : 'Los entrenadores siguen escribiendo las notas.',
            });
            queryClient.invalidateQueries({ queryKey: claveInformes });
        },
        onError: fallar('No se pudo cambiar quién libera'),
    });

    const { data, isLoading, refetch } = useQuery({
        queryKey: claveInformes,
        enabled: !!schoolId,
        queryFn: () =>
            bffClient.get<ReportsResponse>(
                `/api/v1/school/reports?year=${year}&month=${month}`,
            ),
    });

    const resumen = data?.resumen;
    const cobertura = useMemo(() => data?.cobertura ?? [], [data]);
    const releaseBy = data?.release_by ?? 'school';
    const reports = useMemo(() => data?.reports ?? [], [data]);

    const generar = useMutation({
        mutationFn: () => bffClient.post<{ created: number }>('/api/v1/school/reports/generate', periodo),
        onSuccess: (r) => {
            toast({
                title: r.created > 0 ? `${r.created} borradores creados` : 'No había nada que generar',
                description: r.created > 0
                    ? 'Se creó un borrador por atleta con mediciones en el mes.'
                    : 'Solo se generan informes de atletas CON mediciones en el periodo. '
                      + 'Si el mes no tiene evaluaciones cargadas, no hay informe que hacer.',
            });
            queryClient.invalidateQueries({ queryKey: claveInformes });
        },
        onError: fallar('No se pudieron generar los borradores'),
    });

    const guardarNota = useMutation({
        mutationFn: () =>
            bffClient.put(`/api/v1/school/teams/${teamId}/report-note`, { ...periodo, body: nota }),
        onSuccess: () => {
            toast({ title: '✅ Nota del equipo guardada' });
            setNota('');
        },
        onError: fallar('No se pudo guardar la nota'),
    });

    const publicarEquipo = useMutation({
        mutationFn: () =>
            bffClient.post<{ results: { report_id: string; resultado: string; detalle: string | null }[] }>(
                '/api/v1/school/reports/publish-team',
                { ...periodo, team_id: teamId },
            ),
        onSuccess: (r) => {
            const publicados = r.results.filter((x) => x.resultado === 'publicado').length;
            const errores = r.results.filter((x) => x.resultado === 'error');
            toast({
                title: `${publicados} informes publicados`,
                description: errores.length
                    ? `${errores.length} con problema: ${errores[0].detalle}`
                    : 'Snapshot congelado. Ya se pueden enviar.',
                variant: errores.length ? 'destructive' : 'default',
            });
            queryClient.invalidateQueries({ queryKey: claveInformes });
        },
        onError: fallar('No se pudo publicar el lote'),
    });

    const enviar = useMutation({
        mutationFn: () =>
            bffClient.post<{ sent: number; skipped: number }>('/api/v1/school/reports/send', periodo),
        onSuccess: (r) => {
            toast({
                title: `${r.sent} informes enviados`,
                description: r.skipped > 0
                    ? `${r.skipped} sin enviar, casi siempre por falta de acudiente vinculado.`
                    : 'Correo enviado y notificación encolada.',
            });
            queryClient.invalidateQueries({ queryKey: claveInformes });
        },
        onError: fallar('No se pudieron enviar'),
    });

    const guardarNotaIndividual = useMutation({
        mutationFn: ({ id, texto }: { id: string; texto: string }) =>
            bffClient.put(`/api/v1/school/reports/${id}/note`, { note: texto }),
        onSuccess: () => {
            toast({ title: '✅ Nota individual guardada' });
            setNotaIndividual(null);
            queryClient.invalidateQueries({ queryKey: claveInformes });
        },
        onError: fallar('No se pudo guardar la nota individual'),
    });

    /**
     * Corregir un informe YA publicado: admin-only (el BFF y la RPC lo exigen
     * igual, esto solo evita ofrecer un botón que daría 403). No lo revierte a
     * borrador — re-congela el snapshot con la nota nueva y archiva la versión
     * anterior (correct_published_athlete_report, migración 20261103202210).
     */
    const corregirPublicado = useMutation({
        mutationFn: ({ id, texto, motivo }: { id: string; texto: string; motivo: string }) =>
            bffClient.post<{ snapshot_version: number }>(`/api/v1/school/reports/${id}/correct`, {
                note: texto,
                reason: motivo,
            }),
        onSuccess: (r) => {
            toast({
                title: '✅ Informe corregido',
                description: `Versión ${r.snapshot_version} del snapshot. La anterior quedó archivada.`,
            });
            setCorrigiendo(null);
            queryClient.invalidateQueries({ queryKey: claveInformes });
        },
        onError: fallar('No se pudo corregir el informe'),
    });

    /**
     * Publicar y enviar son la misma puerta: admin siempre, coach solo si la
     * escuela le delegó la liberación. Se calcula una vez y se usa en los dos
     * caminos —el lote del equipo y el puntual de una fila— para que no puedan
     * quedar en desacuerdo.
     */
    const puedePublicar = !isCoach || releaseBy === 'coach';
    const puedeEnviar = puedePublicar;

    /**
     * Publicar UN informe. El lote de arriba es el camino de fin de mes; este es
     * el de «acabo de evaluar a este atleta». Misma RPC de siempre, así que
     * también exige la nota del equipo — publicar uno no es saltarse esa regla.
     */
    const publicarUno = useMutation({
        mutationFn: (id: string) => bffClient.post(`/api/v1/school/reports/${id}/publish`, {}),
        onSuccess: () => {
            toast({
                title: '✅ Informe publicado',
                description: 'Snapshot congelado. Ya se puede enviar.',
            });
            queryClient.invalidateQueries({ queryKey: claveInformes });
        },
        onError: fallar('No se pudo publicar'),
    });

    /** Enviar UN informe, sin arrastrar al resto del periodo. */
    const enviarUno = useMutation({
        mutationFn: (id: string) =>
            bffClient.post<{ sent: number; skipped: number; results: { reason?: string }[] }>(
                '/api/v1/school/reports/send',
                { ...periodo, report_id: id },
            ),
        onSuccess: (r) => {
            toast({
                title: r.sent > 0 ? '📧 Informe enviado' : 'No se envió',
                description: r.sent > 0
                    ? 'Correo con el resumen y el enlace, más la notificación en la app.'
                    : r.results?.[0]?.reason ?? 'Revisá que esté publicado y tenga acudiente.',
                variant: r.sent > 0 ? 'default' : 'destructive',
            });
            queryClient.invalidateQueries({ queryKey: claveInformes });
        },
        onError: fallar('No se pudo enviar'),
    });

    const publicables = reports.filter(
        (r) => r.team_id === teamId && (r.status === 'borrador' || r.status === 'listo'),
    ).length;

    const ocupado = generar.isPending || guardarNota.isPending || publicarEquipo.isPending
        || enviar.isPending || guardarNotaIndividual.isPending
        || publicarUno.isPending || enviarUno.isPending || corregirPublicado.isPending;

    return (
        <div className="p-4 md:p-6 space-y-5 max-w-5xl">
            <div>
                <h1 className="text-2xl font-bold flex items-center gap-2">
                    <FileText className="h-6 w-6 text-primary" aria-hidden="true" />
                    Informe Mensual
                </h1>
                <p className="text-sm text-muted-foreground mt-1">
                    {isCoach
                        ? (puedePublicar
                            ? 'Tu nota del mes para cada equipo, la publicación y el envío a las familias.'
                            : 'Tu nota del mes para cada equipo.')
                        : 'Generar, escribir la nota de cada equipo, publicar y enviar a las familias.'}
                </p>
            </div>

            {/* ── Periodo ── */}
            <Card>
                <CardContent className="pt-5 flex flex-wrap items-end gap-3">
                    <div>
                        <Label className="text-xs">Mes</Label>
                        <Select value={String(month)} onValueChange={(v) => setMonth(Number(v))}>
                            <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
                            <SelectContent>
                                {MESES.map((m, i) => (
                                    <SelectItem key={m} value={String(i + 1)}>{m}</SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                    <div>
                        <Label className="text-xs">Año</Label>
                        <Select value={String(year)} onValueChange={(v) => setYear(Number(v))}>
                            <SelectTrigger className="w-28"><SelectValue /></SelectTrigger>
                            <SelectContent>
                                {[hoy.getFullYear() - 1, hoy.getFullYear()].map((y) => (
                                    <SelectItem key={y} value={String(y)}>{y}</SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                    <Button variant="outline" onClick={() => refetch()} disabled={isLoading}>
                        {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Actualizar'}
                    </Button>

                    {!isCoach && (
                        <div className="ml-auto">
                            <Label className="text-xs">Quién publica y envía</Label>
                            <Select
                                value={releaseBy}
                                onValueChange={(v) => cambiarLiberacion.mutate(v as 'school' | 'coach')}
                            >
                                <SelectTrigger className="w-56"><SelectValue /></SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="school">Solo la administración</SelectItem>
                                    <SelectItem value="coach">Cada entrenador, lo suyo</SelectItem>
                                </SelectContent>
                            </Select>
                        </div>
                    )}
                </CardContent>
            </Card>

            {isCoach && (
                <div className="rounded-lg border bg-accent/10 p-3 text-sm">
                    {puedePublicar
                        ? 'Escribe la nota de cada uno de tus equipos, publica, revisa el PDF y envía a las familias. La escuela genera los borradores.'
                        : 'Escribe la nota de cada uno de tus equipos. La escuela genera los borradores y hace el envío a las familias.'}
                </div>
            )}

            {/* ── Paso 1: generar. Solo la escuela. ── */}
            {!isCoach && (
            <Card>
                <CardHeader className="pb-3">
                    <CardTitle className="text-base">1 · Generar borradores</CardTitle>
                    <CardDescription>
                        Crea un informe por atleta <strong>con mediciones en el mes</strong>. Se puede
                        repetir sin duplicar ni pisar notas ya escritas.
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    <Button onClick={() => generar.mutate()} disabled={ocupado}>
                        {generar.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                        Generar borradores de {MESES[month - 1]}
                    </Button>

                    {resumen && (
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center">
                            {[
                                { label: 'Total', valor: resumen.total },
                                { label: 'Borradores', valor: resumen.borrador },
                                { label: 'Publicados', valor: resumen.publicados },
                                { label: 'Enviados', valor: resumen.enviados },
                            ].map((b) => (
                                <div key={b.label} className="rounded-lg border p-2.5">
                                    <div className="text-xl font-bold tabular-nums">{b.valor}</div>
                                    <div className="text-[11px] text-muted-foreground">{b.label}</div>
                                </div>
                            ))}
                        </div>
                    )}

                    {/* El dato que le sirve al admin para perseguir a las familias
                        que no activaron cuenta. No es un error del sistema. */}
                    {resumen && resumen.sin_destinatario > 0 && (
                        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/[0.07] p-3">
                            <AlertCircle className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" aria-hidden="true" />
                            <p className="text-xs leading-relaxed">
                                <strong>{resumen.sin_destinatario}</strong> informes publicados no tienen a
                                quién enviarse: esas familias no han vinculado su cuenta. El informe queda
                                guardado y lo verán al entrar.
                            </p>
                        </div>
                    )}
                </CardContent>
            </Card>
            )}

            {/* ── Cobertura por equipo ──
                Va para los DOS roles. Al admin le dice qué equipos van atrasados;
                al coach, a quién de los suyos no midió — que es la acción que le
                toca a él y que ninguna otra pantalla le muestra. */}
            {cobertura.length > 0 && (
            <Card>
                <CardHeader className="pb-3">
                    <CardTitle className="text-base">Cobertura de {MESES[month - 1]}</CardTitle>
                    <CardDescription>
                        Cuenta sobre los <strong>inscritos del mes</strong>, no sobre los informes que
                        ya existen: por eso incluye a los atletas que nadie midió.
                    </CardDescription>
                </CardHeader>
                <CardContent className="overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="border-b text-[11px] uppercase tracking-wide text-muted-foreground">
                                <th className="text-left font-medium py-2 pr-3">Equipo</th>
                                <th className="text-right font-medium py-2 px-2">Atletas</th>
                                <th className="text-right font-medium py-2 px-2">Con nota</th>
                                <th className="text-right font-medium py-2 px-2">Falta nota</th>
                                <th className="text-right font-medium py-2 px-2">Publicados</th>
                                <th className="text-right font-medium py-2 px-2">Leídos</th>
                                <th className="text-right font-medium py-2 pl-2">Sin medir</th>
                            </tr>
                        </thead>
                        <tbody>
                            {cobertura.map((c) => (
                                <tr key={c.team_id ?? 'sin-equipo'} className="border-b last:border-0">
                                    <td className="py-2 pr-3 font-medium">{c.team_name}</td>
                                    <td className="py-2 px-2 text-right tabular-nums">{c.total}</td>
                                    <td className="py-2 px-2 text-right tabular-nums">{c.listos}</td>
                                    <td className={`py-2 px-2 text-right tabular-nums ${c.faltan_nota > 0 ? 'text-amber-600 dark:text-amber-400 font-semibold' : 'text-muted-foreground'}`}>
                                        {c.faltan_nota}
                                    </td>
                                    <td className="py-2 px-2 text-right tabular-nums">{c.publicados}</td>
                                    <td className="py-2 px-2 text-right tabular-nums">{c.leidos}</td>
                                    {/* Los dos buckets separados: «vino y nadie lo
                                        midió» es trabajo del coach; «ni vino ni fue
                                        medido» es otra conversación. Sumarlos borra
                                        esa diferencia, que es la útil. */}
                                    <td className="py-2 pl-2 text-right tabular-nums">
                                        <span className={c.sin_mediciones_con_asistencia > 0 ? 'text-red-600 dark:text-red-400 font-semibold' : 'text-muted-foreground'}>
                                            {c.sin_mediciones_con_asistencia}
                                        </span>
                                        {c.sin_actividad > 0 && (
                                            <span className="text-muted-foreground"> + {c.sin_actividad}</span>
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                    <p className="text-[11px] text-muted-foreground mt-3 leading-relaxed">
                        <strong>Sin medir</strong>: el primer número son los que <em>asistieron</em> y nadie
                        midió — ahí falta trabajo del entrenador. El segundo, los que tampoco asistieron.
                    </p>
                </CardContent>
            </Card>
            )}

            {/* ── Nota del equipo y publicación ── */}
            <Card>
                <CardHeader className="pb-3">
                    <CardTitle className="text-base">{isCoach ? 'Nota del equipo' : '2 · Nota del equipo y publicación'}</CardTitle>
                    <CardDescription>
                        La nota de equipo es obligatoria para publicar. Un párrafo por equipo, no uno
                        por atleta.
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div>
                        <Label className="text-xs">Equipo</Label>
                        <Select value={teamId} onValueChange={setTeamId}>
                            <SelectTrigger><SelectValue placeholder="Elegir equipo" /></SelectTrigger>
                            <SelectContent>
                                {(equipos ?? []).map((t) => (
                                    <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>

                    <div>
                        <Label className="text-xs">
                            Cómo le fue al equipo en {MESES[month - 1]}
                        </Label>
                        <Textarea
                            value={nota}
                            onChange={(e) => setNota(e.target.value)}
                            rows={4}
                            placeholder="Lo que trabajaron este mes, cómo respondió el grupo, qué sigue…"
                            disabled={!teamId}
                        />
                        <p className="text-[11px] text-muted-foreground mt-1">
                            Mínimo 20 caracteres. Va en el informe de todos los atletas del equipo.
                        </p>
                    </div>

                    <div className="flex flex-wrap gap-2">
                        <Button
                            variant="outline"
                            onClick={() => guardarNota.mutate()}
                            disabled={ocupado || !teamId || nota.trim().length < 20}
                        >
                            {guardarNota.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                            Guardar nota
                        </Button>

                        <Button
                            onClick={() => publicarEquipo.mutate()}
                            disabled={ocupado || !teamId || publicables === 0}
                        >
                            {publicarEquipo.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                            <Users className="h-4 w-4 mr-2" aria-hidden="true" />
                            Publicar {publicables > 0 ? `${publicables} informes` : 'lote'}
                        </Button>
                    </div>
                </CardContent>
            </Card>

            {/* ── Enviar. La escuela siempre; el coach solo si se lo habilitaron. ── */}
            {puedeEnviar && (
            <Card>
                <CardHeader className="pb-3">
                    <CardTitle className="text-base">3 · Enviar</CardTitle>
                    <CardDescription>
                        Correo con el resumen y el enlace, más notificación en la app. Publicar no
                        envía: esto es lo que le llega a la familia.
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    <Button
                        onClick={() => enviar.mutate()}
                        disabled={ocupado || !resumen || resumen.publicados === 0}
                    >
                        {enviar.isPending
                            ? <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                            : <Send className="h-4 w-4 mr-2" aria-hidden="true" />}
                        Enviar los publicados
                    </Button>
                </CardContent>
            </Card>
            )}

            {/* ── Listado ── */}
            {reports.length > 0 && (
                <Card>
                    <CardHeader className="pb-3">
                        <CardTitle className="text-base">Informes de {MESES[month - 1]} {year}</CardTitle>
                    </CardHeader>
                    <CardContent className="p-0">
                        <div className="divide-y border-t">
                            {reports.map((r) => {
                                const editando = notaIndividual?.id === r.id;
                                const corrigiendoEste = corrigiendo?.id === r.id;
                                // Publicado = congelado: cambiar la nota despues
                                // exige regenerar, que versiona y audita.
                                const editable = r.status !== 'publicado';

                                return (
                                <div key={r.id} className="px-4 py-2.5 text-sm">
                                    <div className="flex items-center gap-3">
                                        <span className="flex-1 min-w-0">
                                            <span className="block truncate font-medium">{r.athlete_name}</span>
                                            <span className="block text-[11px] text-muted-foreground truncate">
                                                {r.teams?.name ?? 'Sin equipo'}
                                                {r.coach_note && ' · con nota individual'}
                                            </span>
                                        </span>
                                        <Badge variant={r.status === 'publicado' ? 'default' : 'secondary'}>
                                            {r.status}
                                        </Badge>
                                        {r.sent_at && (
                                            <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-400" aria-label="enviado" />
                                        )}
                                        {r.status === 'publicado' && !r.recipient_id && (
                                            <span className="text-[11px] text-amber-600 dark:text-amber-400 whitespace-nowrap">
                                                sin acudiente
                                            </span>
                                        )}
                                        {editable && (
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                className="h-7 text-xs"
                                                onClick={() => setNotaIndividual(
                                                    editando ? null : { id: r.id, texto: r.coach_note ?? '' },
                                                )}
                                            >
                                                {r.coach_note ? 'Editar nota' : 'Nota individual'}
                                            </Button>
                                        )}

                                        {/* Camino de UN atleta: evaluar a uno y mandarle a él
                                            sin esperar a que el equipo entero esté listo. El
                                            lote de arriba sigue siendo el camino normal de fin
                                            de mes; esto es el puntual. Los permisos son los
                                            mismos: la RPC y la ruta deciden, acá solo se
                                            esconde lo que sabemos que daría 403. */}
                                        {editable && puedePublicar && (
                                            <Button
                                                variant="outline"
                                                size="sm"
                                                className="h-7 text-xs"
                                                disabled={ocupado}
                                                onClick={() => publicarUno.mutate(r.id)}
                                            >
                                                {publicarUno.isPending && publicarUno.variables === r.id && (
                                                    <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                                                )}
                                                Publicar
                                            </Button>
                                        )}

                                        {/* Revisar antes de enviar: publicar congela el informe, enviar
                                            es otro paso — en medio la escuela ve exactamente lo que
                                            le va a llegar a la familia. */}
                                        {r.status === 'publicado' && (
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                className="h-7 text-xs"
                                                onClick={() => downloadAthleteReportPdf(r.id).catch(fallar('No se pudo abrir el PDF'))}
                                            >
                                                <FileText className="h-3 w-3 mr-1" aria-hidden="true" />
                                                Ver PDF
                                            </Button>
                                        )}

                                        {/* Corregir un publicado: NO lo reabre, re-congela el
                                            snapshot con la nota nueva y archiva la versión
                                            anterior. Misma puerta que publicar/enviar
                                            (puedePublicar): admin siempre, o el coach si la
                                            escuela le delegó la liberación — acá no se le
                                            ofrece al coach un botón que le daría 403. */}
                                        {r.status === 'publicado' && puedePublicar && (
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                className="h-7 text-xs"
                                                onClick={() => setCorrigiendo(
                                                    corrigiendoEste ? null : { id: r.id, texto: r.coach_note ?? '', motivo: '' },
                                                )}
                                            >
                                                Corregir
                                            </Button>
                                        )}

                                        {r.status === 'publicado' && !r.sent_at && r.recipient_id && puedeEnviar && (
                                            <Button
                                                size="sm"
                                                className="h-7 text-xs"
                                                disabled={ocupado}
                                                onClick={() => enviarUno.mutate(r.id)}
                                            >
                                                {enviarUno.isPending && enviarUno.variables === r.id && (
                                                    <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                                                )}
                                                Enviar
                                            </Button>
                                        )}
                                        <span className="text-xs text-muted-foreground tabular-nums whitespace-nowrap">
                                            {r.scheduled_for}
                                        </span>
                                    </div>

                                    {editando && (
                                        <div className="mt-2.5 space-y-2">
                                            <Textarea
                                                value={notaIndividual.texto}
                                                onChange={(e) => setNotaIndividual({ id: r.id, texto: e.target.value })}
                                                rows={3}
                                                placeholder={`Algo puntual sobre ${r.athlete_name.split(' ')[0]}, si hay que decirlo…`}
                                            />
                                            <p className="text-[11px] text-muted-foreground">
                                                Opcional. Va solo en el informe de este atleta, además de la nota
                                                del equipo. Dejala vacía para quitarla.
                                            </p>
                                            <div className="flex gap-2">
                                                <Button
                                                    size="sm"
                                                    disabled={ocupado}
                                                    onClick={() => guardarNotaIndividual.mutate(notaIndividual)}
                                                >
                                                    {guardarNotaIndividual.isPending && (
                                                        <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                                                    )}
                                                    Guardar
                                                </Button>
                                                <Button variant="ghost" size="sm" onClick={() => setNotaIndividual(null)}>
                                                    Cancelar
                                                </Button>
                                            </div>
                                        </div>
                                    )}

                                    {corrigiendoEste && (
                                        <div className="mt-2.5 space-y-2 rounded-md border border-amber-300 dark:border-amber-800 p-2.5">
                                            <p className="text-[11px] font-medium text-amber-700 dark:text-amber-400">
                                                Este informe ya está publicado. Corregirlo re-congela el
                                                snapshot con la nota nueva; la versión anterior queda
                                                archivada, no se pierde.
                                            </p>
                                            <Textarea
                                                value={corrigiendo.texto}
                                                onChange={(e) => setCorrigiendo({ ...corrigiendo, texto: e.target.value })}
                                                rows={3}
                                                placeholder={`Nota corregida sobre ${r.athlete_name.split(' ')[0]}…`}
                                            />
                                            <Textarea
                                                value={corrigiendo.motivo}
                                                onChange={(e) => setCorrigiendo({ ...corrigiendo, motivo: e.target.value })}
                                                rows={2}
                                                placeholder="Motivo de la corrección (obligatorio, queda en la auditoría)"
                                            />
                                            <div className="flex gap-2">
                                                <Button
                                                    size="sm"
                                                    disabled={ocupado || corrigiendo.motivo.trim() === ''}
                                                    onClick={() => corregirPublicado.mutate(corrigiendo)}
                                                >
                                                    {corregirPublicado.isPending && (
                                                        <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                                                    )}
                                                    Guardar corrección
                                                </Button>
                                                <Button variant="ghost" size="sm" onClick={() => setCorrigiendo(null)}>
                                                    Cancelar
                                                </Button>
                                            </div>
                                        </div>
                                    )}
                                </div>
                                );
                            })}
                        </div>
                    </CardContent>
                </Card>
            )}
        </div>
    );
}
