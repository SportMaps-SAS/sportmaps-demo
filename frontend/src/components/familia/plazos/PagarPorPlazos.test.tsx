/**
 * Pagar por plazos (familia): apagado = no sale nada; prendido = botón, calendario del BFF,
 * explicación cuando requiere aprobación, confirmar, mis acuerdos y cancelar.
 * BFF moqueado. Ningún texto habla de mora, deuda, atraso, multa ni recargo.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

const h = vi.hoisted(() => {
    class BFFError extends Error {
        constructor(public status: number, message: string, public body?: unknown) { super(message); }
    }
    return { bff: { get: vi.fn(), post: vi.fn() }, BFFError };
});
vi.mock('@/lib/api/bffClient', () => ({ bffClient: h.bff, BFFError: h.BFFError }));
const toastEstable = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => toastEstable }));

import { PagarPorPlazos } from './PagarPorPlazos';
import type { CobroAbierto } from './plazosModelo';
import { PROHIBIDAS, renderConQuery } from '../utilsPrueba';

const ESCUELA = 'eb3ebc77-4ea4-4992-96c8-3c8ec574578c';
const HOY = '2026-11-06';
const cobros: CobroAbierto[] = [
    { id: 'p1', school_id: ESCUELA, concept: 'Mensualidad noviembre', saldo: 100000 },
    { id: 'p2', school_id: ESCUELA, concept: 'Uniforme', saldo: 50000 },
];

const previa = (x: Record<string, unknown> = {}) => ({
    saldo_total: 150000,
    cuotas: [
        { seq: 1, fecha: '2026-12-06', monto: 75000 },
        { seq: 2, fecha: '2027-01-06', monto: 75000 },
    ],
    primera_fecha: '2026-12-06', ultima_fecha: '2027-01-06', dias: 61,
    requiere_aprobacion: false, motivos: [], ...x,
});

function rutas(opts: { habilitado?: boolean; acuerdos?: unknown[] } = {}) {
    h.bff.get.mockImplementation(async (path: string) => {
        if (path.includes('/settings/')) return { habilitado: opts.habilitado ?? true, max_cuotas: 3, max_dias: 60, auto_aprobar: true };
        if (path.endsWith('/mine')) return { acuerdos: opts.acuerdos ?? [] };
        throw new Error('ruta inesperada ' + path);
    });
}

beforeEach(() => { vi.clearAllMocks(); });

describe('PagarPorPlazos', () => {
    it('con la función apagada no pinta nada ni pide los acuerdos', async () => {
        rutas({ habilitado: false });
        const { container } = renderConQuery(<PagarPorPlazos cobros={cobros} hoy={HOY} />);
        await waitFor(() => expect(h.bff.get).toHaveBeenCalled());
        expect(container).toBeEmptyDOMElement();
        expect(h.bff.get.mock.calls.some((c) => String(c[0]).endsWith('/mine'))).toBe(false);
    });

    it('sin cobros abiertos no pregunta nada', () => {
        rutas();
        const { container } = renderConQuery(<PagarPorPlazos cobros={[]} hoy={HOY} />);
        expect(container).toBeEmptyDOMElement();
        expect(h.bff.get).not.toHaveBeenCalled();
    });

    it('arma el calendario con el BFF y confirma un plan que queda activo', async () => {
        rutas();
        h.bff.post.mockImplementation(async (path: string) => {
            if (path.endsWith('/preview')) return previa();
            return { agreement_id: 'a1', status: 'activo', auto_aprobado: true, total: 150000, cuotas: 2 };
        });
        renderConQuery(<PagarPorPlazos cobros={cobros} hoy={HOY} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Pagar por plazos' }));

        // Dos cuotas por defecto, con fecha sugerida y valor aproximado.
        expect(await screen.findByLabelText('Cuota 1')).toHaveValue('2026-12-06');
        expect(screen.getByLabelText('Cuota 2')).toHaveValue('2027-01-06');
        fireEvent.click(screen.getByRole('button', { name: 'Ver calendario' }));

        await waitFor(() => expect(h.bff.post).toHaveBeenCalledWith('/api/v1/payment-agreements/preview', {
            school_id: ESCUELA, payment_ids: ['p1', 'p2'], cuotas: 2, fechas: ['2026-12-06', '2027-01-06'],
        }));
        const calendario = await screen.findByRole('list', { name: 'Calendario de cuotas' });
        expect(within(calendario).getAllByRole('listitem')).toHaveLength(3);
        expect(screen.getByText('Este plan queda activo apenas lo confirmes.')).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Confirmar plan' }));
        await waitFor(() => expect(h.bff.post).toHaveBeenCalledWith('/api/v1/payment-agreements', {
            school_id: ESCUELA, payment_ids: ['p1', 'p2'],
            items: [{ due_date: '2026-12-06', amount: 75000 }, { due_date: '2027-01-06', amount: 75000 }],
        }));
        expect(await screen.findByText(/quedó activo/)).toBeInTheDocument();
    });

    it('explica con claridad cuando la escuela tiene que aprobar', async () => {
        rutas();
        h.bff.post.mockResolvedValue(previa({ requiere_aprobacion: true, motivos: ['mas_cuotas_del_tope', 'incumplio_antes'] }));
        renderConQuery(<PagarPorPlazos cobros={cobros} hoy={HOY} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Pagar por plazos' }));
        fireEvent.click(await screen.findByRole('button', { name: 'Ver calendario' }));
        expect(await screen.findByText('La escuela tiene que aprobar este plan')).toBeInTheDocument();
        expect(screen.getByText(/más cuotas de las que la escuela aprueba/)).toBeInTheDocument();
        expect(screen.getByText(/no se completó/)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Enviar solicitud' })).toBeInTheDocument();
    });

    it('no llama al BFF si las fechas son inválidas o no hay cobros elegidos', async () => {
        rutas();
        renderConQuery(<PagarPorPlazos cobros={cobros} hoy={HOY} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Pagar por plazos' }));
        fireEvent.change(await screen.findByLabelText('Cuota 2'), { target: { value: '2026-12-01' } });
        fireEvent.click(screen.getByRole('button', { name: 'Ver calendario' }));
        expect(await screen.findByRole('alert')).toHaveTextContent(/posterior a la anterior/);
        fireEvent.change(screen.getByLabelText('Cuota 2'), { target: { value: '2027-01-06' } });
        fireEvent.click(screen.getByLabelText(/Mensualidad noviembre/));
        fireEvent.click(screen.getByLabelText(/Uniforme/));
        fireEvent.click(screen.getByRole('button', { name: 'Ver calendario' }));
        expect(await screen.findByRole('alert')).toHaveTextContent('Elige al menos un cobro.');
        expect(h.bff.post).not.toHaveBeenCalled();
    });

    it('muestra el error del BFF en español', async () => {
        rutas();
        h.bff.post.mockRejectedValue(new h.BFFError(409, 'x', { error: 'cobro_ya_en_acuerdo' }));
        renderConQuery(<PagarPorPlazos cobros={cobros} hoy={HOY} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Pagar por plazos' }));
        fireEvent.click(await screen.findByRole('button', { name: 'Ver calendario' }));
        expect(await screen.findByRole('alert')).toHaveTextContent('Uno de esos cobros ya está en otro acuerdo.');
    });

    it('lista mis acuerdos con estado y próxima fecha, y permite cancelar', async () => {
        rutas({
            acuerdos: [{
                id: 'a1', status: 'activo', school_id: ESCUELA,
                items: [
                    { due_date: '2026-12-06', amount: 75000, status: 'pagado' },
                    { due_date: '2027-01-06', amount: 75000, status: 'pendiente' },
                ],
            }, {
                id: 'a2', status: 'solicitado', items: [{ due_date: '2027-03-01', amount: 10000, status: 'pendiente' }],
            }],
        });
        h.bff.post.mockResolvedValue({ agreement_id: 'a1', status: 'cancelado' });
        renderConQuery(<PagarPorPlazos cobros={cobros} hoy={HOY} />);

        expect(await screen.findByText('Mis acuerdos de pago')).toBeInTheDocument();
        expect(screen.getByText('Activo')).toBeInTheDocument();
        expect(screen.getByText('En revisión de la escuela')).toBeInTheDocument();
        expect(screen.getByText('Próxima fecha: 06/01/2027')).toBeInTheDocument();

        fireEvent.click(screen.getAllByRole('button', { name: 'Cancelar este acuerdo' })[0]);
        fireEvent.click(await screen.findByRole('button', { name: 'Sí, cancelar' }));
        await waitFor(() => expect(h.bff.post).toHaveBeenCalledWith('/api/v1/payment-agreements/a1/cancel', {}));
    });

    it('ningún texto visible usa lenguaje de mora, deuda, atraso, multa ni recargo', async () => {
        rutas({
            acuerdos: [{
                id: 'a1', status: 'incumplido',
                items: [{ due_date: '2026-12-06', amount: 75000, status: 'vencido' }],
            }],
        });
        h.bff.post.mockResolvedValue(previa({ requiere_aprobacion: true, motivos: ['mas_cuotas_del_tope', 'mas_dias_del_tope', 'sin_autoaprobacion', 'incumplio_antes'] }));
        const { baseElement } = renderConQuery(<PagarPorPlazos cobros={cobros} hoy={HOY} />);
        await screen.findByText('Mis acuerdos de pago');
        expect(baseElement.textContent).not.toMatch(PROHIBIDAS);
        fireEvent.click(screen.getByRole('button', { name: 'Pagar por plazos' }));
        expect(baseElement.textContent).not.toMatch(PROHIBIDAS);
        fireEvent.click(await screen.findByRole('button', { name: 'Ver calendario' }));
        await screen.findByText('La escuela tiene que aprobar este plan');
        expect(baseElement.textContent).not.toMatch(PROHIBIDAS);
    });
});
