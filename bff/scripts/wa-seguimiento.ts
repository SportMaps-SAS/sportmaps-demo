/**
 * Lista de seguimiento de conversaciones de WhatsApp de una escuela, desde la
 * terminal (la misma función que usa la pestaña «Seguimiento»). SOLO LECTURA.
 *
 *   cd bff
 *   npx tsx scripts/wa-seguimiento.ts --escuela <school_id> [--dias 7] [--filas 40] [--sin-responder]
 *
 * Imprime los contadores (escribieron / respondió la escuela / respondió el bot /
 * sin responder / con comprobante / con cobro…) y las filas con el teléfono
 * enmascarado a los últimos 4 dígitos. Nada de envíos ni escrituras.
 */
import 'dotenv/config';

function arg(nombre: string): string | null {
    const i = process.argv.indexOf(nombre);
    return i >= 0 ? process.argv[i + 1] ?? null : null;
}

const ESCUELA = arg('--escuela');
const DIAS = Math.max(1, Math.min(31, Number(arg('--dias') ?? 7) || 7));
const FILAS = Math.max(0, Number(arg('--filas') ?? 40) || 0);
const SOLO_SIN_RESPONDER = process.argv.includes('--sin-responder');

const corto = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const horas = (min: number | null) => (min === null ? '' : min >= 60 ? `${Math.round(min / 6) / 10} h` : `${min} min`);

async function main(): Promise<void> {
    if (!ESCUELA || !/^[0-9a-f-]{36}$/i.test(ESCUELA)) {
        console.error('Uso: npx tsx scripts/wa-seguimiento.ts --escuela <school_id> [--dias 7] [--filas 40] [--sin-responder]');
        process.exit(1);
    }
    const {
        leerRangoSeguimiento, seguimientoDeConversaciones, resumirSeguimiento, filtrarSeguimiento, enmascararTelefono, etiquetaAutor,
    } = await import('../src/services/whatsapp-seguimiento-conversaciones.service');

    const ahora = Date.now();
    const hoy = new Date(ahora - 5 * 3600_000).toISOString().slice(0, 10);
    const d = new Date(`${hoy}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - (DIAS - 1));
    const rango = leerRangoSeguimiento(d.toISOString().slice(0, 10), hoy, ahora);
    if (!rango.ok) throw new Error(rango.error);

    const t0 = Date.now();
    const r = await seguimientoDeConversaciones(ESCUELA, rango, { ahora });
    const ms = Date.now() - t0;
    const resumen = resumirSeguimiento(r.filas);

    console.log(`Seguimiento ${ESCUELA} · ${rango.desde} a ${rango.hasta} (${DIAS} días, hora de Bogotá) · leído en ${ms} ms\n`);
    console.log('Contadores');
    console.log(`  Escribieron ............... ${resumen.escribieron}`);
    console.log(`  Respondió la escuela ...... ${resumen.respondioEscuela}`);
    console.log(`  Respondió el bot .......... ${resumen.respondioBot}`);
    console.log(`  Nadie respondió ........... ${resumen.nadieRespondio}`);
    console.log(`  Sin responder ............. ${resumen.sinResponder}  (esperando o con pendientes de la escuela)`);
    console.log(`  Esperando más de 2 h ...... ${resumen.esperandoMas2h}`);
    console.log(`  Con pendientes escuela .... ${resumen.conPendientes}`);
    console.log(`  Datos de pago enviados .... ${resumen.conDatosDePago}`);
    console.log(`  Con comprobante ........... ${resumen.conComprobante}`);
    console.log(`  Con cobro ................. ${resumen.conCobro}`);

    const temas = new Map<string, number>();
    for (const f of r.filas) temas.set(f.tema.nombre, (temas.get(f.tema.nombre) ?? 0) + 1);
    console.log('\nPor tema');
    for (const [t, n] of [...temas].sort((a, b) => b[1] - a[1])) console.log(`  ${corto(t, 40).padEnd(40)} ${n}`);
    if (r.avisos.length) console.log(`\nAvisos:\n  ${r.avisos.join('\n  ')}`);

    const filas = filtrarSeguimiento(r.filas, { soloSinResponder: SOLO_SIN_RESPONDER }).slice(0, FILAS);
    if (!filas.length) return;
    console.log(`\nFilas (${filas.length} de ${r.filas.length}${SOLO_SIN_RESPONDER ? ', solo sin responder' : ''})`);
    for (const f of filas) {
        const marcas = [
            f.respondioEscuela ? 'escuela' : '', f.respondioBot ? 'bot' : '', f.datosDePagoEnviados ? 'datos-pago' : '',
            f.comprobanteRecibido ? 'comprobante' : '', f.cobro ? `cobro:${f.cobro.estado}` : '',
        ].filter(Boolean).join(',');
        console.log(`${f.alerta ? '!' : ' '} ${enmascararTelefono(f.contacto.telefono).padEnd(7)} ${corto(f.tema.nombre, 26).padEnd(26)} `
            + `último:${etiquetaAutor(f.ultimoMensaje.de).padEnd(10)} ${('esp ' + horas(f.esperandoMin)).padEnd(11)} [${marcas}]`);
        for (const p of f.pendientesEscuela) console.log(`      pendiente: ${corto(p.texto, 70)}`);
    }
}

main().then(() => process.exit(0)).catch((e) => {
    console.error(e?.message ?? e);
    process.exit(1);
});
