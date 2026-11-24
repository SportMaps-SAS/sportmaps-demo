/**
 * Bandeja de salida común (Fase 2 del modo offline) — lo que el usuario hizo sin señal y
 * todavía no llegó al servidor.
 *
 * Reglas (spec docs/specs/modo-offline-y-sincronizacion.md §3.3, §4, §5):
 *  · Una acción por `id` lógico (p. ej. `evaluar:<sesión>`): guardar otra vez REEMPLAZA a la
 *    pendiente (gana lo último; la `version` sube). Nunca hay dos envíos del mismo asunto en cola.
 *  · Solo entran flujos IDEMPOTENTES (reenviar N veces = 1 efecto) y sin dinero/cupos/permisos
 *    (checklist §9). La bandeja no decide eso: lo decide quien registra el `tipo`.
 *  · Almacén: IndexedDB, un registro por acción (`ob:{userId}:{id}`) para que dos pestañas no se
 *    pisen entre sí. NO se borra al cerrar sesión: es trabajo del usuario, no una copia de lectura.
 *    Cada acción lleva su `userId`; esta instancia solo envía las suyas (otra cuenta en el mismo
 *    celular no las toca ni las envía).
 *  · Envío de a una, con una sola pestaña a la vez (candado), y esperas crecientes (backoffDelay).
 *  · Errores clasificados como en la cola de asistencia: `ok` | `rule` (se aparta CON su motivo, no se
 *    descarta en silencio) | `auth` (frena sin perder nada) | `retry` (red/5xx; tras
 *    MAX_INTENTOS_SERVIDOR seguidos queda «atascada» para que el usuario decida).
 *  · Sin React ni red propia: pura y probable. El almacén, el reloj y el candado se inyectan.
 */
import { backoffDelay, safeStorage } from '@/lib/tournamentActionQueue';
import { candadoNavegador, type Candado, type ResultadoEnvio } from '@/components/coach/v2/colaAsistencia';
import { idbDel, idbGet, idbListPrefix, idbSet } from './idbStore';

export const MAX_INTENTOS_SERVIDOR = 6;
const PREFIJO = 'ob:';

export interface AccionEnBandeja<P = unknown> {
  /** Identidad lógica (también la clave de idempotencia del lado del cliente). */
  id: string;
  tipo: string;
  userId: string;
  schoolId: string;
  payload: P;
  /** «Evaluación · Sub 11 · jueves 8 de octubre» — lo que ve el usuario en «Pendientes». */
  etiqueta: string;
  created_at: number;
  updated_at: number;
  /** Sube cada vez que se vuelve a guardar o reintentar; evita borrar una versión nueva que llegó mientras viajaba la anterior. */
  version: number;
  rev: string;
  intentos: number;
  nextAttemptAt: number;
  /** Rechazo de regla, o servidor caído muchas veces. No se reintenta hasta que el usuario lo pida. */
  error?: string;
  /** El error es de servidor caído (no de regla): «Volver a intentar» tiene sentido. */
  atascada?: boolean;
}

export type EnviarAccion = (a: AccionEnBandeja) => Promise<ResultadoEnvio>;

export type EventoBandeja =
  | { type: 'sent'; accion: AccionEnBandeja }
  | { type: 'rule_error'; accion: AccionEnBandeja; message: string }
  | { type: 'auth_error'; message: string; delayMs: number }
  | { type: 'retry'; accion: AccionEnBandeja; delayMs: number; message: string }
  | { type: 'stuck'; accion: AccionEnBandeja; message: string };

export interface AlmacenBandeja {
  get<T>(clave: string): Promise<T | undefined>;
  set(clave: string, valor: unknown): Promise<void>;
  del(clave: string): Promise<void>;
  list<T>(prefijo: string): Promise<T[]>;
}

export const almacenIndexedDb: AlmacenBandeja = {
  get: (k) => idbGet(k),
  set: (k, v) => idbSet(k, v),
  del: (k) => idbDel(k),
  list: (p) => idbListPrefix(p),
};

export interface BandejaOpciones {
  userId: string;
  /** Un manejador por `tipo`. Un tipo sin manejador se conserva intacto (no se envía ni se descarta). */
  manejadores: Record<string, EnviarAccion>;
  almacen?: AlmacenBandeja;
  now?: () => number;
  onChange?: () => void;
  /** Por defecto: navigator.locks (o candado con vencimiento en localStorage). */
  candado?: Candado | null;
  /** Avisa a las demás pestañas que algo cambió. Por defecto BroadcastChannel si existe. */
  canal?: { avisar: () => void; escuchar: (fn: () => void) => () => void } | null;
}

function nuevoRev(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch { /* sin crypto */ }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function canalDelNavegador(nombre: string): BandejaOpciones['canal'] {
  try {
    if (typeof BroadcastChannel === 'undefined') return null;
    const bc = new BroadcastChannel(nombre);
    return {
      avisar: () => { try { bc.postMessage('cambio'); } catch { /* cerrado */ } },
      escuchar: (fn) => { const f = () => fn(); bc.addEventListener('message', f); return () => bc.removeEventListener('message', f); },
    };
  } catch { return null; }
}

export class Bandeja {
  private items: AccionEnBandeja[] = [];
  private flushing: Promise<EventoBandeja[]> | null = null;
  private again = false;
  private authFallos = 0;
  private authHasta = 0;
  private cola: Promise<unknown> = Promise.resolve();
  private readonly o: Required<Pick<BandejaOpciones, 'userId' | 'manejadores'>> & BandejaOpciones;
  private readonly almacen: AlmacenBandeja;
  private readonly now: () => number;
  private readonly candado: Candado | null;
  private readonly canal: BandejaOpciones['canal'];
  private quitarCanal: (() => void) | null = null;

  constructor(opts: BandejaOpciones) {
    this.o = opts;
    this.almacen = opts.almacen ?? almacenIndexedDb;
    this.now = opts.now ?? Date.now;
    this.candado = opts.candado !== undefined ? opts.candado : candadoNavegador(`sm-bandeja:${opts.userId}:envio`, safeStorage());
    this.canal = opts.canal !== undefined ? opts.canal : canalDelNavegador('sm-bandeja');
    this.quitarCanal = this.canal?.escuchar(() => { void this.cargar(true); }) ?? null;
  }

  /** Suelta el canal entre pestañas (al desmontar o cambiar de usuario). */
  cerrar() { this.quitarCanal?.(); this.quitarCanal = null; }

  private clave(id: string) { return `${PREFIJO}${this.o.userId}:${id}`; }

  /** Las operaciones sobre el almacén van de a una dentro de esta pestaña (lectura-modificación-escritura). */
  private serie<T>(fn: () => Promise<T>): Promise<T> {
    const r = this.cola.then(fn, fn);
    this.cola = r.catch(() => undefined);
    return r;
  }

  /** Relee lo que hay en el almacén (otra pestaña pudo cambiarlo). */
  async cargar(notificar = false): Promise<void> {
    const todas = await this.almacen.list<AccionEnBandeja>(`${PREFIJO}${this.o.userId}:`);
    const validas = todas.filter((a) => a && typeof a.id === 'string' && typeof a.tipo === 'string');
    validas.sort((x, y) => x.created_at - y.created_at || x.id.localeCompare(y.id));
    const cambio = JSON.stringify(validas) !== JSON.stringify(this.items);
    this.items = validas;
    if (cambio && notificar) this.o.onChange?.();
  }

  private avisar() {
    this.o.onChange?.();
    this.canal?.avisar();
  }

  /**
   * Guarda (o reemplaza) la acción. Devuelve cuando YA quedó escrita en el teléfono: desde ahí
   * se le puede decir al usuario «guardado» con honestidad.
   */
  encolar<P>(e: { id: string; tipo: string; schoolId: string; payload: P; etiqueta: string }): Promise<AccionEnBandeja<P>> {
    return this.serie(async () => {
      const previa = await this.almacen.get<AccionEnBandeja>(this.clave(e.id));
      const t = this.now();
      const accion: AccionEnBandeja<P> = {
        ...e, userId: this.o.userId, created_at: previa?.created_at ?? t, updated_at: t,
        version: (previa?.version ?? 0) + 1, rev: nuevoRev(), intentos: 0, nextAttemptAt: 0,
      };
      await this.almacen.set(this.clave(e.id), accion);
      await this.cargar();
      this.avisar();
      return accion;
    });
  }

  /** El usuario decide no enviarla. */
  descartar(id: string): Promise<void> {
    return this.serie(async () => {
      await this.almacen.del(this.clave(id));
      await this.cargar();
      this.avisar();
    });
  }

  /** «Volver a intentar» una rechazada o atascada: nueva versión, sin espera. */
  reintentar(id: string): Promise<boolean> {
    return this.serie(async () => {
      const a = await this.almacen.get<AccionEnBandeja>(this.clave(id));
      if (!a) return false;
      const n: AccionEnBandeja = { ...a, version: a.version + 1, rev: nuevoRev(), intentos: 0, nextAttemptAt: 0, updated_at: this.now() };
      delete n.error;
      delete n.atascada;
      await this.almacen.set(this.clave(id), n);
      await this.cargar();
      this.avisar();
      return true;
    });
  }

  todas(): AccionEnBandeja[] { return this.items.slice(); }
  pendientes(): AccionEnBandeja[] { return this.items.filter((i) => !i.error); }
  conProblema(): AccionEnBandeja[] { return this.items.filter((i) => !!i.error); }
  get size(): number { return this.items.length; }

  /** Cuándo toca el próximo intento (para programar un solo temporizador); null si no hay nada esperando. */
  proximoIntento(): number | null {
    const esperas = this.pendientes().map((i) => i.nextAttemptAt);
    return esperas.length ? Math.min(...esperas) : null;
  }

  /** Envía lo que toque, una acción a la vez y una sola pestaña a la vez. `force` ignora las esperas. */
  flush(force = false): Promise<EventoBandeja[]> {
    if (this.flushing) { this.again = true; return this.flushing; }
    this.flushing = (async () => {
      const all: EventoBandeja[] = [];
      let f = force;
      do {
        this.again = false;
        const ev = this.candado ? await this.candado.con(() => this.correr(f)) : await this.correr(f);
        if (ev) all.push(...ev);
        f = false;
      } while (this.again);
      return all;
    })().finally(() => { this.flushing = null; });
    return this.flushing;
  }

  private async correr(force: boolean): Promise<EventoBandeja[]> {
    const eventos: EventoBandeja[] = [];
    const intentadas = new Set<string>();
    for (;;) {
      await this.cargar(true);
      const t = this.now();
      if (!force && this.authHasta > t) break;
      const accion = this.items.find((i) => !i.error && (force || i.nextAttemptAt <= t) && !intentadas.has(i.id));
      if (!accion) break;
      intentadas.add(accion.id);
      const enviar = this.o.manejadores[accion.tipo];
      if (!enviar) continue; // tipo que esta versión no conoce: se conserva tal cual
      let res: ResultadoEnvio;
      try { res = await enviar(accion); } catch (err) {
        const e = err as { message?: string };
        res = { kind: 'retry', message: e?.message || 'Error de red' };
      }

      // Mientras viajaba pudo volver a guardarse (esta u otra pestaña): se relee antes de tocar nada.
      const actual = await this.almacen.get<AccionEnBandeja>(this.clave(accion.id));
      const misma = !!actual && actual.version === accion.version && actual.rev === accion.rev;

      if (res.kind === 'ok') {
        this.authFallos = 0; this.authHasta = 0;
        if (misma) await this.serie(() => this.almacen.del(this.clave(accion.id)));
        // La volvieron a guardar mientras viajaba: la versión nueva sale a continuación (idempotente).
        else if (actual) intentadas.delete(accion.id);
        eventos.push({ type: 'sent', accion });
        await this.cargar(); this.avisar();
        continue;
      }
      if (res.kind === 'rule') {
        if (misma) await this.serie(() => this.almacen.set(this.clave(accion.id), { ...actual!, error: res.message || 'El servidor no aceptó la acción.' }));
        eventos.push({ type: 'rule_error', accion, message: res.message });
        await this.cargar(); this.avisar();
        continue;
      }
      if (res.kind === 'auth') {
        this.authFallos += 1;
        const delay = backoffDelay(this.authFallos);
        this.authHasta = this.now() + delay;
        eventos.push({ type: 'auth_error', message: res.message, delayMs: delay });
        break;
      }
      // retry: esta espera; las demás siguen.
      const delay = Math.max(backoffDelay((actual?.intentos ?? accion.intentos) + 1), res.retryAfterMs ?? 0);
      if (misma) {
        const n: AccionEnBandeja = { ...actual!, intentos: actual!.intentos + 1, nextAttemptAt: this.now() + delay };
        if (res.servidor && n.intentos >= MAX_INTENTOS_SERVIDOR) {
          n.error = res.message || 'El servidor no respondió después de varios intentos.';
          n.atascada = true;
          await this.serie(() => this.almacen.set(this.clave(accion.id), n));
          eventos.push({ type: 'stuck', accion: n, message: res.message });
          await this.cargar(); this.avisar();
          continue;
        }
        await this.serie(() => this.almacen.set(this.clave(accion.id), n));
      }
      eventos.push({ type: 'retry', accion, delayMs: delay, message: res.message });
      await this.cargar(); this.avisar();
    }
    return eventos;
  }
}
