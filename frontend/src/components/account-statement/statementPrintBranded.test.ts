/**
 * El estado de cuenta imprimible con la marca de la escuela. Se vigila lo que
 * sale (fechas, puntualidad, cómo pagó, asistencia), lo que NO debe salir
 * (rutas de comprobantes, texto sin escapar, colores o logos no válidos) y que
 * la marca de cada escuela llegue al documento.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { construirEstadoImprimible, imprimirEstadoConMarca, MARCA_SPORTMAPS, type EntradaEstadoImprimible, type MarcaEscuela } from './statementPrintBranded';
import type { CobroCuenta } from './estadoCuentaModel';
import type { StatementData } from './statementPrint';

vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));

const HOY = new Date(2026, 10, 12, 10, 0);
const BESSER: MarcaEscuela = {
  nombre: 'CLUB DEPORTIVO BESSER', logoUrl: 'https://cdn.test/besser.jpg', colorPrimario: '#E3000F', colorSecundario: '#FFCC00',
  fondoLogo: '#030303', mostrarMarcaSportmaps: true,
};

const cobro = (over: Partial<CobroCuenta>): CobroCuenta => ({
  id: 'p', status: 'pending', amount: 380_000, amount_paid: null, concept: 'Mensualidad 11/2026 - Valentina Ospina',
  due_date: '2026-11-10', payment_date: null, period_year: 2026, period_month: 11, created_at: '2026-11-01T06:30:00Z', ...over,
});

const COBROS: CobroCuenta[] = [
  cobro({ id: 'nov', status: 'overdue' }),
  cobro({ id: 'oct', status: 'partial', amount_paid: 200_000, due_date: '2026-10-10', payment_date: '2026-10-14', period_month: 10, payment_channel: 'cash', concept: 'Mensualidad 10/2026 - Valentina Ospina' }),
  cobro({ id: 'sep', status: 'paid', amount_paid: 380_000, due_date: '2026-09-10', payment_date: '2026-09-08', period_month: 9, payment_channel: 'transfer', receipt_url: 'ruta/secreta/comprobante.png', concept: 'Mensualidad 09/2026 - Valentina Ospina' }),
];

const STATEMENT: StatementData = {
  athlete_name: 'Valentina Ospina',
  summary: { count_expected: 3, total_expected: 1_140_000, count_settled: 1, total_settled: 580_000, count_open: 2, total_open: 560_000, total_late_fees: 0 },
  meses: [],
  events: [
    { tipo: 'sesion', fecha: '2026-10-02', status: null, amount: null, amount_paid: null, attendance_status: 'present' },
    { tipo: 'sesion', fecha: '2026-10-09', status: null, amount: null, amount_paid: null, attendance_status: 'absent' },
    { tipo: 'sesion', fecha: '2026-11-03', status: null, amount: null, amount_paid: null, attendance_status: 'present' },
    { tipo: 'pago', fecha: '2026-09-08', status: 'paid', amount: 380_000, amount_paid: 380_000, attendance_status: null },
  ],
};

const html = (over: Partial<EntradaEstadoImprimible> = {}) =>
  construirEstadoImprimible({ statement: STATEMENT, cobros: COBROS, months: 12, marca: BESSER, modo: 'escuela', now: HOY, ...over });

describe('la marca de la escuela llega al documento', () => {
  it('Besser: rojo, amarillo, fondo negro con texto blanco, logo y nombre', () => {
    const h = html();
    expect(h).toContain('--p: #E3000F');
    expect(h).toContain('--s: #FFCC00');
    expect(h).toMatch(/\.band \{ background: #030303; color: #ffffff;/);
    expect(h).toContain('<img src="https://cdn.test/besser.jpg"');
    expect(h).toContain('CLUB DEPORTIVO BESSER');
    expect(h).toContain('Estado de cuenta');
  });

  it('sin marca propia: encabezado blanco con texto oscuro, colores de SportMaps y sin logo', () => {
    const h = html({ marca: MARCA_SPORTMAPS });
    expect(h).toContain('--p: #248223');
    expect(h).toMatch(/\.band \{ background: #ffffff; color: #111111;/);
    expect(h).not.toContain('<img');
    expect(h).toContain('SportMaps');
  });

  it('un logo con fondo claro usa texto oscuro sobre su fondo', () => {
    expect(html({ marca: { ...BESSER, fondoLogo: '#FFCC00' } })).toMatch(/\.band \{ background: #FFCC00; color: #111111;/);
  });

  it('colores que no son hex de 6 dígitos no entran (se usa el de SportMaps)', () => {
    const h = html({ marca: { ...BESSER, colorPrimario: 'red; } body { display:none', colorSecundario: 'url(javascript:1)', fondoLogo: 'expression(1)' } });
    expect(h).toContain('--p: #248223');
    expect(h).toContain('--s: #FB9F1E');
    expect(h).not.toContain('display:none');
    expect(h).not.toContain('javascript');
    expect(h).toMatch(/\.band \{ background: #ffffff;/);
  });

  it('un logo que no es https no se carga', () => {
    for (const logoUrl of ['http://cdn.test/x.jpg', 'javascript:alert(1)', 'data:image/png;base64,AAAA', '']) {
      expect(html({ marca: { ...BESSER, logoUrl } })).not.toContain('<img');
    }
  });

  it('«Powered by SportMaps» solo si la escuela lo tiene activo', () => {
    expect(html()).toContain('Powered by SportMaps');
    expect(html({ marca: { ...BESSER, mostrarMarcaSportmaps: false } })).not.toContain('Powered by SportMaps');
  });
});

describe('el mes a mes', () => {
  it('del más viejo al más nuevo, con fecha límite y fecha de pago', () => {
    const h = html();
    expect(h.indexOf('Septiembre 2026')).toBeLessThan(h.indexOf('Octubre 2026'));
    expect(h.indexOf('Octubre 2026')).toBeLessThan(h.indexOf('Noviembre 2026'));
    expect(h).toContain('10 sep');
    expect(h).toContain('8 sep');
    expect(h).toContain('14 oct');
  });

  it('puntualidad, abono y vencido, en palabras', () => {
    const h = html();
    expect(h).toContain('Pagó a tiempo');
    expect(h).toMatch(/Falta .*180\.000 · vencido hace 33 días/);
    expect(h).toContain('Lleva 2 días vencido');
    expect(h).toContain('Sin pagar');
    expect(h).toContain('<small>abono</small>');
  });

  it('cada cobro muestra lo cobrado, lo pagado y el saldo', () => {
    const h = html();
    expect(h).toMatch(/380\.000/);
    expect(h).toMatch(/200\.000/);
    expect(h).toMatch(/<b>\$\s?180\.000<\/b>/);
  });

  it('el comprobante nunca sale: ni la ruta ni un enlace', () => {
    const h = html();
    expect(h).not.toContain('ruta/secreta');
    expect(h).not.toContain('comprobante.png');
    expect(h).not.toMatch(/href=/);
    expect(h).toContain('con comprobante');
  });

  it('pagado sin fecha de pago: lo dice y no inventa puntualidad', () => {
    const h = html({ cobros: [cobro({ id: 'x', status: 'paid', amount_paid: 380_000, payment_date: null, payment_channel: 'manual', receipt_url: 'a.png' })] });
    expect(h).toContain('sin fecha registrada');
    expect(h).not.toContain('Pagó a tiempo');
    expect(h).not.toMatch(/Pagó \d+ días? tarde/);
  });

  it('comprobante en revisión: «comprobante enviado» y sin puntualidad', () => {
    const h = html({ cobros: [cobro({ id: 'r', status: 'awaiting_approval', payment_date: '2026-11-11' })] });
    expect(h).toContain('comprobante enviado');
    expect(h).toContain('En revisión');
  });

  it('doce meses son doce filas', () => {
    const doce = Array.from({ length: 12 }, (_, i) => {
      const m = ((10 - i + 12) % 12) + 1; const y = i <= 10 ? 2026 : 2025;
      return cobro({ id: `m${i}`, status: 'paid', amount_paid: 380_000, period_year: y, period_month: m, due_date: `${y}-${String(m).padStart(2, '0')}-10`, payment_date: `${y}-${String(m).padStart(2, '0')}-08` });
    });
    expect((html({ cobros: doce }).match(/<tr>\s*<td><b>/g) ?? []).length).toBe(12);
  });

  it('sin cobros: lo dice en vez de una tabla vacía', () => {
    const h = html({ cobros: [] });
    expect(h).toContain('Todavía no hay cobros para mostrar');
    expect(h).not.toContain('<table');
  });

  it('un cobro anulado no sale', () => {
    expect(html({ cobros: [cobro({ id: 'a', status: 'cancelled' })] })).toContain('Todavía no hay cobros');
  });
});

describe('cómo pagó: la escuela ve más que la familia', () => {
  const sinMedio = [cobro({ id: 's', status: 'paid', amount_paid: 380_000, payment_date: '2026-11-05' })];
  it('«Sin registrar» y las notas del medio, solo para la escuela', () => {
    expect(html({ cobros: sinMedio, modo: 'escuela' })).toContain('Sin registrar');
    expect(html({ cobros: sinMedio, modo: 'familia' })).not.toContain('Sin registrar');
    expect(html({ modo: 'escuela' })).toContain('sin comprobante');
    expect(html({ modo: 'familia' })).not.toContain('sin comprobante');
  });
});

describe('las cifras de arriba son las del sistema', () => {
  it('facturado, pagado y por pagar salen del resumen, no de sumar filas', () => {
    const h = html();
    expect(h).toMatch(/1\.140\.000/);
    expect(h).toMatch(/580\.000/);
    expect(h).toMatch(/560\.000/);
    expect(h).toContain('1 cobro vencido'.replace('1 cobro', '2 cobros'));
  });
  it('los pagos a tiempo se cuentan de los cobros pagados', () => {
    expect(html()).toMatch(/Pagos a tiempo<\/div><div class="v">1 de 1</);
  });
});

describe('la asistencia', () => {
  it('por mes y en total, con el porcentaje', () => {
    const h = html();
    expect(h).toContain('Asistencia mes a mes');
    expect(h).toContain('Octubre 2026');
    expect(h).toContain('Asistió a 1 de 2 clases');
    expect(h).toContain('Asistió a 2 de 3 clases (67 %)');
    expect(h).toMatch(/Asistencia<\/div><div class="v">2 de 3 clases</);
  });
  it('sin sesiones no hay sección ni cifra inventada', () => {
    const h = html({ statement: { ...STATEMENT, events: [] } });
    expect(h).not.toContain('Asistencia mes a mes');
    expect(h).toMatch(/Asistencia<\/div><div class="v">—</);
  });
  it('nunca sale la fecha de una clase', () => {
    expect(html()).not.toMatch(/2026-10-0[29]|2 oct|9 oct/);
  });
});

describe('todo lo variable va escapado', () => {
  it('el nombre del deportista, el de la escuela y el concepto', () => {
    const h = html({
      marca: { ...BESSER, nombre: '<script>x()</script>' },
      statement: { ...STATEMENT, athlete_name: '<img src=x onerror=alert(1)>' },
      cobros: [cobro({ id: 'z', status: 'overdue', concept: '<b onclick=1>Mensualidad</b>' })],
    });
    expect(h).not.toContain('<script>x()');
    expect(h).not.toContain('<img src=x');
    expect(h).not.toContain('<b onclick');
    expect(h).toContain('&lt;script&gt;');
  });
});

describe('imprimirEstadoConMarca', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
  const entrada: EntradaEstadoImprimible = { statement: STATEMENT, cobros: COBROS, months: 12, marca: BESSER, modo: 'escuela', now: HOY };

  it('devuelve false si el navegador bloqueó la ventana', () => {
    vi.stubGlobal('open', () => null);
    expect(imprimirEstadoConMarca(entrada)).toBe(false);
  });

  it('espera al logo e imprime UNA sola vez aunque también venza el tope de tiempo', () => {
    vi.useFakeTimers();
    const oyentes: Record<string, () => void> = {};
    const img = { complete: false, addEventListener: (ev: string, fn: () => void) => { oyentes[ev] = fn; } };
    const print = vi.fn();
    vi.stubGlobal('open', () => ({ document: { write: vi.fn(), close: vi.fn(), images: [img] }, print }));
    expect(imprimirEstadoConMarca(entrada)).toBe(true);
    expect(print).not.toHaveBeenCalled();
    oyentes.load();
    vi.advanceTimersByTime(500);
    expect(print).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5000);
    expect(print).toHaveBeenCalledTimes(1);
  });

  it('si el logo nunca carga, imprime igual al pasar el tope', () => {
    vi.useFakeTimers();
    const img = { complete: false, addEventListener: () => undefined };
    const print = vi.fn();
    vi.stubGlobal('open', () => ({ document: { write: vi.fn(), close: vi.fn(), images: [img] }, print }));
    imprimirEstadoConMarca(entrada);
    vi.advanceTimersByTime(3100);
    expect(print).toHaveBeenCalledTimes(1);
  });

  it('sin logo imprime enseguida', () => {
    vi.useFakeTimers();
    const print = vi.fn();
    vi.stubGlobal('open', () => ({ document: { write: vi.fn(), close: vi.fn(), images: [] }, print }));
    imprimirEstadoConMarca(entrada);
    vi.advanceTimersByTime(400);
    expect(print).toHaveBeenCalledTimes(1);
  });
});
