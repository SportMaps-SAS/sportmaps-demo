/**
 * Lo que sale por el enlace público del estado de cuenta. El enlace es una
 * credencial: estas pruebas fijan lo que NUNCA debe salir y lo que SIEMPRE debe
 * decir lo mismo que la base (el resumen replica get_athlete_account_statement).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../config/supabase', () => ({ supabase: {} }));
import {
    atletaPublico, asistenciaPorMes, claveEnvioEstadoEnlace, cobroPublico, cobrosVisibles, cuerpoCorreoEstadoEnlace,
    enmascararCorreo, hoyColombia, mesDelCobro, nombreCorto, quitarNombreDelConcepto, resumenDeCobros, resumenParaCorreo,
    ventanaDe, type PagoFila, type VistaEstadoPublico,
} from './estado-cuenta-enlace.contenido';
import { nombreCorto as nombreCortoDelCobro } from './cobro-enlace-publico.service';

const pago = (over: Partial<PagoFila> = {}): PagoFila => ({
    status: 'pending', amount: 380000, amount_paid: null, late_fee_amount: 0,
    concept: 'Mensualidad 11/2026 - ISABELLA ALFONSO', due_date: '2026-11-10', payment_date: null,
    period_year: 2026, period_month: 11, created_at: '2026-11-01T06:30:00Z',
    payment_method: null, payment_channel: null, payment_provider: 'wompi', receipt_url: null,
    wompi_reference: null, wompi_transaction_id: null, provider_transaction_id: null, ...over,
});

describe('nombre corto', () => {
    it('abrevia igual que la página /p/:token', () => {
        for (const n of ['Valentina Ospina', 'Samuel', 'Ana María López Pérez', '  ', null, undefined, 'ISABELLA ALFONSO']) {
            expect(nombreCorto(n as any)).toBe(nombreCortoDelCobro(n as any));
        }
        expect(nombreCorto('Valentina Ospina')).toBe('Valentina O.');
    });
});

describe('ventana de meses', () => {
    it('12 meses hacia atrás desde el día 1 del mes más viejo', () => {
        expect(ventanaDe(new Date('2026-11-12T15:00:00Z'), 12)).toEqual({ desde: '2025-12-01', hasta: '2026-11-12' });
    });
    it('1 mes es solo el mes actual', () => {
        expect(ventanaDe(new Date('2026-11-12T15:00:00Z'), 1)).toEqual({ desde: '2026-11-01', hasta: '2026-11-12' });
    });
    it('cruza el año correctamente y respeta el tope de 36', () => {
        expect(ventanaDe(new Date('2026-02-03T15:00:00Z'), 3)).toEqual({ desde: '2025-12-01', hasta: '2026-02-03' });
        expect(ventanaDe(new Date('2026-11-12T15:00:00Z'), 99).desde).toBe('2023-12-01');
        expect(ventanaDe(new Date('2026-11-12T15:00:00Z'), 0).desde).toBe('2025-12-01'); // valor inválido → 12
    });
    it('cuenta el día en Colombia, no en UTC (madrugada del 13 UTC sigue siendo 12 en Bogotá)', () => {
        expect(hoyColombia(new Date('2026-11-13T02:00:00Z'))).toBe('2026-11-12');
    });
});

describe('quitar el nombre completo del concepto', () => {
    it('como parte entre guiones', () => {
        expect(quitarNombreDelConcepto('Mensualidad 09/2026 - ISABELLA ALFONSO', 'Isabella Alfonso')).toBe('Mensualidad 09/2026');
    });
    it('suelto dentro del texto y sin importar mayúsculas', () => {
        expect(quitarNombreDelConcepto('Camiseta de isabella alfonso talla 10', 'ISABELLA ALFONSO')).toBe('Camiseta de talla 10');
    });
    it('un concepto sin el nombre queda igual', () => {
        expect(quitarNombreDelConcepto('Mensualidad Septiembre 2026', 'Isabella Alfonso')).toBe('Mensualidad Septiembre 2026');
    });
    it('un nombre con caracteres de expresión regular no rompe', () => {
        expect(quitarNombreDelConcepto('Mensualidad - A.(B)+ C', 'A.(B)+ C')).toBe('Mensualidad');
    });
    // Casos tomados de los conceptos reales de Besser (corte 2026-11-12): el nombre llega mal escrito.
    it('con un error de la carga («Sngel» por «Ángel»): no quedan los apellidos', () => {
        expect(quitarNombreDelConcepto('Mensualidad Octubre 2026 - Sngel Felipe Torres (CLUB DEPORTIVO BESSER)', 'Ángel Felipe Torres')).toBe('Mensualidad Octubre 2026');
    });
    it('solo con el primer nombre y el nombre del club entre paréntesis', () => {
        expect(quitarNombreDelConcepto('Mensualidad Septiembre 2026 - Alicia  (CLUB DEPORTIVO BESSER)', 'Alicia Ponce de León')).toBe('Mensualidad Septiembre 2026');
        expect(quitarNombreDelConcepto('Mensualidad Septiembre 2026 - Juan Felipe  (CLUB DEPORTIVO BESSER)', 'Juan Felipe Jiménez Quintero')).toBe('Mensualidad Septiembre 2026');
    });
    it('sin tildes donde el nombre las tiene, y al revés', () => {
        expect(quitarNombreDelConcepto('Mensualidad 09/2026 - Jacobo Sanchez Velasquez', 'Jacobo Sánchez Velásquez')).toBe('Mensualidad 09/2026');
        expect(quitarNombreDelConcepto('Mensualidad 11/2026 - ÁNGEL FELIPE TORRES', 'Angel Felipe Torres')).toBe('Mensualidad 11/2026');
    });
    it('un concepto de plan, sin nombre, no se toca', () => {
        expect(quitarNombreDelConcepto('Plan 4 DÍAS / SEMANA (PROFUNDIZACIÓN)', 'JUAN FELIPE CUBILLOS OCAMPO')).toBe('Plan 4 DÍAS / SEMANA (PROFUNDIZACIÓN)');
    });
    it('conceptos largos con guiones largos: se conserva todo menos el nombre', () => {
        expect(quitarNombreDelConcepto('Plan PGP4x1 — Mensualidad completa, vence el 01/12 — Amira Duarte', 'Amira Duarte')).toBe('Plan PGP4x1 · Mensualidad completa, vence el 01/12');
    });
    it('una partícula («de», «del») no cuenta como palabra del nombre', () => {
        expect(quitarNombreDelConcepto('Mensualidad de septiembre - Ana de la Cruz', 'Ana de la Cruz')).toBe('Mensualidad de septiembre');
    });
    it('si no sobra nada, null', () => {
        expect(quitarNombreDelConcepto('Isabella Alfonso', 'Isabella Alfonso')).toBeNull();
    });
    it('sin concepto: null', () => {
        expect(quitarNombreDelConcepto('', 'X')).toBeNull();
        expect(quitarNombreDelConcepto(null, 'X')).toBeNull();
    });
});

describe('un cobro publicable', () => {
    it('no deja salir la ruta del comprobante ni referencias de pasarela', () => {
        const c = cobroPublico(pago({
            status: 'paid', amount_paid: 380000, payment_date: '2026-11-08T14:00:00Z',
            receipt_url: 'abc-123/1791552945932_o5qlg.png', payment_channel: 'transfer',
            wompi_reference: 'SCH-SECRETA-1', wompi_transaction_id: '1234-9999', provider_transaction_id: 'P-1',
        }), 0, 'Isabella Alfonso');
        const json = JSON.stringify(c);
        expect(json).not.toContain('1791552945932');
        expect(json).not.toContain('abc-123');
        expect(json).not.toContain('SCH-SECRETA');
        expect(json).not.toContain('1234-9999');
        expect(c.receipt_url).toBe('recibido');
        expect(c.wompi_reference).toBe('x');
        expect(c.id).toBe('c1');
        expect(c.payment_date).toBe('2026-11-08');
    });
    it('sin comprobante ni pasarela: null, no «recibido»', () => {
        const c = cobroPublico(pago({ payment_channel: 'cash' }), 4, 'Isabella Alfonso');
        expect(c.receipt_url).toBeNull();
        expect(c.wompi_reference).toBeNull();
        expect(c.id).toBe('c5');
    });
    it('los importes numéricos que llegan como texto se vuelven número', () => {
        expect(cobroPublico(pago({ amount: '340000', amount_paid: '290200' }), 0, null)).toMatchObject({ amount: 340000, amount_paid: 290200 });
    });
});

describe('resumen: la misma cuenta que la RPC', () => {
    it('esperado sin anulados ni rechazados; liquidado = pagados + lo abonado; abierto = la diferencia', () => {
        const r = resumenDeCobros([
            pago({ status: 'paid', amount: 380000 }),
            pago({ status: 'partial', amount: 340000, amount_paid: 290200 }),
            pago({ status: 'overdue', amount: 380000, late_fee_amount: 15000 }),
            pago({ status: 'cancelled', amount: 999999 }),
            pago({ status: 'rejected', amount: 888888 }),
        ]);
        expect(r.count_expected).toBe(3);
        expect(r.total_expected).toBe(1100000);
        expect(r.count_settled).toBe(2);
        expect(r.total_settled).toBe(380000 + 290200);
        expect(r.total_open).toBe(1100000 - 670200);
        expect(r.count_open).toBe(1);
        expect(r.total_late_fees).toBe(15000);
    });
    it('sin cobros: todo en cero', () => {
        expect(resumenDeCobros([])).toEqual({ count_expected: 0, total_expected: 0, count_settled: 0, total_settled: 0, count_open: 0, total_open: 0, total_late_fees: 0 });
    });
    it('una deuda vieja cuenta en el saldo aunque no se muestre en los meses de la ventana', () => {
        const pagos = [pago({ status: 'overdue', period_year: 2025, period_month: 3, due_date: '2025-03-10', amount: 100000 }), pago({ status: 'paid' })];
        expect(resumenDeCobros(pagos).total_open).toBe(100000);
    });
});

describe('qué cobros se muestran', () => {
    it('los de la ventana, y los abiertos aunque sean más viejos; nunca los anulados', () => {
        const visibles = cobrosVisibles([
            pago({ status: 'paid', period_year: 2025, period_month: 3, due_date: '2025-03-10' }),     // viejo y pagado: no
            pago({ status: 'overdue', period_year: 2025, period_month: 3, due_date: '2025-03-10' }),  // viejo y abierto: sí
            pago({ status: 'paid', period_year: 2026, period_month: 1, due_date: '2026-01-10' }),     // en la ventana: sí
            pago({ status: 'cancelled', period_year: 2026, period_month: 2 }),                         // anulado: no
        ], '2025-12-01');
        expect(visibles.map((p) => `${p.period_year}-${p.period_month}-${p.status}`)).toEqual(['2025-3-overdue', '2026-1-paid']);
    });
    it('el mes sale del periodo; sin periodo, de la fecha límite', () => {
        expect(mesDelCobro({ period_year: 2026, period_month: 11, due_date: '2026-12-01', payment_date: null, created_at: '2026-11-05' })).toBe('2026-11');
        expect(mesDelCobro({ period_year: null, period_month: null, due_date: '2026-03-15', payment_date: null, created_at: '2026-03-01' })).toBe('2026-03');
    });
});

describe('asistencia: solo el resumen del mes', () => {
    it('cuenta por mes y nunca expone la fecha de una clase', () => {
        const a = asistenciaPorMes([
            { attendance_date: '2026-10-02', status: 'present' }, { attendance_date: '2026-10-09', status: 'late' },
            { attendance_date: '2026-10-16', status: 'absent' }, { attendance_date: '2026-10-23', status: 'excused' },
            { attendance_date: '2026-11-03', status: 'present' }, { attendance_date: '2026-11-04', status: 'raro' },
        ]);
        expect(a['2026-10']).toEqual({ asistio: 2, tarde: 1, excusada: 1, falto: 1, total: 4 });
        expect(a['2026-11']).toEqual({ asistio: 1, tarde: 0, excusada: 0, falto: 0, total: 2 });
        expect(JSON.stringify(a)).not.toMatch(/2026-10-\d\d/);
    });
});

describe('el deportista completo, con lo que NUNCA debe salir', () => {
    const atleta = atletaPublico({
        nombreCompleto: 'Isabella Alfonso',
        desde: '2025-12-01',
        pagos: [
            pago({ status: 'paid', amount_paid: 380000, due_date: '2026-09-10', payment_date: '2026-09-08', period_month: 9, receipt_url: 'x/y/comprobante-privado.png', payment_channel: 'transfer', concept: 'Mensualidad 09/2026 - ISABELLA ALFONSO' }),
            pago({ status: 'overdue', concept: 'Mensualidad 11/2026 - ISABELLA ALFONSO' }),
        ],
        asistencia: [{ attendance_date: '2026-10-02', status: 'present' }, { attendance_date: '2025-01-02', status: 'present' }],
    });

    it('nombre corto en todas partes', () => {
        const json = JSON.stringify(atleta);
        expect(atleta.nombre).toBe('Isabella A.');
        expect(json).not.toMatch(/alfonso/i);
    });
    it('los cobros salen ordenados por fecha límite, con ids opacos', () => {
        expect(atleta.cobros.map((c) => c.id)).toEqual(['c1', 'c2']);
        expect(atleta.cobros.map((c) => c.due_date)).toEqual(['2026-09-10', '2026-11-10']);
    });
    it('no se filtra ninguna ruta, correo ni teléfono', () => {
        const json = JSON.stringify(atleta);
        expect(json).not.toContain('comprobante-privado');
        expect(json).not.toMatch(/@|\+57|\b3\d{9}\b/);
    });
    it('la asistencia anterior a la ventana no entra', () => {
        expect(Object.keys(atleta.asistencia)).toEqual(['2026-10']);
    });
    it('un deportista sin nombre no rompe', () => {
        expect(atletaPublico({ nombreCompleto: null, pagos: [], asistencia: [], desde: '2025-12-01' }).nombre).toBe('Deportista');
    });
});

describe('la vista completa no tiene campos prohibidos', () => {
    it('ninguna llave de la vista pública es un dato personal o interno', () => {
        const vista: VistaEstadoPublico = {
            escuela: { nombre: 'CLUB DEPORTIVO BESSER', logoUrl: 'https://x/logo.jpg', colorPrimario: '#E3000F', mostrarMarcaSportmaps: true },
            generadoEn: '2026-11-12T15:00:00Z', periodo: { desde: '2025-12-01', hasta: '2026-11-12', meses: 12 }, enlaceVenceEn: '2027-01-11T00:00:00Z',
            atletas: [atletaPublico({ nombreCompleto: 'Isabella Alfonso', desde: '2025-12-01', pagos: [pago()], asistencia: [] })], pagarUrl: null,
        };
        const llaves = new Set<string>();
        const recorrer = (o: unknown) => { if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { llaves.add(k); recorrer(v); } };
        recorrer(vista);
        const prohibidas = ['email', 'correo', 'phone', 'telefono', 'document', 'documento', 'doc_number', 'parent_id', 'child_id', 'user_id', 'payment_id', 'notes', 'ocr_reference', 'reference', 'wompi_transaction_id', 'school_id'];
        expect(prohibidas.filter((k) => llaves.has(k))).toEqual([]);
    });
});

describe('el correo', () => {
    const r = resumenParaCorreo(atletaPublico({
        nombreCompleto: 'Isabella Alfonso', desde: '2025-12-01',
        pagos: [
            pago({ status: 'paid', amount: 380000, amount_paid: 380000, due_date: '2026-09-10', payment_date: '2026-09-08', period_month: 9 }),
            pago({ status: 'paid', amount: 380000, amount_paid: 380000, due_date: '2026-10-10', payment_date: '2026-10-14', period_month: 10 }),
            pago({ status: 'overdue', amount: 380000 }),
        ],
        asistencia: [{ attendance_date: '2026-10-02', status: 'present' }, { attendance_date: '2026-10-09', status: 'absent' }],
    }));

    it('resume lo que debe, lo pagado, los pagos a tiempo y las clases', () => {
        expect(r).toMatchObject({ nombre: 'Isabella A.', debe: 380000, pagado: 760000, pagosATiempo: 1, pagosTotales: 2, clasesAsistidas: 1, clasesTotales: 2 });
    });
    it('escapa HTML en el nombre y en la escuela', () => {
        const html = cuerpoCorreoEstadoEnlace({ escuela: '<script>x</script>', atletas: [{ ...r, nombre: '<img src=x onerror=1>' }], meses: 12 });
        expect(html).not.toContain('<script>');
        expect(html).not.toContain('<img src=x');
        expect(html).toContain('&lt;script&gt;');
    });
    it('quien no debe sale «Al día»; el que debe, en rojo', () => {
        expect(cuerpoCorreoEstadoEnlace({ escuela: 'Besser', atletas: [{ ...r, debe: 0 }], meses: 12 })).toContain('Al día');
        expect(cuerpoCorreoEstadoEnlace({ escuela: 'Besser', atletas: [r], meses: 12 })).toContain('#b91c1c');
    });
    it('sin pagos ni clases muestra raya, no «0 de 0»', () => {
        const html = cuerpoCorreoEstadoEnlace({ escuela: 'Besser', atletas: [{ ...r, pagosTotales: 0, clasesTotales: 0 }], meses: 12 });
        expect(html).not.toContain('0 de 0');
        expect(html).toContain('—');
    });
    it('no incluye ningún enlace ni dato de contacto: el botón lo pone el layout', () => {
        const html = cuerpoCorreoEstadoEnlace({ escuela: 'Besser', atletas: [r], meses: 12 });
        expect(html).not.toMatch(/href|@|https?:/);
    });
});

describe('correo enmascarado y clave de idempotencia', () => {
    it('muestra la inicial y el dominio, nada más', () => {
        expect(enmascararCorreo('carolina.ospina@gmail.com')).toBe('c••••••@gmail.com');
        expect(enmascararCorreo('a@b.co')).toBe('a••@b.co');
        expect(enmascararCorreo('sin-arroba')).toBe('•••');
    });
    it('una clave por familia y día; el reenvío tiene la suya', () => {
        const base = { schoolId: 's1', familia: 'a@b.co', dia: '2026-11-12' };
        expect(claveEnvioEstadoEnlace({ ...base, reenvio: false })).toBe('estado_cuenta_enlace:s1:a@b.co:2026-11-12');
        expect(claveEnvioEstadoEnlace({ ...base, reenvio: true })).toBe('estado_cuenta_enlace_reenvio:s1:a@b.co:2026-11-12');
        expect(claveEnvioEstadoEnlace({ ...base, reenvio: false })).not.toBe(claveEnvioEstadoEnlace({ ...base, reenvio: true }));
    });
});
