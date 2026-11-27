/**
 * Capa 2 (docs/specs/mapi-consultas-sin-ia.md): frases reales → intención.
 * `null` = va al modelo. Ante la duda, null: un falso positivo que responde otra
 * cosa es peor que gastar un turno.
 */
import { describe, it, expect } from 'vitest';
import { reconocer, esAccion } from './intenciones';
import { normalizarMensaje, sinCortesias, extraerFecha, extraerMes, nombreValido, equipoDelResto } from './texto';

/** Jueves 26 de noviembre de 2026 (hora de Colombia). */
const HOY = '2026-11-26';

type Caso = [string, Record<string, unknown> | null];

const CONSULTAS: Caso[] = [
    // ── menú ──
    ['hola', { tipo: 'menu' }],
    ['Hola Mapi!!', { tipo: 'menu' }],
    ['buenas tardes', { tipo: 'menu' }],
    ['holaaa', { tipo: 'menu' }],
    ['menú', { tipo: 'menu' }],
    ['MENU', { tipo: 'menu' }],
    ['opciones', { tipo: 'menu' }],
    ['ayuda', { tipo: 'menu' }],
    ['¿qué puedes hacer?', { tipo: 'menu' }],
    ['en que me puedes ayudar', { tipo: 'menu' }],
    // ── cartera ──
    ['quién debe', { tipo: 'cartera', mes: null }],
    ['Quien debe?', { tipo: 'cartera', mes: null }],
    ['quienes deben', { tipo: 'cartera', mes: null }],
    ['kienes deben', { tipo: 'cartera', mes: null }],
    ['cartera', { tipo: 'cartera', mes: null }],
    ['la cartera', { tipo: 'cartera', mes: null }],
    ['cómo va la cartera', { tipo: 'cartera', mes: null }],
    ['morosos', { tipo: 'cartera', mes: null }],
    ['quiénes están en mora?', { tipo: 'cartera', mes: null }],
    ['quienes no han pagado', { tipo: 'cartera', mes: null }],
    ['quien no ha pagado este mes', { tipo: 'cartera', mes: '2026-11' }],
    ['cuánto nos deben', { tipo: 'cartera', mes: null }],
    ['cuanto me deben x fa', { tipo: 'cartera', mes: null }],
    ['q cartera hay', { tipo: 'cartera', mes: null }],
    ['cartera de octubre', { tipo: 'cartera', mes: '2026-10' }],
    ['quién debe noviembre', { tipo: 'cartera', mes: '2026-11' }],
    ['mensualidades vencidas', { tipo: 'cartera', mes: null }],
    ['pagos atrasados', { tipo: 'cartera', mes: null }],
    ['hola mapi, me puedes decir quién debe por favor', { tipo: 'cartera', mes: null }],
    ['dame la cartera porfa', { tipo: 'cartera', mes: null }],
    ['cartera del mes pasado', { tipo: 'cartera', mes: '2026-10' }],
    ['deudores', { tipo: 'cartera', mes: null }],
    ['cuánto se debe', { tipo: 'cartera', mes: null }],
    // ── cuánto debe X ──
    ['cuánto debe Samuel', { tipo: 'debe', nombre: 'samuel', mes: null }],
    ['cuanto debe samuel ortiz', { tipo: 'debe', nombre: 'samuel ortiz' }],
    ['CUANTO DEBE MARIANA LOPEZ', { tipo: 'debe', nombre: 'mariana lopez' }],
    ['kuanto deve juanes', { tipo: 'debe', nombre: 'juanes' }],
    ['q debe Majo?', { tipo: 'debe', nombre: 'majo' }],
    ['cuánto debe María José en octubre', { tipo: 'debe', nombre: 'maria jose', mes: '2026-10' }],
    ['samuel cuánto debe', { tipo: 'debe', nombre: 'samuel' }],
    ['ya pagó Valentina?', { tipo: 'debe', nombre: 'valentina' }],
    ['Valentina ya pagó', { tipo: 'debe', nombre: 'valentina' }],
    ['está al día Santiago Gómez', { tipo: 'debe', nombre: 'santiago gomez' }],
    ['estado de cuenta de Sofía', { tipo: 'debe', nombre: 'sofia' }],
    ['saldo de Tomás', { tipo: 'debe', nombre: 'tomas' }],
    ['cuanto le falta pagar a Emiliano', { tipo: 'debe', nombre: 'emiliano' }],
    ['cuánto debe maria de los angeles', { tipo: 'debe', nombre: 'maria de los angeles' }],
    ['dime cuánto debe la Mafe', { tipo: 'debe', nombre: 'mafe' }],
    // ── cómo va X ──
    ['cómo va Samuel', { tipo: 'resumen', nombre: 'samuel', mes: null }],
    ['como va mariana lopez', { tipo: 'resumen', nombre: 'mariana lopez' }],
    ['¿cómo le va a Santi?', { tipo: 'resumen', nombre: 'santi' }],
    ['resumen de Juan Pablo', { tipo: 'resumen', nombre: 'juan pablo' }],
    ['como va isabella en octubre', { tipo: 'resumen', nombre: 'isabella', mes: '2026-10' }],
    ['estado de Sebastián', { tipo: 'resumen', nombre: 'sebastian' }],
    ['ficha de Nico', { tipo: 'resumen', nombre: 'nico' }],
    // ── por validar ──
    ['por validar', { tipo: 'por_validar' }],
    ['comprobantes', { tipo: 'por_validar' }],
    ['¿qué comprobantes hay por validar?', { tipo: 'por_validar' }],
    ['cuántos comprobantes hay', { tipo: 'por_validar' }],
    ['comprobantes pendientes', { tipo: 'por_validar' }],
    ['qué hay por aprobar', { tipo: 'por_validar' }],
    ['pagos por revisar', { tipo: 'por_validar' }],
    ['comprovantes x validar', { tipo: 'por_validar' }],
    ['revisa los comprobantes', { tipo: 'por_validar' }],
    ['pendientes de aprobar', { tipo: 'por_validar' }],
    // ── por qué no se aprobó ──
    ['por qué no se aprobó el de Samuel', { tipo: 'por_que', nombre: 'samuel' }],
    ['xq no se aprobo el comprobante de mariana lopez', { tipo: 'por_que', nombre: 'mariana lopez' }],
    ['por que no se aprobó', { tipo: 'por_que', nombre: null }],
    ['¿por qué quedó por validar el pago de Juanes?', { tipo: 'por_que', nombre: 'juanes' }],
    ['por que esta en rojo el de valentina', { tipo: 'por_que', nombre: 'valentina' }],
    // ── auditar ──
    ['auditar', { tipo: 'auditar' }],
    ['audita los comprobantes', { tipo: 'auditar' }],
    ['auditoría de pagos', { tipo: 'auditar' }],
    ['auditar comprobantes pendientes', { tipo: 'auditar' }],
    // ── aprobación automática ──
    ['aprobación automática', { tipo: 'aprobacion_automatica' }],
    ['qué me falta para la aprobación automática', { tipo: 'aprobacion_automatica' }],
    ['estado de la aprobacion automatica', { tipo: 'aprobacion_automatica' }],
    // ── asistencia ──
    ['asistencia de hoy', { tipo: 'asistencia', equipo: null, fecha: HOY }],
    ['Asistencia', { tipo: 'asistencia', equipo: null, fecha: HOY }],
    ['asistensia de hoi', { tipo: 'asistencia', equipo: null, fecha: HOY }],
    ['asistencia de ayer', { tipo: 'asistencia', equipo: null, fecha: '2026-11-25' }],
    ['asistencia de aller', { tipo: 'asistencia', fecha: '2026-11-25' }],
    ['asistencia de antier', { tipo: 'asistencia', fecha: '2026-11-24' }],
    ['quién faltó hoy', { tipo: 'asistencia', equipo: null, fecha: HOY }],
    ['quienes faltaron ayer', { tipo: 'asistencia', fecha: '2026-11-25' }],
    ['quién vino hoy a la sub 12', { tipo: 'asistencia', equipo: 'sub 12', fecha: HOY }],
    ['asistencia de hoy de los Tiburones', { tipo: 'asistencia', equipo: 'tiburones', fecha: HOY }],
    ['asistencia sub-10 ayer', { tipo: 'asistencia', equipo: 'sub-10', fecha: '2026-11-25' }],
    ['asistencia del 20 de noviembre', { tipo: 'asistencia', fecha: '2026-11-20' }],
    ['asistencia del 20/11', { tipo: 'asistencia', fecha: '2026-11-20' }],
    ['asistencia 2026-11-18', { tipo: 'asistencia', fecha: '2026-11-18' }],
    ['asistencia del lunes', { tipo: 'asistencia', fecha: '2026-11-23' }],
    ['asistencia del el 24', { tipo: 'asistencia', fecha: '2026-11-24' }],
    ['quienes no vinieron hoy', { tipo: 'asistencia', fecha: HOY }],
    ['cómo va la lista de hoy', { tipo: 'asistencia', fecha: HOY }],
    // ── semana / horarios ──
    ['semana de los Tiburones', { tipo: 'semana', equipo: 'tiburones' }],
    ['la semana del equipo sub 12', { tipo: 'semana', equipo: 'sub 12' }],
    ['qué hay esta semana', { tipo: 'semana', equipo: null }],
    ['horario de la sub 14', { tipo: 'semana', equipo: 'sub 14' }],
    ['horarios', { tipo: 'horarios' }],
    ['los horarios', { tipo: 'horarios' }],
    ['orarios', { tipo: 'horarios' }],
    ['equipos', { tipo: 'horarios' }],
    ['mis equipos', { tipo: 'horarios' }],
    ['qué entrenos hay hoy', { tipo: 'horarios' }],
    ['entrenos de mañana', { tipo: 'horarios' }],
    ['quién entrena hoy', { tipo: 'horarios' }],
    // ── clases de prueba ──
    ['clases de prueba', { tipo: 'clases_prueba', fecha: null }],
    ['clases de prueba de hoy', { tipo: 'clases_prueba', fecha: HOY }],
    ['clase de prueba mañana', { tipo: 'clases_prueba', fecha: '2026-11-27' }],
    ['quién viene a clase de prueba esta semana', { tipo: 'clases_prueba', fecha: null }],
    ['prospectos', { tipo: 'clases_prueba', fecha: null }],
    ['clases de prueba del sábado', { tipo: 'clases_prueba', fecha: '2026-11-28' }],
    ['clace de pruva', { tipo: 'clases_prueba' }],
    // ── WhatsApp ──
    ['sin responder', { tipo: 'whatsapp', dias: null }],
    ['quién escribió', { tipo: 'whatsapp', dias: null }],
    ['quien escribio hoy por wsp', { tipo: 'whatsapp', dias: 1 }],
    ['mensajes sin responder', { tipo: 'whatsapp' }],
    ['seguimiento de whatsapp', { tipo: 'whatsapp' }],
    ['whatsapp de esta semana', { tipo: 'whatsapp', dias: 7 }],
    ['chats pendientes', { tipo: 'whatsapp' }],
    ['quién está esperando respuesta', { tipo: 'whatsapp' }],
    ['mensajes de los últimos 3 días', { tipo: 'whatsapp', dias: 3 }],
    // ── reservas ──
    ['reservas de hoy', { tipo: 'reservas', fecha: HOY, instalacion: null }],
    ['reservas', { tipo: 'reservas', fecha: HOY }],
    ['resevas de mañana', { tipo: 'reservas', fecha: '2026-11-27' }],
    ['reservas de la cancha 2 mañana', { tipo: 'reservas', fecha: '2026-11-27', instalacion: 'cancha 2' }],
    ['canchas libres hoy', { tipo: 'reservas', fecha: HOY }],
    ['quién reservó el sábado', { tipo: 'reservas', fecha: '2026-11-28' }],
    // ── tienda / inventario ──
    ['ventas del mes', { tipo: 'tienda', mes: '2026-11' }],
    ['ventas de la tienda', { tipo: 'tienda', mes: null }],
    ['ventas de octubre', { tipo: 'tienda', mes: '2026-10' }],
    ['pedidos de la tienda', { tipo: 'tienda' }],
    ['cuánto vendimos este mes', { tipo: 'tienda', mes: '2026-11' }],
    ['inventario', { tipo: 'inventario', producto: null }],
    ['qué se está acabando', { tipo: 'inventario', producto: null }],
    ['agotados', { tipo: 'inventario' }],
    ['stock bajo', { tipo: 'inventario' }],
    ['inventario de camisetas', { tipo: 'inventario', producto: 'camisetas' }],
    ['stock de la camiseta azul', { tipo: 'inventario', producto: 'camiseta azul' }],
    ['inbentario', { tipo: 'inventario' }],
    // ── torneos / servicios ──
    ['torneos', { tipo: 'torneos', estado: 'vigentes' }],
    ['próximos torneos', { tipo: 'torneos', estado: 'vigentes' }],
    ['qué torneos hay', { tipo: 'torneos', estado: 'vigentes' }],
    ['torneos activos', { tipo: 'torneos', estado: 'activos' }],
    ['torneos finalizados', { tipo: 'torneos', estado: 'finalizados' }],
    ['torneos en borrador', { tipo: 'torneos', estado: 'borradores' }],
    ['ventas de servicios', { tipo: 'servicios', item: null }],
    ['cómo va la venta de la clínica', { tipo: 'servicios', item: 'clinica' }],
    ['como va la clinica de porteros', { tipo: 'servicios', item: 'clinica de porteros' }],
    ['interesados en el vacacional', { tipo: 'servicios', item: 'vacacional' }],
    ['vacacional', { tipo: 'servicios', item: 'vacacional' }],
    // ── informes ──
    ['informes de Samuel', { tipo: 'informes', nombre: 'samuel' }],
    ['el informe mensual de Mariana López', { tipo: 'informes', nombre: 'mariana lopez' }],
    // ── ayuda de la app ──
    ['cómo hago para crear un equipo', { tipo: 'ayuda' }],
    ['¿cómo registro un pago en efectivo?', { tipo: 'ayuda' }],
    ['dónde veo los carnets', { tipo: 'ayuda' }],
];

/** Deben ir al MODELO: acciones, compuestas, ambiguas, de contexto, fuera de la escuela. */
const AL_MODELO: string[] = [
    // acciones (salen como tarjeta + Confirmar, siempre con el modelo)
    'excusa a Samuel mañana', 'excusar a mariana del viernes', 'dale de baja a Juanes', 'da de baja a Tomás',
    'aprueba el pago de Samuel', 'aprueba los verdes', 'apruebalo', 'registra un pago de 120 mil de Sofía',
    'registra el pago en efectivo de Valentina', 'cóbrale el uniforme a todos', 'cobra la mensualidad', 'paga',
    'mándale un recordatorio a los que deben', 'envíale el informe a la mamá de Samuel', 'recuérdale a la familia de Juan',
    'pausa a Mariana por vacaciones', 'reactiva a Samuel', 'cambia de plan a Sofía', 'crea un cobro único de 50 mil',
    'agenda una clase de prueba para Luis el sábado', 'convoca a la sub 12 al torneo', 'inscribe a Samuel al torneo',
    'pasa lista de la sub 12', 'marca a Samuel presente', 'felicita a Valentina', 'evalúa el entreno de hoy',
    'ajusta el stock de camisetas', 'cancela la reserva de las 5', 'borra a Samuel', 'elimina el pago duplicado',
    'anula el cobro', 'reembolsa el pago', 'prende la aprobación automática', 'activa la aprobación automática',
    'pídele aclaración del comprobante a la mamá de Samuel', 'valida el pago de Juan', 'avísale a los papás que no hay entreno',
    'escríbele a la familia de Mariana', 'sube el precio de la mensualidad', 'quítale la mora a Samuel',
    'dale los buenos días a todos', 'haz la auditoría y aprueba los verdes', 'genera el informe de Samuel',
    // compuestas
    'quién debe y quién faltó hoy', 'cartera y comprobantes por validar', 'cuánto debe Samuel y Mariana',
    'asistencia de hoy y de ayer', 'torneos y clases de prueba', 'además de la cartera, los torneos',
    // contexto de la conversación
    'y Samuel?', 'y el de Mariana?', '¿y hoy?', '¿y los pagos?', 'ese', 'esa misma', 'lo mismo para ayer', 'el de ella',
    'y la sub 12?', 'otra vez',
    // negaciones raras y comparaciones
    'quién no debe', 'cartera sin contar octubre', 'torneos menos los finalizados', 'quién debe más que Samuel',
    'asistencia promedio del mes', 'cartera comparada con el mes pasado', 'quién es el mejor de la sub 12',
    // ambiguas o con parentesco (el modelo resuelve «el hijo de…»)
    'cuanto debe el hijo de Carlos Pérez', 'cuánto debe la hija de Milena', 'cómo va el hijo de la señora Ruiz',
    'cuanto debe', 'pagos pendientes', 'cómo vamos?', 'como va todo', 'cómo va el mes',
    'asistencia de la mañana', 'asistencia del lunes y martes', 'cobro', 'cobro de uniforme', 'recordatorio',
    'uno', 'dos', 'tres', 'si', 'ok', 'gracias',
    // fuera de la escuela
    '¿cuál es la capital de Francia?', 'qué clima hace hoy en Bogotá', 'resultados del Real Madrid',
    'dame una receta de arepas', 'tradúceme esto al inglés', 'escríbeme un código en python',
    'cuéntame un chiste', 'qué hago si a mi hijo le duele la rodilla', 'cuánto cobra la escuela de al lado',
    'quién ganó el partido de anoche',
    // texto largo con contexto
    'oye mapi, ayer hablé con la mamá de Samuel y me dijo que ya había pagado pero no veo el comprobante, ¿me ayudas a revisar qué pasó?',
    // datos sensibles o fuera de lo que hace una consulta
    'dame el teléfono de la mamá de Samuel', 'la dirección de Mariana', 'el documento de Juanes',
    'asistencia de Samuel en octubre del 2025 comparada', 'informe de asistencia de octubre',
];

describe('reconocer: consultas frecuentes', () => {
    it.each(CONSULTAS)('«%s»', (frase, esperado) => {
        const r = reconocer(frase, HOY);
        expect(r).not.toBeNull();
        expect(r).toMatchObject(esperado!);
    });
});

describe('reconocer: lo que va al modelo', () => {
    it.each(AL_MODELO.map((f) => [f]))('«%s» → modelo', (frase) => {
        expect(reconocer(frase, HOY)).toBeNull();
    });
});

describe('cobertura de la tabla', () => {
    it('al menos 150 frases reales', () => {
        expect(CONSULTAS.length + AL_MODELO.length).toBeGreaterThanOrEqual(150);
    });
    it('todas las intenciones de la lista tienen frases', () => {
        const tipos = new Set(CONSULTAS.map(([, e]) => e!.tipo));
        for (const t of ['menu', 'ayuda', 'cartera', 'debe', 'resumen', 'por_validar', 'por_que', 'auditar', 'aprobacion_automatica', 'asistencia', 'semana', 'horarios', 'clases_prueba', 'whatsapp', 'reservas', 'tienda', 'inventario', 'torneos', 'servicios', 'informes']) {
            expect(tipos.has(t as any), t).toBe(true);
        }
    });
});

describe('texto: normalización', () => {
    it('minúsculas, sin tildes, sin signos ni letras repetidas', () => {
        expect(normalizarMensaje('¿¿Cuántooo DEBE Mariá??')).toBe('cuanto debe maria');
    });
    it('abreviaturas de WhatsApp', () => {
        expect(normalizarMensaje('q debe x fa')).toBe('que debe por fa');
        expect(normalizarMensaje('xq no se aprobó')).toBe('por que no se aprobo');
        expect(normalizarMensaje('xfa la cartera')).toBe('la cartera');
    });
    it('cortesías al principio y al final', () => {
        expect(sinCortesias('hola mapi me puedes decir quien debe gracias').texto).toBe('quien debe');
        expect(sinCortesias('buenas dime la cartera').saludo).toBe(true);
    });
});

describe('texto: fechas en hora de Colombia', () => {
    it('relativas', () => {
        expect(extraerFecha('hoy', HOY, 'pasado').fecha).toBe(HOY);
        expect(extraerFecha('ayer', HOY, 'pasado').fecha).toBe('2026-11-25');
        expect(extraerFecha('antier', HOY, 'pasado').fecha).toBe('2026-11-24');
        expect(extraerFecha('manana', HOY, 'futuro').fecha).toBe('2026-11-27');
        expect(extraerFecha('pasado manana', HOY, 'futuro').fecha).toBe('2026-11-28');
    });
    it('día de la semana: hacia atrás o hacia adelante según la consulta', () => {
        expect(extraerFecha('el lunes', HOY, 'pasado').fecha).toBe('2026-11-23');
        expect(extraerFecha('el lunes', HOY, 'futuro').fecha).toBe('2026-11-30');
        expect(extraerFecha('el jueves', HOY, 'pasado').fecha).toBe(HOY);
        expect(extraerFecha('el jueves pasado', HOY, 'futuro').fecha).toBe('2026-11-19');
    });
    it('«en la mañana» y dos fechas son dudosas', () => {
        expect(extraerFecha('asistencia en la manana', HOY, 'pasado').dudosa).toBe(true);
        expect(extraerFecha('hoy y ayer', HOY, 'pasado').dudosa).toBe(true);
        expect(extraerFecha('el 31 de febrero', HOY, 'pasado').dudosa).toBe(true);
    });
    it('meses: un mes que no ha llegado es del año pasado', () => {
        expect(extraerMes('de diciembre', HOY).mes).toBe('2025-12');
        expect(extraerMes('de noviembre', HOY).mes).toBe('2026-11');
        expect(extraerMes('el mes pasado', HOY).mes).toBe('2026-10');
        expect(extraerMes('octubre de 2025', HOY).mes).toBe('2025-10');
        expect(extraerMes('enero', '2026-01-10').mes).toBe('2026-01');
        expect(extraerMes('el mes pasado', '2026-01-10').mes).toBe('2025-12');
    });
});

describe('texto: nombres y equipos', () => {
    it('nombres válidos', () => {
        expect(nombreValido('a samuel ortiz')).toBe('samuel ortiz');
        expect(nombreValido('maria de los angeles')).toBe('maria de los angeles');
    });
    it('lo que no es un nombre', () => {
        for (const s of ['el hijo de carlos', 'todos', 'ella', 'la sub 12', 'samuel123', 'el mes', 'de', 'la mama de juan', 'uno dos tres cuatro cinco']) {
            expect(nombreValido(s), s).toBeNull();
        }
    });
    it('equipos', () => {
        expect(equipoDelResto('de los tiburones')).toBe('tiburones');
        expect(equipoDelResto('del equipo sub-12')).toBe('sub-12');
        expect(equipoDelResto('de mi equipo')).toBeUndefined();
        expect(equipoDelResto('de samuel y mariana')).toBeNull();
    });
    it('acciones', () => {
        expect(esAccion('aprueba el pago')).toBe(true);
        expect(esAccion('que hay por aprobar')).toBe(false);
        expect(esAccion('quienes no han pagado')).toBe(false);
        expect(esAccion('comprobantes por validar')).toBe(false);
    });
});
