/** Aviso de referido ganado (`referral_won`) en el centro de notificaciones V2: solo texto y enlace. */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { NotificacionesV2, type NotificacionV2 } from './NotificacionesV2';

const largo = 'Tu referido Ana Pérez ya cumplió su primer mes. Ganaste un mes de descuento en tu próxima cuota, que se aplica solo.';
const ganado: NotificacionV2 = {
    id: 'r1', type: 'referral_won', title: 'Ganaste un descuento por referir', message: largo,
    created_at: '2026-11-06T10:00:00Z', read: false, link: '/my-payments',
};
const otra: NotificacionV2 = { id: 'o1', type: 'info', title: 'Aviso', message: 'Texto', created_at: '2026-11-05T10:00:00Z', read: true, link: null };

describe('NotificacionesV2 · referido ganado', () => {
    it('marca el aviso con «Referido ganado», muestra el mensaje completo y lleva al enlace', () => {
        const onOpen = vi.fn();
        const { container } = render(
            <NotificacionesV2
                notifications={[ganado, otra]} isLoading={false} isError={false} onRetry={vi.fn()}
                filter="all" onFilter={vi.fn()} timeAgo={() => 'hace 1 h'} onOpen={onOpen}
                onMarkRead={vi.fn()} onDelete={vi.fn()} onMarkAll={vi.fn()}
            />,
        );
        expect(screen.getByText('Referido ganado')).toBeInTheDocument();
        expect(screen.getAllByText('Referido ganado')).toHaveLength(1);
        const mensaje = screen.getByText(largo);
        expect(mensaje.className).not.toContain('line-clamp');
        expect(container.querySelector('.line-clamp-3')).toBeTruthy(); // la otra notificación sí se recorta
        fireEvent.click(screen.getByText('Ganaste un descuento por referir'));
        expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'r1' }));
    });
});
