/**
 * EnrollmentIntakeInboxPage — inbox de revisión de hojas de matrícula
 * (fase 4 de docs/specs/alta-atleta-por-foto-hoja-matricula.md), V2.
 *
 * NO reimplementa el alta de deportista: lo crea llamando a
 * POST /api/v1/students/create-one (mismo endpoint que el alta manual, con su
 * detección de duplicados y su guardia de mayor-de-edad ya construidas), y
 * solo después confirma acá con /mark-approved. Si create-one devuelve 409
 * (duplicado o mayor de edad mal tipado), se muestra el motivo en la ficha y
 * no se reintenta solo.
 *
 * Crear, descartar y completar la ficha existente se mandan a los 8 s
 * (useEnvioConDeshacer): mientras tanto la ficha se oculta y «Deshacer» la
 * devuelve sin tocar la base.
 *
 * La lógica pura (qué se pide, qué falta, estado de cada ficha) vive en
 * enrollmentIntakeModel.ts.
 */
import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { toast } from 'sonner';
import { useSchoolContext } from '@/hooks/useSchoolContext';
import { useAuth } from '@/contexts/AuthContext';
import { useEntitlements } from '@/hooks/useEntitlements';
import { bffClient, BFFError } from '@/lib/api/bffClient';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { Loader2, AlertTriangle, Camera } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { todayColombia } from '@/lib/dateUtils';
import { cn } from '@/lib/utils';
import { InlineError } from '@/components/parent/v2/hijos/parts';
import { useEnvioConDeshacer, SEGUNDOS_DESHACER } from '@/components/athlete/v2/useEnvioConDeshacer';
import {
    camposAPedir,
    camposQueFaltan,
    esMayorDeEdad,
    estadoFicha,
    formularioInicial,
    soloDigitos,
    type CampoFicha,
    type EstadoFicha,
    type FormState,
    type IntakeItem,
} from './enrollmentIntakeModel';
import { FichaMatricula } from './enrollment-intake/FichaMatricula';

/**
 * Una foto de celular pesa 3–8 MB y el BFF acepta hasta 4 MB. Se pasa a JPEG
 * 0,92 SIN achicar (tope 3.200 px de lado mayor). Medido el 2026-10-04 con una
 * hoja real de Dynasty (1284×2778): a resolución completa el OCR leyó el
 * documento bien 3/3; reducida a 2.200 px, 1/3 (invertía o agregaba dígitos).
 * Lo que importa es la resolución, no el formato. Un PDF se manda tal cual.
 */
async function prepararArchivo(file: File): Promise<{ imageBase64: string; mimeType: string }> {
    const leerComoDataUrl = (blob: Blob) => new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result as string);
        r.onerror = () => reject(r.error);
        r.readAsDataURL(blob);
    });

    if (file.type === 'application/pdf') {
        return { imageBase64: await leerComoDataUrl(file), mimeType: 'application/pdf' };
    }

    const url = URL.createObjectURL(file);
    try {
        const img = await new Promise<HTMLImageElement>((resolve, reject) => {
            const i = new Image();
            i.onload = () => resolve(i);
            i.onerror = () => reject(new Error('No se pudo abrir la imagen.'));
            i.src = url;
        });
        const LADO_MAX = 3200;
        const escala = Math.min(1, LADO_MAX / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * escala);
        canvas.height = Math.round(img.height * escala);
        const ctx = canvas.getContext('2d')!;
        ctx.fillStyle = '#ffffff'; // un PNG con transparencia saldría negro en JPEG
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        return { imageBase64: canvas.toDataURL('image/jpeg', 0.92), mimeType: 'image/jpeg' };
    } finally {
        URL.revokeObjectURL(url);
    }
}

function SubirMatricula({ onSubida, modoCoach = false }: { onSubida: () => void; modoCoach?: boolean }) {
    const { toast } = useToast();
    const inputRef = useRef<HTMLInputElement>(null);
    const [subiendo, setSubiendo] = useState(false);
    const [errorMsg, setErrorMsg] = useState<string | null>(null);

    async function onArchivo(e: React.ChangeEvent<HTMLInputElement>) {
        const file = e.target.files?.[0];
        e.target.value = ''; // permite volver a elegir la misma foto
        if (!file) return;
        setSubiendo(true);
        setErrorMsg(null);
        try {
            const body = await prepararArchivo(file);
            const res = await bffClient.post<{ athleteFullName: string | null; duplicateOfChildId: string | null }>(
                '/api/v1/enrollment-intake/upload', body,
            );
            toast({
                title: 'Hoja leída',
                description: modoCoach
                    // El coach sube; la escuela revisa y aprueba (D2 del spec).
                    ? `${res.athleteFullName ?? 'La ficha'} quedó en la bandeja de la escuela para que la revisen y la aprueben.`
                    : res.duplicateOfChildId
                        ? `${res.athleteFullName ?? 'El deportista'} ya existe en la escuela: revísala abajo antes de crear nada.`
                        : `${res.athleteFullName ?? 'La ficha'} quedó lista para revisar abajo.`,
            });
            onSubida();
        } catch (err) {
            setErrorMsg(err instanceof BFFError ? err.message : 'No se pudo subir la foto.');
        } finally {
            setSubiendo(false);
        }
    }

    return (
        <div className="space-y-2">
            <input
                ref={inputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp,application/pdf"
                capture="environment"
                className="hidden"
                onChange={onArchivo}
            />
            <div className="flex flex-col items-stretch gap-3 rounded-2xl border-[1.5px] border-dashed bg-card p-3 min-[421px]:flex-row min-[421px]:items-center">
                <Button className="min-h-touch rounded-xl" onClick={() => inputRef.current?.click()} disabled={subiendo}>
                    {subiendo ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Camera className="h-4 w-4 mr-2" />}
                    {subiendo ? 'Leyendo la hoja…' : 'Subir hoja de matrícula'}
                </Button>
                {!modoCoach && (
                    <p className="min-w-0 flex-1 text-xs text-muted-foreground">
                        Las hojas que llegan por WhatsApp también aparecen aquí.
                    </p>
                )}
            </div>
            {errorMsg && (
                <Alert variant="destructive">
                    <AlertTriangle className="h-4 w-4" />
                    <AlertDescription>{errorMsg}</AlertDescription>
                </Alert>
            )}
        </div>
    );
}

// ---------------------------------------------------------------------------

type Filtro = 'pend' | 'listas' | 'todas';

const PESTANAS: Array<{ id: Filtro; label: string }> = [
    { id: 'pend', label: 'Por completar' },
    { id: 'listas', label: 'Listas' },
    { id: 'todas', label: 'Todas' },
];

interface Fila {
    item: IntakeItem;
    form: FormState;
    pedir: CampoFicha[];
    mayor: boolean;
    faltan: CampoFicha[];
    estado: EstadoFicha;
    dupPendiente: boolean;
}

const coincide = (f: Fila, filtro: Filtro) =>
    filtro === 'todas' || (filtro === 'listas' ? f.estado === 'lista' : f.estado !== 'lista');

type Creado = { child_id?: string; unregistered_athlete_id?: string };

function mensajeDeError(err: unknown, porDefecto: string): string {
    return err instanceof BFFError ? err.message : porDefecto;
}

function BandejaAdmin({ schoolId, recarga }: { schoolId: string | null | undefined; recarga: number }) {
    const envio = useEnvioConDeshacer();
    const [items, setItems] = useState<IntakeItem[]>([]);
    const [forms, setForms] = useState<Record<string, FormState>>({});
    const [cargando, setCargando] = useState(true);
    const [cargadoUnaVez, setCargadoUnaVez] = useState(false);
    const [errorCarga, setErrorCarga] = useState<string | null>(null);
    const [filtro, setFiltro] = useState<Filtro>('pend');
    /**
     * Ficha abierta. `undefined` = automático (la primera de la pestaña);
     * `null` = la escuela cerró todas a propósito. Al tocar una ficha queda fija,
     * así no salta a otra cuando pasa de «Por completar» a «Lista» mientras se escribe.
     */
    const [abierto, setAbierto] = useState<string | null | undefined>(undefined);
    /** Fichas con envío programado (esperando los 8 s o en vuelo): no se muestran. */
    const [ocultos, setOcultos] = useState<string[]>([]);
    const [errores, setErrores] = useState<Record<string, string>>({});
    /** Fichas con «ya existe» que la escuela marcó como «Es otra persona». */
    const [otraPersona, setOtraPersona] = useState<string[]>([]);
    const pendienteRef = useRef<string | null>(null);
    const toastRef = useRef<string | number | null>(null);
    /** Solo cuenta la respuesta del último pedido: una vieja revivía una ficha ya procesada. */
    const pedidoRef = useRef(0);
    /** Deportistas ya creados cuya hoja falta marcar (mark-approved falló), por id de ficha. */
    const creadosRef = useRef<Record<string, Creado>>({});

    // Cerrar o recargar la pestaña no desmonta React: el envío pendiente se perdería
    // mientras el aviso ya dijo «quedó creado». El navegador pide confirmación.
    useEffect(() => {
        const avisar = (ev: BeforeUnloadEvent) => {
            if (pendienteRef.current == null) return;
            ev.preventDefault();
            ev.returnValue = '';
        };
        window.addEventListener('beforeunload', avisar);
        return () => window.removeEventListener('beforeunload', avisar);
    }, []);

    const load = useCallback(async () => {
        if (!schoolId) { setCargando(false); return; }
        const pedido = ++pedidoRef.current;
        setCargando(true);
        setErrorCarga(null);
        try {
            const res = await bffClient.get<{ items: IntakeItem[] }>('/api/v1/enrollment-intake');
            if (pedido !== pedidoRef.current) return;
            const ids = new Set(res.items.map((i) => i.id));
            setItems(res.items);
            // Lo escrito en fichas que siguen en la bandeja no se pierde al recargar.
            setForms((prev) => {
                const next: Record<string, FormState> = {};
                for (const it of res.items) next[it.id] = prev[it.id] ?? formularioInicial(it);
                return next;
            });
            setOcultos((prev) => prev.filter((id) => ids.has(id)));
            setAbierto((prev) => (typeof prev === 'string' && !ids.has(prev) ? undefined : prev));
            setCargadoUnaVez(true);
        } catch (err) {
            if (pedido !== pedidoRef.current) return;
            setErrorCarga(mensajeDeError(err, 'No pudimos cargar las matrículas. Revisa tu conexión.'));
        } finally {
            if (pedido === pedidoRef.current) setCargando(false);
        }
    }, [schoolId]);

    // `recarga` sube cuando se lee una hoja nueva: se recarga sin perder lo escrito.
    useEffect(() => { load(); }, [load, recarga]);

    // Qué se pide y si es adulto se decide una vez por ficha, con lo leído de la hoja.
    const fijos = useMemo(() => {
        const m: Record<string, { pedir: CampoFicha[]; mayor: boolean }> = {};
        for (const it of items) m[it.id] = { pedir: camposAPedir(it), mayor: esMayorDeEdad(it) };
        return m;
    }, [items]);

    const filas: Fila[] = items
        .filter((it) => !ocultos.includes(it.id))
        .map((item) => {
            const form = forms[item.id] ?? formularioInicial(item);
            const { pedir, mayor } = fijos[item.id] ?? { pedir: [], mayor: false };
            const faltan = camposQueFaltan(form, mayor);
            const esOtra = otraPersona.includes(item.id);
            const estado: EstadoFicha = estadoFicha(item, form, undefined, { esOtraPersona: esOtra });
            return { item, form, pedir, mayor, faltan, estado, dupPendiente: Boolean(item.duplicateOfChildId) && !esOtra };
        });

    const cuenta: Record<Filtro, number> = {
        pend: filas.filter((f) => coincide(f, 'pend')).length,
        listas: filas.filter((f) => coincide(f, 'listas')).length,
        todas: filas.length,
    };
    // Si no queda nada por completar pero sí hay fichas listas, no se abre en una
    // pestaña vacía (salvo que la escuela haya elegido «Por completar» a mano).
    const filtroTocadoRef = useRef(false);
    useEffect(() => {
        if (!filtroTocadoRef.current && filtro === 'pend' && cuenta.pend === 0 && cuenta.listas > 0) setFiltro('listas');
    }, [filtro, cuenta.pend, cuenta.listas]);

    const idAbierto = abierto === undefined ? filas.find((f) => coincide(f, filtro))?.item.id ?? null : abierto;
    // La ficha abierta se queda a la vista aunque cambie de pestaña mientras se escribe.
    const visibles = filas.filter((f) => coincide(f, filtro) || f.item.id === idAbierto);

    const cambiarFiltro = (nuevo: Filtro) => {
        filtroTocadoRef.current = true;
        setFiltro(nuevo);
        const actual = filas.find((f) => f.item.id === idAbierto);
        if (!actual || !coincide(actual, nuevo)) setAbierto(undefined);
    };

    const setCampo = (id: string) => (campo: CampoFicha, valor: string) => {
        setAbierto(id);
        setForms((prev) => ({ ...prev, [id]: { ...(prev[id] ?? formularioInicial(items.find((i) => i.id === id)!)), [campo]: valor } }));
    };

    const quitarError = (id: string) => setErrores((e) => {
        if (!(id in e)) return e;
        const { [id]: _omit, ...resto } = e;
        void _omit;
        return resto;
    });

    /** Oculta la ficha, abre la siguiente y manda `run` a los 8 s salvo «Deshacer». */
    const programarAccion = (
        id: string,
        nombre: string,
        mensaje: string,
        run: (encabezados: Record<string, string> | undefined) => Promise<unknown>,
    ) => {
        // La escuela se fija al tocar. bffClient la vuelve a leer al mandar, y si la
        // persona cambió de escuela en esos 8 s el deportista se creaba en la otra.
        const encabezados = schoolId ? { 'x-school-id': schoolId } : undefined;
        quitarError(id);
        setOcultos((o) => [...o, id]);
        setAbierto(undefined);
        if (toastRef.current != null) toast.dismiss(toastRef.current);
        pendienteRef.current = id;
        const aviso: { id: string | number | null } = { id: null };
        envio.programar(() => {
            if (pendienteRef.current === id) pendienteRef.current = null;
            // Ya salió: sonner pausa el aviso con el puntero encima, y un «Deshacer»
            // todavía visible haría creer que se canceló.
            if (aviso.id != null) toast.dismiss(aviso.id);
            run(encabezados)
                .then(() => load())
                .catch((err: unknown) => {
                    console.error('[matriculas-v2]', err);
                    const msg = mensajeDeError(err, 'No se pudo completar la acción.');
                    setErrores((e) => ({ ...e, [id]: msg }));
                    setOcultos((o) => o.filter((x) => x !== id));
                    setAbierto(id);
                    toast.error(`No se pudo terminar la ficha de ${nombre}`, { description: msg });
                });
        });
        aviso.id = toast.success(mensaje, {
            duration: SEGUNDOS_DESHACER * 1000,
            action: {
                label: 'Deshacer',
                onClick: () => {
                    // Solo deshace si este envío sigue siendo el pendiente (no el de otra ficha).
                    if (pendienteRef.current !== id || !envio.deshacer()) {
                        toast.info('Ya se había enviado: no alcanzó a deshacerse.');
                        return;
                    }
                    pendienteRef.current = null;
                    setOcultos((o) => o.filter((x) => x !== id));
                    setAbierto(id);
                },
            },
        });
        toastRef.current = aviso.id;
    };

    const crear = (f: Fila) => {
        const { item, mayor } = f;
        const form = { ...f.form };
        const nombre = form.athleteFullName.trim();
        // «Es otra persona» es la confirmación explícita para la que existe
        // allow_duplicate: sin ella create-one vuelve a encontrar el mismo duplicado y da 409.
        const duplicadoConfirmado = Boolean(item.duplicateOfChildId) && !f.dupPendiente
            ? { allow_duplicate: true }
            : {};
        programarAccion(item.id, nombre, `${nombre} quedó creado.`, async (h) => {
            const startDate = todayColombia();
            // Si un intento anterior creó al deportista y lo que falló fue marcar la
            // hoja, reintentar NO vuelve a llamar create-one: daba 409, o un segundo
            // deportista cuando la hoja no traía documento.
            let created = creadosRef.current[item.id];
            if (!created) {
                created = mayor
                    ? await bffClient.post<Creado>('/api/v1/students/create-one', {
                        type: 'unregistered_adult',
                        doc_type: form.docType || undefined,
                        doc_number: form.docNumber || null,
                        full_name: form.athleteFullName,
                        email: form.athleteEmail || null,
                        phone: soloDigitos(form.athletePhone) || null,
                        date_of_birth: form.dateOfBirth || null,
                        start_date: startDate,
                        send_invite: Boolean(form.athleteEmail),
                        ...duplicadoConfirmado,
                    }, h)
                    : await bffClient.post<Creado>('/api/v1/students/create-one', {
                        type: 'child',
                        doc_type: form.docType || 'TI',
                        doc_number: form.docNumber || null,
                        full_name: form.athleteFullName,
                        date_of_birth: form.dateOfBirth || null,
                        parent_name: form.guardianFullName || form.athleteFullName,
                        parent_email: form.guardianEmail || null,
                        parent_phone: soloDigitos(form.guardianPhone || ''),
                        start_date: startDate,
                        send_invite: true,
                        ...duplicadoConfirmado,
                    }, h);
                creadosRef.current[item.id] = created;
            }
            try {
                await bffClient.post(`/api/v1/enrollment-intake/${item.id}/mark-approved`, {
                    ...(mayor
                        ? { unregisteredAthleteId: created.unregistered_athlete_id }
                        : { childId: created.child_id }),
                    epsName: form.epsName || undefined,
                    bloodType: form.bloodType || undefined,
                }, h);
            } catch (err) {
                throw new BFFError(
                    err instanceof BFFError ? err.status : 0,
                    `${nombre} ya quedó creado, pero no se pudo marcar la hoja como revisada`
                        + `${err instanceof BFFError ? ` (${err.message})` : ''}. Toca «Crear deportista» para reintentar: no se crea dos veces.`,
                );
            }
            delete creadosRef.current[item.id];
        });
    };

    const descartar = (f: Fila, motivo: string | null) => {
        const nombre = f.form.athleteFullName.trim() || 'sin nombre';
        programarAccion(f.item.id, nombre, `Descartaste la ficha de ${nombre}.`, (h) =>
            bffClient.post(`/api/v1/enrollment-intake/${f.item.id}/reject`, { reason: motivo ?? undefined }, h));
    };

    const completarFicha = (f: Fila) => {
        const childId = f.item.duplicateOfChildId;
        if (!childId) return;
        const existente = f.item.duplicateOfChildName ?? 'el deportista existente';
        programarAccion(f.item.id, existente, `Completamos la ficha de ${existente}.`, (h) =>
            bffClient.post(`/api/v1/enrollment-intake/${f.item.id}/link`, { childId }, h));
    };

    if (!cargadoUnaVez && cargando) {
        return (
            <div className="flex flex-col gap-2" aria-busy="true" aria-label="Cargando matrículas">
                <Skeleton className="h-12 w-full rounded-2xl" />
                <Skeleton className="h-16 w-full rounded-2xl" />
                <Skeleton className="h-16 w-full rounded-2xl" />
                <Skeleton className="h-16 w-full rounded-2xl" />
            </div>
        );
    }

    if (errorCarga && !cargadoUnaVez) {
        return <InlineError message={errorCarga} onRetry={() => { void load(); }} />;
    }

    return (
        <>
            {errorCarga && <InlineError message={errorCarga} onRetry={() => { void load(); }} />}

            {filas.length === 0 ? (
                <div className="rounded-2xl border bg-card px-4 py-8 text-center">
                    <p className="text-base font-semibold">Todo al día.</p>
                    <p className="text-sm text-muted-foreground">Las hojas nuevas aparecen aquí.</p>
                </div>
            ) : (
                <>
                    <div role="tablist" aria-label="Filtrar fichas" className="grid grid-cols-3 gap-1 rounded-2xl bg-muted p-1">
                        {PESTANAS.map((p) => {
                            const activa = filtro === p.id;
                            return (
                                <button
                                    key={p.id}
                                    type="button"
                                    role="tab"
                                    aria-selected={activa}
                                    aria-controls="lista-matriculas"
                                    onClick={() => cambiarFiltro(p.id)}
                                    className={cn(
                                        'min-h-touch rounded-xl px-1 text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                                        activa ? 'bg-card font-semibold text-foreground shadow-sm' : 'font-medium text-muted-foreground',
                                    )}
                                >
                                    {p.label}
                                    <span className="ml-1 tabular-nums opacity-75">{cuenta[p.id]}</span>
                                </button>
                            );
                        })}
                    </div>

                    {visibles.length === 0 ? (
                        <div id="lista-matriculas" role="tabpanel" className="rounded-2xl border bg-card px-4 py-8 text-center">
                            <p className="text-base font-semibold">Nada en esta pestaña</p>
                            <p className="text-sm text-muted-foreground">Revisa las otras pestañas.</p>
                        </div>
                    ) : (
                        <div id="lista-matriculas" role="tabpanel">
                            <ul className="flex flex-col gap-2">
                                {visibles.map((f) => (
                                    <FichaMatricula
                                        key={f.item.id}
                                        item={f.item}
                                        form={f.form}
                                        pedir={f.pedir}
                                        mayor={f.mayor}
                                        estado={f.estado}
                                        faltan={f.faltan}
                                        dupPendiente={f.dupPendiente}
                                        abierto={f.item.id === idAbierto}
                                        error={errores[f.item.id] ?? null}
                                        onToggle={() => setAbierto(f.item.id === idAbierto ? null : f.item.id)}
                                        onCampo={setCampo(f.item.id)}
                                        onCrear={() => crear(f)}
                                        onDescartar={(motivo) => descartar(f, motivo)}
                                        onCompletarFicha={() => completarFicha(f)}
                                        onOtraPersona={() => {
                                            setAbierto(f.item.id);
                                            setOtraPersona((o) => (o.includes(f.item.id) ? o : [...o, f.item.id]));
                                        }}
                                    />
                                ))}
                            </ul>
                        </div>
                    )}
                </>
            )}
        </>
    );
}

export default function EnrollmentIntakeInboxPage() {
    const { schoolId } = useSchoolContext();
    const { profile } = useAuth();
    const { coachCanUploadEnrollmentForms, isLoading: entLoading } = useEntitlements();
    const [recarga, setRecarga] = useState(0);

    // Coach (si la escuela lo activó, school_settings.coach_can_upload_enrollment_forms):
    // solo SUBE la foto. La bandeja con los datos de cada ficha y la aprobación
    // siguen siendo del admin — el BFF tampoco le deja listar.
    const esCoach = profile?.role === 'coach';

    if (esCoach) {
        return (
            <div className="p-4 md:p-6 max-w-4xl mx-auto space-y-4">
                <div>
                    <h1 className="text-xl font-semibold">Subir hoja de matrícula</h1>
                    <p className="text-sm text-muted-foreground">
                        Toma la foto de la hoja completa, de frente y con buena luz. La escuela revisa los datos
                        y crea al deportista — nada se crea solo.
                    </p>
                </div>
                {entLoading ? (
                    <div className="flex justify-center py-8"><Loader2 className="h-6 w-6 animate-spin" /></div>
                ) : coachCanUploadEnrollmentForms ? (
                    <SubirMatricula onSubida={() => undefined} modoCoach />
                ) : (
                    <Alert>
                        <AlertDescription>
                            Tu escuela no tiene habilitado que los entrenadores suban hojas de matrícula. Pídeselo a la escuela.
                        </AlertDescription>
                    </Alert>
                )}
            </div>
        );
    }

    return (
        <div className="mx-auto flex w-full max-w-page-narrow flex-col gap-4 px-4 py-5 pb-nav-safe font-poppins animate-in fade-in duration-300 md:px-0">
            <div>
                <h1 className="text-2xl font-bold leading-tight [text-wrap:balance]">Matrículas por revisar</h1>
                <p className="mt-1 text-sm text-muted-foreground">
                    Completa lo que la hoja no trae y crea al deportista. Nada se crea solo.
                </p>
            </div>

            <SubirMatricula onSubida={() => setRecarga((n) => n + 1)} />

            <BandejaAdmin key={schoolId ?? ''} schoolId={schoolId} recarga={recarga} />
        </div>
    );
}
