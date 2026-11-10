/**
 * El buzón de conversaciones (F3).
 *
 * Hasta ahora la escuela no tenía dónde leer ni responder: la pestaña "Bandeja"
 * lista comprobantes que fallaron, no chats. El bot atendía y lo que no sabía
 * manejar quedaba escalado sin que nadie pudiera verlo.
 *
 * Lo que manda sobre el diseño de acá:
 *
 *  - **Primero lo que hay que hacer.** La dueña de Dynasty (2026-10-06): «se ve
 *    todo en una sola pantalla». Eran 169 filas mezclando familias, prospectos,
 *    contactos personales, staff, hilos sin mensajes y ventanas cerradas hace
 *    días. Ahora el buzón abre en la bandeja «Por responder» (sin respuesta y
 *    con la ventana abierta), ordenada por la ventana que vence primero, y el
 *    resto queda en bandejas aparte. Lo que no pide nada (hilos sin mensajes o
 *    con solo salientes viejos) se oculta.
 *
 *  - **La ventana de 24 horas.** WhatsApp solo deja responder en texto libre
 *    mientras el titular haya escrito en las últimas 24 h. Con la ventana
 *    cerrada NO se pinta el cuadro de texto: si se pintara, la escuela
 *    escribiría, le daría enviar, y recibiría un error que no sabe leer. Vale
 *    más un cuadro que no está que uno que falla. En la lista, las de ventana
 *    cerrada van a un grupo aparte, colapsado.
 *
 *  - **Quién escribió cada mensaje.** El bot y una persona de la escuela salen
 *    por el mismo número. Si el hilo no los distingue, nadie sabe qué se
 *    prometió ni quién lo prometió.
 *
 *  - **El número también es el WhatsApp personal de la dueña** (Coexistence).
 *    Una conversación se puede marcar como personal (desde la fila o desde el
 *    hilo) para que salga a «Personal y otros» y el asistente nunca le conteste.
 *
 * Fase 1 del rediseño (2026-10-13, docs/specs/comunicaciones-inventario.md):
 *  - La búsqueda va al servidor (todas las conversaciones: nombre, teléfono,
 *    deportista y texto). Antes filtraba las 200 más recientes y decía «usa la
 *    búsqueda para el resto», que era falso.
 *  - Los adjuntos se ven (foto, nota de voz, PDF) en vez de «(image)».
 *  - Con la ventana cerrada hay «Enviar plantilla» (antes, callejón sin salida).
 *  - Escritorio: el panel mide el alto que queda en la ventana; el compositor
 *    siempre a la vista y sin la burbuja de soporte encima. Celular: el hilo es
 *    pantalla completa con su flecha atrás y el compositor fijo abajo.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
    DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
    DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { bffClient } from '@/lib/api/bffClient';
import { useToast } from '@/hooks/use-toast';
import { useIsMobile } from '@/hooks/use-mobile';
import { useAltoDisponible } from '@/hooks/useAltoDisponible';
import { useOcultarFabSoporte } from '@/lib/supportFab';
import { AdjuntoDelMensaje, type MedioDelMensaje } from './AdjuntoDelMensaje';
import { EnviarPlantilla } from './EnviarPlantilla';
import { TipoDeContactoDialog } from './TipoDeContactoDialog';
import {
    OPCIONES_DE_TIPO, esMarcaNoFamilia, esSoloNoFamilia, pedidoDeTipo, textoDelResultado,
    type OpcionDeTipo, type RespuestaDeTipo,
} from './tipoDeContacto';
import {
    MessageSquare, Send, Bot, User, Clock, Loader2, ChevronLeft, ChevronDown, ChevronRight, Sparkles, X,
    CheckCircle2, Hand, Unlock, Search, MoreVertical, RefreshCw, MessageCircle, FileText, Tags,
} from 'lucide-react';

interface UltimoMensaje {
    direction: string; text_body: string | null; type: string;
    created_at: string; ai_generated: boolean | null;
}
export interface Conversacion {
    id: string;
    contact_wa_id: string;
    contact_name: string | null;
    identified: boolean;
    status: string;
    unread_count: number | null;
    last_message_at: string | null;
    last_inbound_at: string | null;
    ventana_abierta: boolean;
    ventana_vence: string | null;
    ultimo_mensaje: UltimoMensaje | null;
    borradores_pendientes: number;
    /** Quién es el contacto. null/ausente si el backend todavía no lo calcula. */
    contact_kind?: TipoDeContacto | null;
    /** Marcado no-familia pero también acudiente (sus comprobantes sí entran). Ausente en backends viejos. */
    tambien_familia?: boolean;
    /** El último mensaje entrante no tiene respuesta. Ausente en backends viejos. */
    pendiente?: boolean;
    /** Pendiente y lo último NO es un cierre («gracias», «ok», 👍). Ausente en backends viejos. */
    requiere_respuesta?: boolean;
    /** Mejora 9: tomada por una persona (solo si está vigente). Mientras tanto el asistente calla. */
    toma?: Toma | null;
    /** El asistente lo atendió como prospecto (pidió info de clases/inscripción). Ausente en backends viejos. */
    es_prospecto?: boolean;
    /**
     * Detección de prospectos del backend (otro frente, en curso). Forma
     * tentativa: si llega un objeto, la conversación es prospecto.
     */
    prospecto?: { estado?: string | null; interes?: string | null } | null;
    /** Solo en resultados de búsqueda: por qué apareció. */
    coincidencia?: { tipo: 'nombre' | 'telefono' | 'deportista' | 'mensaje'; texto: string | null } | null;
}

interface Toma { tomada_por: string; tomada_por_nombre: string | null; tomada_hasta: string }

/** «Atendida por Milena · hasta 9:30 p. m.» */
function textoDeToma(t: Toma): string {
    const hasta = new Date(t.tomada_hasta).toLocaleString('es-CO', { hour: 'numeric', minute: '2-digit' });
    return `Atendida por ${t.tomada_por_nombre || 'alguien de la escuela'} · hasta ${hasta}`;
}

export type TipoDeContacto =
    | 'familia' | 'familia_sin_cuenta' | 'ambiguo' | 'staff' | 'desconocido'
    // Marcas manuales de no-familia (ver tipoDeContacto.ts).
    | 'personal' | 'negocio' | 'otro_club' | 'plataforma'
    // Reservado: si el backend llega a guardar la detección de prospectos como tipo.
    | 'prospecto';

/** Etiqueta corta por tipo de contacto. */
const ETIQUETA_TIPO: Record<TipoDeContacto, { texto: string; clase: string }> = {
    familia:            { texto: 'Familia',     clase: 'border-green-300 text-green-700 dark:text-green-400' },
    familia_sin_cuenta: { texto: 'Sin cuenta',  clase: 'border-sky-300 text-sky-700 dark:text-sky-400' },
    ambiguo:            { texto: 'Revisar',     clase: 'border-amber-300 text-amber-700 dark:text-amber-400' },
    staff:              { texto: 'Equipo',      clase: 'border-violet-300 text-violet-700 dark:text-violet-400' },
    desconocido:        { texto: 'Desconocido', clase: 'text-muted-foreground' },
    personal:           { texto: 'Personal',    clase: 'border-slate-400 text-slate-600 dark:text-slate-300' },
    negocio:            { texto: 'Negocio',     clase: 'border-slate-400 text-slate-600 dark:text-slate-300' },
    otro_club:          { texto: 'Otro club',   clase: 'border-slate-400 text-slate-600 dark:text-slate-300' },
    plataforma:         { texto: 'Plataforma',  clase: 'border-slate-400 text-slate-600 dark:text-slate-300' },
    prospecto:          { texto: 'Interesado',   clase: 'border-fuchsia-300 text-fuchsia-700 dark:text-fuchsia-400' },
};

function EtiquetaTipo({ c }: { c: Pick<Conversacion, 'contact_kind' | 'es_prospecto' | 'prospecto' | 'last_inbound_at'> }) {
    const tipo: TipoDeContacto | null | undefined = esProspectoMarcado(c) ? 'prospecto' : c.contact_kind;
    if (!tipo || !ETIQUETA_TIPO[tipo]) return null;
    const e = ETIQUETA_TIPO[tipo];
    return (
        <Badge variant="outline" className={`text-xs ${e.clase}`}
               title={tipo === 'ambiguo' ? 'El número coincide con más de una persona: revísalo'
                   : tipo === 'prospecto' ? 'Interesado: pidió información de clases o inscripción' : undefined}>
            {e.texto}
        </Badge>
    );
}

/**
 * ¿Está esperando respuesta? Si el backend manda `pendiente`, manda eso. Si no
 * (versión vieja), se cae al `status === 'open'` de antes.
 */
const sinResponder = (c: Conversacion) =>
    typeof c.requiere_respuesta === 'boolean' ? c.requiere_respuesta
        : typeof c.pendiente === 'boolean' ? c.pendiente : c.status === 'open';

const TIPOS_FAMILIA: readonly string[] = ['familia', 'familia_sin_cuenta', 'ambiguo'];
const esFamilia = (c: Conversacion) => !!c.contact_kind && TIPOS_FAMILIA.includes(c.contact_kind);

/**
 * ¿Es un interesado? Solo lo que el backend marcó: el asistente le respondió
 * como prospecto (pidió precio, horario, inscripción o clase de cortesía) o
 * hay un lead suyo en `school_signup_leads`.
 * Antes también entraba cualquier desconocido que escribiera: en Dynasty eran
 * 131 filas, casi todas ruido (spec comunicaciones-rediseno-v2, D5). Ese
 * desconocido sigue en «Ver todo › Todas».
 */
function esProspectoMarcado(c: Pick<Conversacion, 'contact_kind' | 'es_prospecto' | 'prospecto'>): boolean {
    if (esMarcaNoFamilia(c.contact_kind) || c.contact_kind === 'staff') return false;
    return c.es_prospecto === true || !!c.prospecto || c.contact_kind === 'prospecto';
}
const esProspecto = (c: Conversacion) => esProspectoMarcado(c);

const DIA_MS = 24 * 3_600_000;

/**
 * Filas que no piden nada y solo estorban: hilos sin ningún mensaje, o en los
 * que la persona nunca escribió y lo único que hay son salientes (bot, plantilla
 * o echo del celular) de hace más de una semana.
 */
function esRuido(c: Conversacion): boolean {
    if (sinResponder(c) || c.borradores_pendientes > 0 || c.toma) return false;
    if (!c.ultimo_mensaje && !c.last_inbound_at) return true;
    if (!c.last_inbound_at) {
        const t = c.last_message_at ? new Date(c.last_message_at).getTime() : 0;
        return Date.now() - t > 7 * DIA_MS;
    }
    return false;
}

type Bandeja = 'responder' | 'aprobar' | 'prospectos' | 'familias' | 'otros' | 'todas';
/**
 * V2 (spec comunicaciones-rediseno-v2, D2): a la vista solo «Te esperan» y los
 * filtros que tengan algo; el resto va plegado en «Ver todo».
 */
const BANDEJAS: { id: Bandeja; texto: string; urgente?: boolean; soloClasificado?: boolean; enVerTodo?: boolean }[] = [
    { id: 'responder',  texto: 'Te esperan',  urgente: true },
    { id: 'aprobar',    texto: 'Por aprobar', urgente: true },
    // Los leads sin respuesta se estaban quedando (2026-10-06): van a la vista.
    { id: 'prospectos', texto: 'Interesados', soloClasificado: true },
    { id: 'familias',   texto: 'Familias',    soloClasificado: true, enVerTodo: true },
    { id: 'otros',      texto: 'Personales y otros', soloClasificado: true, enVerTodo: true },
    { id: 'todas',      texto: 'Todas',       enVerTodo: true },
];
const CLAVE_BANDEJA = 'sm.wa.buzon.bandeja';
const POR_PAGINA = 25;

function leerBandeja(): Bandeja {
    try {
        const v = localStorage.getItem(CLAVE_BANDEJA);
        if (v && BANDEJAS.some((b) => b.id === v)) return v as Bandeja;
    } catch { /* almacenamiento bloqueado: se usa el default */ }
    return 'responder';
}
function guardarBandeja(b: Bandeja) {
    try { localStorage.setItem(CLAVE_BANDEJA, b); } catch { /* sin almacenamiento: no pasa nada */ }
}

/** Minúsculas y sin tildes, para buscar «maria» y encontrar «María». */
/**
 * Quien usa nombre de usuario de WhatsApp y no comparte su teléfono entra con un
 * identificador interno («wau-…», ver bff whatsapp-usuario-meta): no es un número
 * y no se le muestra a la escuela. Su @usuario va en el nombre del contacto.
 */
const numeroVisible = (waId: string | null | undefined) =>
    String(waId ?? '').startsWith('wau-') ? 'Sin teléfono · usuario de WhatsApp' : String(waId ?? '');

const normalizar = (s: string | null | undefined) =>
    (s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

interface Mensaje {
    id: string; direction: string; type: string; text_body: string | null;
    status: string | null; ai_generated: boolean | null; created_at: string;
    error_detail: string | null;
    /** Adjunto (foto, audio, documento…). Ausente en backends viejos. */
    media?: MedioDelMensaje | null;
}
interface Borrador {
    id: string; proposed_text: string; edited_text: string | null;
    llm_provider: string | null; created_at: string;
}

const hora = (s: string | null) =>
    s ? new Date(s).toLocaleString('es-CO', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';

/** Fecha corta para la lista: la hora si es de hoy, el día si no. */
function cuando(s: string | null): string {
    if (!s) return '';
    const d = new Date(s);
    const hoy = new Date();
    return d.toDateString() === hoy.toDateString()
        ? d.toLocaleTimeString('es-CO', { hour: 'numeric', minute: '2-digit' })
        : d.toLocaleDateString('es-CO', { day: '2-digit', month: 'short' });
}

const msRestantes = (vence: string | null) => (vence ? new Date(vence).getTime() - Date.now() : -1);

/** Cuánto le queda a la ventana, en palabras. */
function restante(vence: string | null): string {
    const ms = msRestantes(vence);
    if (!vence) return '';
    if (ms <= 0) return 'cerrada';
    const h = Math.floor(ms / 3_600_000);
    return h >= 1 ? `${h} h` : `${Math.max(1, Math.floor(ms / 60_000))} min`;
}

/**
 * Hasta cuándo se le puede escribir en texto libre, en palabras de la cancha:
 * «3:40 p. m.», «mañana 1:05 p. m.» o la fecha. Nunca «ventana de 24 h».
 */
export function hastaCuando(vence: string | null | undefined, ahora = new Date()): string {
    if (!vence) return '';
    const d = new Date(vence);
    const horaTxt = d.toLocaleTimeString('es-CO', { hour: 'numeric', minute: '2-digit' });
    if (d.toDateString() === ahora.toDateString()) return horaTxt;
    const manana = new Date(ahora); manana.setDate(ahora.getDate() + 1);
    if (d.toDateString() === manana.toDateString()) return `mañana ${horaTxt}`;
    return d.toLocaleDateString('es-CO', { day: '2-digit', month: 'short' });
}

const AYUDA_VENTANA_CERRADA =
    'Pasó más de un día desde su último mensaje: WhatsApp solo deja escribirle con un mensaje aprobado hasta que vuelva a escribir';

/** Hasta cuándo responder: rojo si quedan menos de 3 h para contestar en texto libre. */
function ChipVentana({ c, destacar = false }: { c: Conversacion; destacar?: boolean }) {
    if (!c.ventana_abierta) {
        return destacar ? (
            <Badge variant="outline" className="text-xs border-amber-400 text-amber-700 dark:text-amber-400"
                   title={AYUDA_VENTANA_CERRADA}>
                pasó un día · solo mensaje aprobado
            </Badge>
        ) : <span className="text-xs text-amber-600 dark:text-amber-500" title={AYUDA_VENTANA_CERRADA}>pasó un día</span>;
    }
    const urgente = msRestantes(c.ventana_vence) < 3 * 3_600_000;
    const texto = `responde hasta ${hastaCuando(c.ventana_vence)}`;
    if (destacar && !urgente) {
        return (
            <Badge variant="outline" className="text-xs border-orange-300 text-orange-700 dark:border-orange-800 dark:text-orange-400"
                   title={`Quedan ${restante(c.ventana_vence)}`}>
                <Clock className="h-3 w-3 mr-1" />{texto}
            </Badge>
        );
    }
    return urgente ? (
        <Badge variant="outline" className="text-xs border-red-300 text-red-700 dark:border-red-800 dark:text-red-400"
               title={`Quedan ${restante(c.ventana_vence)}`}>
            <Clock className="h-3 w-3 mr-1" />{texto}
        </Badge>
    ) : (
        <span className="text-xs text-muted-foreground" title={`Quedan ${restante(c.ventana_vence)}`}>
            <Clock className="h-3 w-3 inline mr-0.5" />{texto}
        </span>
    );
}

/**
 * Urgencia: lo que espera respuesta primero, y entre eso la ventana que vence
 * antes. Después, lo más reciente.
 */
function porUrgencia(a: Conversacion, b: Conversacion): number {
    const pa = sinResponder(a) && a.ventana_abierta;
    const pb = sinResponder(b) && b.ventana_abierta;
    if (pa !== pb) return pa ? -1 : 1;
    if (pa && pb) return msRestantes(a.ventana_vence) - msRestantes(b.ventana_vence);
    const da = a.borradores_pendientes > 0, db = b.borradores_pendientes > 0;
    if (da !== db) return da ? -1 : 1;
    return (b.last_message_at ?? '').localeCompare(a.last_message_at ?? '');
}

function quien(m: Mensaje, tipo?: TipoDeContacto | null): { texto: string; icono: JSX.Element } {
    if (m.direction === 'inbound') {
        // Sin tipo (backend viejo) se conserva el rótulo de siempre.
        const familia = !tipo || tipo === 'familia' || tipo === 'familia_sin_cuenta';
        return { texto: familia ? 'Familia' : 'Contacto', icono: <User className="h-3 w-3" /> };
    }
    return m.ai_generated
        ? { texto: 'Mapi', icono: <Bot className="h-3 w-3" /> }
        : { texto: 'Escuela', icono: <User className="h-3 w-3" /> };
}

/** «Asistente: …» / «Tú: …» delante del último mensaje si salió de la escuela. */
/** Lo que se lee en la lista cuando el mensaje es un adjunto sin texto. */
const TIPO_LEGIBLE: Record<string, string> = {
    image: '📷 Foto', audio: '🎤 Audio', video: '🎬 Video', document: '📄 Documento', sticker: 'Sticker',
    interactive: 'Respuesta a un botón', button: 'Respuesta a un botón', template: 'Plantilla',
    reaction: 'Reacción', location: '📍 Ubicación', contacts: 'Contacto', unsupported: 'Mensaje no compatible',
};
export const tipoLegible = (t: string) => TIPO_LEGIBLE[t] ?? 'Mensaje';

function resumenUltimo(c: Conversacion): string {
    const u = c.ultimo_mensaje;
    if (!u) return '(sin mensajes)';
    const cuerpo = u.text_body ?? tipoLegible(u.type);
    if (u.direction !== 'outbound') return cuerpo;
    return `${u.ai_generated ? 'Mapi' : 'Escuela'}: ${cuerpo}`;
}


/** Debajo del último mensaje, en un resultado de búsqueda: por qué apareció. */
function TextoCoincidencia({ c }: { c: Conversacion }) {
    const co = c.coincidencia;
    if (!co) return null;
    const texto = co.tipo === 'deportista' ? `Deportista: ${co.texto ?? ''}`
        : co.tipo === 'mensaje' ? `«${co.texto ?? ''}»`
        : co.tipo === 'telefono' ? 'Coincide el teléfono' : null;
    if (!texto) return null;
    return <p className="mt-0.5 text-xs text-primary/90 line-clamp-2" data-testid="coincidencia">{texto}</p>;
}

/** Espera a que la persona deje de escribir antes de ir al servidor. */
function useDebounced<T>(valor: T, ms: number): T {
    const [v, setV] = useState(valor);
    useEffect(() => {
        const t = setTimeout(() => setV(valor), ms);
        return () => clearTimeout(t);
    }, [valor, ms]);
    return v;
}

interface RespuestaBusqueda { total: number; hay_mas: boolean; conversaciones: Conversacion[] }

export function Conversaciones({ schoolId, conversacionInicial }: { schoolId: string; conversacionInicial?: string | null }) {
    const { toast } = useToast();
    const esCelular = useIsMobile();
    const [lista, setLista] = useState<Conversacion[]>([]);
    const [cargandoLista, setCargandoLista] = useState(true);
    const [abierta, setAbierta] = useState<Conversacion | null>(null);
    const [mensajes, setMensajes] = useState<Mensaje[]>([]);
    const [borradores, setBorradores] = useState<Borrador[]>([]);
    const [cargandoHilo, setCargandoHilo] = useState(false);
    const [texto, setTexto] = useState('');
    const [enviando, setEnviando] = useState(false);
    const [bandeja, setBandejaState] = useState<Bandeja>(leerBandeja);
    const [busqueda, setBusqueda] = useState('');
    const [verOcultas, setVerOcultas] = useState(false);
    const [verCerradas, setVerCerradas] = useState(() => leerBandeja() === 'prospectos');
    const [limite, setLimite] = useState(POR_PAGINA);
    const [limiteCerradas, setLimiteCerradas] = useState(POR_PAGINA);
    const [total, setTotal] = useState<number | null>(null);
    // Sin la migración de Fase A el BFF devuelve todo sin tipo: las bandejas por tipo mentirían.
    const [clasificacion, setClasificacion] = useState(true);
    /** Conversación cuyo tipo se está eligiendo (Familia / Personal / Negocio…), con la opción preseleccionada. */
    const [tipoDialogo, setTipoDialogo] = useState<{ c: Conversacion; tipo: OpcionDeTipo } | null>(null);
    const [accionando, setAccionando] = useState(false);
    // Sin la migración de «tomar» el BFF manda toma_disponible=false: el botón se deshabilita.
    const [tomaDisponible, setTomaDisponible] = useState(true);
    const [plantillaAbierta, setPlantillaAbierta] = useState(false);
    // Búsqueda en el servidor (todas las conversaciones), paginada.
    const [resultados, setResultados] = useState<Conversacion[]>([]);
    const [totalBusqueda, setTotalBusqueda] = useState(0);
    const [hayMas, setHayMas] = useState(false);
    const [buscando, setBuscando] = useState(false);
    /** El servidor no tiene la búsqueda (BFF viejo): se busca en lo cargado y se dice. */
    const [busquedaLocal, setBusquedaLocal] = useState(false);
    const finDelHilo = useRef<HTMLDivElement>(null);
    const raiz = useRef<HTMLDivElement>(null);
    const listaRef = useRef<HTMLDivElement>(null);

    // Escritorio: el panel ocupa lo que queda de la ventana (compositor a la vista).
    const alto = useAltoDisponible(raiz, !esCelular);
    // La burbuja de soporte tapaba «Enviar»: mientras el buzón está montado, no se ve.
    useOcultarFabSoporte(true);

    const setBandeja = (b: Bandeja) => {
        setBandejaState(b);
        guardarBandeja(b);
        setLimite(POR_PAGINA);
        setLimiteCerradas(POR_PAGINA);
        // En Prospectos el lead con ventana cerrada sigue importando: se ve de una.
        setVerCerradas(b === 'prospectos');
        listaRef.current?.scrollTo?.({ top: 0 });
    };

    // Se pide todo de una vez (el BFF entrega las 200 más recientes) y las
    // bandejas se arman acá: así cambiar de bandeja no es otro viaje.
    const cargarLista = useCallback(async () => {
        setCargandoLista(true);
        try {
            const r = await bffClient.get<{
                conversaciones: Conversacion[]; conteos?: { todas?: number } | null;
                clasificacion_disponible?: boolean; toma_disponible?: boolean;
            }>(`/api/v1/whatsapp/${schoolId}/conversaciones?vista=todas`);
            setLista(r.conversaciones ?? []);
            // Backend viejo (sin el campo) = no disponible: no hay endpoint que llamar.
            setTomaDisponible(r.toma_disponible === true);
            setTotal(typeof r.conteos?.todas === 'number' ? r.conteos.todas : null);
            setClasificacion(r.clasificacion_disponible !== false);
        } catch (e: any) {
            toast({ title: 'No se pudieron cargar las conversaciones', description: e?.message, variant: 'destructive' });
        } finally {
            setCargandoLista(false);
        }
    }, [schoolId, toast]);

    useEffect(() => { void cargarLista(); }, [cargarLista]);

    // Sin clasificación todo llega sin tipo: se atiende todo.
    const atendible = useCallback(
        (c: Conversacion) => !clasificacion || esFamilia(c) || esProspecto(c), [clasificacion]);

    const enBandeja = useCallback((c: Conversacion, b: Bandeja): boolean => {
        switch (b) {
            case 'responder':  return atendible(c) && sinResponder(c) && c.ventana_abierta;
            case 'aprobar':    return c.borradores_pendientes > 0;
            case 'prospectos': return esProspecto(c);
            case 'familias':   return esFamilia(c);
            case 'otros':      return !esFamilia(c) && !esProspecto(c);
            default:           return true;
        }
    }, [atendible]);

    const visiblesBase = useMemo(() => lista.filter((c) => verOcultas || !esRuido(c)), [lista, verOcultas]);
    const ocultas = useMemo(() => lista.filter(esRuido).length, [lista]);

    const conteos = useMemo(() => {
        const r = {} as Record<Bandeja, number>;
        for (const b of BANDEJAS) r[b.id] = visiblesBase.filter((c) => enBandeja(c, b.id)).length;
        return r;
    }, [visiblesBase, enBandeja]);
    /** Prospectos que escribieron y nadie les contestó (con o sin ventana). */
    const prospectosSinResponder = useMemo(
        () => visiblesBase.filter((c) => esProspecto(c) && sinResponder(c)).length, [visiblesBase]);

    // ── Búsqueda ──
    // Va al servidor y mira TODAS las conversaciones (incluidas las ocultas y
    // las que no entran en las 200 más recientes), sin importar la bandeja:
    // quien busca un nombre no sabe en qué bandeja quedó.
    const q = normalizar(busqueda.trim());
    const qDigitos = busqueda.replace(/\D/g, '');
    const qServidor = useDebounced(busqueda.trim(), 350);
    const buscandoAlgo = q.length > 0;

    const buscarEnServidor = useCallback(async (termino: string, offset: number) => {
        setBuscando(true);
        try {
            const r = await bffClient.get<RespuestaBusqueda>(
                `/api/v1/whatsapp/${schoolId}/buzon/buscar?q=${encodeURIComponent(termino)}&offset=${offset}&limite=${POR_PAGINA}`);
            setResultados((prev) => (offset === 0 ? r.conversaciones ?? [] : [...prev, ...(r.conversaciones ?? [])]));
            setTotalBusqueda(r.total ?? 0);
            setHayMas(Boolean(r.hay_mas));
            setBusquedaLocal(false);
        } catch (e: any) {
            // BFF sin la ruta (404): se cae a lo cargado y se dice. Otro error: se avisa.
            if (e?.status === 404) setBusquedaLocal(true);
            else toast({ title: 'No se pudo buscar', description: e?.message, variant: 'destructive' });
        } finally {
            setBuscando(false);
        }
    }, [schoolId, toast]);

    useEffect(() => {
        if (qServidor.length < 2) {
            // Funcional: no re-renderiza si ya estaba vacío.
            setResultados((r) => (r.length ? [] : r)); setTotalBusqueda(0); setHayMas(false);
            return;
        }
        void buscarEnServidor(qServidor, 0);
    }, [qServidor, buscarEnServidor]);

    const resultadosLocales = useMemo(() => (!q ? [] : lista.filter((c) =>
        normalizar(c.contact_name).includes(q)
        || (qDigitos.length >= 3 && c.contact_wa_id.includes(qDigitos))
        || normalizar(c.ultimo_mensaje?.text_body).includes(q)).sort(porUrgencia)), [q, qDigitos, lista]);

    const filtradas = useMemo(
        () => [...visiblesBase.filter((c) => enBandeja(c, bandeja))].sort(porUrgencia),
        [visiblesBase, enBandeja, bandeja]);

    // Ventana cerrada = solo se puede escribir con plantilla: grupo aparte.
    const abiertas = useMemo(() => filtradas.filter((c) => c.ventana_abierta), [filtradas]);
    const cerradas = useMemo(() => filtradas.filter((c) => !c.ventana_abierta), [filtradas]);

    // El detalle no trae `contact_kind` ni `pendiente`: los toma de la lista
    // cada vez que se recarga, para que el encabezado no quede viejo.
    useEffect(() => {
        setAbierta((a) => {
            if (!a) return a;
            const fresca = lista.find((c) => c.id === a.id);
            if (!fresca) return a;
            return { ...a, contact_kind: fresca.contact_kind, es_prospecto: fresca.es_prospecto,
                     pendiente: fresca.pendiente, requiere_respuesta: fresca.requiere_respuesta, status: fresca.status, toma: fresca.toma ?? null };
        });
    }, [lista]);

    // Al abrir o recibir mensajes, el hilo baja al último.
    useEffect(() => {
        if (!cargandoHilo) finDelHilo.current?.scrollIntoView?.({ block: 'end' });
    }, [mensajes, cargandoHilo]);

    const abrir = useCallback(async (c: Conversacion) => {
        setAbierta(c);
        setTexto('');
        setCargandoHilo(true);
        try {
            const r = await bffClient.get<{
                conversacion: Conversacion; mensajes: Mensaje[]; borradores: Borrador[]; toma_disponible?: boolean;
            }>(`/api/v1/whatsapp/${schoolId}/conversaciones/${c.id}`);
            if (typeof r.toma_disponible === 'boolean') setTomaDisponible(r.toma_disponible);
            setMensajes(r.mensajes ?? []);
            setBorradores(r.borradores ?? []);
            // El servidor recalcula la ventana: la de la lista pudo quedar
            // vieja si la pestaña lleva rato abierta.
            setAbierta({ ...c, ...r.conversacion });
        } catch (e: any) {
            toast({ title: 'No se pudo abrir la conversación', description: e?.message, variant: 'destructive' });
        } finally {
            setCargandoHilo(false);
        }
    }, [schoolId, toast]);

    // Llegada desde el correo de escalamiento (o «Ver chat» de la Bandeja):
    // abrir esa conversación una vez por id pedido. Si no está en la bandeja
    // actual, se abre igual por id: el detalle lo trae el servidor.
    const [inicialAbierta, setInicialAbierta] = useState<string | null>(null);
    useEffect(() => {
        if (!conversacionInicial || inicialAbierta === conversacionInicial || cargandoLista) return;
        setInicialAbierta(conversacionInicial);
        const c = lista.find((x) => x.id === conversacionInicial) ?? ({ id: conversacionInicial } as Conversacion);
        void abrir(c);
    }, [conversacionInicial, inicialAbierta, cargandoLista, lista, abrir]);

    const responder = async () => {
        if (!abierta || !texto.trim()) return;
        setEnviando(true);
        try {
            await bffClient.post(`/api/v1/whatsapp/${schoolId}/conversaciones/${abierta.id}/responder`, { texto });
            setTexto('');
            await abrir(abierta);
            await cargarLista();
        } catch (e: any) {
            toast({ title: 'No se pudo enviar', description: e?.message, variant: 'destructive' });
        } finally {
            setEnviando(false);
        }
    };

    const resolverBorrador = async (id: string, accion: 'aprobar' | 'descartar', textoEditado?: string) => {
        if (!abierta) return;
        setEnviando(true);
        try {
            await bffClient.post(`/api/v1/whatsapp/${schoolId}/borradores/${id}/${accion}`,
                accion === 'aprobar' && textoEditado ? { texto: textoEditado } : {});
            await abrir(abierta);
            await cargarLista();
        } catch (e: any) {
            toast({ title: 'No se pudo resolver el borrador', description: e?.message, variant: 'destructive' });
        } finally {
            setEnviando(false);
        }
    };

    // Marcado como no-familia y sin «también es familia»: el canal de la escuela no le escribe.
    const esPersonal = esSoloNoFamilia(abierta?.contact_kind, abierta?.tambien_familia);

    /** Cambia una conversación en la lista y, si es la abierta, también en el hilo. */
    const parchar = (id: string, cambio: Partial<Conversacion>) => {
        setLista((l) => l.map((c) => (c.id === id ? { ...c, ...cambio } : c)));
        setResultados((l) => l.map((c) => (c.id === id ? { ...c, ...cambio } : c)));
        setAbierta((a) => (a && a.id === id ? { ...a, ...cambio } : a));
    };

    /** Lo que el contacto tiene hoy, como opción del selector. */
    const tipoActual = (c: Conversacion): OpcionDeTipo => (esMarcaNoFamilia(c.contact_kind) ? c.contact_kind : 'familia');

    /** Después de marcar (desde el diálogo o el menú): la lista y el hilo, y la recarga. */
    const tipoCambiado = async (c: Conversacion, tipo: OpcionDeTipo, tambienFamilia: boolean) => {
        // El tipo real al quitar la marca lo recalcula el servidor; llega con la
        // recarga de la lista (ver el efecto que sincroniza `abierta`).
        parchar(c.id, {
            contact_kind: tipo === 'familia' ? null : tipo,
            tambien_familia: tipo === 'familia' ? false : tambienFamilia,
            es_prospecto: tipo === 'familia' ? c.es_prospecto : false,
        });
        await cargarLista();
    };

    /**
     * Cambios directos desde el menú, sin diálogo: volver a «Familia» (quitar la
     * marca) y prender/apagar «También es familia» de un contacto ya marcado.
     * Marcar como personal/negocio/… pasa siempre por el diálogo.
     */
    const cambiarTipo = async (c: Conversacion, tipo: OpcionDeTipo, tambienFamilia: boolean) => {
        setAccionando(true);
        try {
            const { ruta, cuerpo } = pedidoDeTipo(schoolId, c.id, tipo, tambienFamilia);
            const r = await bffClient.patch<RespuestaDeTipo>(ruta, cuerpo);
            toast(textoDelResultado(tipo, r?.filas_cerradas ?? 0));
            await tipoCambiado(c, tipo, cuerpo.tambien_familia);
        } catch (e: any) {
            toast({ title: 'No se pudo cambiar', description: e?.message, variant: 'destructive' });
        } finally {
            setAccionando(false);
        }
    };

    /** «Tipo de contacto ▸ Familia / Personal / Negocio / Otro club / Plataforma» + «También es familia». */
    const submenuTipo = (c: Conversacion) => {
        const actual = tipoActual(c);
        return (
            <DropdownMenuSub>
                <DropdownMenuSubTrigger disabled={accionando} className="min-h-touch md:min-h-0">
                    <Tags className="h-4 w-4 mr-2" /> Tipo de contacto
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-56">
                    {OPCIONES_DE_TIPO.map((o) => (
                        <DropdownMenuCheckboxItem key={o.valor} checked={actual === o.valor} disabled={accionando}
                                                  className="min-h-touch md:min-h-0"
                                                  onSelect={() => {
                                                      if (o.valor === actual) return;
                                                      if (o.valor === 'familia') void cambiarTipo(c, 'familia', false);
                                                      else setTipoDialogo({ c, tipo: o.valor });
                                                  }}>
                            {o.texto}
                        </DropdownMenuCheckboxItem>
                    ))}
                    <DropdownMenuSeparator />
                    <DropdownMenuCheckboxItem checked={c.tambien_familia === true}
                                              disabled={accionando || actual === 'familia'}
                                              className="min-h-touch md:min-h-0"
                                              onSelect={() => { if (actual !== 'familia') void cambiarTipo(c, actual, !c.tambien_familia); }}>
                        También es familia
                    </DropdownMenuCheckboxItem>
                </DropdownMenuSubContent>
            </DropdownMenuSub>
        );
    };

    /** Mejora 9: tomar (el asistente calla) o soltar (vuelve a atender). */
    const cambiarToma = async (c: Conversacion, tomar: boolean) => {
        setAccionando(true);
        try {
            const r = await bffClient.post<{ tomada_por?: string; tomada_hasta?: string }>(
                `/api/v1/whatsapp/${schoolId}/conversaciones/${c.id}/${tomar ? 'tomar' : 'soltar'}`, {});
            toast({
                title: tomar ? 'Tomaste la conversación' : 'Soltaste la conversación',
                description: tomar
                    ? 'Mapi no le va a escribir nada automático hasta que la sueltes o pasen 12 horas.'
                    : 'Mapi vuelve a atenderla.',
            });
            parchar(c.id, {
                toma: tomar && r?.tomada_hasta
                    ? { tomada_por: r.tomada_por ?? '', tomada_por_nombre: 'ti', tomada_hasta: r.tomada_hasta }
                    : null,
            });
            await cargarLista();
        } catch (e: any) {
            toast({ title: tomar ? 'No se pudo tomar' : 'No se pudo soltar', description: e?.message, variant: 'destructive' });
        } finally {
            setAccionando(false);
        }
    };

    const cerrar = async () => {
        if (!abierta) return;
        setAccionando(true);
        try {
            await bffClient.post(`/api/v1/whatsapp/${schoolId}/conversaciones/${abierta.id}/cerrar`, {});
            toast({ title: 'Conversación cerrada', description: 'Si la persona vuelve a escribir, se abre de nuevo.' });
            parchar(abierta.id, { status: 'closed', pendiente: false, requiere_respuesta: false });
            await cargarLista();
        } catch (e: any) {
            toast({ title: 'No se pudo cerrar', description: e?.message, variant: 'destructive' });
        } finally {
            setAccionando(false);
        }
    };

    const vacio: Record<Bandeja, string> = {
        responder: 'Nadie te espera: estás al día.',
        aprobar: 'No hay respuestas de Mapi esperando tu aprobación.',
        prospectos: 'No hay interesados pidiendo información.',
        familias: 'No hay conversaciones con familias.',
        otros: 'No hay conversaciones personales ni de otros números.',
        todas: 'Todavía no hay conversaciones.',
    };

    const bandejasVisibles = BANDEJAS.filter((b) => clasificacion || !b.soloClasificado);

    const fila = (c: Conversacion) => {
        const atenuada = !atendible(c) || !c.ventana_abierta;
        return (
            <div
                key={c.id}
                role="button"
                tabIndex={0}
                onClick={() => void abrir(c)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void abrir(c); } }}
                className={`group relative w-full text-left rounded-lg border p-3 pr-12 transition-colors cursor-pointer
                            hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
                            ${abierta?.id === c.id ? 'bg-muted border-primary/40' : ''}
                            ${atenuada && abierta?.id !== c.id ? 'opacity-75' : ''}`}
            >
                <div className="flex items-start justify-between gap-2 min-w-0">
                    <span className={`text-sm truncate ${sinResponder(c) ? 'font-semibold' : 'font-medium'}`}>
                        {c.contact_name || numeroVisible(c.contact_wa_id)}
                    </span>
                    <span className="text-xs text-muted-foreground shrink-0">{cuando(c.last_message_at)}</span>
                </div>
                <p className="text-xs text-muted-foreground truncate mt-0.5">{resumenUltimo(c)}</p>
                <TextoCoincidencia c={c} />
                <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                    {sinResponder(c) && (
                        <Badge variant="destructive" className="text-xs">Sin responder</Badge>
                    )}
                    {c.borradores_pendientes > 0 && (
                        <Badge variant="secondary" className="text-xs">
                            <Sparkles className="h-2.5 w-2.5 mr-1" />
                            {c.borradores_pendientes} por aprobar
                        </Badge>
                    )}
                    <EtiquetaTipo c={c} />
                    {c.toma && (
                        <Badge variant="outline" className="text-xs border-blue-300 text-blue-700 dark:text-blue-400"
                               title={textoDeToma(c.toma)}>
                            <Hand className="h-2.5 w-2.5 mr-1" />
                            Atendida por {c.toma.tomada_por_nombre || 'la escuela'}
                        </Badge>
                    )}
                    {/* Con contact_kind ya se sabe quién es; "Sin identificar" sobra. */}
                    {!c.identified && !c.contact_kind && !c.es_prospecto && (
                        <Badge variant="outline" className="text-xs">Sin identificar</Badge>
                    )}
                    {/* Un prospecto sin respuesta es un lead que se enfría: su ventana se ve siempre. */}
                    <ChipVentana c={c} destacar={esProspecto(c) && sinResponder(c)} />
                    {c.prospecto?.interes && (
                        <span className="text-xs text-muted-foreground truncate max-w-[10rem]" title={c.prospecto.interes}>
                            {c.prospecto.interes}
                        </span>
                    )}
                </div>

                {/* Acciones rápidas: siempre visibles en el celular, al pasar el mouse en escritorio. */}
                <div className="absolute right-1 top-1" onClick={(e) => e.stopPropagation()}
                     onKeyDown={(e) => e.stopPropagation()}>
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" aria-label="Acciones de la conversación"
                                    className="w-touch h-touch md:h-8 md:w-8 md:opacity-0 md:group-hover:opacity-100 focus-visible:opacity-100
                                               data-[state=open]:opacity-100">
                                <MoreVertical className="h-4 w-4" />
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-56">
                            <DropdownMenuItem onSelect={() => void abrir(c)}>
                                <MessageCircle className="h-4 w-4 mr-2" /> Abrir
                            </DropdownMenuItem>
                            {tomaDisponible && (
                                c.toma ? (
                                    <DropdownMenuItem disabled={accionando} onSelect={() => void cambiarToma(c, false)}>
                                        <Unlock className="h-4 w-4 mr-2" /> Devolver a Mapi
                                    </DropdownMenuItem>
                                ) : (
                                    <DropdownMenuItem disabled={accionando} onSelect={() => void cambiarToma(c, true)}>
                                        <Hand className="h-4 w-4 mr-2" /> Atender yo (Mapi en pausa)
                                    </DropdownMenuItem>
                                )
                            )}
                            {clasificacion && (<>
                                <DropdownMenuSeparator />
                                {submenuTipo(c)}
                            </>)}
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
            </div>
        );
    };

    const cargarMas = (restan: number, onClick: () => void) => restan > 0 && (
        <Button variant="ghost" size="sm" className="w-full text-xs min-h-touch md:min-h-0" onClick={onClick}>
            Cargar más ({restan} restantes)
        </Button>
    );

    // ── La lista ──
    const panelLista = (
        <div className={`min-w-0 flex-col md:flex md:min-h-0 ${abierta && esCelular ? 'hidden' : 'flex'}`}>
            <div className="space-y-2 pb-2">
                <div className="flex gap-2">
                    <div className="relative flex-1 min-w-0">
                        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
                        <Input
                            value={busqueda}
                            onChange={(e) => setBusqueda(e.target.value)}
                            placeholder="Buscar nombre, teléfono, deportista o mensaje"
                            className="pl-8 pr-8 h-touch md:h-9 text-input md:text-sm"
                            aria-label="Buscar conversaciones"
                        />
                        {busqueda && (
                            <button type="button" onClick={() => setBusqueda('')} aria-label="Limpiar búsqueda"
                                    className="absolute right-0 top-1/2 -translate-y-1/2 w-touch h-touch md:w-8 md:h-8 flex items-center justify-center text-muted-foreground hover:text-foreground">
                                <X className="h-4 w-4" />
                            </button>
                        )}
                    </div>
                    <Button variant="outline" size="icon" className="w-touch h-touch md:h-9 md:w-9 shrink-0" aria-label="Actualizar"
                            disabled={cargandoLista} onClick={() => void cargarLista()}>
                        <RefreshCw className={`h-4 w-4 ${cargandoLista ? 'animate-spin' : ''}`} />
                    </Button>
                </div>

                {!buscandoAlgo && (
                    // Una sola fila que se desliza: en el celular eran 3 filas de chips
                    // y la primera conversación aparecía a mitad de pantalla.
                    <div className="flex gap-1.5 overflow-x-auto scrollbar-none scroll-fade-x whitespace-nowrap -mx-1 px-1"
                         role="tablist" aria-label="Bandejas">
                        {bandejasVisibles.map((b) => {
                            const activa = bandeja === b.id;
                            const n = conteos[b.id];
                            return (
                                <button
                                    key={b.id}
                                    type="button"
                                    role="tab"
                                    aria-selected={activa}
                                    onClick={() => { setBandeja(b.id); }}
                                    className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 min-h-touch md:min-h-0 md:py-1 text-xs transition-colors
                                                ${activa
                                                    ? 'bg-primary text-primary-foreground border-primary'
                                                    : 'bg-background hover:bg-muted text-foreground'}
                                                ${b.id === 'otros' && !activa ? 'text-muted-foreground' : ''}`}
                                >
                                    {b.texto}
                                    {!cargandoLista && b.id === 'prospectos' && prospectosSinResponder > 0 && (
                                        <span className={`tabular-nums rounded-full px-1.5 text-xs leading-4 font-semibold
                                            ${activa ? 'bg-primary-foreground text-primary' : 'bg-destructive text-destructive-foreground'}`}
                                              title={`${prospectosSinResponder} sin responder`}
                                              aria-label={`${prospectosSinResponder} sin responder`}>
                                            {prospectosSinResponder} sin resp.
                                        </span>
                                    )}
                                    {!cargandoLista && (
                                        <span className={`tabular-nums rounded-full px-1.5 text-xs leading-4
                                            ${activa ? 'bg-primary-foreground/20'
                                                : b.urgente && n > 0 ? 'bg-destructive text-destructive-foreground'
                                                : 'bg-muted text-muted-foreground'}`}>
                                            {n}
                                        </span>
                                    )}
                                </button>
                            );
                        })}
                    </div>
                )}

                {buscandoAlgo ? (
                    <p className="text-xs text-muted-foreground px-1" role="status" data-testid="resumen-busqueda">
                        {busquedaLocal
                            ? `${resultadosLocales.length} resultado${resultadosLocales.length === 1 ? '' : 's'} entre las ${lista.length} conversaciones más recientes (el servidor no tiene la búsqueda completa).`
                            : busqueda.trim().length < 2 ? 'Escribe al menos 2 letras o 3 números.'
                            : buscando && !resultados.length ? 'Buscando en todas las conversaciones…'
                            : `${totalBusqueda} resultado${totalBusqueda === 1 ? '' : 's'} en todas las conversaciones.`}
                    </p>
                ) : bandeja === 'responder' ? (
                    <p className="hidden md:block text-xs text-muted-foreground px-1">
                        Familias e interesados que escribieron y nadie les ha respondido. Primero a
                        quien se le acaba antes el tiempo para responder.
                    </p>
                ) : bandeja === 'prospectos' ? (
                    <p className="hidden md:block text-xs text-muted-foreground px-1">
                        Personas que pidieron precio, horario, inscripción o clase de cortesía. Respóndeles
                        a tiempo: pasado un día solo se les puede escribir con un mensaje aprobado.
                        Si alguno es un contacto tuyo, márcalo como personal desde los tres puntos.
                    </p>
                ) : bandeja === 'otros' ? (
                    <p className="hidden md:block text-xs text-muted-foreground px-1">
                        Personas del equipo, lo que marcaste como personal y números sin clasificar. El
                        Mapi no les responde.
                    </p>
                ) : null}
            </div>

            <div ref={listaRef} className="space-y-2 md:flex-1 md:min-h-0 md:overflow-y-auto md:pr-1">
                {buscandoAlgo ? (
                    <>
                        {(busquedaLocal ? resultadosLocales : resultados).map(fila)}
                        {!busquedaLocal && hayMas && (
                            <Button variant="ghost" size="sm" className="w-full text-xs min-h-touch md:min-h-0" disabled={buscando}
                                    onClick={() => void buscarEnServidor(qServidor, resultados.length)}>
                                {buscando && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
                                Cargar más ({totalBusqueda - resultados.length} restantes)
                            </Button>
                        )}
                        {!buscando && busqueda.trim().length >= 2 && !(busquedaLocal ? resultadosLocales : resultados).length && (
                            <div className="text-center py-12 text-sm text-muted-foreground">
                                <MessageSquare className="h-8 w-8 mx-auto mb-3 opacity-40" />
                                Nada coincide con la búsqueda.
                            </div>
                        )}
                    </>
                ) : (
                    <>
                        {cargandoLista && !lista.length && (
                            <div className="flex items-center gap-2 text-sm text-muted-foreground py-10 justify-center">
                                <Loader2 className="h-4 w-4 animate-spin" /> Cargando conversaciones…
                            </div>
                        )}
                        {!(cargandoLista && !lista.length) && !filtradas.length && (
                            <div className="text-center py-12 text-sm text-muted-foreground">
                                {bandeja === 'responder'
                                    ? <CheckCircle2 className="h-8 w-8 mx-auto mb-3 text-green-600 opacity-70" />
                                    : <MessageSquare className="h-8 w-8 mx-auto mb-3 opacity-40" />}
                                {vacio[bandeja]}
                                {bandeja !== 'todas' && (
                                    <div>
                                        <Button variant="link" size="sm" onClick={() => setBandeja('todas')}>
                                            Ver todas las conversaciones
                                        </Button>
                                    </div>
                                )}
                            </div>
                        )}

                        {abiertas.slice(0, limite).map(fila)}
                        {cargarMas(abiertas.length - limite, () => setLimite((n) => n + POR_PAGINA))}

                        {cerradas.length > 0 && (
                            <div className="pt-2">
                                <button
                                    type="button"
                                    onClick={() => setVerCerradas((v) => !v)}
                                    aria-expanded={verCerradas}
                                    className="flex w-full items-center gap-1.5 px-1 min-h-touch md:min-h-0 md:py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
                                >
                                    {verCerradas ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                                    Pasó más de un día · solo mensaje aprobado ({cerradas.length})
                                </button>
                                {verCerradas && (
                                    <div className="space-y-2 mt-1">
                                        {cerradas.slice(0, limiteCerradas).map(fila)}
                                        {cargarMas(cerradas.length - limiteCerradas, () => setLimiteCerradas((n) => n + POR_PAGINA))}
                                    </div>
                                )}
                            </div>
                        )}

                        {!cargandoLista && (ocultas > 0 || (total !== null && total > lista.length)) && (
                            <div className="pt-2 pb-1 px-1 text-xs text-muted-foreground space-y-1">
                                {ocultas > 0 && (
                                    <button type="button" className="underline-offset-2 hover:underline min-h-touch md:min-h-0 text-left"
                                            onClick={() => setVerOcultas((v) => !v)}>
                                        {verOcultas
                                            ? 'Ocultar las conversaciones sin mensajes de la persona'
                                            : `Mostrar ${ocultas} conversación${ocultas === 1 ? '' : 'es'} sin mensajes de la persona`}
                                    </button>
                                )}
                                {total !== null && total > lista.length && (
                                    <p data-testid="nota-recientes">
                                        Las bandejas cuentan las {lista.length} conversaciones más recientes de {total}.
                                        La búsqueda revisa todas.
                                    </p>
                                )}
                            </div>
                        )}
                    </>
                )}
            </div>
        </div>
    );

    // ── El hilo ──
    const menuHilo = abierta && (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="w-touch h-touch shrink-0" aria-label="Más acciones">
                    <MoreVertical className="h-5 w-5" />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
                {abierta.toma ? (
                    <DropdownMenuItem disabled={accionando || !tomaDisponible} onSelect={() => void cambiarToma(abierta, false)}>
                        <Unlock className="h-4 w-4 mr-2" /> Devolver a Mapi
                    </DropdownMenuItem>
                ) : (
                    <DropdownMenuItem disabled={accionando || !tomaDisponible} onSelect={() => void cambiarToma(abierta, true)}>
                        <Hand className="h-4 w-4 mr-2" /> Atender yo (Mapi en pausa)
                    </DropdownMenuItem>
                )}
                {submenuTipo(abierta)}
                <DropdownMenuSeparator />
                <DropdownMenuItem disabled={accionando || abierta.status === 'closed'} onSelect={() => void cerrar()}>
                    <CheckCircle2 className="h-4 w-4 mr-2" />
                    {abierta.status === 'closed' ? 'Cerrada' : 'Dar por atendida'}
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );

    const panelHilo = abierta ? (
        <div data-testid="hilo"
             className={esCelular
                 // Celular: pantalla completa por encima del encabezado y la barra de abajo.
                 ? 'fixed inset-0 z-50 flex flex-col bg-background pt-safe-t'
                 : 'border rounded-lg flex flex-col md:min-h-0 min-w-0 overflow-hidden'}>
            <div className="border-b px-gutter py-2 md:p-3 space-y-2 shrink-0">
                <div className="flex items-center gap-1 md:gap-2">
                    {esCelular && (
                        <Button variant="ghost" size="icon" className="w-touch h-touch -ml-2 shrink-0" onClick={() => setAbierta(null)}
                                aria-label="Volver a la lista">
                            <ChevronLeft className="h-5 w-5" />
                        </Button>
                    )}
                    <div className="min-w-0 flex-1">
                        <p className="font-medium text-sm truncate">
                            {abierta.contact_name || numeroVisible(abierta.contact_wa_id)}
                        </p>
                        <p className="text-xs text-muted-foreground flex items-center gap-2 flex-wrap">
                            <span>{numeroVisible(abierta.contact_wa_id)}</span>
                            {abierta.ventana_vence !== undefined && <ChipVentana c={abierta} />}
                        </p>
                    </div>
                    <EtiquetaTipo c={abierta} />
                    {/* Escritorio: las tres acciones a la vista, en una sola línea. */}
                    {!esCelular && (
                        <div className="flex shrink-0 items-center gap-1.5">
                            {abierta.toma ? (
                                <Button variant="outline" size="sm" disabled={accionando || !tomaDisponible}
                                        onClick={() => void cambiarToma(abierta, false)}>
                                    <Unlock className="h-3.5 w-3.5 mr-1" /> Devolver a Mapi
                                </Button>
                            ) : (
                                <Button variant="outline" size="sm" disabled={accionando || !tomaDisponible}
                                        title={tomaDisponible ? 'Mapi deja de responder en esta conversación'
                                            : 'Todavía no disponible'}
                                        onClick={() => void cambiarToma(abierta, true)}>
                                    <Hand className="h-3.5 w-3.5 mr-1" /> Atender yo
                                </Button>
                            )}
                            <Button variant="outline" size="sm" disabled={accionando}
                                    onClick={() => setTipoDialogo({ c: abierta, tipo: tipoActual(abierta) })}>
                                <Tags className="h-3.5 w-3.5 mr-1" /> Tipo de contacto
                            </Button>
                            <Button variant="outline" size="sm" disabled={accionando || abierta.status === 'closed'}
                                    onClick={() => void cerrar()}>
                                {accionando
                                    ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                                    : <CheckCircle2 className="h-3.5 w-3.5 mr-1" />}
                                {abierta.status === 'closed' ? 'Cerrada' : 'Dar por atendida'}
                            </Button>
                        </div>
                    )}
                    {esCelular && menuHilo}
                </div>
                {esPersonal && (
                    <p className="text-xs text-muted-foreground">
                        Contacto marcado como {ETIQUETA_TIPO[abierta.contact_kind as TipoDeContacto]?.texto.toLowerCase() ?? 'personal'}:
                        Mapi no le responde. Contéstala desde tu celular.
                    </p>
                )}
                {esMarcaNoFamilia(abierta.contact_kind) && abierta.tambien_familia && (
                    <p className="text-xs text-muted-foreground">
                        También es familia: sus comprobantes de pago se aplican sin escribirle; Mapi no le contesta.
                    </p>
                )}
                {abierta.toma && (
                    <p className="text-xs text-blue-700 dark:text-blue-400 flex items-center gap-1">
                        <Hand className="h-3 w-3 shrink-0" />
                        {textoDeToma(abierta.toma)}. Mapi no le escribe nada automático
                        (los comprobantes se aplican igual, sin avisarle).
                    </p>
                )}
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto px-gutter py-3 md:p-3 space-y-3" data-testid="mensajes">
                {cargandoHilo && (
                    <p className="text-sm text-muted-foreground text-center py-6">
                        <Loader2 className="h-4 w-4 animate-spin inline mr-2" />Cargando…
                    </p>
                )}
                {!cargandoHilo && !mensajes.length && (
                    <p className="text-sm text-muted-foreground text-center py-6">Sin mensajes todavía.</p>
                )}
                {mensajes.map((m) => {
                    const qn = quien(m, abierta.contact_kind);
                    const mio = m.direction === 'outbound';
                    const medio = m.media ?? null;
                    return (
                        <div key={m.id} className={`flex ${mio ? 'justify-end' : 'justify-start'}`}>
                            <div className={`max-w-[85%] rounded-lg px-3 py-2 space-y-1.5 ${mio ? 'bg-primary/10' : 'bg-muted'}`}>
                                <div className="flex items-center gap-1 text-xs text-muted-foreground">
                                    {qn.icono} {qn.texto} · {hora(m.created_at)}
                                    {m.type === 'template' && <span>· plantilla</span>}
                                </div>
                                {medio && (
                                    <AdjuntoDelMensaje schoolId={schoolId} conversacionId={abierta.id} mensajeId={m.id} medio={medio} />
                                )}
                                {m.text_body ? (
                                    <p className="text-sm whitespace-pre-wrap break-words">
                                        {medio?.tipo === 'audio' && (
                                            <span className="block text-xs text-muted-foreground">Transcripción:</span>
                                        )}
                                        {m.text_body}
                                    </p>
                                ) : !medio && (
                                    <p className="text-sm italic opacity-70">{tipoLegible(m.type)}</p>
                                )}
                                {m.error_detail && (
                                    <p className="text-xs text-destructive">{m.error_detail}</p>
                                )}
                            </div>
                        </div>
                    );
                })}
                <div ref={finDelHilo} />
            </div>

            {/* Borradores del modo asistido: con scroll propio para que no empujen el compositor fuera. */}
            {borradores.length > 0 && (
                <div className="shrink-0 max-h-[40%] overflow-y-auto border-t">
                    {borradores.map((b) => (
                        <div key={b.id} className="bg-muted/30 px-gutter py-3 md:p-3 space-y-2 border-b last:border-b-0">
                            <p className="text-xs font-medium text-foreground flex items-center gap-1">
                                <Sparkles className="h-3 w-3" /> Mapi propone responder
                                {b.llm_provider && <span className="text-muted-foreground">· {b.llm_provider}</span>}
                            </p>
                            <Textarea
                                defaultValue={b.edited_text ?? b.proposed_text}
                                rows={3}
                                id={`draft-${b.id}`}
                                className="text-input md:text-sm"
                            />
                            <div className="flex gap-2 flex-wrap">
                                <Button size="sm" disabled={enviando} onClick={() => {
                                    const el = document.getElementById(`draft-${b.id}`) as HTMLTextAreaElement | null;
                                    const v = el?.value?.trim();
                                    void resolverBorrador(b.id, 'aprobar', v !== b.proposed_text ? v : undefined);
                                }}>
                                    <Send className="h-3.5 w-3.5 mr-1" /> Aprobar y enviar
                                </Button>
                                <Button size="sm" variant="outline" disabled={enviando}
                                        onClick={() => void resolverBorrador(b.id, 'descartar')}>
                                    <X className="h-3.5 w-3.5 mr-1" /> Descartar
                                </Button>
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {/* Compositor: siempre abajo y a la vista (en el celular, sobre el safe area). */}
            <div className={`border-t px-gutter pt-2 md:p-3 shrink-0 bg-background ${esCelular ? 'pb-[max(0.5rem,env(safe-area-inset-bottom))]' : ''}`}
                 data-testid="compositor">
                {abierta.ventana_abierta ? (
                    <div className="flex items-end gap-2">
                        <Button type="button" variant="ghost" size="icon" className="w-touch h-touch md:h-10 md:w-10 shrink-0"
                                aria-label="Enviar mensaje aprobado" title="Enviar un mensaje aprobado por WhatsApp"
                                onClick={() => setPlantillaAbierta(true)}>
                            <FileText className="h-4 w-4" />
                        </Button>
                        <Textarea
                            value={texto}
                            onChange={(e) => setTexto(e.target.value)}
                            placeholder="Escribe tu respuesta…"
                            rows={2}
                            className="text-input md:text-sm min-h-touch"
                        />
                        <Button onClick={() => void responder()} disabled={enviando || !texto.trim()}
                                className="w-touch h-touch md:h-10 md:w-10 shrink-0 p-0" aria-label="Enviar">
                            {enviando ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                        </Button>
                    </div>
                ) : (
                    <div className="rounded-lg bg-amber-500/10 border border-amber-500/30 p-3 text-sm space-y-2">
                        <p className="font-medium text-amber-700 dark:text-amber-400 flex items-center gap-1.5">
                            <Clock className="h-4 w-4 shrink-0" /> Pasó más de un día sin que escriba
                        </p>
                        <p className="text-muted-foreground">
                            WhatsApp solo deja escribirle con un mensaje aprobado hasta que vuelva a escribir.
                            Cuando escriba, puedes responderle normal otra vez.
                        </p>
                        <Button size="sm" className="min-h-touch md:min-h-0" onClick={() => setPlantillaAbierta(true)}
                                disabled={esPersonal}
                                title={esPersonal ? 'Es una conversación personal: el canal de la escuela no le escribe' : undefined}>
                            <FileText className="h-4 w-4 mr-1.5" /> Enviar mensaje aprobado
                        </Button>
                        {esPersonal && (
                            <p className="text-xs text-muted-foreground">Es personal: el canal de la escuela no le escribe.</p>
                        )}
                    </div>
                )}
            </div>

            <EnviarPlantilla
                schoolId={schoolId}
                conversacionId={abierta.id}
                contacto={abierta.contact_name}
                abierto={plantillaAbierta}
                onAbiertoChange={setPlantillaAbierta}
                onEnviada={() => { void abrir(abierta); void cargarLista(); }}
            />
        </div>
    ) : (
        <div className="hidden md:flex flex-col items-center justify-center gap-2 border rounded-lg text-sm text-muted-foreground">
            <MessageSquare className="h-8 w-8 opacity-40" />
            {conteos.responder > 0
                ? `Tienes ${conteos.responder} conversación${conteos.responder === 1 ? '' : 'es'} por responder. Elige una de la lista.`
                : 'Elige una conversación'}
        </div>
    );

    return (
        <div ref={raiz}
             // Escritorio: el alto lo mide useAltoDisponible (encabezado, avisos y pestañas descontados).
             style={!esCelular && alto ? { height: alto } : undefined}
             className="md:grid md:grid-cols-[minmax(18.75rem,23.75rem)_1fr] gap-4 md:min-h-0">
            {panelLista}
            {panelHilo}

            <TipoDeContactoDialog
                schoolId={schoolId}
                conversacionId={tipoDialogo?.c.id ?? null}
                nombre={tipoDialogo ? (tipoDialogo.c.contact_name || numeroVisible(tipoDialogo.c.contact_wa_id)) : null}
                tipoInicial={tipoDialogo?.tipo ?? 'familia'}
                tambienFamiliaInicial={tipoDialogo?.c.tambien_familia === true}
                abierto={!!tipoDialogo}
                onAbiertoChange={(v) => { if (!v) setTipoDialogo(null); }}
                onHecho={(r) => { if (tipoDialogo) void tipoCambiado(tipoDialogo.c, r.tipo, r.tambienFamilia); }}
            />
        </div>
    );
}
