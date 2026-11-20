/**
 * Reglas puras de la cola de comprobantes, con los casos reales de la auditoría de producción (1–16 nov 2026).
 */
import { describe, it, expect } from 'vitest';
import {
    lecturaCompleta, motivoSinPendientesConPago, textoSinPendientesALaEscuela, hijoNombrado, mesNombrado,
    acotarCobrosPorLoEscrito, fichaPorNombreYApellido, propuestaNumeroFueraDeFicha, senalDeTorneoOClub,
    motivoTorneoOClub, laVentaCede, pagoPartido, motivoPagoPartido, difiereDelCobro, motivoMontoDistintoAplicado,
    hablaDePagoMesOMonto, pareceNombreDePersona, cuentaComoRespuesta, esCorreccionDeResultado, motivoReclamo,
} from './wa-cola-reglas';
import type { PagoPendiente } from './whatsapp-receipt-matching.service';

const HOY = new Date('2026-11-16T15:00:00Z');
const cobro = (id: string, amount: number, mes: number, atleta: string, childId: string): PagoPendiente => ({
    id, amount, concept: `Mensualidad ${String(mes).padStart(2, '0')}/2026`, due_date: `2026-${String(mes).padStart(2, '0')}-10`,
    child_id: childId, atleta, categoria: 'mensualidad',
});

describe('R1 · guardar siempre lo leído', () => {
    it('agrega quién pagó, la nota y el titular a las huellas, sin perder sha ni referencias', () => {
        const huellas = { sha: 'abc', ocr: { amount: 180000, reference: 'M123', destination: '3001112222', date: '2026-11-03', bank: 'Nequi' },
            storagePath: 's/whatsapp/f1.jpg', parentId: null, referencias: ['M123'] };
        const r = lecturaCompleta(huellas, { amount: 180000, reference: 'M123', originName: 'Carolina Amórtegui', description: 'Mensualidad Isabella', destinationName: 'Club SAS' }) as any;
        expect(r).toMatchObject({ sha: 'abc', storagePath: 's/whatsapp/f1.jpg', referencias: ['M123'] });
        expect(r.ocr).toMatchObject({ amount: 180000, reference: 'M123', destination: '3001112222', date: '2026-11-03', bank: 'Nequi',
            originName: 'Carolina Amórtegui', description: 'Mensualidad Isabella', destinationName: 'Club SAS' });
    });
    it('un archivo que NO era comprobante también deja rastro de lo que se leyó', () => {
        const r = lecturaCompleta({ sha: 'x', ocr: { amount: null, reference: null, destination: null, date: null, bank: null }, storagePath: null, parentId: null, referencias: [] },
            { isReceipt: false, amount: null }) as any;
        expect(r.ocr.isReceipt).toBe(false);
        expect(r.sha).toBe('x');
    });
    it('sin huellas ni lectura no inventa nada', () => {
        expect(lecturaCompleta(null, null)).toBeNull();
    });
});

describe('R2 · sin cobros abiertos pero con un pago real', () => {
    it('el motivo trae el monto y la propuesta, con el prefijo que la bandeja lee', () => {
        const m = motivoSinPendientesConPago({ monto: 180000, quienPago: 'Luz Marina Ríos', deportistas: ['Samuel Ríos'], fecha: '2026-11-04' });
        expect(m.base).toBe('sin_pendientes: pagó $180.000 y no tiene cobros abiertos: puede ser otro concepto o un mes que no se ha generado');
        expect(m.propuesta).toContain('pagó: Luz Marina Ríos');
        expect(m.propuesta).toContain('deportista: Samuel Ríos');
        expect(m.propuesta).toContain('aplicar este comprobante');
    });
    it('a la familia nunca se le dice que quedó registrado', () => {
        const t = textoSinPendientesALaEscuela(180000);
        expect(t).toContain('$180.000');
        expect(t).toContain('se lo paso a la escuela');
        expect(t).not.toMatch(/registrad|aplicad|al día/i);
    });
});

describe('R4 · el nombre del pie o de la nota manda sobre el hijo por defecto', () => {
    const hermanas = [{ id: 'jul', nombre: 'Juliana Rodríguez Amórtegui' }, { id: 'isa', nombre: 'Isabella Rodríguez Amórtegui' }];

    it('pie «Mensualidad Isabella Rodríguez Amórtegui» → Isabella, no Juliana', () => {
        expect(hijoNombrado(['Mensualidad Isabella Rodríguez Amórtegui'], hermanas)?.id).toBe('isa');
    });
    it('pie «Juan Diego Osorio» → Juan Diego, no Victoria', () => {
        const hijos = [{ id: 'vic', nombre: 'Victoria Osorio Mejía' }, { id: 'jd', nombre: 'Juan Diego Osorio Mejía' }];
        expect(hijoNombrado(['Juan Diego Osorio'], hijos)?.id).toBe('jd');
    });
    it('«pago del mes de noviembre de mi hija Antonella» → Antonella (nombre de pila único entre los hermanos)', () => {
        const hijos = [{ id: 'ant', nombre: 'Antonella Pérez Gil' }, { id: 'mat', nombre: 'Matías Pérez Gil' }];
        expect(hijoNombrado(['pago del mes de noviembre de mi hija Antonella'], hijos)?.id).toBe('ant');
    });
    it('«Mes noviembre María Camila…» entre María Camila y María José → Camila', () => {
        const hijos = [{ id: 'cam', nombre: 'María Camila Torres' }, { id: 'jose', nombre: 'María José Torres' }];
        expect(hijoNombrado(['Mes noviembre María Camila Torres'], hijos)?.id).toBe('cam');
    });
    it('solo los apellidos (los comparten) no señalan a ninguna', () => {
        expect(hijoNombrado(['pago Rodríguez Amórtegui'], hermanas)).toBeNull();
    });
    it('nombra a las dos → no se adivina', () => {
        expect(hijoNombrado(['mensualidad de Isabella y Juliana'], hermanas)).toBeNull();
    });
    it('la nota del comprobante también cuenta (no solo el pie)', () => {
        expect(hijoNombrado([null, 'Pago mensualidad ISABELLA', ''], hermanas)?.id).toBe('isa');
    });
    it('una hija llamada Abril no se confunde con el mes', () => {
        const hijos = [{ id: 'abr', nombre: 'Abril Gómez Ruiz' }, { id: 'sam', nombre: 'Samuel Gómez Ruiz' }];
        expect(hijoNombrado(['pago del mes de abril'], hijos)).toBeNull();
        expect(hijoNombrado(['mensualidad Abril Gómez'], hijos)?.id).toBe('abr');
    });

    it('el mes: «Adjunto soporte de pago Noviembre», «Mes noviembre María Camila…», «19 de octubre de 2026»', () => {
        expect(mesNombrado(['Adjunto soporte de pago Noviembre'], HOY)).toEqual({ mes: 11, anio: 2026 });
        expect(mesNombrado(['Mes noviembre María Camila Torres'], HOY, ['María Camila Torres'])).toEqual({ mes: 11, anio: 2026 });
        expect(mesNombrado(['19 de octubre de 2026'], HOY)).toEqual({ mes: 10, anio: 2026 });
    });
    it('sin mes escrito → null; diciembre escrito en febrero es del año pasado', () => {
        expect(mesNombrado(['comprobante de pago SARA DAZA'], HOY)).toBeNull();
        expect(mesNombrado(['pago de diciembre'], new Date('2027-02-03T15:00:00Z'))).toEqual({ mes: 12, anio: 2026 });
    });

    it('con cobros de las dos hermanas, el nombre deja UNO por el monto: se aplica sin preguntar', () => {
        const ops = [cobro('p-jul', 180000, 11, 'Juliana Rodríguez Amórtegui', 'jul'), cobro('p-isa', 180000, 11, 'Isabella Rodríguez Amórtegui', 'isa')];
        const r = acotarCobrosPorLoEscrito(ops, ['Mensualidad Isabella Rodríguez Amórtegui'], 180000);
        expect(r.elegido?.id).toBe('p-isa');
    });
    it('nombre + mes entre dos cobros de la misma niña', () => {
        const ops = [cobro('isa-oct', 180000, 10, 'Isabella Rodríguez Amórtegui', 'isa'), cobro('isa-nov', 180000, 11, 'Isabella Rodríguez Amórtegui', 'isa'),
            cobro('jul-nov', 180000, 11, 'Juliana Rodríguez Amórtegui', 'jul')];
        const r = acotarCobrosPorLoEscrito(ops, ['Adjunto soporte de pago Noviembre de Isabella'], 180000);
        expect(r).toMatchObject({ por: 'nombre_y_mes' });
        expect(r.elegido?.id).toBe('isa-nov');
    });
    it('el monto no es el de ningún cobro del hijo nombrado: no se aplica, se pregunta solo entre los suyos', () => {
        const ops = [cobro('p-jul', 180000, 11, 'Juliana Rodríguez Amórtegui', 'jul'), cobro('p-isa', 180000, 11, 'Isabella Rodríguez Amórtegui', 'isa')];
        const r = acotarCobrosPorLoEscrito(ops, ['Mensualidad Isabella'], 150000);
        expect(r.elegido).toBeNull();
        expect(r.opciones?.map((o) => o.id)).toEqual(['p-isa']);
    });
    it('sin nombre escrito no acota nada', () => {
        const ops = [cobro('p-jul', 180000, 11, 'Juliana Rodríguez Amórtegui', 'jul'), cobro('p-isa', 180000, 11, 'Isabella Rodríguez Amórtegui', 'isa')];
        expect(acotarCobrosPorLoEscrito(ops, ['buen día'], 180000)).toEqual({ elegido: null, opciones: null, por: null });
    });
});

describe('R5 · número que no está en la ficha', () => {
    const fichas = [
        { id: 's1', nombre: 'Sara Valentina Daza Gómez', tipo: 'child' as const },
        { id: 's2', nombre: 'Sara Lucía Pérez Ruiz', tipo: 'child' as const },
        { id: 'd3', nombre: 'Tomás Daza Mora', tipo: 'child' as const },
    ];
    it('pie «comprobante de pago SARA DAZA» → la única Sara Daza de la escuela', () => {
        expect(fichaPorNombreYApellido(['comprobante de pago SARA DAZA'], fichas)?.id).toBe('s1');
    });
    it('solo el apellido, o solo el nombre de pila: no alcanza', () => {
        expect(fichaPorNombreYApellido(['pago de Daza'], fichas)).toBeNull();
        expect(fichaPorNombreYApellido(['pago de Sara'], fichas)).toBeNull();
    });
    it('dos deportistas con el mismo nombre y apellido: no se propone ninguna', () => {
        const dos = [...fichas, { id: 's4', nombre: 'Sara Daza Niño', tipo: 'child' as const }];
        expect(fichaPorNombreYApellido(['comprobante de pago SARA DAZA'], dos)).toBeNull();
    });
    it('la propuesta dice el mes, el deportista, el valor y que hay que ligar el número', () => {
        const p = propuestaNumeroFueraDeFicha({ deportista: 'Sara Valentina Daza Gómez', monto: 150000, cobro: cobro('p9', 150000, 11, 'Sara Valentina Daza Gómez', 's1') });
        expect(p.detalle).toBe('parece el pago de noviembre de Sara Valentina Daza Gómez: $150.000; el número no está en su ficha');
        expect(p.propuesta).toContain('aplicar al cobro p9');
        expect(p.propuesta).toContain('ligar el número');
    });
    it('sin un cobro por ese valor, la propuesta lo dice', () => {
        const p = propuestaNumeroFueraDeFicha({ deportista: 'Sara Valentina Daza Gómez', monto: 150000, cobro: null, abiertos: 'Mensualidad 11/2026 $180.000' });
        expect(p.detalle).toContain('ese valor no es el de un cobro abierto');
        expect(p.propuesta).toContain('confirmar con quien pagó');
    });
});

describe('R6 · pagos de torneo o de club', () => {
    it.each([
        'Inscripción del equipo Halcones sub 15',
        'pago torneo relámpago',
        'Club Deportivo Los Pinos - inscripción',
        'Liga de voleibol categoría juvenil',
        'pago equipo femenino',
    ])('«%s» → es de torneo o de club', (t) => {
        expect(senalDeTorneoOClub([null, t])).toBe(t);
    });
    it('una mensualidad no es un torneo aunque diga «club»', () => {
        expect(senalDeTorneoOClub(['mensualidad del club de noviembre'])).toBeNull();
        expect(senalDeTorneoOClub(['pago de noviembre de Antonella'])).toBeNull();
        expect(senalDeTorneoOClub([null, '', undefined])).toBeNull();
    });
    it('el motivo de la bandeja trae el monto ($900.000) y lo que dijo', () => {
        const m = motivoTorneoOClub({ monto: 900000, dijo: 'Inscripción del equipo Halcones sub 15', quienPago: 'Club Halcones SAS' });
        expect(m.base).toBe('torneo_o_club: $900.000 que parece de un torneo o de un club · dijo: «Inscripción del equipo Halcones sub 15»');
        expect(m.propuesta).toContain('pagó: Club Halcones SAS');
    });
});

describe('R7 · la venta de un servicio no secuestra pagos de familias', () => {
    const alias = ['clinica jorge mesa', 'clinica'];
    it('«no estamos pagando la clínica, estamos pagando la mensualidad» → nunca a la venta', () => {
        const r = laVentaCede({ textos: ['no estamos pagando la clínica, estamos pagando la mensualidad'], alias, monto: 150000 });
        expect(r).toMatchObject({ cede: true, desmiente: true, razon: 'desmiente_el_servicio' });
    });
    it('«no es la clínica» / «no es de la clinica» también desmienten', () => {
        expect(laVentaCede({ textos: ['no es la clínica'], alias, monto: 150000 }).desmiente).toBe(true);
        expect(laVentaCede({ textos: ['eso no es de la clinica'], alias, monto: 150000 }).desmiente).toBe(true);
    });
    it('torneo + mensualidad, sin nombrar la clínica → camino de familia', () => {
        expect(laVentaCede({ textos: ['pago torneo y mensualidad de noviembre'], alias, monto: 260000 }))
            .toMatchObject({ cede: true, razon: 'habla_de_la_mensualidad' });
    });
    it('$10.000 que es el saldo de una mensualidad abonada no es un abono de la clínica', () => {
        const r = laVentaCede({ textos: [null], alias, monto: 10000, parciales: [{ amount: 145000, amount_paid: 135000 }] });
        expect(r).toMatchObject({ cede: true, razon: 'saldo_de_un_cobro' });
    });
    it('el monto es la suma exacta de dos cobros de la familia → familia', () => {
        expect(laVentaCede({ textos: [], alias, monto: 260000, pendientes: [{ amount: 180000 }, { amount: 80000 }] }))
            .toMatchObject({ cede: true, razon: 'suma_de_cobros' });
    });
    it('nombra el servicio (o no dice nada): decide la venta como siempre', () => {
        expect(laVentaCede({ textos: ['pago de la clínica de Sofía'], alias, monto: 150000, parciales: [{ amount: 300000, amount_paid: 150000 }] }).cede).toBe(false);
        expect(laVentaCede({ textos: ['abono clínica, la mensualidad la pago el viernes'], alias, monto: 150000 }).cede).toBe(false);
        expect(laVentaCede({ textos: [null], alias, monto: 150000 }).cede).toBe(false);
    });
});

describe('R8 · pago partido', () => {
    const pendientes = [cobro('p90', 90000, 11, 'Luciana Mora', 'c1')];
    it('$9.000 + $81.000 = la cuota de $90.000', () => {
        const r = pagoPartido([{ id: 'f1', monto: 9000 }], 81000, pendientes);
        expect(r).toMatchObject({ total: 90000, partes: [{ id: 'f1', monto: 9000 }] });
        expect(r?.cobro.id).toBe('p90');
        const m = motivoPagoPartido({ partes: r!.partes, monto: 81000, total: r!.total, descripcion: 'Mensualidad 11/2026', cobroId: 'p90' });
        expect(m.base).toBe('pago_partido: $9.000 + $81.000 = $90.000, el valor de Mensualidad 11/2026 (llegó en 2 comprobantes)');
        expect(m.propuesta).toContain('aplicar los 2 comprobantes al cobro p90');
    });
    it('el primero solo no cuadra con nada: no es un pago partido', () => {
        expect(pagoPartido([], 9000, pendientes)).toBeNull();
    });
    it('la suma no calza con ningún cobro → null', () => {
        expect(pagoPartido([{ id: 'f1', monto: 9000 }], 50000, pendientes)).toBeNull();
    });
    it('con ruido anterior, prueba con el comprobante más reciente', () => {
        const r = pagoPartido([{ id: 'f0', monto: 30000 }, { id: 'f1', monto: 9000 }], 81000, pendientes);
        expect(r?.partes.map((p) => p.id)).toEqual(['f1']);
    });
    it('dos cobros iguales de deportistas distintos: no se adivina', () => {
        const dos = [...pendientes, cobro('p90b', 90000, 11, 'Otro Niño', 'c2')];
        expect(pagoPartido([{ id: 'f1', monto: 9000 }], 81000, dos)).toBeNull();
    });
});

describe('R9 · monto leído distinto del cobro', () => {
    it('$197.000 contra $180.000, $708.000 contra $180.000 y $110.000 contra $150.000 difieren', () => {
        expect(difiereDelCobro(197000, 180000)).toBe(true);
        expect(difiereDelCobro(708000, 180000)).toBe(true);
        expect(difiereDelCobro(110000, 150000)).toBe(true);
    });
    it('el mismo valor (±$1) o un monto sin leer no difieren', () => {
        expect(difiereDelCobro(180000, 180000)).toBe(false);
        expect(difiereDelCobro(180001, 180000)).toBe(false);
        expect(difiereDelCobro(null, 180000)).toBe(false);
    });
    it('el motivo muestra los dos valores y la diferencia', () => {
        expect(motivoMontoDistintoAplicado({ montoLeido: 197000, valorCobro: 180000, descripcion: 'Mensualidad 10/2026' }))
            .toBe('monto_distinto_aplicado: comprobante de $197.000 aplicado a Mensualidad 10/2026, que vale $180.000 ($17.000 de más): revisar antes de aprobar');
        expect(motivoMontoDistintoAplicado({ montoLeido: 110000, valorCobro: 150000, descripcion: 'Mensualidad 11/2026' }))
            .toContain('faltan $40.000');
    });
});

describe('R10 · pregunta abierta que atrapa mensajes ajenos', () => {
    it('16 h después, un mensaje para la dueña sobre otra cosa NO es una respuesta', () => {
        for (const t of ['Hola Milena, ¿el sábado hay entrenamiento?', 'Me confirmas la hora por fa', 'Listo, muchas gracias']) {
            expect(cuentaComoRespuesta({ texto: t, minutos: 16 * 60, calzaConOpcion: false })).toBe(false);
        }
    });
    it('pasada la hora sigue contando lo que calza con una opción o habla de pago, mes o monto', () => {
        expect(cuentaComoRespuesta({ texto: '2', minutos: 300, calzaConOpcion: true })).toBe(true);
        expect(cuentaComoRespuesta({ texto: 'el de octubre', minutos: 300, calzaConOpcion: false })).toBe(true);
        expect(cuentaComoRespuesta({ texto: 'es la mensualidad', minutos: 300, calzaConOpcion: false })).toBe(true);
        expect(cuentaComoRespuesta({ texto: 'fueron $180.000', minutos: 300, calzaConOpcion: false })).toBe(true);
    });
    it('dentro de la primera hora todo sigue como antes', () => {
        expect(cuentaComoRespuesta({ texto: 'Hola Milena', minutos: 12, calzaConOpcion: false })).toBe(true);
    });
    it('si se preguntó un nombre, un nombre sigue contando', () => {
        expect(cuentaComoRespuesta({ texto: 'Sara Valentina Daza', minutos: 200, calzaConOpcion: false, esperaNombre: true })).toBe(true);
        expect(cuentaComoRespuesta({ texto: '¿A qué hora es la clase?', minutos: 200, calzaConOpcion: false, esperaNombre: true })).toBe(false);
    });
    it('hablaDePagoMesOMonto y pareceNombreDePersona', () => {
        expect(hablaDePagoMesOMonto('ya hice la transferencia')).toBe(true);
        expect(hablaDePagoMesOMonto('mañana llevo a la niña')).toBe(false);
        expect(pareceNombreDePersona('Juan Diego Osorio')).toBe(true);
        expect(pareceNombreDePersona('hola buenas tardes')).toBe(false);
    });
});

describe('R11 · reclamo o corrección tras el resultado', () => {
    const listoOctubre = { paso: 'resultado_comprobante', texto: 'Listo: comprobante de *$180.000* de *Samuel* para *octubre*. La escuela lo confirma.', minutos: 4 };
    const noEsComprobante = { paso: 'no_es_comprobante', texto: 'Revisé el archivo que enviaste y *no es un comprobante de pago*.', minutos: 2 };

    it('«Este fue octubre» tras «…para octubre» → corrige el mes o el concepto', () => {
        expect(esCorreccionDeResultado('Este fue octubre', listoOctubre)).toEqual({ tipo: 'mes_o_concepto', mesDicho: null });
    });
    it('«El 3 de octubre hicimos pago de octubre. Ahora estoy pagando noviembre» → dice noviembre', () => {
        expect(esCorreccionDeResultado('El 3 de octubre hicimos pago de octubre. Ahora estoy pagando noviembre', listoOctubre))
            .toEqual({ tipo: 'mes_o_concepto', mesDicho: 11 });
    });
    it('«Ahí dice estado exitoso» / «compra exitosa» tras «no es un comprobante de pago» → insiste en que sí es un pago', () => {
        expect(esCorreccionDeResultado('Ahí dice estado exitoso', noEsComprobante)).toEqual({ tipo: 'si_es_un_pago' });
        expect(esCorreccionDeResultado('ahi dice compra exitosa', noEsComprobante)).toEqual({ tipo: 'si_es_un_pago' });
    });
    it('«No has revisado este pago del domingo» → no revisado', () => {
        expect(esCorreccionDeResultado('No has revisado este pago del domingo', listoOctubre)).toEqual({ tipo: 'no_revisado' });
    });
    it('un «gracias» o un tema distinto no es una corrección', () => {
        expect(esCorreccionDeResultado('Muchas gracias', listoOctubre)).toBeNull();
        expect(esCorreccionDeResultado('¿El sábado hay clase?', listoOctubre)).toBeNull();
        expect(esCorreccionDeResultado('ok', noEsComprobante)).toBeNull();
    });
    it('pasados 30 minutos ya no cuenta, y sin resultado previo tampoco', () => {
        expect(esCorreccionDeResultado('Ahora estoy pagando noviembre', { ...listoOctubre, minutos: 45 })).toBeNull();
        expect(esCorreccionDeResultado('Ahora estoy pagando noviembre', null)).toBeNull();
    });
    it('el motivo de la bandeja lleva el texto del cliente y lo que decía antes', () => {
        const m = motivoReclamo({ texto: 'Ahora estoy pagando noviembre', correccion: { tipo: 'mes_o_concepto', mesDicho: 11 }, paso: 'resultado_comprobante', previo: null });
        expect(m).toBe('reclamo_del_cliente: la familia corrige el mes o el concepto (dice noviembre): «Ahora estoy pagando noviembre» (tras resultado_comprobante)');
    });
});

// ─── Cobros abiertos: nunca «no coincide con $350.000 o $175.000» (Monster 2026-11, nombres inventados) ───
describe('laVentaCede · el monto es de un cobro abierto', () => {
    const alias = ['clinica de armadores'];
    it('cobro de clínica de $300.000 con $150.000 abonados: un comprobante de $150.000 es su saldo, cede al camino de familia', () => {
        const r = laVentaCede({
            textos: ['te envío el pago'], alias, monto: 150000,
            parciales: [{ amount: 300000, amount_paid: 150000 }],
        });
        expect(r).toMatchObject({ cede: true, razon: 'saldo_de_un_cobro' });
    });
    it('mensualidad abierta de $10.000: un comprobante de $10.000 no es una venta nueva', () => {
        const r = laVentaCede({ textos: ['pago'], alias, monto: 10000, pendientes: [{ amount: 10000 }] });
        expect(r).toMatchObject({ cede: true, razon: 'saldo_de_un_cobro' });
    });
    it('si nombra el servicio, la venta decide como siempre', () => {
        const r = laVentaCede({ textos: ['abono clinica de armadores'], alias, monto: 10000, pendientes: [{ amount: 10000 }] });
        expect(r.cede).toBe(false);
    });
    it('un monto que no es de ningún cobro abierto no cede', () => {
        expect(laVentaCede({ textos: ['pago'], alias, monto: 90000, pendientes: [{ amount: 10000 }] }).cede).toBe(false);
    });
});
