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
        expect(articuloElegido('Guantes talla M', CATALOGO)).toEqual({ item: GUANTES, talla: 'M', cantidad: 1 });
        expect(articuloElegido('Guantes', CATALOGO)).toEqual({ item: GUANTES, talla: null, cantidad: 1 });
        expect(articuloElegido('Guantes pro', CATALOGO)?.item.id).toBe('a2');
        expect(articuloElegido('Guantes talla XXL', CATALOGO)).toEqual({ item: GUANTES, talla: null, cantidad: 1 });
        expect(articuloElegido('Guantes talla M x3', CATALOGO)).toEqual({ item: GUANTES, talla: 'M', cantidad: 3 });
        expect(articuloElegido('Guantes pro x2', CATALOGO)).toEqual({ item: GUANTES_PRO, talla: null, cantidad: 2 });
        const PACK: ArticuloDeCatalogo = { id: 'a3', name: 'Pack x2', price: 10_000, size_options: null };
        expect(articuloElegido('Pack x2', [PACK])).toEqual({ item: PACK, talla: null, cantidad: 1 });
        expect(articuloElegido('Pack x2 x4', [PACK])).toEqual({ item: PACK, talla: null, cantidad: 4 });
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

    it('la cantidad solo aparece con un ítem elegido', () => {
        montar([linea()]);
        expect(screen.queryByTestId('cyp-articulos-cantidad-0')).toBeNull();
    });

    it('subir la cantidad multiplica el valor y lo deja escrito en el detalle', () => {
        const onChange = montar([linea({ concept: 'Guantes talla M', amount: 45_000 })]);
        fireEvent.click(screen.getByRole('button', { name: 'Agregar una unidad' }));
        expect((onChange.mock.calls[0][0] as NewLineDraft[])[0]).toMatchObject({ concept: 'Guantes talla M x2', amount: 90_000 });
    });

    it('la cantidad respeta el precio unitario que la escuela editó', () => {
        const onChange = montar([linea({ concept: 'Guantes talla M x2', amount: 80_000 })]);
        fireEvent.click(screen.getByRole('button', { name: 'Agregar una unidad' }));
        expect((onChange.mock.calls[0][0] as NewLineDraft[])[0]).toMatchObject({ concept: 'Guantes talla M x3', amount: 120_000 });
    });

    it('bajar a una unidad quita el «x» del detalle; en 1 no se puede bajar más', () => {
        const onChange = montar([linea({ concept: 'Guantes pro x2', amount: 180_000 })]);
        fireEvent.click(screen.getByRole('button', { name: 'Quitar una unidad' }));
        expect((onChange.mock.calls[0][0] as NewLineDraft[])[0]).toMatchObject({ concept: 'Guantes pro', amount: 90_000 });
    });
    it('con una unidad el botón de quitar está deshabilitado', () => {
        montar([linea({ concept: 'Guantes pro', amount: 90_000 })]);
        expect((screen.getByRole('button', { name: 'Quitar una unidad' }) as HTMLButtonElement).disabled).toBe(true);
    });

    it('sin valor escrito, la cantidad usa el precio del catálogo', () => {
        const onChange = montar([linea({ concept: 'Guantes pro', amount: null })]);
        fireEvent.click(screen.getByRole('button', { name: 'Agregar una unidad' }));
        expect((onChange.mock.calls[0][0] as NewLineDraft[])[0].amount).toBe(180_000);
    });

    it('cambiar la talla conserva la cantidad', () => {
        const onChange = montar([linea({ concept: 'Guantes talla S x2', amount: 90_000 })]);
        fireEvent.click(screen.getByRole('button', { name: 'L' }));
        expect((onChange.mock.calls[0][0] as NewLineDraft[])[0]).toMatchObject({ concept: 'Guantes talla L x2', amount: 90_000 });
    });

    it('«Otro artículo» agrega otra línea de artículos sin tocar la que ya está', () => {
        const onChange = montar([linea({ concept: 'Guantes pro', amount: 90_000 })]);
        fireEvent.click(screen.getByTestId('cyp-articulos-otro-0'));
        const lineas = onChange.mock.calls[0][0] as NewLineDraft[];
        expect(lineas).toHaveLength(2);
        expect(lineas[0]).toMatchObject({ concept: 'Guantes pro', amount: 90_000 });
        expect(lineas[1]).toMatchObject({ category: 'articulos', amount: null, due_date: '2026-11-30' });
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
