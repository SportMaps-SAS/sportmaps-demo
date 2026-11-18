/**
 * El script del Widget de Wompi ya no va en index.html (bloqueaba ~1,1 s el render
 * de todas las páginas): se inyecta bajo demanda al pagar. Estas pruebas fijan que
 * index.html no lo vuelva a cargar, que la carga se haga una sola vez y que un fallo
 * de red deje reintentar.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const w = window as unknown as { WidgetCheckout?: unknown };

const scriptsWompi = () =>
    Array.from(document.head.querySelectorAll('script')).filter((s) => s.src.includes('checkout.wompi.co/widget.js'));

beforeEach(() => {
    vi.resetModules();
    scriptsWompi().forEach((s) => s.remove());
    delete w.WidgetCheckout;
});

afterEach(() => {
    vi.useRealTimers();
    delete w.WidgetCheckout;
});

describe('cargarWidgetWompi', () => {
    it('index.html ya no carga el widget de forma síncrona', () => {
        const html = readFileSync(join(__dirname, '..', '..', 'index.html'), 'utf8');
        expect(html).not.toMatch(/<script[^>]+checkout\.wompi\.co\/widget\.js/);
    });

    it('si el Widget ya está, resuelve true sin inyectar nada', async () => {
        w.WidgetCheckout = class {};
        const { cargarWidgetWompi } = await import('@/lib/wompiWidget');
        await expect(cargarWidgetWompi()).resolves.toBe(true);
        expect(scriptsWompi()).toHaveLength(0);
    });

    it('inyecta el script una sola vez aunque lo pidan dos llamadas a la vez', async () => {
        const { cargarWidgetWompi } = await import('@/lib/wompiWidget');
        const a = cargarWidgetWompi();
        const b = cargarWidgetWompi();
        expect(scriptsWompi()).toHaveLength(1);
        w.WidgetCheckout = class {};
        scriptsWompi()[0].dispatchEvent(new Event('load'));
        await expect(a).resolves.toBe(true);
        await expect(b).resolves.toBe(true);
    });

    it('si la red falla resuelve false y deja reintentar', async () => {
        const { cargarWidgetWompi } = await import('@/lib/wompiWidget');
        const primero = cargarWidgetWompi();
        scriptsWompi()[0].dispatchEvent(new Event('error'));
        await expect(primero).resolves.toBe(false);
        expect(scriptsWompi()).toHaveLength(0);

        const segundo = cargarWidgetWompi();
        expect(scriptsWompi()).toHaveLength(1);
        w.WidgetCheckout = class {};
        scriptsWompi()[0].dispatchEvent(new Event('load'));
        await expect(segundo).resolves.toBe(true);
    });

    it('si no carga a tiempo resuelve false', async () => {
        vi.useFakeTimers();
        const { cargarWidgetWompi } = await import('@/lib/wompiWidget');
        const p = cargarWidgetWompi(1000);
        vi.advanceTimersByTime(1001);
        await expect(p).resolves.toBe(false);
    });
});
