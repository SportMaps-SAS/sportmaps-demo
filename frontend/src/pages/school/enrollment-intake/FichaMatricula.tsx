/**
 * Una ficha de la bandeja de matrículas (V2): fila compacta + detalle en acordeón.
 *
 * El estado del formulario NO vive acá: lo guarda la página para que la píldora
 * y los conteos de las pestañas se actualicen mientras se escribe y no se pierda
 * lo escrito al abrir otra ficha. Acá solo vive lo efímero de la ficha abierta
 * (panel de descarte, foto ampliada, editar el nombre), que se reinicia al cerrarla.
 */
import { useState } from 'react';
import { AlertTriangle, ChevronRight, ImageOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { cn } from '@/lib/utils';
import {
    camposObligatorios,
    campoValido,
    listaLegible,
    soloDigitos,
    textoEstado,
    GRUPOS_SANGUINEOS,
    MOTIVOS_DESCARTE,
    TIPOS_DOC,
    type CampoFicha,
    type EstadoFicha,
    type FormState,
    type IntakeItem,
} from '../enrollmentIntakeModel';

export interface FichaMatriculaProps {
    item: IntakeItem;
    form: FormState;
    /** Lo que se pide como campo editable; calculado una vez por ficha. */
    pedir: CampoFicha[];
    mayor: boolean;
    estado: EstadoFicha;
    faltan: CampoFicha[];
    /** Aviso de «ya existe» visible (hay duplicado y no se marcó «Es otra persona»). */
    dupPendiente: boolean;
    abierto: boolean;
    error: string | null;
    onToggle: () => void;
    onCampo: (campo: CampoFicha, valor: string) => void;
    onCrear: () => void;
    onDescartar: (motivo: string | null) => void;
    onCompletarFicha: () => void;
    onOtraPersona: () => void;
}

const EPS_COLOMBIA = [
    'Sura', 'Sanitas', 'Nueva EPS', 'Compensar', 'Famisanar', 'Salud Total', 'Coosalud',
    'Mutual Ser', 'Aliansalud', 'SOS', 'Emssanar', 'Savia Salud', 'Asmet Salud', 'Cajacopi',
    'Capresoca', 'Comfenalco Valle', 'Dusakawi', 'Pijaos Salud', 'Anas Wayuu', 'Mallamas',
];

/** Una categoría corta cabe en la fila; las notas largas de planilla van al plegable. */
const CATEGORIA_MAX_FILA = 40;

function iniciales(nombre: string): string {
    const partes = nombre.split(/\s+/).filter(Boolean).slice(0, 2);
    return partes.map((p) => p[0]).join('').toUpperCase() || '?';
}

function fechaCorta(iso: string): string {
    const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T12:00:00` : iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString('es-CO', { day: 'numeric', month: 'short', year: 'numeric' });
}

function fechaHora(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString('es-CO', {
        day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'America/Bogota',
    });
}

const CLASE_PILDORA: Record<EstadoFicha, string> = {
    faltan: 'bg-amber-100 text-amber-900 dark:bg-amber-950/50 dark:text-amber-300',
    lista: 'bg-primary/10 text-primary',
    duplicada: 'bg-blue-100 text-blue-800 dark:bg-blue-950/50 dark:text-blue-300',
};

export function FichaMatricula(props: FichaMatriculaProps) {
    const { item, form, estado, faltan, abierto, onToggle } = props;
    const nombre = form.athleteFullName.trim() || 'Sin nombre legible';
    const categoria = item.extracted?.category?.trim();
    const subtitulo = [
        categoria && categoria.length <= CATEGORIA_MAX_FILA ? categoria : null,
        item.source === 'app' ? 'subida en la app' : 'por WhatsApp',
        props.mayor ? 'mayor de edad' : null,
    ].filter(Boolean).join(' · ');
    const idDetalle = `ficha-${item.id}`;

    return (
        <li
            className={cn(
                'overflow-hidden rounded-2xl border bg-card transition-shadow',
                abierto && 'border-primary/40 shadow-md',
            )}
        >
            <button
                type="button"
                onClick={onToggle}
                aria-expanded={abierto}
                aria-controls={abierto ? idDetalle : undefined}
                className="flex w-full items-center gap-3 px-3.5 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            >
                <span aria-hidden className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-semibold">
                    {iniciales(nombre)}
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-semibold">{nombre}</span>
                    <span className="truncate text-xs text-muted-foreground">{subtitulo}</span>
                </span>
                <span className={cn('shrink-0 whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-semibold', CLASE_PILDORA[estado])}>
                    {textoEstado(estado, faltan.length)}
                </span>
                <ChevronRight
                    aria-hidden
                    className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none', abierto && 'rotate-90')}
                />
            </button>
            {abierto && <DetalleFicha {...props} idDetalle={idDetalle} />}
        </li>
    );
}

// ---------------------------------------------------------------------------

function DetalleFicha(props: FichaMatriculaProps & { idDetalle: string }) {
    const { item, form, pedir, mayor, faltan, dupPendiente, error, onCampo } = props;
    const e = item.extracted;
    const [descartando, setDescartando] = useState(false);
    const [motivo, setMotivo] = useState<string | null>(null);
    const [fotoGrande, setFotoGrande] = useState(false);
    /** Filas de «Leído de la hoja» abiertas para corregir (el OCR invierte dígitos o lee mal un correo). */
    const [editando, setEditando] = useState<CampoFicha[]>([]);

    const obligatorios = camposObligatorios(mayor);
    const pedidosObligatorios = pedir.filter((c) => obligatorios.includes(c));
    const hechos = pedidosObligatorios.filter((c) => campoValido(c, form[c])).length;
    const avance = pedidosObligatorios.length ? Math.round((hechos / pedidosObligatorios.length) * 100) : 100;

    const autorizaciones = e?.authorizations ?? [];
    const autorizacionesDudosas = autorizaciones.some((a) => a.checked !== true);

    // Una fila está en «Leído de la hoja» porque NO está en `pedir`, o sea que se
    // leyó y servía. No se mira el valor actual: si la escuela lo borra al
    // corregir, la fila sigue ahí con su campo abierto (y el pie dice qué falta).
    const filaEditable = (campo: CampoFicha, dt: string, texto: React.ReactNode) => ({
        dt,
        dd: editando.includes(campo) ? (
            <CampoPedido
                item={item}
                campo={campo}
                form={form}
                opcional={!obligatorios.includes(campo)}
                onCampo={onCampo}
                etiquetaOculta
                onListo={() => setEditando((x) => x.filter((c) => c !== campo))}
            />
        ) : (
            <>
                {texto || <span className="text-muted-foreground">Vacío</span>}
                <button
                    type="button"
                    onClick={() => setEditando((x) => (x.includes(campo) ? x : [...x, campo]))}
                    aria-label={`Editar ${dt.toLowerCase()}`}
                    className="ml-2 rounded text-xs font-semibold text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                    Editar
                </button>
            </>
        ),
    });
    const telefono = (v: string) => (soloDigitos(v).length === 10 ? `+57 ${v}` : v);

    const filasLeidas: Array<{ dt: string; dd: React.ReactNode }> = [];
    if (!pedir.includes('athleteFullName')) filasLeidas.push(filaEditable('athleteFullName', 'Deportista', form.athleteFullName));
    if (!pedir.includes('docNumber')) {
        filasLeidas.push(filaEditable('docNumber', 'Documento', form.docNumber && `${form.docType} ${form.docNumber}`));
    }
    if (!pedir.includes('dateOfBirth')) {
        filasLeidas.push(filaEditable('dateOfBirth', 'Nacimiento', form.dateOfBirth && fechaCorta(form.dateOfBirth)));
    }
    if (mayor) {
        // Para un adulto es solo el contacto de emergencia: informativo, no se invita.
        if (form.guardianFullName) filasLeidas.push({ dt: 'Contacto de emergencia', dd: form.guardianFullName });
    } else if (!pedir.includes('guardianFullName')) {
        filasLeidas.push(filaEditable('guardianFullName', 'Acudiente', form.guardianFullName));
    }
    const campoCel: CampoFicha = mayor ? 'athletePhone' : 'guardianPhone';
    const campoCorreo: CampoFicha = mayor ? 'athleteEmail' : 'guardianEmail';
    if (!pedir.includes(campoCel)) filasLeidas.push(filaEditable(campoCel, 'Celular', form[campoCel] && telefono(form[campoCel])));
    if (!pedir.includes(campoCorreo)) filasLeidas.push(filaEditable(campoCorreo, 'Correo', form[campoCorreo]));
    if (!mayor && e?.guardianDocNumber) {
        filasLeidas.push({ dt: 'Doc. acudiente', dd: `${e.guardianDocType ?? ''} ${e.guardianDocNumber}`.trim() });
    }
    if (e?.formDate) filasLeidas.push({ dt: 'Hoja del', dd: e.formDate });

    const origenTexto = `${item.source === 'app' ? 'Subida en la app' : 'Llegó por WhatsApp'}${fechaHora(item.createdAt) ? ` · ${fechaHora(item.createdAt)}` : ''}`;

    const nombreInvitado = mayor
        ? (campoValido('athleteEmail', form.athleteEmail) ? form.athleteFullName.split(/\s+/)[0] : null)
        : (form.guardianFullName.trim() || null);
    const textoListo = mayor && !nombreInvitado
        ? 'Todo listo. Sin correo, no le llega invitación a la app.'
        : `Todo listo. Le llega la invitación a ${nombreInvitado ?? 'el acudiente'}.`;

    return (
        <div id={props.idDetalle} className="flex flex-col gap-4 px-3.5 pb-3.5">
            {/* Origen */}
            {item.photoUrl ? (
                <div className="flex flex-wrap items-center gap-3 rounded-xl bg-muted/60 p-2.5 text-xs text-muted-foreground">
                    <button
                        type="button"
                        onClick={() => setFotoGrande((v) => !v)}
                        aria-expanded={fotoGrande}
                        aria-label={fotoGrande ? 'Achicar la foto de la hoja' : 'Ampliar la foto de la hoja'}
                        className={cn(
                            'shrink-0 overflow-hidden rounded border bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                            fotoGrande ? 'order-last w-full' : 'h-16 w-12',
                        )}
                    >
                        <img
                            src={item.photoUrl}
                            alt="Hoja de matrícula"
                            className={cn('h-full w-full', fotoGrande ? 'max-h-[70vh] object-contain' : 'object-cover')}
                        />
                    </button>
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span>{origenTexto}</span>
                        <a
                            href={item.photoUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="self-start font-semibold text-primary underline-offset-2 hover:underline"
                        >
                            Abrir la foto en otra pestaña
                        </a>
                        {item.duplicateOfIntakeId && <span>Hay otra foto pendiente de la misma hoja.</span>}
                    </div>
                </div>
            ) : (
                <p className="flex items-center gap-2 rounded-xl bg-muted/60 px-3 py-2.5 text-xs text-muted-foreground">
                    <ImageOff className="h-4 w-4 shrink-0" aria-hidden />
                    Sin foto. {origenTexto}.
                    {item.duplicateOfIntakeId && ' Hay otra foto pendiente de la misma hoja.'}
                </p>
            )}

            {/* Leído de la hoja */}
            {filasLeidas.length > 0 && (
                <section aria-labelledby={`leido-${item.id}`}>
                    <h3 id={`leido-${item.id}`} className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        Leído de la hoja
                    </h3>
                    <dl className="grid grid-cols-[auto_1fr] gap-x-3.5 gap-y-1.5 text-sm">
                        {filasLeidas.map((f) => (
                            <div key={f.dt} className="contents">
                                <dt className="text-muted-foreground">{f.dt}</dt>
                                <dd className="min-w-0 break-words font-medium [overflow-wrap:anywhere]">{f.dd}</dd>
                            </div>
                        ))}
                    </dl>
                </section>
            )}

            {/* Ya existe / Falta completar */}
            {dupPendiente ? (
                <div className="flex flex-col gap-2.5 rounded-xl bg-blue-100 p-3 text-sm text-blue-900 dark:bg-blue-950/50 dark:text-blue-200">
                    <p>
                        <strong>{item.duplicateOfChildName ?? 'Este deportista'}</strong> ya está en la escuela. Si es la misma
                        persona, completa su ficha con los datos de esta hoja.
                    </p>
                    <div className="flex flex-wrap gap-2">
                        <Button type="button" className="min-h-touch rounded-xl" onClick={props.onCompletarFicha}>
                            Completar su ficha
                        </Button>
                        <Button type="button" variant="outline" className="min-h-touch rounded-xl bg-card" onClick={props.onOtraPersona}>
                            Es otra persona
                        </Button>
                    </div>
                </div>
            ) : pedir.length > 0 && (
                <section aria-labelledby={`falta-${item.id}`}>
                    <h3 id={`falta-${item.id}`} className="mb-2 flex items-center justify-between gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        Falta completar
                        {pedidosObligatorios.length > 0 && (
                            <small className="text-xs font-medium normal-case tracking-normal tabular-nums">
                                {hechos} de {pedidosObligatorios.length}
                            </small>
                        )}
                    </h3>
                    {pedidosObligatorios.length > 0 && (
                        <div
                            className="mb-3 h-1 overflow-hidden rounded bg-muted"
                            role="progressbar"
                            aria-label="Datos obligatorios completos"
                            aria-valuemin={0}
                            aria-valuemax={pedidosObligatorios.length}
                            aria-valuenow={hechos}
                        >
                            <span className="block h-full bg-primary transition-[width] motion-reduce:transition-none" style={{ width: `${avance}%` }} />
                        </div>
                    )}
                    <div className="flex flex-col gap-3">
                        {pedir.map((c) => (
                            <CampoPedido
                                key={c}
                                item={item}
                                campo={c}
                                form={form}
                                opcional={!obligatorios.includes(c)}
                                onCampo={onCampo}
                            />
                        ))}
                    </div>
                </section>
            )}

            {/* Salud */}
            <Plegable
                titulo="Salud"
                resumen={[form.epsName, form.bloodType].filter(Boolean).join(' · ') || 'opcional'}
            >
                <div className="flex flex-col gap-1">
                    <Label htmlFor={`f-${item.id}-eps`}>EPS</Label>
                    <Input
                        id={`f-${item.id}-eps`}
                        list={`eps-${item.id}`}
                        value={form.epsName}
                        placeholder="Ej. Sura"
                        autoComplete="off"
                        onChange={(ev) => onCampo('epsName', ev.target.value)}
                        className="h-11 rounded-xl text-base"
                    />
                    <datalist id={`eps-${item.id}`}>
                        {EPS_COLOMBIA.map((x) => <option key={x} value={x} />)}
                    </datalist>
                </div>
                <div className="flex flex-col gap-1">
                    <span id={`rh-${item.id}`} className="text-sm font-medium">Grupo sanguíneo</span>
                    <Chips
                        etiquetaId={`rh-${item.id}`}
                        opciones={GRUPOS_SANGUINEOS}
                        valor={form.bloodType}
                        onElegir={(v) => onCampo('bloodType', form.bloodType === v ? '' : v)}
                    />
                </div>
            </Plegable>

            {/* Nota de la hoja (hoy `category` trae notas largas de planilla) */}
            {notaDeLaHoja(item) && (
                <Plegable titulo="Nota de la hoja">
                    <p className="rounded-xl bg-muted/60 px-3 py-2.5 text-sm text-muted-foreground">{notaDeLaHoja(item)}</p>
                </Plegable>
            )}

            {/* Autorizaciones */}
            {autorizaciones.length > 0 && (
                <Plegable
                    titulo="Autorizaciones firmadas"
                    resumen={autorizacionesDudosas ? 'revisa' : 'todas marcadas'}
                    abiertoAlInicio={autorizacionesDudosas}
                >
                    <ul className="flex flex-col gap-1">
                        {autorizaciones.map((a, i) => (
                            <li key={i} className="flex gap-2 text-sm">
                                <span aria-hidden className={a.checked ? 'text-green-600' : a.checked === false ? 'text-red-600' : 'text-amber-600'}>
                                    {a.checked ? '☑' : a.checked === false ? '☐' : '?'}
                                </span>
                                <span className={a.checked ? '' : 'font-medium'}>
                                    {a.text}
                                    {a.checked === false && ' — SIN MARCAR'}
                                    {a.checked === null && ' — no se distingue, revisa la foto'}
                                </span>
                            </li>
                        ))}
                    </ul>
                </Plegable>
            )}

            {error && (
                <Alert variant="destructive">
                    <AlertTriangle className="h-4 w-4" />
                    <AlertDescription>{error}</AlertDescription>
                </Alert>
            )}

            {/* Pie */}
            {descartando ? (
                <div className="flex flex-col gap-2.5 rounded-xl bg-muted/60 p-3">
                    <p id={`motivo-${item.id}`} className="text-sm font-medium">¿Por qué descartas esta ficha?</p>
                    <Chips
                        etiquetaId={`motivo-${item.id}`}
                        opciones={MOTIVOS_DESCARTE}
                        valor={motivo ?? ''}
                        onElegir={(m) => setMotivo((actual) => (actual === m ? null : m))}
                    />
                    <div className="flex flex-wrap justify-end gap-2">
                        <Button type="button" variant="ghost" className="min-h-touch rounded-xl" onClick={() => { setDescartando(false); setMotivo(null); }}>
                            Cancelar
                        </Button>
                        <Button type="button" variant="destructive" className="min-h-touch rounded-xl" onClick={() => props.onDescartar(motivo)}>
                            Descartar ficha
                        </Button>
                    </div>
                </div>
            ) : (
                <div className="flex flex-col gap-2 border-t pt-3">
                    {!dupPendiente && (
                        <p
                            aria-live="polite"
                            className={cn('text-xs', faltan.length ? 'text-amber-700 dark:text-amber-400' : 'text-primary')}
                        >
                            {faltan.length ? `Falta: ${listaLegible(faltan)}.` : textoListo}
                        </p>
                    )}
                    <div className="flex gap-2">
                        <Button
                            type="button"
                            variant={dupPendiente ? 'ghost' : 'outline'}
                            className="min-h-touch rounded-xl"
                            onClick={() => setDescartando(true)}
                        >
                            Descartar
                        </Button>
                        {!dupPendiente && (
                            <Button
                                type="button"
                                className="min-h-touch flex-1 rounded-xl"
                                disabled={faltan.length > 0}
                                onClick={props.onCrear}
                            >
                                Crear deportista
                            </Button>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}

function notaDeLaHoja(item: IntakeItem): string | null {
    return item.extracted?.category?.trim() || null;
}

// ---------------------------------------------------------------------------

interface DefCampo {
    label: string;
    tipo: 'text' | 'doc' | 'date' | 'tel' | 'email';
    placeholder?: string;
    ayuda?: string;
}

const DEF_CAMPOS: Partial<Record<CampoFicha, DefCampo>> = {
    athleteFullName: { label: 'Nombre del deportista', tipo: 'text', placeholder: 'Nombres y apellidos' },
    docNumber: { label: 'Documento del deportista', tipo: 'doc' },
    dateOfBirth: { label: 'Fecha de nacimiento', tipo: 'date' },
    guardianFullName: { label: 'Nombre del acudiente', tipo: 'text', placeholder: 'Ej. Carolina Zarco' },
    guardianPhone: { label: 'Celular del acudiente', tipo: 'tel', ayuda: 'Por aquí le llegan los cobros y avisos.' },
    guardianEmail: { label: 'Correo del acudiente', tipo: 'email', placeholder: 'nombre@correo.com', ayuda: 'Le llega la invitación a la app.' },
    athletePhone: { label: 'Celular del deportista', tipo: 'tel' },
    athleteEmail: { label: 'Correo del deportista', tipo: 'email', placeholder: 'nombre@correo.com', ayuda: 'Le llega la invitación a la app.' },
};

function CampoPedido({ item, campo, form, opcional, onCampo, etiquetaOculta = false, onListo }: {
    item: IntakeItem;
    campo: CampoFicha;
    form: FormState;
    opcional: boolean;
    onCampo: (campo: CampoFicha, valor: string) => void;
    /** Dentro de «Leído de la hoja» la etiqueta visible ya es el <dt>. */
    etiquetaOculta?: boolean;
    /** Cierra la corrección de una fila leída. */
    onListo?: () => void;
}) {
    const def = DEF_CAMPOS[campo] ?? { label: campo, tipo: 'text' as const };
    const id = `f-${item.id}-${campo}`;
    const valor = form[campo];
    const listo = !opcional && campoValido(campo, valor);
    const claseInput = cn('h-11 rounded-xl text-base', listo && 'border-primary/60');
    const ayuda = campo === 'dateOfBirth' && item.extracted?.dateOfBirthRaw
        ? `La hoja dice: «${item.extracted.dateOfBirthRaw}».`
        : def.ayuda;
    const idAyuda = ayuda ? `${id}-ayuda` : undefined;
    const cambiar = (ev: React.ChangeEvent<HTMLInputElement>) => onCampo(campo, ev.target.value);

    let control: React.ReactNode;
    if (def.tipo === 'doc') {
        const tipos: string[] = [...TIPOS_DOC];
        if (form.docType && !tipos.includes(form.docType)) tipos.push(form.docType);
        control = (
            <>
                <Chips
                    etiqueta="Tipo de documento"
                    opciones={tipos}
                    valor={form.docType}
                    onElegir={(t) => onCampo('docType', t)}
                    className="mb-2"
                />
                <Input id={id} inputMode="numeric" autoComplete="off" placeholder="Número" value={valor}
                    onChange={cambiar} aria-describedby={idAyuda} className={claseInput} />
            </>
        );
    } else if (def.tipo === 'tel') {
        control = (
            <div className="flex">
                <span aria-hidden className="flex items-center rounded-l-xl border border-r-0 bg-muted px-2.5 text-sm text-muted-foreground">+57</span>
                <Input id={id} type="tel" inputMode="tel" autoComplete="off" placeholder="300 000 0000" value={valor}
                    onChange={cambiar} aria-describedby={idAyuda} className={cn(claseInput, 'rounded-l-none')} />
            </div>
        );
    } else {
        control = (
            <Input
                id={id}
                type={def.tipo}
                inputMode={def.tipo === 'email' ? 'email' : undefined}
                autoComplete="off"
                placeholder={def.placeholder}
                value={valor}
                onChange={cambiar}
                aria-describedby={idAyuda}
                className={claseInput}
            />
        );
    }

    return (
        <div>
            <Label htmlFor={id} className={cn('mb-1 flex justify-between gap-2 text-sm font-medium', etiquetaOculta && 'sr-only')}>
                {def.label}
                {opcional && <small className="font-normal text-muted-foreground">opcional</small>}
            </Label>
            {control}
            {ayuda && <p id={idAyuda} className="mt-1 text-xs text-muted-foreground">{ayuda}</p>}
            {onListo && (
                <button
                    type="button"
                    onClick={onListo}
                    className="mt-1 min-h-touch rounded text-xs font-semibold text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                    Listo
                </button>
            )}
        </div>
    );
}

function Chips({ opciones, valor, onElegir, etiqueta, etiquetaId, className }: {
    opciones: readonly string[];
    valor: string;
    onElegir: (v: string) => void;
    etiqueta?: string;
    etiquetaId?: string;
    className?: string;
}) {
    return (
        <div role="group" aria-label={etiqueta} aria-labelledby={etiquetaId} className={cn('flex flex-wrap gap-1.5', className)}>
            {opciones.map((o) => {
                const activo = valor === o;
                return (
                    <button
                        key={o}
                        type="button"
                        aria-pressed={activo}
                        onClick={() => onElegir(o)}
                        className={cn(
                            'min-h-touch rounded-full border px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
                            activo ? 'border-primary bg-primary text-primary-foreground' : 'bg-card hover:bg-muted',
                        )}
                    >
                        {o}
                    </button>
                );
            })}
        </div>
    );
}

function Plegable({ titulo, resumen, abiertoAlInicio = false, children }: {
    titulo: string;
    resumen?: string;
    abiertoAlInicio?: boolean;
    children: React.ReactNode;
}) {
    return (
        <details open={abiertoAlInicio} className="group border-t pt-2.5">
            <summary className="flex min-h-touch cursor-pointer list-none items-center justify-between gap-2 rounded text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                <span>
                    {titulo}
                    {resumen && <small className="ml-1.5 font-normal text-muted-foreground">{resumen}</small>}
                </span>
                <span aria-hidden className="text-lg text-muted-foreground group-open:hidden">+</span>
                <span aria-hidden className="hidden text-lg text-muted-foreground group-open:inline">–</span>
            </summary>
            <div className="flex flex-col gap-3 pt-2">{children}</div>
        </details>
    );
}
