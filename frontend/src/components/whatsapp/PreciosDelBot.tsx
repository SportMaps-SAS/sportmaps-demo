/**
 * WhatsApp › Precios — los valores que el bot usa para reconocer un pago en un
 * comprobante y para responder cuánto cuesta algo, todos en un solo lugar.
 *
 * La usa la administradora de la academia, no una persona técnica: cada fila
 * dice con una marca si el bot la reconoce en un comprobante y si la dice al
 * responder, y por qué no cuando no.
 *
 * Aquí se editan la matrícula, la clase de prueba y los artículos. Las
 * mensualidades y los servicios se ven, y se editan donde ya viven (Equipos y
 * Planes · Finanzas › Pagos). Toda escritura devuelve la pantalla completa ya
 * actualizada, así que no se vuelve a pedir.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { bffClient } from '@/lib/api/bffClient';
import { useToast } from '@/hooks/use-toast';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { AlertTriangle, Check, ExternalLink, Loader2, Minus, Pencil, Plus } from 'lucide-react';

// ─── Lo que devuelve el BFF ─────────────────────────────────────────────────

export interface Interruptores { responde_precios: boolean; cobra_desde_comprobante: boolean }
export interface Mensualidad { plan_id: string; nombre: string; precio: number | null }
export interface Articulo { id: string; nombre: string; precio: number | null; activo: boolean }
export interface OpcionDeServicio { clave: string; etiqueta: string; precio: number | null; precio_afiliado: number | null }
export interface Servicio {
    id: string; nombre: string; tipo: string | null; precio: number | null; precio_afiliado: number | null;
    opciones: OpcionDeServicio[] | null; activo: boolean; vende_por_whatsapp: boolean;
}
export interface PreciosBot {
    interruptores: Interruptores;
    mensualidades: Mensualidad[];
    matricula: { valor: number | null; valores_distintos: number[]; planes: number };
    clase_prueba: { valor: number | null; habilitada: boolean };
    articulos: Articulo[];
    servicios: Servicio[];
    avisos: { clave: string; texto: string }[];
}

// ─── Plata ──────────────────────────────────────────────────────────────────

/** $310.000 — pesos colombianos, con punto de miles y sin centavos. */
export function pesos(n: number | null | undefined): string {
    if (n === null || n === undefined || !Number.isFinite(n)) return 'Sin valor';
    const entero = Math.round(Math.abs(n));
    return `${n < 0 ? '-' : ''}$${String(entero).replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`;
}

/**
 * Lee lo que la persona escribió: «310000», «310.000», «$ 310.000» o
 * «310.000,00». Vacío es `null` (sin valor); lo que no se entiende, `undefined`.
 */
export function leerMonto(texto: string): number | null | undefined {
    const limpio = texto.replace(/[\s$]/g, '');
    if (!limpio) return null;
    const sinCentavos = limpio.replace(/,\d{1,2}$/, '');
    if (/^\d+$/.test(sinCentavos)) return Number(sinCentavos);
    if (/^\d{1,3}([.,]\d{3})+$/.test(sinCentavos)) return Number(sinCentavos.replace(/[.,]/g, ''));
    return undefined;
}

const paraEditar = (n: number | null | undefined) => (n === null || n === undefined ? '' : pesos(n).replace('$', ''));

// ─── Las marcas de cada fila ────────────────────────────────────────────────

export interface Marca { si: boolean; texto: string }

/**
 * Qué hace el bot con una fila: si la reconoce en un comprobante y si la dice
 * al responder. Depende de los dos interruptores, de que tenga valor y de que
 * esté activa. `seOfrece` = falso cuando el servicio no se vende por WhatsApp.
 */
export function marcasDe(p: {
    tieneValor: boolean; interruptores: Interruptores; activo?: boolean; seOfrece?: boolean;
}): { reconoce: Marca; dice: Marca } {
    const motivoBase = p.activo === false ? 'está desactivado' : !p.tieneValor ? 'no tiene valor' : null;
    const motivoReconoce = motivoBase ?? (!p.interruptores.cobra_desde_comprobante ? 'lo apagaste arriba' : null);
    const motivoDice = motivoBase
        ?? (p.seOfrece === false ? 'no se vende por WhatsApp' : null)
        ?? (!p.interruptores.responde_precios ? 'lo apagaste arriba' : null);
    return {
        reconoce: motivoReconoce
            ? { si: false, texto: `No lo reconoce en comprobantes: ${motivoReconoce}` }
            : { si: true, texto: 'Lo reconoce en comprobantes' },
        dice: motivoDice
            ? { si: false, texto: `No lo dice al responder: ${motivoDice}` }
            : { si: true, texto: 'Lo dice al responder' },
    };
}

const ERRORES: Record<string, string> = {
    valor_invalido: 'Ese valor no es válido. Escribe solo el número, por ejemplo 310.000.',
    precio_invalido: 'Ese precio no es válido. Escribe solo el número, por ejemplo 85.000.',
    nombre_invalido: 'El nombre del artículo debe tener entre 2 y 80 letras.',
    articulo_invalido: 'Revisa el nombre y el precio del artículo.',
    activo_invalido: 'No se pudo cambiar el estado del artículo. Actualiza la pantalla.',
    sin_cambios: 'No hay cambios para guardar.',
    interruptores_invalidos: 'No se pudo cambiar esa opción. Actualiza la pantalla.',
    articulo_no_encontrado: 'Ese artículo ya no existe. Actualiza la pantalla.',
    sin_planes_activos: 'Primero crea un plan en Equipos y Planes: la matrícula se guarda en tus planes.',
    forbidden: 'Esto solo lo puede hacer la administración de la escuela.',
    migracion_pendiente: 'Esta opción todavía no está disponible para tu escuela. Escríbenos y la activamos.',
};
const errorDe = (e: any) => ERRORES[e?.body?.error] ?? 'No se pudo guardar. Intenta de nuevo en un momento.';

// ─── Piezas ─────────────────────────────────────────────────────────────────

function Marcas({ m }: { m: { reconoce: Marca; dice: Marca } }) {
    return (
        <ul className="flex flex-col gap-0.5 text-[11px]" data-testid="marcas">
            {[m.reconoce, m.dice].map((x) => (
                <li key={x.texto} className={`flex items-start gap-1 ${x.si ? 'text-green-700 dark:text-green-400' : 'text-muted-foreground'}`}>
                    {x.si ? <Check className="h-3 w-3 mt-0.5 shrink-0" /> : <Minus className="h-3 w-3 mt-0.5 shrink-0" />}
                    <span className="min-w-0 break-words">{x.texto}</span>
                </li>
            ))}
        </ul>
    );
}

function Seccion(p: { titulo: string; descripcion: string; enlace?: { a: string; texto: string }; children: ReactNode; testId: string }) {
    return (
        <Card data-testid={p.testId}>
            <CardHeader className="pb-3">
                <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
                    <CardTitle className="text-base">{p.titulo}</CardTitle>
                    {p.enlace && (
                        <Link to={p.enlace.a} className="text-sm text-primary underline-offset-4 hover:underline inline-flex items-center gap-1">
                            {p.enlace.texto} <ExternalLink className="h-3.5 w-3.5" />
                        </Link>
                    )}
                </div>
                <CardDescription>{p.descripcion}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">{p.children}</CardContent>
        </Card>
    );
}

/** Una fila: nombre a la izquierda, precio a la derecha, las marcas debajo. */
function Fila(p: { nombre: ReactNode; precio: ReactNode; marcas?: ReactNode; extra?: ReactNode; acciones?: ReactNode; testId?: string; apagada?: boolean }) {
    return (
        <li className={`rounded-lg border p-3 space-y-1.5 ${p.apagada ? 'bg-muted/40' : ''}`} data-testid={p.testId}>
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                <p className="text-sm font-medium min-w-0 break-words">{p.nombre}</p>
                <p className="text-sm font-semibold tabular-nums whitespace-nowrap">{p.precio}</p>
            </div>
            {p.extra}
            {p.marcas}
            {p.acciones && <div className="flex flex-wrap gap-2 pt-1">{p.acciones}</div>}
        </li>
    );
}

/** Un valor único que se edita y se guarda (matrícula, clase de prueba). */
function ValorEditable(p: {
    id: string; etiqueta: string; valor: number | null; ocupado: boolean; ayuda: string;
    onGuardar: (valor: number | null) => Promise<boolean>;
}) {
    const [texto, setTexto] = useState(paraEditar(p.valor));
    const [error, setError] = useState<string | null>(null);
    // Cuando el BFF devuelve el valor guardado, el campo lo refleja.
    useEffect(() => { setTexto(paraEditar(p.valor)); setError(null); }, [p.valor]);

    const leido = leerMonto(texto);
    const cambio = leido !== undefined && leido !== p.valor;

    const guardar = async () => {
        if (leido === undefined) { setError('Escribe solo el número, por ejemplo 310.000.'); return; }
        setError(null);
        await p.onGuardar(leido);
    };

    return (
        <form className="space-y-1.5" onSubmit={(e) => { e.preventDefault(); void guardar(); }}>
            <Label htmlFor={p.id}>{p.etiqueta}</Label>
            <div className="flex flex-wrap gap-2">
                <div className="relative flex-1 min-w-[9rem] max-w-xs">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
                    <Input id={p.id} className="pl-6" inputMode="numeric" autoComplete="off" placeholder="Sin valor"
                        value={texto} onChange={(e) => { setTexto(e.target.value); setError(null); }}
                        aria-invalid={error ? true : undefined} />
                </div>
                <Button type="submit" disabled={p.ocupado || !cambio}>
                    {p.ocupado && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                    Guardar
                </Button>
            </div>
            {error
                ? <p className="text-xs text-destructive" role="alert">{error}</p>
                : <p className="text-xs text-muted-foreground">{p.ayuda}</p>}
        </form>
    );
}

/** Nombre y precio de un artículo: sirve para agregar y para editar. */
function FormularioArticulo(p: {
    inicial?: { nombre: string; precio: number | null }; ocupado: boolean; textoBoton: string;
    onGuardar: (a: { nombre: string; precio: number }) => Promise<boolean>; onCancelar?: () => void; prefijo: string;
}) {
    const [nombre, setNombre] = useState(p.inicial?.nombre ?? '');
    const [precio, setPrecio] = useState(paraEditar(p.inicial?.precio));
    const [error, setError] = useState<string | null>(null);

    const guardar = async () => {
        const monto = leerMonto(precio);
        if (!nombre.trim()) { setError('Escribe el nombre del artículo.'); return; }
        if (monto === undefined || monto === null || monto <= 0) { setError('Escribe el precio, por ejemplo 85.000.'); return; }
        setError(null);
        const ok = await p.onGuardar({ nombre: nombre.trim(), precio: monto });
        if (ok && !p.inicial) { setNombre(''); setPrecio(''); }
    };

    return (
        <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); void guardar(); }}>
            <div className="grid gap-2 sm:grid-cols-[1fr_10rem]">
                <div className="space-y-1 min-w-0">
                    <Label htmlFor={`${p.prefijo}-nombre`}>Nombre</Label>
                    <Input id={`${p.prefijo}-nombre`} placeholder="Ej. Uniforme" maxLength={80} autoComplete="off"
                        value={nombre} onChange={(e) => { setNombre(e.target.value); setError(null); }} />
                </div>
                <div className="space-y-1 min-w-0">
                    <Label htmlFor={`${p.prefijo}-precio`}>Precio</Label>
                    <Input id={`${p.prefijo}-precio`} placeholder="85.000" inputMode="numeric" autoComplete="off"
                        value={precio} onChange={(e) => { setPrecio(e.target.value); setError(null); }} />
                </div>
            </div>
            {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
            <div className="flex flex-wrap gap-2">
                <Button type="submit" size="sm" disabled={p.ocupado}>
                    {p.ocupado && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                    {p.textoBoton}
                </Button>
                {p.onCancelar && <Button type="button" size="sm" variant="ghost" onClick={p.onCancelar}>Cancelar</Button>}
            </div>
        </form>
    );
}

// ─── Componente ─────────────────────────────────────────────────────────────

export function PreciosDelBot({ schoolId }: { schoolId: string }) {
    const { toast } = useToast();
    const [datos, setDatos] = useState<PreciosBot | null>(null);
    const [cargando, setCargando] = useState(true);
    const [error, setError] = useState(false);
    /** Qué se está guardando ahora (una sola cosa a la vez). */
    const [ocupado, setOcupado] = useState<string | null>(null);
    const [editando, setEditando] = useState<string | null>(null);
    const [agregando, setAgregando] = useState(false);

    const base = `/api/v1/whatsapp/${schoolId}/precios`;

    const cargar = useCallback(async () => {
        setCargando(true);
        try {
            setDatos(await bffClient.get<PreciosBot>(base));
            setError(false);
        } catch {
            setError(true);
        } finally {
            setCargando(false);
        }
    }, [base]);

    useEffect(() => { setDatos(null); void cargar(); }, [cargar]);

    /** Toda escritura devuelve la pantalla completa; si no viniera, se vuelve a pedir. */
    const escribir = async (clave: string, llamada: () => Promise<PreciosBot>, listo: string): Promise<boolean> => {
        setOcupado(clave);
        try {
            const nuevo = await llamada();
            if (nuevo && nuevo.interruptores) setDatos(nuevo); else await cargar();
            toast({ title: listo });
            return true;
        } catch (e: any) {
            toast({ title: 'No se pudo guardar', description: errorDe(e), variant: 'destructive' });
            return false;
        } finally {
            setOcupado(null);
        }
    };

    if (!datos && error) {
        return (
            <div className="py-8 text-center space-y-3">
                <p className="text-sm text-muted-foreground">No pudimos cargar tus precios. Intenta de nuevo en un momento.</p>
                <Button size="sm" variant="outline" disabled={cargando} onClick={() => void cargar()}>Reintentar</Button>
            </div>
        );
    }
    if (!datos) {
        return (
            <div className="flex items-center justify-center py-10 text-sm text-muted-foreground" role="status">
                <Loader2 className="h-5 w-5 mr-2 animate-spin" /> Cargando tus precios…
            </div>
        );
    }

    const it = datos.interruptores;
    const mensualidades = datos.mensualidades ?? [];
    const articulos = datos.articulos ?? [];
    const servicios = datos.servicios ?? [];
    const avisos = datos.avisos ?? [];
    const distintos = datos.matricula.valores_distintos ?? [];
    const conValor = (n: number | null | undefined) => typeof n === 'number' && n > 0;

    const interruptor = (clave: keyof Interruptores, valor: boolean) =>
        void escribir(clave, () => bffClient.put<PreciosBot>(`${base}/interruptores`, { [clave]: valor }),
            valor ? 'Listo, quedó prendido' : 'Listo, quedó apagado');

    return (
        <div className="space-y-4 min-w-0">
            <div className="space-y-1">
                <h2 className="text-lg font-semibold">Precios que usa el bot</h2>
                <p className="text-sm text-muted-foreground">
                    Con estos valores el bot sabe qué te están pagando cuando llega un comprobante y qué responder cuando
                    alguien pregunta cuánto cuesta algo. Mantenlos al día y el bot no se equivoca.
                </p>
            </div>

            {avisos.map((a) => (
                <div key={a.clave} role="alert" data-testid={`aviso-${a.clave}`}
                    className="flex gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/20 dark:text-amber-200">
                    <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                    <p className="min-w-0 break-words">{a.texto}</p>
                </div>
            ))}

            <Card data-testid="sec-interruptores">
                <CardContent className="pt-6 space-y-4">
                    <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                            <Label htmlFor="int-responde" className="text-sm font-medium">El bot responde precios</Label>
                            <p className="text-xs text-muted-foreground">
                                Cuando alguien pregunta cuánto cuesta algo, el bot contesta con los valores de esta pantalla.
                            </p>
                        </div>
                        <Switch id="int-responde" className="shrink-0" checked={it.responde_precios} disabled={ocupado !== null}
                            onCheckedChange={(v) => interruptor('responde_precios', v)} />
                    </div>
                    <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                            <Label htmlFor="int-cobra" className="text-sm font-medium">El bot registra el pago cuando llega el comprobante</Label>
                            <p className="text-xs text-muted-foreground">
                                Si el valor del comprobante coincide con uno de estos precios, el bot deja el pago registrado por ti.
                            </p>
                        </div>
                        <Switch id="int-cobra" className="shrink-0" checked={it.cobra_desde_comprobante} disabled={ocupado !== null}
                            onCheckedChange={(v) => interruptor('cobra_desde_comprobante', v)} />
                    </div>
                </CardContent>
            </Card>

            <Seccion testId="sec-mensualidades" titulo="Mensualidades"
                descripcion="Lo que cuesta cada plan al mes."
                enlace={{ a: '/offerings', texto: 'Editar en Equipos y Planes' }}>
                {mensualidades.length === 0
                    ? <p className="text-sm text-muted-foreground">Todavía no tienes planes. Créalos en Equipos y Planes y aparecen aquí con su precio.</p>
                    : (
                        <ul className="space-y-2">
                            {mensualidades.map((m) => (
                                <Fila key={m.plan_id} testId={`plan-${m.plan_id}`} nombre={m.nombre} precio={pesos(m.precio)}
                                    marcas={<Marcas m={marcasDe({ tieneValor: conValor(m.precio), interruptores: it })} />} />
                            ))}
                        </ul>
                    )}
            </Seccion>

            <Seccion testId="sec-matricula" titulo="Matrícula"
                descripcion="Lo que se paga una sola vez al entrar a la escuela.">
                {distintos.length > 1 && (
                    <p className="text-sm rounded-md border border-amber-300 bg-amber-50 p-2 text-amber-900 dark:bg-amber-950/20 dark:text-amber-200" data-testid="matricula-distinta">
                        Hoy tus planes tienen valores de matrícula distintos ({distintos.map((v) => pesos(v)).join(', ')}).
                        Si guardas un valor aquí, todos tus planes quedan con ese mismo valor.
                    </p>
                )}
                <p className="text-sm text-muted-foreground">
                    Ten en cuenta: con un valor guardado, a quien se inscriba de aquí en adelante (por el código QR, por un
                    entrenador o desde Deportistas) le queda el cobro de la matrícula en todos tus planes. A los que ya
                    están inscritos no se les cobra nada.
                </p>
                {datos.matricula.planes === 0 && (
                    <p className="text-sm text-muted-foreground">
                        La matrícula se guarda en tus planes y todavía no tienes ninguno. Crea primero un plan en{' '}
                        <Link to="/offerings" className="text-primary underline-offset-4 hover:underline">Equipos y Planes</Link>.
                    </p>
                )}
                <ValorEditable id="valor-matricula" etiqueta="Valor de la matrícula" valor={datos.matricula.valor}
                    ocupado={ocupado === 'matricula'}
                    ayuda="Déjalo vacío si no cobras matrícula."
                    onGuardar={(valor) => escribir('matricula', () => bffClient.put<PreciosBot>(`${base}/matricula`, { valor }), 'Matrícula guardada')} />
                <Marcas m={marcasDe({ tieneValor: conValor(datos.matricula.valor) || distintos.some(conValor), interruptores: it })} />
            </Seccion>

            <Seccion testId="sec-clase-prueba" titulo="Clase de prueba"
                descripcion="Lo que cuesta la primera clase para quien quiere conocer la escuela.">
                {!datos.clase_prueba.habilitada && (
                    <p className="text-sm text-muted-foreground">Hoy tu escuela no está ofreciendo clase de prueba, así que el bot no usa este valor.</p>
                )}
                <ValorEditable id="valor-clase-prueba" etiqueta="Valor de la clase de prueba" valor={datos.clase_prueba.valor}
                    ocupado={ocupado === 'clase-prueba'}
                    ayuda="Déjalo vacío si la clase de prueba no tiene un valor fijo."
                    onGuardar={(valor) => escribir('clase-prueba', () => bffClient.put<PreciosBot>(`${base}/clase-prueba`, { valor }), 'Clase de prueba guardada')} />
                <Marcas m={marcasDe({ tieneValor: conValor(datos.clase_prueba.valor), activo: datos.clase_prueba.habilitada, interruptores: it })} />
            </Seccion>

            <Seccion testId="sec-articulos" titulo="Artículos"
                descripcion="Uniformes, balones y lo demás que vendes. Si dejas de vender algo, desactívalo: no se borra.">
                {articulos.length === 0 && !agregando && (
                    <p className="text-sm text-muted-foreground">Todavía no tienes artículos. Agrega el uniforme o lo que vendas, con su precio, y el bot lo reconoce cuando te lo paguen.</p>
                )}
                {articulos.length > 0 && (
                    <ul className="space-y-2">
                        {articulos.map((a) => (editando === a.id ? (
                            <li key={a.id} className="rounded-lg border p-3" data-testid={`articulo-${a.id}`}>
                                <FormularioArticulo prefijo={`art-${a.id}`} inicial={a} textoBoton="Guardar" ocupado={ocupado === a.id}
                                    onCancelar={() => setEditando(null)}
                                    onGuardar={async (v) => {
                                        const ok = await escribir(a.id, () => bffClient.patch<PreciosBot>(`${base}/articulos/${a.id}`, v), 'Artículo guardado');
                                        if (ok) setEditando(null);
                                        return ok;
                                    }} />
                            </li>
                        ) : (
                            <Fila key={a.id} testId={`articulo-${a.id}`} apagada={!a.activo}
                                nombre={<>{a.nombre}{!a.activo && <Badge variant="secondary" className="ml-2">Desactivado</Badge>}</>}
                                precio={pesos(a.precio)}
                                marcas={<Marcas m={marcasDe({ tieneValor: conValor(a.precio), activo: a.activo, interruptores: it })} />}
                                acciones={<>
                                    <Button size="sm" variant="outline" disabled={ocupado !== null} onClick={() => { setEditando(a.id); setAgregando(false); }}>
                                        <Pencil className="h-3.5 w-3.5 mr-1" /> Editar
                                    </Button>
                                    <Button size="sm" variant="ghost" disabled={ocupado !== null}
                                        onClick={() => void escribir(a.id, () => bffClient.patch<PreciosBot>(`${base}/articulos/${a.id}`, { activo: !a.activo }),
                                            a.activo ? 'Artículo desactivado' : 'Artículo activado')}>
                                        {ocupado === a.id && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
                                        {a.activo ? 'Desactivar' : 'Activar'}
                                    </Button>
                                </>} />
                        )))}
                    </ul>
                )}
                {agregando ? (
                    <div className="rounded-lg border border-dashed p-3" data-testid="articulo-nuevo">
                        <FormularioArticulo prefijo="art-nuevo" textoBoton="Agregar" ocupado={ocupado === 'nuevo'}
                            onCancelar={() => setAgregando(false)}
                            onGuardar={async (v) => {
                                const ok = await escribir('nuevo', () => bffClient.post<PreciosBot>(`${base}/articulos`, v), 'Artículo agregado');
                                if (ok) setAgregando(false);
                                return ok;
                            }} />
                    </div>
                ) : (
                    <Button size="sm" variant="outline" onClick={() => { setAgregando(true); setEditando(null); }}>
                        <Plus className="h-4 w-4 mr-1" /> Agregar artículo
                    </Button>
                )}
            </Seccion>

            <Seccion testId="sec-servicios" titulo="Servicios"
                descripcion="Clínicas, torneos, campamentos y otros cobros aparte de la mensualidad."
                enlace={{ a: '/payments-automation', texto: 'Editar en Finanzas › Pagos' }}>
                {servicios.length === 0
                    ? <p className="text-sm text-muted-foreground">Todavía no tienes servicios. Créalos en Finanzas › Pagos y aparecen aquí con su precio.</p>
                    : (
                        <ul className="space-y-2">
                            {servicios.map((s) => {
                                const opciones = s.opciones ?? [];
                                const tieneValor = conValor(s.precio) || opciones.some((o) => conValor(o.precio));
                                return (
                                    <Fila key={s.id} testId={`servicio-${s.id}`} apagada={!s.activo}
                                        nombre={<>{s.nombre}{!s.activo && <Badge variant="secondary" className="ml-2">Desactivado</Badge>}</>}
                                        precio={conValor(s.precio) || opciones.length === 0 ? pesos(s.precio) : 'Según la opción'}
                                        extra={<>
                                            {conValor(s.precio_afiliado) && (
                                                <p className="text-xs text-muted-foreground">Para quienes ya son de la escuela: <span className="tabular-nums">{pesos(s.precio_afiliado)}</span></p>
                                            )}
                                            {opciones.length > 0 && (
                                                <ul className="text-xs text-muted-foreground space-y-0.5">
                                                    {opciones.map((o) => (
                                                        <li key={o.clave} className="flex flex-wrap justify-between gap-x-3">
                                                            <span className="min-w-0 break-words">{o.etiqueta}</span>
                                                            <span className="tabular-nums">
                                                                {pesos(o.precio)}
                                                                {conValor(o.precio_afiliado) && ` · de la escuela: ${pesos(o.precio_afiliado)}`}
                                                            </span>
                                                        </li>
                                                    ))}
                                                </ul>
                                            )}
                                        </>}
                                        marcas={<Marcas m={marcasDe({ tieneValor, activo: s.activo, seOfrece: s.vende_por_whatsapp, interruptores: it })} />} />
                                );
                            })}
                        </ul>
                    )}
            </Seccion>
        </div>
    );
}
