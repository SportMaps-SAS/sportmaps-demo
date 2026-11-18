import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const bff = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
const toastEstable = vi.hoisted(() => ({ toast: () => {} }));
vi.mock('@/lib/api/bffClient', () => ({ bffClient: bff }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => toastEstable }));

const bffClient = bff;
import { PorClasificarCard, explicarErrorDeCreacion, diasEsperando } from './PorClasificarCard';

const fila = (o: Record<string, unknown> = {}) => ({
    id: 'f1', contacto: '573001234567', contacto_nombre: 'Isaac Zaidman', monto: 150000, referencia: 'M20540656',
    fecha_comprobante: '2026-11-15', banco: 'Nequi', etiqueta: 'servicio_nuevo', propuesta: { texto: 'Isaac zaidman' },
    created_at: new Date(Date.now() - 3 * 86_400_000).toISOString(), archivo_url: null, ...o,
});

describe('PorClasificarCard', () => {
    it('no pinta nada si no hay comprobantes por clasificar', async () => {
        (bffClient.get as any).mockResolvedValueOnce({ filas: [], servicios: [] });
        const { container } = render(<PorClasificarCard schoolId="s1" />);
        await waitFor(() => expect(bffClient.get).toHaveBeenCalled());
        expect(container.querySelector('[data-testid="por-clasificar"]')).toBeNull();
    });

    it('no pinta nada ni se rompe si el BFF falla (sin permiso o sin migración)', async () => {
        (bffClient.get as any).mockRejectedValueOnce(new Error('403'));
        const { container } = render(<PorClasificarCard schoolId="s1" />);
        await waitFor(() => expect(bffClient.get).toHaveBeenCalled());
        expect(container.querySelector('[data-testid="por-clasificar"]')).toBeNull();
    });

    it('lista cada comprobante con monto, etiqueta y las tres salidas', async () => {
        (bffClient.get as any).mockResolvedValueOnce({ filas: [fila()], servicios: [] });
        render(<PorClasificarCard schoolId="s1" />);
        expect(await screen.findByText('Comprobantes por clasificar')).toBeTruthy();
        expect(screen.getByText('Servicio nuevo')).toBeTruthy();
        expect(screen.getByText('hace 3 días')).toBeTruthy();
        for (const t of ['Crear cobro', 'Aplicar a un cobro', 'Descartar']) expect(screen.getByRole('button', { name: t })).toBeTruthy();
    });
});

describe('helpers', () => {
    it('explica por qué la base no creó el cobro, con los números', () => {
        const t = explicarErrorDeCreacion({ error: 'monto_no_coincide', precio: 350000, abono_minimo: 175000 }, 150000);
        expect(t).toContain('$150.000');
        expect(t).toContain('$350.000');
        expect(t).toContain('$175.000');
    });
    it('cuenta los días de espera', () => {
        expect(diasEsperando('2026-11-15T12:00:00Z', Date.parse('2026-11-18T12:00:00Z'))).toBe(3);
        expect(diasEsperando('2026-11-18T12:00:00Z', Date.parse('2026-11-18T13:00:00Z'))).toBe(0);
    });
});
