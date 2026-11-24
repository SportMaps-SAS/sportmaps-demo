/**
 * Cola de listas guardadas en el teléfono — PURA (sin React ni red propia).
 *
 * Mismo mecanismo que la cola del marcador de torneos en vivo
 * (lib/tournamentActionQueue.ts, usada por LiveScorer): se persiste en
 * localStorage con try/catch, se envía EN ORDEN y de a una, y ante falta de
 * señal / 5xx / 429 se reintenta con espera creciente (backoffDelay).
 *
 * Diferencias con la del marcador, propias de una lista:
 *  - UNA entrada por lista (`key` = escuela + equipo/clase + fecha). Guardar otra
 *    vez la misma lista REEMPLAZA a la pendiente (fusiona por deportista, gana
 *    lo último): nunca hay dos envíos de la misma lista en la cola.
 *  - El BFF es idempotente por sesión + deportista: `upsert_attendance_record`
 *    y el crédito se mueve solo por TRANSICIÓN (presente↔no presente), así que
 *    reenviar una lista que ya entró (respuesta perdida) no descuenta dos veces.
 *    La fecha viaja siempre en el cuerpo: si sube al otro día, entra con la
 *    fecha del entreno, no con la de la subida.
 *  - `holdUntil`: ventana de «Deshacer» (8 s). Mientras corre, la lista no se
 *    envía y `deshacer()` la saca sin que el servidor se entere.
 *  - Un rechazo de regla (400/403/404/409/422, p. ej. lista ya cerrada) NO
 *    descarta la lista: queda marcada con el error para que el entrenador la vea.
 *  - Sesión vencida (401): se detiene sin perder nada y espera con backoff.
 *  - Una lista con 5xx no frena a las de atrás: cada una lleva su propia espera,
 *    y tras MAX_INTENTOS_SERVIDOR queda marcada para «Volver a intentar / Descartar».
 *
 * VARIAS PESTAÑAS / INSTANCIAS (la PWA y una pestaña de Chrome comparten el
 * mismo localStorage):
 *  - Nunca se escribe el arreglo propio a ciegas: cada escritura RELEE lo que hay
 *    y FUSIONA por `key` (gana la `version` más alta; a igual versión, el cambio
 *    más reciente). Lo que se sacó de la cola (enviada, deshecha, descartada) deja
 *    una marca `hechas` {key, version, rev}: así otra pestaña con una copia vieja
 *    no la resucita, y una versión NUEVA de la misma lista no se borra por error.
 *  - Envía una sola pestaña a la vez (`navigator.locks` si existe; si no, un
 *    candado con vencimiento en el mismo storage). Antes de cada envío se relee:
 *    siempre sube la versión más nueva que haya en el teléfono.
 */
import { backoffDelay, conJitter, safeStorage, type QueueStorage } from '@/lib/tournamentActionQueue';
import { claveDeRegistroLista, type RegistroLista } from './asistenciaModel';

export const DESHACER_MS = 8000;
/** Fallos del servidor (5xx) seguidos antes de pedirle al entrenador que decida. */
export const MAX_INTENTOS_SERVIDOR = 6;
/** Cuánto se recuerdan las listas ya sacadas de la cola (para no resucitarlas). */
const HECHAS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const HECHAS_MAX = 300;
const CANDADO_TTL_MS = 45_000;

export interface PayloadLista {
  teamId?: string;
  sessionId?: string;
  date: string;
  records: RegistroLista[];
}

export interface ListaEnCola {
  key: string;
  schoolId: string;
  payload: PayloadLista;
  /** «Sub 11 · jueves 8 de octubre» — para avisarle al entrenador qué falta subir. */
  etiqueta: string;
  created_at: number;
  updated_at: number;
  /** Sube con cada guardado de la misma lista; evita borrar una versión más nueva que llegó mientras se enviaba la anterior. */
  version: number;
  /** Identifica ESTE guardado (dos pestañas podrían llegar a la misma versión). */
  rev?: string;
  /** Último cambio de cualquier campo (intentos, ventana…): desempata a igual versión. */
  tocado_at?: number;
  attempts: number;
  nextAttemptAt: number;
  holdUntil: number;
  /** Rechazo del servidor (regla) o servidor caído muchas veces. No se reintenta hasta que el entrenador lo pida. */
  error?: string;
  /** El error es de servidor caído (no de regla): «Volver a intentar» tiene sentido. */
  atascada?: boolean;
}

/** Marca de lo que ya salió de la cola: todo lo de esa key con versión ≤ `version` está resuelto. */
export interface ListaHecha {
  key: string;
  version: number;
  rev?: string;
  at: number;
}

export interface EstadoCola {
  items: ListaEnCola[];
  hechas: ListaHecha[];
}

export type ResultadoEnvio =
  | { kind: 'ok'; body?: unknown }
  | { kind: 'rule'; message: string }
  | { kind: 'auth'; message: string }
  /** `servidor`: el servidor respondió con error (5xx), no es falta de señal. */
  | { kind: 'retry'; message: string; retryAfterMs?: number; servidor?: boolean };

export type EventoCola =
  | { type: 'sent'; item: ListaEnCola; body?: unknown }
  | { type: 'rule_error'; item: ListaEnCola; message: string }
  | { type: 'auth_error'; message: string; delayMs: number }
  | { type: 'retry'; item: ListaEnCola; delayMs: number; message: string }
  | { type: 'stuck'; item: ListaEnCola; message: string };

export type EnviarFn = (item: ListaEnCola) => Promise<ResultadoEnvio>;

/** Exclusión entre pestañas. `con` devuelve null si otra pestaña tiene el candado (no espera). */
export interface Candado {
  con<T>(fn: (renovar: () => void) => Promise<T>): Promise<T | null>;
}

export interface ColaOpciones {
  key: string;
  send: EnviarFn;
  storage?: QueueStorage | null;
  now?: () => number;
  onChange?: () => void;
  /** Azar del jitter de reintentos (tests: `() => 1`). */
  random?: () => number;
  /** Por defecto: candado con vencimiento en el mismo storage (o ninguno si no hay storage). */
  candado?: Candado | null;
}

export function claveLista(schoolId: string, contexto: string, fecha: string): string {
  return `${schoolId}|${contexto}|${fecha}`;
}

/** Traduce el error de bffClient (BFFError con status/body) o de fetch. */
export function clasificarError(err: unknown): ResultadoEnvio {
  const e = err as { status?: number; body?: { error?: string } | null; message?: string; retryAfterSeconds?: number };
  const status = typeof e?.status === 'number' ? e.status : 0;
  const message = e?.body?.error ?? e?.message ?? 'Error de red';
  if (status === 401) return { kind: 'auth', message };
  if (status === 400 || status === 403 || status === 404 || status === 409 || status === 422) return { kind: 'rule', message };
  return {
    kind: 'retry',
    message,
    retryAfterMs: e?.retryAfterSeconds != null ? e.retryAfterSeconds * 1000 : undefined,
    servidor: status >= 500,
  };
}

/** Fusiona por deportista: lo nuevo manda, lo que solo estaba antes se conserva. */
export function fusionarRegistros(antes: RegistroLista[], nuevos: RegistroLista[]): RegistroLista[] {
  const porClave = new Map<string, RegistroLista>();
  for (const r of antes) { const k = claveDeRegistroLista(r); if (k) porClave.set(k, r); }
  for (const r of nuevos) { const k = claveDeRegistroLista(r); if (k) porClave.set(k, r); }
  return [...porClave.values()];
}

const tocado = (i: ListaEnCola) => i.tocado_at ?? i.updated_at ?? 0;

/** ¿Esta marca cubre a esta entrada? (versión menor, o la misma versión del mismo guardado). */
function cubre(h: ListaHecha | undefined, i: ListaEnCola): boolean {
  if (!h) return false;
  if (h.version > i.version) return true;
  return h.version === i.version && (!h.rev || !i.rev || h.rev === i.rev);
}

/**
 * Fusión de dos estados de la cola (memoria de esta pestaña + lo que hay en el
 * storage). Gana la versión más alta; a igual versión, el cambio más reciente.
 * En un empate exacto manda `empate` ('a' al escribir lo propio; 'b' = el
 * storage al recargar, para que dos pestañas no se reescriban sin fin).
 */
export function fusionarEstados(a: EstadoCola, b: EstadoCola, ahora: number, empate: 'a' | 'b' = 'a'): EstadoCola {
  const hechas = new Map<string, ListaHecha>();
  const marcasA = new Set(a.hechas);
  for (const h of [...a.hechas, ...b.hechas]) {
    if (!h || typeof h.key !== 'string') continue;
    const p = hechas.get(h.key);
    const gana = !p || h.version > p.version || (h.version === p.version && (h.at > p.at || (h.at === p.at && empate === 'b' && !marcasA.has(h))));
    if (gana) hechas.set(h.key, h);
  }
  const items = new Map<string, ListaEnCola>();
  const deA = new Set(a.items);
  for (const i of [...a.items, ...b.items]) {
    if (!i || typeof i.key !== 'string' || !i.payload) continue;
    const p = items.get(i.key);
    const gana = !p || i.version > p.version
      || (i.version === p.version && (tocado(i) > tocado(p) || (tocado(i) === tocado(p) && empate === 'b' && !deA.has(i))));
    if (gana) items.set(i.key, i);
  }
  const vivos = [...items.values()].filter((i) => !cubre(hechas.get(i.key), i));
  const conItem = new Set(vivos.map((i) => i.key));
  const marcas = [...hechas.values()]
    // Se olvidan las marcas viejas, salvo la de una lista que sigue en la cola.
    .filter((h) => conItem.has(h.key) || ahora - h.at < HECHAS_TTL_MS)
    .sort((x, y) => y.at - x.at || x.key.localeCompare(y.key))
    .slice(0, HECHAS_MAX);
  return { items: vivos.sort((x, y) => x.created_at - y.created_at || x.key.localeCompare(y.key)), hechas: marcas };
}

function nuevoRev(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch { /* sin crypto */ }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Candado con vencimiento guardado en el storage (respaldo de navigator.locks). */
export function candadoEnStorage(storage: QueueStorage, nombre: string, now: () => number = Date.now, ttlMs = CANDADO_TTL_MS): Candado {
  const yo = nuevoRev();
  const leer = (): { dueno?: string; hasta?: number } | null => {
    try { return JSON.parse(storage.getItem(nombre) ?? 'null'); } catch { return null; }
  };
  const escribir = (hasta: number) => { try { storage.setItem(nombre, JSON.stringify({ dueno: yo, hasta })); } catch { /* lleno */ } };
  return {
    async con(fn) {
      const l = leer();
      if (l && l.dueno !== yo && (l.hasta ?? 0) > now()) return null;
      escribir(now() + ttlMs);
      if (leer()?.dueno !== yo) return null; // otra pestaña escribió a la vez
      try {
        return await fn(() => { if (leer()?.dueno === yo) escribir(now() + ttlMs); });
      } finally {
        if (leer()?.dueno === yo) escribir(0);
      }
    },
  };
}

type LocksLike = {
  request: (name: string, opts: { ifAvailable: boolean }, cb: (lock: unknown) => Promise<unknown>) => Promise<unknown>;
};

/** navigator.locks si el navegador lo tiene (PWA y pestañas del mismo origen lo comparten). */
export function candadoNavegador(nombre: string, respaldo: QueueStorage | null): Candado | null {
  try {
    const locks = (typeof navigator !== 'undefined' ? (navigator as Navigator & { locks?: LocksLike }).locks : undefined);
    if (locks && typeof locks.request === 'function') {
      return {
        async con(fn) {
          const r = await locks.request(nombre, { ifAvailable: true }, async (lock) => (lock ? { v: await fn(() => undefined) } : null));
          return r ? (r as { v: Awaited<ReturnType<typeof fn>> }).v : null;
        },
      };
    }
  } catch { /* sin soporte */ }
  return respaldo ? candadoEnStorage(respaldo, `${nombre}:candado`) : null;
}

export class ColaAsistencia {
  private items: ListaEnCola[] = [];
  private hechas: ListaHecha[] = [];
  private flushing: Promise<EventoCola[]> | null = null;
  private again = false;
  private authFallos = 0;
  private authHasta = 0;
  private readonly opts: ColaOpciones;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly candado: Candado | null;

  constructor(opts: ColaOpciones) {
    const storage = opts.storage === undefined ? safeStorage() : opts.storage;
    this.opts = { ...opts, storage };
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? Math.random;
    this.candado = opts.candado !== undefined ? opts.candado : storage ? candadoEnStorage(storage, `${opts.key}:candado`, this.now) : null;
    this.recargar(false);
  }

  private leerStorage(): EstadoCola | null {
    try {
      const raw = this.opts.storage?.getItem(this.opts.key);
      if (!raw) return { items: [], hechas: [] };
      const p = JSON.parse(raw) as Partial<EstadoCola>;
      return {
        items: Array.isArray(p.items) ? p.items.filter((i) => i && typeof i.key === 'string' && i.payload) : [],
        hechas: Array.isArray(p.hechas) ? p.hechas : [],
      };
    } catch { return null; /* ilegible o bloqueado: se sigue con la memoria */ }
  }

  private firma(e: EstadoCola) {
    return JSON.stringify(e);
  }

  /**
   * Relee el storage y lo fusiona con la memoria. Si esta pestaña tenía algo que
   * el storage perdió (otra pestaña escribió con una copia vieja), lo repone.
   * Devuelve true si cambió lo que ve esta pestaña.
   */
  recargar(notificar = true): boolean {
    const antes = this.firma({ items: this.items, hechas: this.hechas });
    const remoto = this.leerStorage();
    if (!remoto) return false;
    const fus = fusionarEstados({ items: this.items, hechas: this.hechas }, remoto, this.now(), 'b');
    this.items = fus.items;
    this.hechas = fus.hechas;
    if (this.firma(fus) !== this.firma(remoto)) this.escribir();
    const cambio = this.firma(fus) !== antes;
    if (cambio && notificar) this.opts.onChange?.();
    return cambio;
  }

  private escribir() {
    try { this.opts.storage?.setItem(this.opts.key, JSON.stringify({ items: this.items, hechas: this.hechas })); } catch { /* lleno o bloqueado */ }
  }

  /** Relee, fusiona y escribe (nunca el arreglo propio a ciegas). */
  private save() {
    const remoto = this.leerStorage();
    if (remoto) {
      const fus = fusionarEstados({ items: this.items, hechas: this.hechas }, remoto, this.now());
      this.items = fus.items;
      this.hechas = fus.hechas;
    }
    this.escribir();
    this.opts.onChange?.();
  }

  /** Marca de cambio estrictamente creciente en esta pestaña (desempata a igual versión). */
  private tocar(it: ListaEnCola) {
    it.tocado_at = Math.max(this.now(), tocado(it) + 1);
  }

  private marcarHecha(item: Pick<ListaEnCola, 'key' | 'version' | 'rev'>) {
    this.hechas = [...this.hechas.filter((h) => h.key !== item.key || h.version > item.version), { key: item.key, version: item.version, rev: item.rev, at: this.now() }];
    this.items = this.items.filter((i) => !(i.key === item.key && cubre({ key: item.key, version: item.version, rev: item.rev, at: 0 }, i)));
  }

  /**
   * Guarda (o reemplaza) la lista. Arranca la ventana de «Deshacer» de `holdMs`.
   * Devuelve la entrada resultante.
   */
  guardar(entrada: { key: string; schoolId: string; payload: PayloadLista; etiqueta: string }, holdMs = DESHACER_MS): ListaEnCola {
    this.recargar(false);
    const t = this.now();
    const prev = this.items.find((i) => i.key === entrada.key);
    if (prev) {
      prev.payload = { ...entrada.payload, records: fusionarRegistros(prev.payload.records, entrada.payload.records) };
      prev.etiqueta = entrada.etiqueta;
      prev.schoolId = entrada.schoolId;
      prev.updated_at = t;
      this.tocar(prev);
      prev.version += 1;
      prev.rev = nuevoRev();
      prev.attempts = 0;
      prev.nextAttemptAt = 0;
      prev.holdUntil = t + holdMs;
      delete prev.error;
      delete prev.atascada;
      this.save();
      return this.get(entrada.key) ?? prev;
    }
    // Si esta lista ya subió antes (marca), la nueva versión va por encima de la marca.
    const marca = this.hechas.find((h) => h.key === entrada.key);
    const item: ListaEnCola = {
      ...entrada, created_at: t, updated_at: t, tocado_at: t, version: (marca?.version ?? 0) + 1, rev: nuevoRev(),
      attempts: 0, nextAttemptAt: 0, holdUntil: t + holdMs,
    };
    this.items.push(item);
    this.save();
    return this.get(entrada.key) ?? item;
  }

  /** Deshacer: solo mientras la lista no salió (ventana de 8 s). */
  deshacer(key: string): boolean {
    this.recargar(false);
    const it = this.items.find((x) => x.key === key);
    if (!it || it.holdUntil <= this.now()) return false;
    this.marcarHecha(it);
    this.save();
    return true;
  }

  /** Quitar una lista rechazada o atascada (el entrenador decide no subirla). */
  descartar(key: string) {
    this.recargar(false);
    const it = this.items.find((i) => i.key === key);
    if (!it) return;
    this.marcarHecha(it);
    this.save();
  }

  /** «Volver a intentar» una lista rechazada o atascada: nueva versión, sin espera ni ventana. */
  reintentar(key: string): boolean {
    this.recargar(false);
    const it = this.items.find((i) => i.key === key);
    if (!it) return false;
    const t = this.now();
    it.version += 1;
    it.rev = nuevoRev();
    this.tocar(it);
    it.attempts = 0;
    it.nextAttemptAt = 0;
    it.holdUntil = t;
    delete it.error;
    delete it.atascada;
    this.save();
    return true;
  }

  /** Termina ya la ventana de Deshacer (p. ej. al salir de la pantalla). */
  soltar(key: string) {
    this.recargar(false);
    const it = this.items.find((i) => i.key === key);
    if (it && it.holdUntil > this.now()) { it.holdUntil = this.now(); this.tocar(it); this.save(); }
  }

  get(key: string): ListaEnCola | undefined { return this.items.find((i) => i.key === key); }
  todas(): ListaEnCola[] { return this.items.slice(); }
  /** Listas que todavía tienen que subir (sin las rechazadas ni atascadas). */
  pendientes(): ListaEnCola[] { return this.items.filter((i) => !i.error); }
  rechazadas(): ListaEnCola[] { return this.items.filter((i) => !!i.error); }
  get size(): number { return this.items.length; }

  /**
   * Envía en orden lo pendiente, una a la vez y una sola pestaña a la vez.
   * `force` ignora las esperas de reintento (no la de Deshacer).
   */
  flush(force = false): Promise<EventoCola[]> {
    if (this.flushing) { this.again = true; return this.flushing; }
    this.flushing = (async () => {
      const all: EventoCola[] = [];
      let f = force;
      do {
        this.again = false;
        const ev = this.candado ? await this.candado.con((renovar) => this.run(f, renovar)) : await this.run(f, () => undefined);
        // null = otra pestaña está enviando: ella sube lo que haya (relee antes de cada envío).
        if (ev) all.push(...ev);
        f = false;
      } while (this.again);
      return all;
    })().finally(() => { this.flushing = null; });
    return this.flushing;
  }

  private async run(force: boolean, renovar: () => void): Promise<EventoCola[]> {
    const events: EventoCola[] = [];
    const intentadas = new Set<string>();
    for (;;) {
      this.recargar();
      const t = this.now();
      if (!force && this.authHasta > t) break;
      const item = this.items
        .filter((i) => !i.error && i.holdUntil <= t && (force || i.nextAttemptAt <= t) && !intentadas.has(i.key))
        .sort((a, b) => a.created_at - b.created_at)[0];
      if (!item) break;
      intentadas.add(item.key);
      renovar();
      const enviada = { key: item.key, version: item.version, rev: item.rev };
      let res: ResultadoEnvio;
      try { res = await this.opts.send(item); } catch (err) { res = clasificarError(err); }

      // Mientras viajaba pudo cambiar (otra pestaña o esta misma): se relee antes de tocar nada.
      this.recargar(false);
      const actual = this.items.find((i) => i.key === enviada.key);
      const mismaVersion = !!actual && actual.version === enviada.version && actual.rev === enviada.rev;

      if (res.kind === 'ok') {
        this.authFallos = 0;
        this.authHasta = 0;
        // Si la volvieron a guardar mientras viajaba, la versión nueva sigue en la cola.
        this.marcarHecha(enviada);
        events.push({ type: 'sent', item, body: res.body });
        this.save();
        continue;
      }
      if (res.kind === 'rule') {
        if (mismaVersion) { actual!.error = res.message || 'El servidor no aceptó la lista.'; this.tocar(actual!); }
        events.push({ type: 'rule_error', item, message: res.message });
        this.save();
        continue;
      }
      if (res.kind === 'auth') {
        // Sesión vencida: no se insiste cada 2 s; espera creciente hasta que vuelva a entrar.
        this.authFallos += 1;
        const delay = conJitter(backoffDelay(this.authFallos), this.random);
        this.authHasta = this.now() + delay;
        events.push({ type: 'auth_error', message: res.message, delayMs: delay });
        break;
      }
      // retry: esta lista espera; las demás siguen (cada una con su propia espera).
      const delay = Math.max(conJitter(backoffDelay((actual?.attempts ?? item.attempts) + 1), this.random), res.retryAfterMs ?? 0);
      if (mismaVersion) {
        actual!.attempts += 1;
        actual!.nextAttemptAt = this.now() + delay;
        this.tocar(actual!);
        if (res.servidor && actual!.attempts >= MAX_INTENTOS_SERVIDOR) {
          actual!.error = 'El servidor no respondió después de varios intentos.';
          actual!.atascada = true;
          events.push({ type: 'stuck', item: actual!, message: res.message });
          this.save();
          continue;
        }
      }
      events.push({ type: 'retry', item, delayMs: delay, message: res.message });
      this.save();
    }
    return events;
  }
}
