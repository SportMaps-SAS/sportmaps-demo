/**
 * «Chat» de la barra de abajo: para la escuela abre el buzón de WhatsApp
 * (2026-10-13); los demás roles siguen en /messages hasta que se decida.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const auth = vi.hoisted(() => ({ role: 'school', rolEscuela: null as string | null }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ profile: { role: auth.role } }) }));
vi.mock('@/hooks/useSchoolContext', () => ({ useSchoolContext: () => ({ currentUserRole: auth.rolEscuela }) }));
vi.mock('@/hooks/useMySchoolStore', () => ({ useMySchoolStore: () => ({ showStore: false }) }));

import { MobileBottomNav } from './MobileBottomNav';
import { ACUDIENTE_V2, ENTRENADOR_V2, DEPORTISTA_V2 } from '@/lib/feature-flags';

const enlace = (texto: string) => screen.getByText(texto).closest('a')!;

describe('MobileBottomNav · Chat', () => {
    it('escuela: Chat → Comunicaciones, y se marca activo estando en /whatsapp', () => {
        auth.role = 'school';
        render(<MemoryRouter initialEntries={['/whatsapp?tab=bandeja']}><MobileBottomNav /></MemoryRouter>);
        expect(enlace('Chat')).toHaveAttribute('href', '/messages');
        expect(enlace('Chat').className).toContain('text-primary');
    });

    // Con la reversa del entrenador (VITE_ENTRENADOR_V2=false) vuelve el Chat a /messages.
    it.skipIf(ENTRENADOR_V2)('entrenador clásico: sigue en /messages', () => {
        auth.role = 'coach';
        render(<MemoryRouter initialEntries={['/dashboard']}><MobileBottomNav /></MemoryRouter>);
        expect(enlace('Chat')).toHaveAttribute('href', '/messages');
    });
});

const textosBarra = () =>
    Array.from(screen.getByTestId('mobile-bottom-nav').querySelectorAll('a')).map((a) => a.textContent);

describe.skipIf(!ENTRENADOR_V2)('MobileBottomNav · entrenador V2', () => {
    it('Hoy · Equipos · Sesiones · Asistencia · Más; Mensajes vive en Más', () => {
        auth.role = 'coach';
        const { unmount } = render(<MemoryRouter initialEntries={['/dashboard']}><MobileBottomNav /></MemoryRouter>);
        expect(textosBarra()).toEqual(['Hoy', 'Equipos', 'Sesiones', 'Asistencia', 'Más']);
        unmount();
        render(<MemoryRouter initialEntries={['/messages']}><MobileBottomNav /></MemoryRouter>);
        expect(enlace('Más').className).toContain('text-primary');
    });
});

describe.skipIf(!DEPORTISTA_V2)('MobileBottomNav · deportista V2', () => {
    it('Hoy · Entrenos · Progreso · Carnet · Más; Pagos vive en Más', () => {
        auth.role = 'athlete';
        const { unmount } = render(<MemoryRouter initialEntries={['/dashboard']}><MobileBottomNav /></MemoryRouter>);
        expect(textosBarra()).toEqual(['Hoy', 'Entrenos', 'Progreso', 'Carnet', 'Más']);
        unmount();
        render(<MemoryRouter initialEntries={['/athlete-payments']}><MobileBottomNav /></MemoryRouter>);
        expect(enlace('Más').className).toContain('text-primary');
    });

    // Multirol (8 cuentas reales athlete/parent): manda el rol de la escuela activa.
    it('perfil de acudiente que entra como deportista ve la barra del deportista', () => {
        auth.role = 'parent';
        auth.rolEscuela = 'athlete';
        render(<MemoryRouter initialEntries={['/dashboard']}><MobileBottomNav /></MemoryRouter>);
        expect(textosBarra()).toEqual(['Hoy', 'Entrenos', 'Progreso', 'Carnet', 'Más']);
        auth.rolEscuela = null;
    });

    // Perfil de escuela que entra a una sede como coach: se queda con su barra de escuela.
    it('perfil de escuela con membresía coach conserva la barra de escuela', () => {
        auth.role = 'school';
        auth.rolEscuela = 'coach';
        render(<MemoryRouter initialEntries={['/dashboard']}><MobileBottomNav /></MemoryRouter>);
        expect(enlace('Chat')).toHaveAttribute('href', '/messages');
        expect(screen.queryByText('Sesiones')).toBeNull();
        auth.rolEscuela = null;
    });
});

// Con VITE_ACUDIENTE_V2=false (reversa) la barra del acudiente vuelve a la anterior.
describe.skipIf(!ACUDIENTE_V2)('MobileBottomNav · acudiente V2', () => {
    it('cinco pestañas en orden y la quinta es «Más»; sin Chat', () => {
        auth.role = 'parent';
        render(<MemoryRouter initialEntries={['/dashboard']}><MobileBottomNav /></MemoryRouter>);
        const textos = Array.from(screen.getByTestId('mobile-bottom-nav').querySelectorAll('a')).map((a) => a.textContent);
        expect(textos).toEqual(['Inicio', 'Calendario', 'Hijos', 'Pagos', 'Más']);
        expect(enlace('Más')).toHaveAttribute('href', '/mas');
        expect(screen.queryByText('Chat')).toBeNull();
    });

    it('las pantallas que viven dentro de una pestaña la encienden', () => {
        auth.role = 'parent';
        const { unmount } = render(<MemoryRouter initialEntries={['/my-cards']}><MobileBottomNav /></MemoryRouter>);
        expect(enlace('Más').className).toContain('text-primary');
        unmount();
        render(<MemoryRouter initialEntries={['/estado-cuenta']}><MobileBottomNav /></MemoryRouter>);
        expect(enlace('Pagos').className).toContain('text-primary');
        expect(enlace('Inicio').className).not.toContain('text-primary');
    });
});
