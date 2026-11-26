/**
 * Paso 4 de docs/specs/seguridad-veredicto-comprobante-plan.md: qué cobros
 * re-sella scripts/resellar-cola-comprobantes.ts (y cuáles no gastan OCR).
 */
import { describe, it, expect, vi } from 'vitest';

// rutaDelComprobante vive junto al sellado, que importa el cliente: aquí no se toca la base.
vi.mock('../config/supabase', () => ({ supabase: {} }));
import {
    necesitaResellado, accionDeResellado, planDeResellado, conteoPorEscuela, loteDeEstaCorrida, opcionesResellado,
    claveArchivo, type FilaResellado,
} from './resellado-cola';

const A = 'escuela-a';
const B = 'escuela-b';
const f = (o: Partial<FilaResellado> & { id: string }): FilaResellado => ({
    school_id: A, status: 'awaiting_approval', receipt_url: `u1/${o.id}.jpg`, receipt_verdict: 'verde',
    receipt_image_sha256_source: 'client_original', amount_source: 'servidor', amount: 145000,
    receipt_submitted_at: '2026-11-20T10:00:00Z', created_at: '2026-11-01T00:00:00Z', ...o,
});

describe('selección del re-sellado', () => {
    it('entra lo que está por validar, con comprobante y sin sello del servidor', () => {
        expect(necesitaResellado(f({ id: 'a' }))).toBe(true);
        expect(necesitaResellado(f({ id: 'a', receipt_image_sha256_source: null }))).toBe(true);
        expect(necesitaResellado(f({ id: 'a', receipt_image_sha256_source: 'whatever' }))).toBe(true);
    });

    it('no entra lo ya sellado, lo que no está por validar ni lo que no tiene comprobante', () => {
        expect(necesitaResellado(f({ id: 'a', receipt_image_sha256_source: 'server_verified' }))).toBe(false);
        expect(necesitaResellado(f({ id: 'a', status: 'paid' }))).toBe(false);
        expect(necesitaResellado(f({ id: 'a', status: 'pending' }))).toBe(false);
        expect(necesitaResellado(f({ id: 'a', receipt_url: null }))).toBe(false);
        expect(necesitaResellado(f({ id: 'a', receipt_url: '  ' }))).toBe(false);
    });

    it('acción: sellar, compartido (otro cobro vivo con el archivo) o ruta inválida (sin OCR)', () => {
        const compartidos = new Set([claveArchivo(A, 'u1/comp.jpg')]);
        expect(accionDeResellado(f({ id: 'a' }), compartidos)).toBe('sellar');
        expect(accionDeResellado(f({ id: 'a', receipt_url: 'u1/comp.jpg' }), compartidos)).toBe('compartido');
        // El mismo archivo en OTRA escuela no cuenta.
        expect(accionDeResellado(f({ id: 'a', school_id: B, receipt_url: 'u1/comp.jpg' }), compartidos)).toBe('sellar');
        expect(accionDeResellado(f({ id: 'a', receipt_url: 'https://x.co/r.jpg' }), compartidos)).toBe('ruta_invalida');
        expect(accionDeResellado(f({ id: 'a', receipt_url: '../otro/r.jpg' }), compartidos)).toBe('ruta_invalida');
    });

    it('el plan filtra, clasifica y ordena del más viejo al más nuevo', () => {
        const plan = planDeResellado([
            f({ id: 'nuevo', receipt_submitted_at: '2026-11-25T10:00:00Z' }),
            f({ id: 'sellado', receipt_image_sha256_source: 'server_verified' }),
            f({ id: 'viejo', receipt_submitted_at: '2026-11-10T10:00:00Z' }),
            f({ id: 'sin-fecha', receipt_submitted_at: null, created_at: '2026-11-05T00:00:00Z' }),
            f({ id: 'pagado', status: 'paid' }),
        ], new Set());
        expect(plan.map((p) => p.fila.id)).toEqual(['sin-fecha', 'viejo', 'nuevo']);
        expect(plan.every((p) => p.accion === 'sellar')).toBe(true);
    });

    it('conteo por escuela con veredicto y fuente', () => {
        const plan = planDeResellado([
            f({ id: '1' }), f({ id: '2', receipt_verdict: 'amarillo', receipt_image_sha256_source: null }),
            f({ id: '3', receipt_url: 'https://x' }), f({ id: '4', school_id: B, receipt_verdict: null }),
        ], new Set());
        const c = conteoPorEscuela(plan);
        expect(c.map((x) => [x.schoolId, x.total, x.sellar, x.rutaInvalida])).toEqual([[A, 3, 2, 1], [B, 1, 1, 0]]);
        expect(c[0].porVeredicto).toEqual({ verde: 2, amarillo: 1 });
        expect(c[0].porFuente).toEqual({ client_original: 2, 'sin fuente': 1 });
        expect(c[1].porVeredicto).toEqual({ 'sin veredicto': 1 });
    });

    it('el lote de la corrida: solo «sellar», hasta el límite', () => {
        const plan = planDeResellado([
            f({ id: '1', receipt_submitted_at: '2026-11-01T00:00:00Z' }),
            f({ id: '2', receipt_url: 'https://x', receipt_submitted_at: '2026-11-02T00:00:00Z' }),
            f({ id: '3', receipt_submitted_at: '2026-11-03T00:00:00Z' }),
            f({ id: '4', receipt_submitted_at: '2026-11-04T00:00:00Z' }),
        ], new Set());
        expect(loteDeEstaCorrida(plan, 2).map((p) => p.fila.id)).toEqual(['1', '3']);
        expect(loteDeEstaCorrida(plan, 0)).toEqual([]);
        expect(loteDeEstaCorrida(plan, -1)).toEqual([]);
    });

    it('opciones: dry-run por defecto, límite 10 y pausa 4000 ms', () => {
        expect(opcionesResellado([])).toEqual({ aplicar: false, escuela: null, limite: 10, pausaMs: 4000 });
        expect(opcionesResellado(['--aplicar', '--escuela', A, '--limite', '41', '--pausa-ms', '2500']))
            .toEqual({ aplicar: true, escuela: A, limite: 41, pausaMs: 2500 });
        expect(opcionesResellado(['--limite', 'muchos']).limite).toBe(10);
        expect(opcionesResellado(['--limite', '-3']).limite).toBe(10);
    });
});
