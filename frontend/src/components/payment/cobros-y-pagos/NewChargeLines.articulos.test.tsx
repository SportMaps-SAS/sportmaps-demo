import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { NewChargeLines } from './NewChargeLines';
import { newLineDraft, type NewLineDraft } from '@/lib/cobrosYPagos';
import { articuloElegido, conceptoDeArticulo, tallasDe, type ArticuloDeCatalogo } from '@/lib/catalogoDeArticulos';

vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));

const GUANTES: ArticuloDeCatalogo = { id: 'a1', name: 'Guantes', price: 45_000, size_options: 'S, M, L' };
const GUANTES_PRO: ArticuloDeCatalogo = { id: 'a2', name: 'Guantes pro', price: 90_000, size_options: null };
const CATALOGO = [GUANTES, GUANTES_PRO];

function montar(lines: NewLineDraft[], articulos: ArticuloDeCatalogo[] = CATALOGO) {
    const onChange = vi.fn();
    render(<NewChargeLines
        mode="single" lines={lines} onChange={onChange} calcByRef={new Map()} paymentOn={false} canDiscount={false} canOverage={false}
        defaultDue="2026-11-30" minDue="2026-11-20" articulos={articulos} />);
    return onChange;
}

const linea = (over: Partial<NewLineDraft> = {}) =>
    newLineDraft({ category: 'articulos', concept: 'Artículos', due_date: '2026-11-30', amount: null, ...over });

describe('catálogo de artículos: funciones puras', () => {
    it('tallas y detalle', () => {
        expect(tallasDe(GUANTES)).toEqual(['S', 'M', 'L']);
        expect(tallasDe(GUANTES_PRO)).toEqual([]);
        expect(conceptoDeArticulo(GUANTES, 'M')).toBe('Guantes talla M');
        expect(conceptoDeArticulo(GUANTES_PRO)).toBe('Guantes pro');
    });

    it('deduce el ítem y la talla del detalle escrito', () => {
        expect(articuloElegido('Guantes talla M', CATALOGO)).toEqual({ item: GUANTES, talla: 'M' });
        expect(articuloElegido('Guantes', CATALOGO)).toEqual({ item: GUANTES, talla: null });
        expect(articuloElegido('Guantes pro', CATALOGO)?.item.id).toBe('a2');
        expect(articuloElegido('Guantes talla XXL', CATALOGO)).toEqual({ item: GUANTES, talla: null });
        expect(articuloElegido('Artículos', CATALOGO)).toBeNull();
        expect(articuloElegido('', CATALOGO)).toBeNull();
    });
});

describe('<NewChargeLines /> línea «Artículos / uniformes» con catálogo', () => {
    it('ofrece los ítems del catálogo con su precio', () => {
        montar([linea()]);
        expect(screen.getByTestId('cyp-articulos-0')).toBeTruthy();
        expect(screen.getByRole('button', { name: /Guantes · / })).toBeTruthy();
        expect(screen.getByRole('button', { name: /Guantes pro · / })).toBeTruthy();
    });

    it('elegir un ítem llena el detalle (con la primera talla) y el valor', () => {
        const onChange = montar([linea()]);
        fireEvent.click(screen.getByRole('button', { name: /Guantes · / }));
        expect((onChange.mock.calls[0][0] as NewLineDraft[])[0]).toMatchObject({ concept: 'Guantes talla S', amount: 45_000, category: 'articulos' });
    });

    it('un ítem sin tallas queda solo con el nombre', () => {
        const onChange = montar([linea()]);
        fireEvent.click(screen.getByRole('button', { name: /Guantes pro · / }));
        expect((onChange.mock.calls[0][0] as NewLineDraft[])[0]).toMatchObject({ concept: 'Guantes pro', amount: 90_000 });
    });

    it('cambiar la talla cambia el detalle y respeta el valor que la escuela haya editado', () => {
        const onChange = montar([linea({ concept: 'Guantes talla S', amount: 40_000 })]);
        fireEvent.click(screen.getByRole('button', { name: 'L' }));
        const l = (onChange.mock.calls[0][0] as NewLineDraft[])[0];
        expect(l.concept).toBe('Guantes talla L');
        expect(l.amount).toBe(40_000);
    });

    it('sin catálogo, o en otro tipo de cobro, no aparece', () => {
        montar([linea()], []);
        expect(screen.queryByTestId('cyp-articulos-0')).toBeNull();
    });
    it('no aparece en una línea de torneo', () => {
        montar([linea({ category: 'torneo', concept: 'Torneo' })]);
        expect(screen.queryByTestId('cyp-articulos-0')).toBeNull();
    });
});
