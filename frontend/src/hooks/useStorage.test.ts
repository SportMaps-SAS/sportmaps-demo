import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// ── Mocks ────────────────────────────────────────────────────────────────────
const upload = vi.fn();
const getPublicUrl = vi.fn((p: string) => ({ data: { publicUrl: `https://x.supabase.co/storage/v1/object/public/b/${p}` } }));
const storageFrom = vi.fn(() => ({ upload, getPublicUrl }));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    storage: { from: (...a: unknown[]) => storageFrom(...(a as [])) },
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'u-1' } } })) },
  },
}));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
// La compresión no es lo que se prueba: devuelve el original.
vi.mock('@/lib/imageCompression', () => ({
  comprimirParaSubir: vi.fn(async (f: File) => f),
  perfilPorBucket: vi.fn(() => 'avatar'),
}));

import { useStorage } from './useStorage';

describe('useStorage.uploadFile — buckets públicos sin listado (20261028110434)', () => {
  beforeEach(() => {
    upload.mockReset();
    upload.mockResolvedValue({ error: null });
    storageFrom.mockClear();
  });

  it('sube SIN upsert: el upsert de Storage exige una policy SELECT que ya no existe', async () => {
    const { result } = renderHook(() => useStorage());
    const file = new File(['x'], 'foto.png', { type: 'image/png' });

    let url: string | null = null;
    await act(async () => {
      url = await result.current.uploadFile(file, 'avatars', 'u-1');
    });

    expect(storageFrom).toHaveBeenCalledWith('avatars');
    expect(upload).toHaveBeenCalledTimes(1);
    const [path, , opts] = upload.mock.calls[0];
    expect(opts.upsert).toBe(false);
    // La ruta conserva la carpeta pedida: la policy de INSERT ata la ruta al dueño.
    expect(path).toMatch(/^u-1\/\d+_[a-z0-9]+\.png$/);
    expect(url).toContain('/storage/v1/object/public/');
  });

  it('cada subida genera un nombre distinto (por eso upsert no hace falta)', async () => {
    const { result } = renderHook(() => useStorage());
    const file = new File(['x'], 'logo.webp', { type: 'image/webp' });

    await act(async () => {
      await result.current.uploadFile(file, 'school-assets', 'logos/s-1');
      await result.current.uploadFile(file, 'school-assets', 'logos/s-1');
    });

    const rutas = upload.mock.calls.map((c) => c[0]);
    expect(rutas[0]).not.toBe(rutas[1]);
    for (const c of upload.mock.calls) expect(c[2].upsert).toBe(false);
  });
});

describe('guardia: ninguna subida de Storage del cliente usa upsert:true', () => {
  it('no queda `.upload(…, { upsert: true })` en src/', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const raiz = path.resolve(__dirname, '..');
    const ofensores: string[] = [];
    const recorrer = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { recorrer(p); continue; }
        if (!/\.(ts|tsx)$/.test(e.name) || /\.test\.(ts|tsx)$/.test(e.name)) continue;
        const src = fs.readFileSync(p, 'utf8');
        // Ventana desde `.upload(` hasta el cierre de sus opciones.
        if (/\.upload\([^;]*?upsert:\s*true/s.test(src)) ofensores.push(path.relative(raiz, p));
      }
    };
    recorrer(raiz);
    // Sin SELECT de bucket completo (20261028110434), un upsert falla por RLS
    // aunque el archivo sea nuevo. Si de verdad hay que sobrescribir, crear una
    // SELECT acotada a la ruta del dueño en una migración y quitar este archivo de aquí.
    expect(ofensores).toEqual([]);
  });
});
