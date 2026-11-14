import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ExternoBadge, TipoDeCobroBadge } from './TipoDeCobroBadge';
import { FiltroTipoDeCobro, TODOS_LOS_TIPOS } from './FiltroTipoDeCobro';

// Insignia y filtro de Gestión de Pagos por tipo (blindaje ventas de servicio §4.D).

describe('TipoDeCobroBadge', () => {
    it('la clínica dice qué es y cuál: «Clínica · <servicio>»', () => {
        render(<TipoDeCobroBadge payment={{ payment_category: 'clase_extra', concept: 'Clínica de armadores y atacantes — Nicolás Cubides' }} />);
        const b = screen.getByText('Clínica · Clínica de armadores y atacantes');
        expect(b).toHaveAttribute('data-tipo-de-cobro', 'clinica');
        expect(b).toHaveAttribute('title', 'Clínica · Clínica de armadores y atacantes');
    });

    it('sin servicio: solo el tipo', () => {
        render(<TipoDeCobroBadge payment={{ payment_category: null, concept: 'Mensualidad 11/2026 - Zoe' }} />);
        expect(screen.getByText('Mensualidad')).toHaveAttribute('data-tipo-de-cobro', 'mensualidad');
    });

    it('conServicio={false} deja solo la etiqueta (el nombre completo queda en el title)', () => {
        render(<TipoDeCobroBadge conServicio={false} payment={{ payment_category: 'torneo', concept: 'Torneo · Mayores — Juan' }} />);
        const b = screen.getByText('Torneo');
        expect(b).toHaveAttribute('title', 'Torneo · Mayores');
    });

    it('ExternoBadge', () => {
        render(<ExternoBadge />);
        expect(screen.getByText('Externo')).toHaveAttribute('title', expect.stringMatching(/prospecto/));
    });
});

describe('FiltroTipoDeCobro', () => {
    const conteos = { mensualidad: 12, clinica: 1, clase_prueba: 2 };

    it('chips con conteo, en el orden del filtro, y «Todos» con el total', () => {
        render(<FiltroTipoDeCobro conteos={conteos} valor={TODOS_LOS_TIPOS} onChange={() => {}} />);
        const botones = screen.getAllByRole('button').map((b) => b.textContent);
        expect(botones).toEqual(['Todos (15)', 'Mensualidad (12)', 'Clase de prueba / cortesía (2)', 'Clínica (1)']);
        expect(screen.getByRole('button', { name: 'Todos (15)' })).toHaveAttribute('aria-pressed', 'true');
    });

    it('elegir un tipo lo filtra; tocar el activo vuelve a «Todos»', () => {
        const onChange = vi.fn();
        const { rerender } = render(<FiltroTipoDeCobro conteos={conteos} valor={TODOS_LOS_TIPOS} onChange={onChange} />);
        fireEvent.click(screen.getByRole('button', { name: 'Clínica (1)' }));
        expect(onChange).toHaveBeenLastCalledWith('clinica');
        rerender(<FiltroTipoDeCobro conteos={conteos} valor="clinica" onChange={onChange} />);
        expect(screen.getByRole('button', { name: 'Clínica (1)' })).toHaveAttribute('aria-pressed', 'true');
        fireEvent.click(screen.getByRole('button', { name: 'Clínica (1)' }));
        expect(onChange).toHaveBeenLastCalledWith(TODOS_LOS_TIPOS);
    });

    it('el tipo elegido se mantiene en 0 cuando la búsqueda lo vacía', () => {
        render(<FiltroTipoDeCobro conteos={{ mensualidad: 3 }} valor="torneo" onChange={() => {}} />);
        expect(screen.getByRole('button', { name: 'Torneo (0)' })).toHaveAttribute('aria-pressed', 'true');
    });

    it('variante select: opciones con conteo y cambio por valor', () => {
        const onChange = vi.fn();
        render(<FiltroTipoDeCobro variante="select" conteos={conteos} valor={TODOS_LOS_TIPOS} onChange={onChange} />);
        const select = screen.getByRole('combobox', { name: 'Tipo de cobro' });
        expect(Array.from((select as HTMLSelectElement).options).map((o) => o.textContent)).toEqual([
            'Todos los tipos (15)', 'Mensualidad (12)', 'Clase de prueba / cortesía (2)', 'Clínica (1)',
        ]);
        fireEvent.change(select, { target: { value: 'clase_prueba' } });
        expect(onChange).toHaveBeenCalledWith('clase_prueba');
    });
});
