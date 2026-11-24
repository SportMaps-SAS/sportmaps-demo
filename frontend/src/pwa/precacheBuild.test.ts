import { describe, expect, it } from 'vitest';
import { convienePrecargar, precachearBuild, urlDeEntrada } from './precacheBuild';

const ORIGEN = 'https://app.sportmaps.co';

function respuesta(opts: { ok?: boolean; ct?: string; len?: number } = {}) {
  const headers = new Map<string, string>([
    ['content-type', opts.ct ?? 'text/javascript'],
    ...(opts.len ? [['content-length', String(opts.len)] as [string, string]] : []),
  ]);
  const r = { ok: opts.ok ?? true, headers: { get: (n: string) => headers.get(n.toLowerCase()) ?? null }, clone: () => r };
  return r;
}

function cacheEnMemoria(previas: string[] = []) {
  const guardado = new Set(previas);
  return {
    guardado,
    match: async (u: string) => (guardado.has(u) ? {} : undefined),
    put: async (u: string) => { guardado.add(u); },
    keys: async () => [...guardado].map((url) => ({ url })),
    delete: async (u: string) => guardado.delete(u),
  };
}

describe('precachearBuild', () => {
  it('convierte la URL del manifiesto en absoluta del mismo origen', () => {
    expect(urlDeEntrada({ url: 'assets/a-123.js' }, ORIGEN)).toBe(`${ORIGEN}/assets/a-123.js`);
    expect(urlDeEntrada('/index.html', ORIGEN)).toBe(`${ORIGEN}/index.html`);
  });

  it('baja lo que falta y NO vuelve a pedir lo que ya está (idempotente)', async () => {
    const cache = cacheEnMemoria([`${ORIGEN}/assets/ya.js`]);
    const pedidas: string[] = [];
    const r = await precachearBuild({
      entradas: [{ url: 'assets/ya.js' }, { url: 'assets/nuevo.js' }, { url: 'assets/nuevo.js' }],
      origen: ORIGEN, cache, traer: async (u) => { pedidas.push(u); return respuesta({ len: 1000 }); },
    });
    expect(pedidas).toEqual([`${ORIGEN}/assets/nuevo.js`]);
    expect(r).toMatchObject({ total: 2, yaEstaban: 1, descargados: 1, fallidos: 0, bytes: 1000 });
    const segunda = await precachearBuild({
      entradas: [{ url: 'assets/ya.js' }, { url: 'assets/nuevo.js' }],
      origen: ORIGEN, cache, traer: async () => { throw new Error('no debería pedir nada'); },
    });
    expect(segunda).toMatchObject({ yaEstaban: 2, descargados: 0, fallidos: 0 });
  });

  it('NO guarda HTML servido en lugar de un script (rewrite SPA) ni respuestas con error', async () => {
    const cache = cacheEnMemoria();
    const r = await precachearBuild({
      entradas: ['assets/viejo.js', 'assets/roto.js', 'assets/ok.js'],
      origen: ORIGEN, cache,
      traer: async (u) => (u.endsWith('viejo.js') ? respuesta({ ct: 'text/html; charset=utf-8' })
        : u.endsWith('roto.js') ? respuesta({ ok: false }) : respuesta()),
    });
    expect([...cache.guardado]).toEqual([`${ORIGEN}/assets/ok.js`]);
    expect(r).toMatchObject({ descargados: 1, fallidos: 2 });
  });

  it('un archivo que falla no frena a los demás ni lanza', async () => {
    const cache = cacheEnMemoria();
    const r = await precachearBuild({
      entradas: ['a.js', 'b.js', 'c.js'], origen: ORIGEN, cache,
      traer: async (u) => { if (u.endsWith('b.js')) throw new TypeError('Failed to fetch'); return respuesta(); },
    });
    expect(r).toMatchObject({ descargados: 2, fallidos: 1 });
  });

  it('respeta la concurrencia (nunca más de N descargas a la vez)', async () => {
    let activas = 0; let maxActivas = 0;
    await precachearBuild({
      entradas: Array.from({ length: 12 }, (_, i) => `a${i}.js`), origen: ORIGEN, cache: cacheEnMemoria(), concurrencia: 3,
      traer: async () => { activas++; maxActivas = Math.max(maxActivas, activas); await new Promise((r) => setTimeout(r, 5)); activas--; return respuesta(); },
    });
    expect(maxActivas).toBeLessThanOrEqual(3);
    expect(maxActivas).toBeGreaterThan(1);
  });

  it('se detiene si `seguir` devuelve false (se fue la red)', async () => {
    const cache = cacheEnMemoria();
    let n = 0;
    const r = await precachearBuild({
      entradas: ['a.js', 'b.js', 'c.js', 'd.js'], origen: ORIGEN, cache, concurrencia: 1,
      seguir: () => n < 2,
      traer: async () => { n++; return respuesta(); },
    });
    expect(r.descargados).toBe(2);
  });
});

describe('poda de la caché estable', () => {
  it('borra lo que ya no está en el manifiesto (deploy nuevo) y conserva lo vigente', async () => {
    const cache = cacheEnMemoria([`${ORIGEN}/assets/viejo-1.js`, `${ORIGEN}/assets/sigue.js`]);
    const r = await precachearBuild({
      entradas: ['assets/sigue.js', 'assets/nuevo.js'], origen: ORIGEN, cache, traer: async () => respuesta(),
    });
    expect([...cache.guardado].sort()).toEqual([`${ORIGEN}/assets/nuevo.js`, `${ORIGEN}/assets/sigue.js`]);
    expect(r).toMatchObject({ descargados: 1, yaEstaban: 1, podados: 1 });
  });

  it('NO poda si algún archivo falló: un manifiesto a medias no debe borrar lo que sí sirve sin red', async () => {
    const cache = cacheEnMemoria([`${ORIGEN}/assets/viejo-1.js`]);
    const r = await precachearBuild({
      entradas: ['assets/nuevo.js'], origen: ORIGEN, cache, traer: async () => { throw new TypeError('Failed to fetch'); },
    });
    expect(cache.guardado.has(`${ORIGEN}/assets/viejo-1.js`)).toBe(true);
    expect(r.podados).toBe(0);
  });

  it('NO poda si la pasada se detuvo a medias', async () => {
    const cache = cacheEnMemoria([`${ORIGEN}/assets/viejo-1.js`]);
    const r = await precachearBuild({
      entradas: ['a.js', 'b.js'], origen: ORIGEN, cache, concurrencia: 1, seguir: () => false, traer: async () => respuesta(),
    });
    expect(cache.guardado.has(`${ORIGEN}/assets/viejo-1.js`)).toBe(true);
    expect(r.podados).toBe(0);
  });
});

describe('convienePrecargar', () => {
  const base = { online: true, haySesion: true };
  it('con red buena y sesión, sí', () => expect(convienePrecargar(base)).toBe(true));
  it('sin sesión (landing pública) no gasta datos', () => expect(convienePrecargar({ ...base, haySesion: false })).toBe(false));
  it('sin red, no', () => expect(convienePrecargar({ ...base, online: false })).toBe(false));
  it('ahorro de datos o 2G, no', () => {
    expect(convienePrecargar({ ...base, saveData: true })).toBe(false);
    expect(convienePrecargar({ ...base, effectiveType: '2g' })).toBe(false);
    expect(convienePrecargar({ ...base, effectiveType: 'slow-2g' })).toBe(false);
    expect(convienePrecargar({ ...base, effectiveType: '4g' })).toBe(true);
  });
});
