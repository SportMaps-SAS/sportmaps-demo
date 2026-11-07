/**
 * Plan del deportista (familia): pausa / retiro / reactivación, «Mis solicitudes» y cancelar.
 * BFF y config de pausa moqueados.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => {
    class BFFError extends Error {
        constructor(public status: number, message: string, public body?: unknown) { super(message); }
    }
    return { bff: { get: vi.fn(), post: vi.fn(), delete: vi.fn() }, BFFError, config: { data: undefined as unknown } };
});
vi.mock('@/lib/api/bffClient', () => ({ bffClient: h.bff, BFFError: h.BFFError }));
vi.mock('@/hooks/usePauses', () => ({ usePauseConfig: () => h.config }));
const toastEstable = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => toastEstable }));

import { PlanDelDeportista } from './PlanDelDeportista';
import { renderConQuery } from '../utilsPrueba';

const HOY = '2026-11-06';
const activa = [{ id: 'e1', status: 'active', etiqueta: 'Voleibol Sub 14' }];
const solicitud = (x: Record<string, unknown> = {}) => ({
    id: 's1', tipo: 'pausa', enrollment_id: 'e1', school_id: 'sc', estado: 'solicitado', atleta_nombre: 'Ana Pérez',
    desde: '2026-12-01', hasta: '2027-01-01', motivo: 'vacation', detalle_motivo: null, canal: 'app',
    solicitante_rol: 'parent', auto_aprobada: false, fuera_de_tope: true, nota_administracion: null,
    creada_at: '2026-11-06T10:00:00Z', resuelta_at: null, ...x,
});

beforeEach(() => {
    vi.clearAllMocks();
    h.config.data = { enabled: true, parent_can_request: true, max_months: 3, enrollment_active: true };
    h.bff.get.mockResolvedValue({ solicitudes: [] });
});

describe('PlanDelDeportista', () => {
    it('sin inscripciones no pinta nada', () => {
        const { container } = renderConQuery(<PlanDelDeportista nombre="Ana Pérez" inscripciones={[]} hoy={HOY} />);
        expect(container).toBeEmptyDOMElement();
        expect(h.bff.get).not.toHaveBeenCalled();
    });

    it('si la función no está montada (503) no pinta nada', async () => {
        h.bff.get.mockRejectedValue(new h.BFFError(503, 'x', { code: 'migracion_pendiente' }));
        const { container } = renderConQuery(<PlanDelDeportista nombre="Ana Pérez" inscripciones={activa} hoy={HOY} />);
        await waitFor(() => expect(h.bff.get).toHaveBeenCalled());
        await waitFor(() => expect(container).toBeEmptyDOMElement());
    });

    it('la pausa solo se ofrece si la escuela la tiene prendida; el retiro sí', async () => {
        h.config.data = { enabled: false, parent_can_request: true, max_months: 0, enrollment_active: true };
        renderConQuery(<PlanDelDeportista nombre="Ana Pérez" inscripciones={activa} hoy={HOY} />);
        expect(await screen.findByRole('button', { name: /Pedir retiro/ })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Pausar el plan/ })).not.toBeInTheDocument();
    });

    it('pide la pausa y dice que quedó aprobada sola', async () => {
        h.bff.post.mockResolvedValue({ request_id: 'r1', status: 'approved', auto_aprobada: true, fuera_de_tope: false });
        renderConQuery(<PlanDelDeportista nombre="Ana Pérez" inscripciones={activa} hoy={HOY} />);
        fireEvent.click(await screen.findByRole('button', { name: /Pausar el plan/ }));
        fireEvent.change(await screen.findByLabelText('Desde el mes'), { target: { value: '2026-12' } });
        fireEvent.change(screen.getByLabelText('Hasta el mes'), { target: { value: '2027-02' } });
        expect(screen.getByText(/3 meses/)).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Enviar solicitud' }));
        await waitFor(() => expect(h.bff.post).toHaveBeenCalledWith('/api/v1/plan-requests/pausa', {
            enrollment_id: 'e1', reason: 'vacation', month_from: '2026-12', month_to: '2027-02', note: undefined,
        }));
        expect(await screen.findByText(/Tu pausa quedó aprobada/)).toBeInTheDocument();
    });

    it('si la pausa queda fuera del tope lo explica como pendiente', async () => {
        h.bff.post.mockResolvedValue({ request_id: 'r1', status: 'pending', auto_aprobada: false, fuera_de_tope: true, tope: 2 });
        renderConQuery(<PlanDelDeportista nombre="Ana Pérez" inscripciones={activa} hoy={HOY} />);
        fireEvent.click(await screen.findByRole('button', { name: /Pausar el plan/ }));
        fireEvent.click(await screen.findByRole('button', { name: 'Enviar solicitud' }));
        expect(await screen.findByText(/cupo es de 2 meses/)).toBeInTheDocument();
    });

    it('no envía una pausa con un rango inválido (más de 12 meses)', async () => {
        renderConQuery(<PlanDelDeportista nombre="Ana Pérez" inscripciones={activa} hoy={HOY} />);
        fireEvent.click(await screen.findByRole('button', { name: /Pausar el plan/ }));
        fireEvent.change(await screen.findByLabelText('Hasta el mes'), { target: { value: '2027-11' } });
        fireEvent.click(screen.getByRole('button', { name: 'Enviar solicitud' }));
        expect(await screen.findByRole('alert')).toHaveTextContent(/hasta 12 meses/);
        expect(h.bff.post).not.toHaveBeenCalled();
    });

    it('el retiro exige fecha, explica que no cancela nada y lo envía', async () => {
        h.bff.post.mockResolvedValue({ request_id: 'r2', status: 'solicitado', kind: 'retiro', effective_date: '2026-12-20' });
        renderConQuery(<PlanDelDeportista nombre="Ana Pérez" inscripciones={activa} hoy={HOY} />);
        fireEvent.click(await screen.findByRole('button', { name: /Pedir retiro/ }));
        expect(await screen.findByText(/No se cancela nada hasta que la apruebe/)).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Enviar solicitud' }));
        expect(await screen.findByRole('alert')).toHaveTextContent('Elige la fecha de salida.');
        expect(h.bff.post).not.toHaveBeenCalled();
        fireEvent.change(screen.getByLabelText('Fecha de salida'), { target: { value: '2026-12-20' } });
        fireEvent.click(screen.getByRole('button', { name: 'Enviar solicitud' }));
        await waitFor(() => expect(h.bff.post).toHaveBeenCalledWith('/api/v1/plan-requests/retiro', {
            enrollment_id: 'e1', exit_date: '2026-12-20', reason: undefined,
        }));
    });

    it('una inscripción inactiva ofrece reactivar con el mes de regreso', async () => {
        h.bff.post.mockResolvedValue({ request_id: 'r3', status: 'solicitado' });
        renderConQuery(<PlanDelDeportista nombre="Ana Pérez" inscripciones={[{ id: 'e2', status: 'cancelled' }]} hoy={HOY} />);
        fireEvent.click(await screen.findByRole('button', { name: /Reactivar el plan/ }));
        fireEvent.change(await screen.findByLabelText('Mes de regreso'), { target: { value: '2027-01' } });
        fireEvent.click(screen.getByRole('button', { name: 'Enviar solicitud' }));
        await waitFor(() => expect(h.bff.post).toHaveBeenCalledWith('/api/v1/plan-requests/reactivacion', {
            enrollment_id: 'e2', from_month: '2027-01', reason: undefined,
        }));
    });

    it('lista mis solicitudes con su estado y cancela solo las abiertas', async () => {
        h.bff.get.mockResolvedValue({ solicitudes: [
            solicitud(),
            solicitud({ id: 's2', tipo: 'retiro', estado: 'aprobado', desde: '2026-12-20', hasta: null, fuera_de_tope: null }),
            solicitud({ id: 's3', enrollment_id: 'otra' }),
        ] });
        h.bff.delete.mockResolvedValue({ status: 'cancelado' });
        renderConQuery(<PlanDelDeportista nombre="Ana Pérez" inscripciones={activa} hoy={HOY} />);
        expect(await screen.findByText('Mis solicitudes')).toBeInTheDocument();
        expect(screen.getByText('En revisión')).toBeInTheDocument();
        expect(screen.getByText('Aprobada')).toBeInTheDocument();
        expect(screen.getByText('diciembre 2026 a enero 2027')).toBeInTheDocument();
        const cancelar = screen.getAllByRole('button', { name: /Cancelar solicitud/ });
        expect(cancelar).toHaveLength(1);
        fireEvent.click(cancelar[0]);
        await waitFor(() => expect(h.bff.delete).toHaveBeenCalledWith('/api/v1/plan-requests/pausa/s1'));
    });

    it('con una pausa abierta no deja pedir otra igual', async () => {
        h.bff.get.mockResolvedValue({ solicitudes: [solicitud()] });
        renderConQuery(<PlanDelDeportista nombre="Ana Pérez" inscripciones={activa} hoy={HOY} />);
        await screen.findByText('Mis solicitudes');
        expect(screen.getByRole('button', { name: /Pausar el plan/ })).toBeDisabled();
    });
});
