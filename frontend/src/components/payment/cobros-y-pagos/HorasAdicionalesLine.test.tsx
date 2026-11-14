import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import {
    HorasAdicionalesLine, borradorDeHorasUsadas, borradorDeVentaDeHoras, inscripcionesConHoras,
} from './HorasAdicionalesLine';
import { newLineDraft, type NewLineDraft } from '@/lib/cobrosYPagos';
import type { ChargeSuggestions } from '@/lib/api/chargeBatches';

const PGR6X2 = {
    enrollment_id: 'enr-1', offering_plan_id: 'p1', plan_name: 'PGR6x2', team_name: 'USAG Nivel 1', is_primary: true,
    monthly_amount: 387_000, active: true, hours_plan: true, hourly_rate: 32_250, included_minutes: 720,
};
const SIN_HORAS = { ...PGR6X2, enrollment_id: 'enr-2', plan_name: 'PGP8x1', hours_plan: false, hourly_rate: null, included_minutes: null, is_primary: false };

const sugerencias = (over: Partial<ChargeSuggestions> = {}): ChargeSuggestions => ({ enrollments: [PGR6X2], overages: [], ...over });

/** Línea ya en «Por adelantado» (1 h, tarifa del plan). */
const adelantada = (over: Partial<NewLineDraft> = {}) =>
    newLineDraft({ category: 'excedente', due_date: '2026-10-30', ...borradorDeVentaDeHoras(sugerencias()), ...over });
/** Línea recién creada: sin modo elegido. */
const sinElegir = (over: Partial<NewLineDraft> = {}) => newLineDraft({ category: 'excedente', due_date: '2026-10-30', ...over });
const usadas = (over: Partial<NewLineDraft> = {}) =>
    newLineDraft({ category: 'excedente', due_date: '2026-10-30', ...borradorDeHorasUsadas(), ...over });

describe('borradores', () => {
    it('«Por adelantado» arranca en 1 hora con la tarifa del plan y la inscripción con banco', () => {
        expect(borradorDeVentaDeHoras(sugerencias())).toMatchObject({
            horas_modo: 'adelantado', extra_hours: 1, enrollment_id: 'enr-1', amount: 32_250, concept: 'Horas adicionales · 1 h', overage_charge_id: null,
        });
    });
    it('ignora las inscripciones sin banco de horas', () => {
        expect(inscripcionesConHoras(sugerencias({ enrollments: [SIN_HORAS, PGR6X2] })).map((e) => e.enrollment_id)).toEqual(['enr-1']);
        expect(borradorDeVentaDeHoras(sugerencias({ enrollments: [SIN_HORAS] }))).toMatchObject({ enrollment_id: null, amount: null });
    });
    it('«Ya las usó» no lleva horas ni inscripción y trae el detalle por defecto', () => {
        expect(borradorDeHorasUsadas()).toMatchObject({
            horas_modo: 'usadas', extra_hours: null, enrollment_id: null, overage_charge_id: null, concept: 'Hora adicional consumida · 1 h',
        });
    });
});

describe('<HorasAdicionalesLine /> elegir qué son las horas', () => {
    it('con banco y sin modo elegido ofrece las dos opciones, ninguna marcada, y no muestra horas ni valor', () => {
        const onPatch = vi.fn();
        render(<HorasAdicionalesLine line={sinElegir()} suggestions={sugerencias()} onPatch={onPatch} />);
        expect(screen.getByText(/Ya las usó/).closest('button')!.getAttribute('aria-pressed')).toBe('false');
        expect(screen.getByText(/Por adelantado/).closest('button')!.getAttribute('aria-pressed')).toBe('false');
        expect(screen.queryByLabelText('Horas vendidas')).toBeNull();
        expect(screen.queryByTestId('cyp-horas-sin-banco')).toBeNull();
        expect(onPatch).not.toHaveBeenCalled();   // no decide por el usuario
    });

    it('«Por adelantado» arma la venta: 1 h, tarifa e inscripción', () => {
        const onPatch = vi.fn();
        render(<HorasAdicionalesLine line={sinElegir()} suggestions={sugerencias()} onPatch={onPatch} />);
        fireEvent.click(screen.getByText(/Por adelantado/));
        expect(onPatch).toHaveBeenCalledWith(expect.objectContaining({ horas_modo: 'adelantado', extra_hours: 1, enrollment_id: 'enr-1', amount: 32_250 }));
    });

    it('«Ya las usó» limpia horas e inscripción y deja el detalle por defecto', () => {
        const onPatch = vi.fn();
        render(<HorasAdicionalesLine line={adelantada()} suggestions={sugerencias()} onPatch={onPatch} />);
        fireEvent.click(screen.getByText(/Ya las usó/));
        expect(onPatch).toHaveBeenCalledWith(expect.objectContaining({
            horas_modo: 'usadas', extra_hours: null, enrollment_id: null, concept: 'Hora adicional consumida · 1 h',
        }));
    });

    it('en «Ya las usó» avisa que el banco no cambia y no muestra el contador de horas', () => {
        render(<HorasAdicionalesLine line={usadas()} suggestions={sugerencias()} onPatch={vi.fn()} />);
        expect(screen.getByTestId('cyp-horas-usadas-nota').textContent).toContain('el banco de horas no cambia');
        expect(screen.queryByLabelText('Horas vendidas')).toBeNull();
        expect(screen.queryByTestId('cyp-horas-tarifa')).toBeNull();
    });

    it('en «Ya las usó» con excedentes pendientes ofrece elegir el período', () => {
        const s = sugerencias({ overages: [{ id: 'ov-1', period_label: 'sep 2026', amount: 50_000 }] });
        render(<HorasAdicionalesLine line={usadas()} suggestions={s} onPatch={vi.fn()} />);
        expect(screen.getByLabelText('Período de horas adicionales')).toBeTruthy();
    });

    it('sin excedentes en «Ya las usó» no hay selector de período (cobro libre)', () => {
        render(<HorasAdicionalesLine line={usadas()} suggestions={sugerencias()} onPatch={vi.fn()} />);
        expect(screen.queryByLabelText('Período de horas adicionales')).toBeNull();
    });
});

describe('<HorasAdicionalesLine /> «Por adelantado»', () => {
    it('muestra las horas y la tarifa (Dreamers)', () => {
        render(<HorasAdicionalesLine line={adelantada()} suggestions={sugerencias()} onPatch={vi.fn()} />);
        expect((screen.getByLabelText('Horas vendidas') as HTMLInputElement).value).toBe('1');
        expect(screen.getByTestId('cyp-horas-tarifa').textContent).toContain('32.250');
        expect(screen.getByTestId('cyp-horas-tarifa').textContent).toContain('pagado');
        expect(screen.getByText(/Por adelantado/).closest('button')!.getAttribute('aria-pressed')).toBe('true');
    });

    it('junto a las horas se ve la cuenta: «2 h × tarifa = valor»', () => {
        render(<HorasAdicionalesLine line={adelantada({ extra_hours: 2, amount: 64_500 })} suggestions={sugerencias()} onPatch={vi.fn()} />);
        const t = screen.getByTestId('cyp-horas-resumen').textContent ?? '';
        expect(t).toContain('2 h');
        expect(t).toContain('32.250');
        expect(t).toContain('64.500');
    });

    it('con 3 horas la cuenta suma las 3 (3 × 32.250 = 96.750)', () => {
        render(<HorasAdicionalesLine line={adelantada({ extra_hours: 3, amount: 96_750 })} suggestions={sugerencias()} onPatch={vi.fn()} />);
        expect(screen.getByTestId('cyp-horas-resumen').textContent).toContain('96.750');
    });

    it('si las horas quedaron sin valor avisa en vez de callar', () => {
        render(<HorasAdicionalesLine line={adelantada({ extra_hours: 2, amount: null })} suggestions={sugerencias()} onPatch={vi.fn()} />);
        const aviso = screen.getByTestId('cyp-horas-sin-valor').textContent ?? '';
        expect(aviso).toContain('Falta el valor');
        expect(aviso).toContain('64.500');
    });

    it('«+» pasa a 2 horas y recalcula el valor con la tarifa y el concepto', () => {
        const onPatch = vi.fn();
        render(<HorasAdicionalesLine line={adelantada()} suggestions={sugerencias()} onPatch={onPatch} />);
        fireEvent.click(screen.getByLabelText('Una hora más'));
        expect(onPatch).toHaveBeenCalledWith({ extra_hours: 2, concept: 'Horas adicionales · 2 h', amount: 64_500 });
    });

    it('«−» no baja de 15 minutos', () => {
        const onPatch = vi.fn();
        render(<HorasAdicionalesLine line={adelantada({ extra_hours: 0.25 })} suggestions={sugerencias()} onPatch={onPatch} />);
        fireEvent.click(screen.getByLabelText('Una hora menos'));
        expect(onPatch).toHaveBeenCalledWith(expect.objectContaining({ extra_hours: 0.25 }));
    });

    it('escribir 1,5 recalcula; el valor sigue editable por fuera (no se bloquea)', () => {
        const onPatch = vi.fn();
        render(<HorasAdicionalesLine line={adelantada()} suggestions={sugerencias()} onPatch={onPatch} />);
        fireEvent.change(screen.getByLabelText('Horas vendidas'), { target: { value: '1.5' } });
        expect(onPatch).toHaveBeenCalledWith({ extra_hours: 1.5, concept: 'Horas adicionales · 1,5 h', amount: 48_375 });
    });

    it('vaciar el campo no rompe: queda en 0 y el cálculo del modal avisa', () => {
        const onPatch = vi.fn();
        render(<HorasAdicionalesLine line={adelantada()} suggestions={sugerencias()} onPatch={onPatch} />);
        fireEvent.change(screen.getByLabelText('Horas vendidas'), { target: { value: '' } });
        expect(onPatch).toHaveBeenCalledWith({ extra_hours: 0 });
    });

    it('sin tarifa del plan pide escribir el valor y no pisa el que hay', () => {
        const s = sugerencias({ enrollments: [{ ...PGR6X2, hourly_rate: null }] });
        const onPatch = vi.fn();
        render(<HorasAdicionalesLine line={adelantada({ ...borradorDeVentaDeHoras(s), amount: 20_000 })} suggestions={s} onPatch={onPatch} />);
        expect(screen.getByTestId('cyp-horas-tarifa').textContent).toContain('escribe el valor');
        fireEvent.click(screen.getByLabelText('Una hora más'));
        expect(onPatch).toHaveBeenCalledWith({ extra_hours: 2, concept: 'Horas adicionales · 2 h' });
    });

    it('si el atleta cambió con la línea abierta, corrige sola la inscripción ajena (y el valor)', () => {
        const onPatch = vi.fn();
        render(<HorasAdicionalesLine line={adelantada({ enrollment_id: 'enr-DEL-OTRO-ATLETA', amount: 1 })} suggestions={sugerencias()} onPatch={onPatch} />);
        expect(onPatch).toHaveBeenCalledWith({ enrollment_id: 'enr-1', amount: 32_250 });
    });

    it('si las sugerencias llegaron después del borrador (sin inscripción), la completa', () => {
        const onPatch = vi.fn();
        render(<HorasAdicionalesLine line={adelantada({ enrollment_id: null, amount: null })} suggestions={sugerencias()} onPatch={onPatch} />);
        expect(onPatch).toHaveBeenCalledWith({ enrollment_id: 'enr-1', amount: 32_250 });
    });

    it('con la inscripción correcta no hace nada (sin bucles)', () => {
        const onPatch = vi.fn();
        render(<HorasAdicionalesLine line={adelantada()} suggestions={sugerencias()} onPatch={onPatch} />);
        expect(onPatch).not.toHaveBeenCalled();
    });
});

describe('<HorasAdicionalesLine /> atleta SIN banco de horas (caso Zoe, PGP8x1)', () => {
    const sinBanco = () => sugerencias({ enrollments: [SIN_HORAS] });

    it('no muestra selector, ni horas, ni el aviso en rojo: solo la nota clara', () => {
        render(<HorasAdicionalesLine line={usadas()} suggestions={sinBanco()} onPatch={vi.fn()} />);
        const nota = screen.getByTestId('cyp-horas-sin-banco');
        expect(nota.textContent).toContain('no tiene un plan con banco de horas');
        expect(nota.textContent).toContain('no se suman horas');
        expect(nota.getAttribute('role')).toBeNull();   // no es una alerta roja
        expect(screen.queryByLabelText('Horas vendidas')).toBeNull();
        expect(screen.queryByRole('group', { name: 'Qué son estas horas' })).toBeNull();
    });

    it('una línea recién creada (sin modo) pasa sola a «Ya las usó» con el detalle por defecto', () => {
        const onPatch = vi.fn();
        render(<HorasAdicionalesLine line={sinElegir()} suggestions={sinBanco()} onPatch={onPatch} />);
        expect(onPatch).toHaveBeenCalledWith(expect.objectContaining({
            horas_modo: 'usadas', extra_hours: null, enrollment_id: null, concept: 'Hora adicional consumida · 1 h',
        }));
    });

    it('con una venta vieja en el borrador (inscripción de otro atleta) la limpia y no deja horas', () => {
        const onPatch = vi.fn();
        render(<HorasAdicionalesLine line={adelantada()} suggestions={sinBanco()} onPatch={onPatch} />);
        expect(onPatch).toHaveBeenCalledWith(expect.objectContaining({ horas_modo: 'usadas', extra_hours: null, enrollment_id: null }));
    });

    it('ya en «Ya las usó» no hace nada (sin bucles) y respeta el detalle que escribió el usuario', () => {
        const onPatch = vi.fn();
        render(<HorasAdicionalesLine line={usadas({ concept: 'Hora de septiembre — Zoe' })} suggestions={sinBanco()} onPatch={onPatch} />);
        expect(onPatch).not.toHaveBeenCalled();
    });

    it('mientras las sugerencias no llegan (null) no decide nada', () => {
        const onPatch = vi.fn();
        render(<HorasAdicionalesLine line={sinElegir()} suggestions={null} onPatch={onPatch} />);
        expect(onPatch).not.toHaveBeenCalled();
        expect(screen.queryByTestId('cyp-horas-sin-banco')).toBeNull();
    });
});

describe('«Ya las usó» con plan con banco: horas × tarifa', () => {
    const usadasConPlan = (over: Partial<NewLineDraft> = {}) =>
        newLineDraft({ category: 'excedente', due_date: '2026-10-30', ...borradorDeHorasUsadas(sugerencias()), ...over });

    it('arranca en 1 hora con el valor de la tarifa y el detalle con las horas', () => {
        expect(borradorDeHorasUsadas(sugerencias())).toMatchObject({
            horas_modo: 'usadas', horas_usadas: 1, extra_hours: null, enrollment_id: null, amount: 32_250, concept: 'Hora adicional consumida · 1 h',
        });
    });

    it('muestra el contador de horas y la tarifa', () => {
        render(<HorasAdicionalesLine line={usadasConPlan()} suggestions={sugerencias()} onPatch={vi.fn()} />);
        expect((screen.getByLabelText('Horas usadas') as HTMLInputElement).value).toBe('1');
        expect(screen.getByTestId('cyp-horas-usadas-tarifa').textContent).toContain('32.250');
        expect(screen.getByTestId('cyp-horas-usadas-resumen').textContent).toContain('32.250');
    });

    it('«+» pasa a 2 horas, recalcula el valor y el detalle, y nunca manda extra_hours', () => {
        const onPatch = vi.fn();
        render(<HorasAdicionalesLine line={usadasConPlan()} suggestions={sugerencias()} onPatch={onPatch} />);
        fireEvent.click(screen.getByLabelText('Una hora usada más'));
        expect(onPatch).toHaveBeenCalledWith({ horas_usadas: 2, concept: 'Hora adicional consumida · 2 h', amount: 64_500 });
    });

    it('un detalle escrito por el usuario no se pisa al cambiar las horas', () => {
        const onPatch = vi.fn();
        render(<HorasAdicionalesLine line={usadasConPlan({ concept: 'Hora de septiembre — Zoe' })} suggestions={sugerencias()} onPatch={onPatch} />);
        fireEvent.click(screen.getByLabelText('Una hora usada más'));
        expect(onPatch).toHaveBeenCalledWith({ horas_usadas: 2, amount: 64_500 });
    });

    it('con 1,5 horas el valor es 48.375', () => {
        const onPatch = vi.fn();
        render(<HorasAdicionalesLine line={usadasConPlan()} suggestions={sugerencias()} onPatch={onPatch} />);
        fireEvent.change(screen.getByLabelText('Horas usadas'), { target: { value: '1.5' } });
        expect(onPatch).toHaveBeenCalledWith({ horas_usadas: 1.5, concept: 'Hora adicional consumida · 1,5 h', amount: 48_375 });
    });

    it('con un excedente del período elegido no muestra el contador (manda el valor del excedente)', () => {
        render(<HorasAdicionalesLine line={usadasConPlan({ overage_charge_id: 'ov-1' })} suggestions={sugerencias({ overages: [{ id: 'ov-1', period_label: 'sep 2026', amount: 50_000 }] })} onPatch={vi.fn()} />);
        expect(screen.queryByLabelText('Horas usadas')).toBeNull();
    });
});

describe('«Ya las usó» con saldo en el banco (Airi, Dreamers, 2026-10-23)', () => {
    it('avisa cuántas horas le quedan cuando el banco del mes no está agotado', () => {
        const conSaldo = sugerencias({ enrollments: [{ ...PGR6X2, available_minutes: 480 }] });
        render(<HorasAdicionalesLine line={usadas()} suggestions={conSaldo} onPatch={vi.fn()} />);
        const aviso = screen.getByTestId('cyp-horas-usadas-saldo');
        expect(aviso.textContent).toMatch(/8 h/);
        expect(aviso.textContent).toMatch(/por encima/);
    });

    it('no avisa con el banco agotado ni cuando no se conoce el saldo', () => {
        const agotado = sugerencias({ enrollments: [{ ...PGR6X2, available_minutes: -60 }] });
        const { unmount } = render(<HorasAdicionalesLine line={usadas()} suggestions={agotado} onPatch={vi.fn()} />);
        expect(screen.queryByTestId('cyp-horas-usadas-saldo')).toBeNull();
        unmount();
        render(<HorasAdicionalesLine line={usadas()} suggestions={sugerencias()} onPatch={vi.fn()} />);
        expect(screen.queryByTestId('cyp-horas-usadas-saldo')).toBeNull();
    });
});
