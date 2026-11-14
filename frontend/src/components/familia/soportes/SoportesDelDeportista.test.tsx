/**
 * Soportes del deportista (familia): apagado = nada; con faltantes = lista con «Subir»;
 * valida en el cliente y sube por base64. BFF moqueado. Sin lenguaje de cobro.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => {
    class BFFError extends Error {
        constructor(public status: number, message: string, public body?: unknown) { super(message); }
    }
    return { bff: { get: vi.fn(), post: vi.fn() }, BFFError };
});
vi.mock('@/lib/api/bffClient', () => ({ bffClient: h.bff, BFFError: h.BFFError }));
const toastEstable = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => toastEstable }));

import { SoportesDelDeportista } from './SoportesDelDeportista';
import { PROHIBIDAS, renderConQuery } from '../utilsPrueba';

const ESC = 'eb3ebc77-4ea4-4992-96c8-3c8ec574578c';
const props = { schoolId: ESC, tipoSujeto: 'child' as const, sujetoId: 'h1', nombre: 'Ana Pérez' };
const RUTA = `/api/v1/soportes/${ESC}/deportistas/child/h1`;

const estado = (x: Record<string, unknown> = {}) => ({
    activo: true, completo: false,
    requeridos: ['athlete_photo', 'eps_certificate', 'athlete_signature'],
    faltan: ['athlete_photo', 'eps_certificate'], ...x,
});

function archivar(input: HTMLElement, f: File) {
    Object.defineProperty(input, 'files', { value: [f], configurable: true });
    fireEvent.change(input);
}

beforeEach(() => { vi.clearAllMocks(); });

describe('SoportesDelDeportista', () => {
    it('si la escuela no los exige no pinta nada', async () => {
        h.bff.get.mockResolvedValue(estado({ activo: false, faltan: [], requeridos: [] }));
        const { container } = renderConQuery(<SoportesDelDeportista {...props} />);
        await waitFor(() => expect(h.bff.get).toHaveBeenCalledWith(RUTA));
        expect(container).toBeEmptyDOMElement();
    });

    it('si el BFF falla (sin permiso, sin migración) no pinta nada', async () => {
        h.bff.get.mockRejectedValue(new h.BFFError(403, 'x'));
        const { container } = renderConQuery(<SoportesDelDeportista {...props} />);
        await waitFor(() => expect(h.bff.get).toHaveBeenCalled());
        expect(container).toBeEmptyDOMElement();
    });

    it('sin escuela o sin deportista no consulta', () => {
        const { container } = renderConQuery(<SoportesDelDeportista {...props} schoolId={null} />);
        expect(container).toBeEmptyDOMElement();
        expect(h.bff.get).not.toHaveBeenCalled();
    });

    it('muestra qué falta con una fila y un botón Subir por cada soporte', async () => {
        h.bff.get.mockResolvedValue(estado());
        renderConQuery(<SoportesDelDeportista {...props} />);
        expect(await screen.findByText('Faltan 2 de 3 soportes de Ana.')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Subir Foto del deportista' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Subir Certificado de la EPS' })).toBeInTheDocument();
        expect(screen.getAllByRole('listitem')).toHaveLength(2);
    });

    it('cuando están completos lo dice y no ofrece subir', async () => {
        h.bff.get.mockResolvedValue(estado({ completo: true, faltan: [] }));
        renderConQuery(<SoportesDelDeportista {...props} />);
        expect(await screen.findByText('Los soportes de Ana están completos.')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Subir/ })).not.toBeInTheDocument();
    });

    it('valida en el cliente: una foto no acepta PDF y nada se envía', async () => {
        h.bff.get.mockResolvedValue(estado());
        const { baseElement } = renderConQuery(<SoportesDelDeportista {...props} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Subir Foto del deportista' }));
        archivar(baseElement.querySelector('input[type=file]') as HTMLElement,
            new File(['x'], 'foto.pdf', { type: 'application/pdf' }));
        await waitFor(() => expect(toastEstable.toast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive', description: expect.stringMatching(/foto/i) })));
        expect(h.bff.post).not.toHaveBeenCalled();
    });

    it('sube el archivo en base64 al tipo correcto y refresca el estado', async () => {
        h.bff.get.mockResolvedValue(estado());
        h.bff.post.mockResolvedValue({ id: 'd1', tipo: 'eps_certificate', activo: true, completo: false, faltan: ['athlete_photo'] });
        const { baseElement } = renderConQuery(<SoportesDelDeportista {...props} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Subir Certificado de la EPS' }));
        archivar(baseElement.querySelector('input[type=file]') as HTMLElement,
            new File(['hola'], 'eps.pdf', { type: 'application/pdf' }));
        await waitFor(() => expect(h.bff.post).toHaveBeenCalledWith(`${RUTA}/eps_certificate`, {
            archivoBase64: btoa('hola'), nombre: 'eps.pdf',
        }));
        await waitFor(() => expect(h.bff.get.mock.calls.length).toBeGreaterThan(1));
    });

    it('ningún texto habla de cobro, mora o deuda', async () => {
        h.bff.get.mockResolvedValue(estado());
        const { baseElement } = renderConQuery(<SoportesDelDeportista {...props} />);
        await screen.findByText(/Faltan 2/);
        expect(baseElement.textContent).not.toMatch(PROHIBIDAS);
        expect(baseElement.textContent).not.toMatch(/cobr|pago|pagar/i);
    });
});
