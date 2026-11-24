/**
 * Precarga del build para abrir la app sin señal (modo offline, Fase 1).
 *
 * NO se hace en el evento `install` del service worker: el 2026-08-17 se midió que precachear
 * ~400 archivos al instalar duplicaba el tiempo de login (8 s → 16 s), porque esas descargas
 * compiten con las peticiones críticas. En su lugar la PÁGINA, ya cargada y ociosa, le pide al
 * service worker que baje lo que falta (`PRECACHE_BUILD`), de a pocos a la vez.
 *
 *  · Idempotente: lo que ya está en la caché no se vuelve a pedir.
 *  · Los archivos del build llevan hash en el nombre: lo guardado nunca queda «viejo»; una build
 *    nueva trae otra caché (el `activate` del sw.js borra las anteriores).
 *  · Nunca guarda HTML servido en lugar de un script (el rewrite SPA responde index.html a una
 *    URL que ya no existe): daría el error de MIME que el sw.js evita a propósito.
 *  · Nunca lanza: un archivo que falla se salta y se reintenta en la próxima pasada.
 */

export interface EntradaManifiesto { url: string; revision?: string | null }

export interface ResultadoPrecarga { total: number; yaEstaban: number; descargados: number; fallidos: number; bytes: number; podados: number }

interface CacheLike {
  match(req: string): Promise<unknown>;
  put(req: string, res: ResponseLike): Promise<void>;
  /** Opcionales: si existen, al terminar se podan los archivos que ya no están en el manifiesto. */
  keys?(): Promise<ReadonlyArray<{ url: string }>>;
  delete?(req: string): Promise<boolean>;
}
interface ResponseLike {
  ok: boolean;
  headers: { get(name: string): string | null };
  clone(): ResponseLike;
  arrayBuffer?(): Promise<ArrayBuffer>;
}

export const CONCURRENCIA_PRECARGA = 3;

/** Un archivo del manifiesto como URL absoluta del mismo origen. */
export function urlDeEntrada(e: EntradaManifiesto | string, origen: string): string {
  const u = typeof e === 'string' ? e : e.url;
  return new URL(u, origen.endsWith('/') ? origen : `${origen}/`).href;
}

export async function precachearBuild(opts: {
  entradas: ReadonlyArray<EntradaManifiesto | string>;
  origen: string;
  cache: CacheLike;
  traer: (url: string) => Promise<ResponseLike>;
  concurrencia?: number;
  /** Se llama antes de cada descarga: devolver false detiene la pasada (se fue la red, ahorro de datos…). */
  seguir?: () => boolean;
}): Promise<ResultadoPrecarga> {
  const { entradas, origen, cache, traer, seguir } = opts;
  const urls = [...new Set(entradas.map((e) => urlDeEntrada(e, origen)))];
  const res: ResultadoPrecarga = { total: urls.length, yaEstaban: 0, descargados: 0, fallidos: 0, bytes: 0, podados: 0 };
  let detenida = false;
  let i = 0;

  const trabajador = async () => {
    while (i < urls.length) {
      if (seguir && !seguir()) { detenida = true; return; }
      const url = urls[i++];
      try {
        if (await cache.match(url)) { res.yaEstaban += 1; continue; }
        const r = await traer(url);
        const ct = r.headers.get('content-type') || '';
        if (!r.ok || ct.includes('text/html')) { res.fallidos += 1; continue; }
        await cache.put(url, r.clone());
        res.descargados += 1;
        const len = Number(r.headers.get('content-length') || 0);
        if (len > 0) res.bytes += len;
      } catch {
        res.fallidos += 1;
      }
    }
  };

  const n = Math.max(1, opts.concurrencia ?? CONCURRENCIA_PRECARGA);
  await Promise.all(Array.from({ length: Math.min(n, urls.length) }, trabajador));

  // Poda: la caché es ESTABLE entre deploys (los archivos llevan hash, así que un deploy solo baja
  // lo que cambió); lo que ya no figura en el manifiesto se borra. Solo si la pasada terminó
  // completa y sin fallos: un manifiesto a medias no debe borrar archivos que sí sirven sin red.
  if (!detenida && res.fallidos === 0 && cache.keys && cache.delete) {
    try {
      const vigentes = new Set(urls);
      for (const k of await cache.keys()) {
        if (!vigentes.has(k.url) && new URL(k.url).origin === new URL(origen).origin) {
          if (await cache.delete(k.url)) res.podados += 1;
        }
      }
    } catch { /* sin poda esta vez */ }
  }
  return res;
}

/** ¿Vale la pena gastar datos del celular ahora? Pura: recibe lo que el navegador reporta. */
export function convienePrecargar(estado: {
  online: boolean;
  saveData?: boolean;
  effectiveType?: string | null;
  haySesion: boolean;
}): boolean {
  if (!estado.online || !estado.haySesion) return false;
  if (estado.saveData) return false;
  if (estado.effectiveType === 'slow-2g' || estado.effectiveType === '2g') return false;
  return true;
}
