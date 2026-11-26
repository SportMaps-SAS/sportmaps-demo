/**
 * Tipos del modo agente de Mapi (docs/specs/mapi-agente-plan.md, aprobado 2026-11-23).
 *
 * Dos clases de herramienta:
 *   · consulta → se ejecuta de una y el resultado vuelve al modelo.
 *   · acción   → NO ejecuta: `preparar()` arma la vista previa (sin efectos),
 *                se guarda un borrador y el turno termina con la tarjeta. El
 *                botón Confirmar llama `ejecutar()` sin pasar por el modelo.
 */

export type RolAgente = 'admin' | 'coach';

/**
 * Con qué alcance habla la persona en ESTE turno. Lo arma el servidor una vez
 * por turno desde la sesión (req.schoolId validado contra school_members) y
 * toda herramienta lo recibe de aquí: ningún esquema tiene parámetro de
 * escuela, y nada de lo que diga el modelo lo cambia (plan §7, paso 0).
 */
export interface Alcance {
    schoolId: string;
    userId: string;
    rol: RolAgente;
    /** Equipos que entrena (solo coach). Vacío para el admin, que ve toda la escuela. */
    teamIds: string[];
    ajustes: {
        coachMapiAttendance: boolean;
        coachMapiNotices: boolean;
        coachHideFinancialInfo: boolean;
    };
    /** Fecha de hoy en America/Bogota (YYYY-MM-DD). */
    hoy: string;
    /**
     * Header Authorization de ESTA request (turno del chat o Confirmar). Solo
     * para las RPC que autorizan con auth.uid() (pausa, baja, evaluar, kudos,
     * clases de prueba…): se llaman como la persona, igual que la pantalla.
     * NO enumerable (alcanceDelTurno): no sale en JSON.stringify ni en logs,
     * nunca va al modelo ni al borrador. Sin él, esas herramientas no se ofrecen.
     */
    authorization?: string | null;
    /**
     * Por dónde llega el turno. 'whatsapp' lo pone solo el adaptador del canal;
     * la auditoría de plata (pago_operaciones.canal) lo distingue de la app.
     */
    canal?: 'app' | 'whatsapp';
}

/** Rechazo que se le explica a la persona (y al modelo) tal cual. */
export class RechazoHerramienta extends Error {
    constructor(mensaje: string) {
        super(mensaje);
        this.name = 'RechazoHerramienta';
    }
}

/** Esquema JSON de la entrada (se manda con `strict: true`). */
export interface EsquemaEntrada {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
    additionalProperties: false;
}

interface HerramientaBase<A> {
    nombre: string;
    descripcion: string;
    esquema: EsquemaEntrada;
    roles: RolAgente[];
    /** Además del rol: flags de la escuela (p. ej. coach_mapi_attendance). */
    habilitada?: (a: Alcance) => boolean;
    /**
     * Valida y normaliza lo que mandó el modelo. Lanza RechazoHerramienta si no
     * sirve. El esquema strict de la API ayuda, pero el servidor no le cree.
     */
    validar: (args: unknown) => A;
}

export interface HerramientaConsulta<A = any> extends HerramientaBase<A> {
    tipo: 'consulta';
    ejecutar: (a: Alcance, args: A) => Promise<unknown>;
}

/** Lo que ve la persona en la tarjeta. Lo escribe el servidor, nunca el modelo (§10.3). */
export interface VistaPrevia {
    titulo: string;
    lineas: string[];
    /** Advertencia en una línea (p. ej. «Esto no se puede deshacer»). */
    aviso?: string | null;
    /** Lista desplegable («Ver lista»). */
    detalle?: { etiqueta: string; items: string[] } | null;
    botonConfirmar: string;
}

export type Preparado<A> =
    | {
          ok: true;
          /** Argumentos normalizados que se guardan en el borrador y se usan al ejecutar. */
          args: A;
          vista: VistaPrevia;
          /** «Mismo objeto» de §10.4: un borrador nuevo sobre él reemplaza al anterior. */
          targetKey: string | null;
          /** Para el hash de §10.1: lo que, si cambia, obliga a confirmar otra vez. */
          huella: unknown;
      }
    | { ok: false; motivo: string };

export type EstadoFinal = 'executed' | 'partial' | 'failed';

export interface ResultadoAccion {
    estado: EstadoFinal;
    /** Lo que se guarda en `result` (sin datos que no hagan falta). */
    resultado: Record<string, unknown>;
}

export interface HerramientaAccion<A = any> extends HerramientaBase<A> {
    tipo: 'accion';
    /**
     * La ejecución puede tardar más que lo que aguanta un request (Cloudflare
     * corta a los ~100 s): el Confirmar responde «en curso» de una vez y la
     * acción termina en segundo plano, que deja el resultado en el chat. Si el
     * proceso muere a mitad, el borrador pasa a «interrumpido» a los 10 min.
     */
    segundoPlano?: boolean;
    /**
     * Mueve plata (aprueba, registra, cobra, cambia tarifa, reembolsa…). En
     * WhatsApp el botón vence a los 10 min y cuenta para el tope por hora (§12.10.1).
     */
    plata?: boolean;
    preparar: (a: Alcance, args: A) => Promise<Preparado<A>>;
    ejecutar: (a: Alcance, args: A) => Promise<ResultadoAccion>;
    /** Mensaje fijo después del Confirmar, armado con el resultado (§10.3). */
    mensajeResultado: (r: ResultadoAccion, args: A) => string;
}

export type Herramienta = HerramientaConsulta | HerramientaAccion;
