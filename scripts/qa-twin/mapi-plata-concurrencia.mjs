// Plata de Mapi con concurrencia REAL (plan docs/specs/mapi-rpc-por-actor-plan.md §9.4, P1–P8).
// Dos conexiones a la vez sobre el mismo cobro: la primera aplica y sostiene sus candados
// un momento; la segunda espera y tiene que ver el estado nuevo.
//
// SOLO el gemelo local (twinClient aborta con otra URL). Crea cobros de prueba en
// Academia Andes del seed, con COMMIT (hace falta para que la segunda conexión los vea),
// y al final los BORRA junto con lo que dejaron (pago_operaciones, notificaciones, logs).
//
// Correr (gemelo arriba, migraciones 20261126101055 y 20261126101150 aplicadas):
//   node scripts/qa-twin/mapi-plata-concurrencia.mjs
import { twinClient } from './lib.mjs';

const A = '00000000-0000-4000-b000-000000000001';
const A02 = '00000000-0000-4000-a000-000000000002';   // school_admin de Andes
const A01 = '00000000-0000-4000-a000-000000000001';   // owner de Andes
const C1 = '00000000-0000-4000-c000-000000000001';
const A04 = '00000000-0000-4000-a000-000000000004';
const MONTO_DIFIERE = '[{"code":"MONTO_DIFIERE","level":"amarillo"}]';

const setup = await twinClient();
const creados = [];
const llaves = [];
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const uuid = async () => (await setup.query('select gen_random_uuid() id')).rows[0].id;

/** Cobro de prueba (COMMIT). Con comprobante: awaiting_approval; sin: pending. */
async function cobro({ monto = 145000, veredicto = 'verde', motivos = '[]', ocr = null, comprobante = true } = {}) {
    const id = await uuid();
    await setup.query(`
        insert into public.payments (id, school_id, child_id, parent_id, amount, concept, due_date, status,
                                     payment_type, payment_category, period_uniqueness_exempt,
                                     receipt_url, receipt_verdict, receipt_verdict_reasons,
                                     receipt_image_sha256, receipt_reference_norm, ocr_reference)
        values ($1::uuid, $2, $3, $4, $5, 'Concurrencia QA ' || left($1::text, 8), current_date, $6,
                'one_time', 'otro', true, $7, $8, $9::jsonb, $10, $11, $11)`,
        [id, A, C1, A04, monto, comprobante ? 'awaiting_approval' : 'pending',
         comprobante ? `qa/conc/${id}.jpg` : null, comprobante ? veredicto : null, comprobante ? motivos : null,
         comprobante ? `conc-${id}` : null, comprobante ? `CONC${id.slice(0, 8).toUpperCase()}` : null]);
    await setup.query(`update public.payments set period_year = null, period_month = null,
                       ocr_amount = coalesce($2, case when receipt_url is null then null else amount - coalesce(early_payment_discount_applied, 0) end),
                       receipt_image_sha256_source = case when receipt_url is null then null else 'server_verified' end
                       where id = $1`, [id, ocr]);
    creados.push(id);
    return id;
}

/** Una operación en su propia conexión y transacción, como una request del BFF. */
async function operacion(etiqueta, sql, params, { sostener = 0, retraso = 0, rol = 'service_role', sub = null } = {}) {
    await espera(retraso);
    const c = await twinClient();
    const t0 = Date.now();
    try {
        await c.query('begin');
        const claims = rol === 'service_role' ? { role: 'service_role' } : { role: rol, sub };
        await c.query(`select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)`,
            [JSON.stringify(claims), sub ?? '']);
        await c.query(`set local role ${rol}`);
        const r = await c.query(sql, params);
        if (sostener) await c.query('select pg_sleep($1)', [sostener / 1000]);
        await c.query('commit');
        return { etiqueta, ok: true, filas: r.rowCount, valor: r.rows[0] ? Object.values(r.rows[0])[0] : null, ms: Date.now() - t0 };
    } catch (e) {
        try { await c.query('rollback'); } catch { /* */ }
        return { etiqueta, ok: false, code: e.code, error: e.message, ms: Date.now() - t0 };
    } finally {
        await c.end();
    }
}

const APROBAR = 'select public.aprobar_comprobante_por($1, $2, $3, $4, $5, \'mapi_whatsapp\', null) r';
const EFECTIVO = 'select public.register_manual_payments_por($1, $2, $3, $4, $5, $6, null, \'mapi_whatsapp\', null) r';
const estado = async (id) => (await setup.query('select status, amount_paid, approved_by from public.payments where id = $1', [id])).rows[0];

/** Una de las dos aplicó y la otra falló con `patron` (no importa cuál llegó primero). */
const unaGanaYLaOtra = (x, y, patron) => (x.ok && !y.ok && patron.test(y.error)) || (y.ok && !x.ok && patron.test(x.error));
const errorDe = (x, y) => (x.ok ? y.error : x.error);

const resultados = [];
function caso(id, descripcion, pasa, detalle) {
    resultados.push({ id, pasa });
    console.log(`${pasa ? 'PASA ' : 'FALLA'} ${id} ${descripcion}`);
    if (detalle) console.log('      ', JSON.stringify(detalle));
}

try {
    // P1: doble clic, misma llave.
    {
        const p = await cobro(); const k = await uuid(); llaves.push(k);
        const [x, y] = await Promise.all([
            operacion('A', APROBAR, [A02, p, null, 0, k], { sostener: 2500 }),
            operacion('B', APROBAR, [A02, p, null, 0, k], { retraso: 1000 }),
        ]);
        const s = await estado(p);
        const logs = (await setup.query(`select count(*)::int n from public.payment_audit_logs where payment_id = $1 and new_status = 'paid'`, [p])).rows[0].n;
        caso('P1', 'misma llave a la vez → una aplica, la otra devuelve ya_aplicada',
            x.ok && y.ok && [x.valor?.ya_aplicada, y.valor?.ya_aplicada].filter(Boolean).length === 1 && s.status === 'paid' && logs === 1,
            { ya_aplicada: [x.valor?.ya_aplicada, y.valor?.ya_aplicada], logs });
    }
    // P2: dos admins (llaves distintas) aprueban el mismo pago.
    {
        const p = await cobro(); const k1 = await uuid(); const k2 = await uuid(); llaves.push(k1, k2);
        const [x, y] = await Promise.all([
            operacion('app', APROBAR, [A02, p, null, 0, k1], { sostener: 2500 }),
            operacion('whatsapp', APROBAR, [A01, p, null, 0, k2], { retraso: 1000 }),
        ]);
        const s = await estado(p);
        caso('P2', 'llaves distintas → la segunda cobro_no_abierto, amount_paid una vez',
            unaGanaYLaOtra(x, y, /cobro_no_abierto/) && s.status === 'paid' && Number(s.amount_paid) === 145000, { error: errorDe(x, y), s });
    }
    // P3: dos abonos con el mismo pagado_antes.
    {
        const p = await cobro({ veredicto: 'amarillo', motivos: MONTO_DIFIERE, ocr: 50000 });
        const k1 = await uuid(); const k2 = await uuid(); llaves.push(k1, k2);
        const [x, y] = await Promise.all([
            operacion('abono1', APROBAR, [A02, p, 50000, 0, k1], { sostener: 2500 }),
            operacion('abono2', APROBAR, [A01, p, 50000, 0, k2], { retraso: 1000 }),
        ]);
        const s = await estado(p);
        caso('P3', 'dos abonos a la vez → el segundo cobro_cambio, amount_paid = un abono',
            unaGanaYLaOtra(x, y, /cobro_cambio/) && s.status === 'partial' && Number(s.amount_paid) === 50000, { error: errorDe(x, y), s });
    }
    // P4: Mapi contra el UPDATE del navegador (approvePayment.ts, cuentas de la tarjeta vieja).
    {
        const NAVEGADOR = `update public.payments set status = 'paid', amount_paid = $2, approved_by = $3, approved_at = now()
                           where id = $1 and status in ('awaiting_approval','pending','overdue','partial')`;
        const p = await cobro(); const k = await uuid(); llaves.push(k);
        const [x, y] = await Promise.all([
            operacion('mapi', APROBAR, [A02, p, null, 0, k], { sostener: 2500 }),
            operacion('navegador', NAVEGADOR, [p, 145000, A01], { retraso: 1000, rol: 'authenticated', sub: A01 }),
        ]);
        // Gane quien gane, el cobro se aprueba una sola vez.
        caso('P4a', 'pago completo por Mapi vs navegador → se aprueba una sola vez',
            (x.ok && y.ok && y.filas === 0) || (!x.ok && /cobro_no_abierto/.test(x.error) && y.ok && y.filas === 1), { mapi: x.ok ? 'aplicó' : x.error, navegador: y.filas });
        const q = await cobro({ veredicto: 'amarillo', motivos: MONTO_DIFIERE, ocr: 50000 }); const k2 = await uuid(); llaves.push(k2);
        const [x2, y2] = await Promise.all([
            operacion('mapi-abono', APROBAR, [A02, q, 50000, 0, k2], { sostener: 2500 }),
            operacion('navegador', NAVEGADOR, [q, 145000, A01], { retraso: 1000, rol: 'authenticated', sub: A01 }),
        ]);
        const s = await estado(q);
        // Riesgo 4 del plan: esperado que el navegador PISE el abono (no tiene candado sobre amount_paid).
        caso('P4b', 'abono por Mapi + navegador con cuentas viejas → riesgo 4 documentado (el navegador pisa)',
            // Si el navegador llegó primero, Mapi ve el cobro cerrado y no hay riesgo que mostrar en esta vuelta.
            (x2.ok && y2.ok && y2.filas === 1 && s.status === 'paid') || (!x2.ok && /cobro_no_abierto/.test(x2.error)), { mapi: x2.ok ? 'aplicó' : x2.error, navegador: y2.filas, s });
    }
    // P5: aprobar contra reject_payment_receipt.
    {
        const p = await cobro(); const k = await uuid(); llaves.push(k);
        const [x, y] = await Promise.all([
            operacion('aprobar', APROBAR, [A02, p, null, 0, k], { sostener: 2500 }),
            operacion('rechazar', `select public.reject_payment_receipt($1, 'OTRO', 'QA concurrencia') r`, [p], { retraso: 1000 }),
        ]);
        const s = (await setup.query('select status, receipt_rejected_at from public.payments where id = $1', [p])).rows[0];
        caso('P5', 'aprobar vs rechazar → nunca paid con el comprobante rechazado',
            !(s.status === 'paid' && s.receipt_rejected_at), { aprobar: x.ok, rechazar: y.ok ? 'ok' : y.error, s });
    }
    // P6: aprobar contra auto_approve_payment (§2.3 #5).
    {
        const p = await cobro(); const k = await uuid(); llaves.push(k);
        const [x, y] = await Promise.all([
            operacion('aprobar', APROBAR, [A02, p, null, 0, k], { sostener: 2500 }),
            operacion('automatica', 'select public.auto_approve_payment($1) r', [p], { retraso: 1000 }),
        ]);
        const s = await estado(p);
        const avisos = (await setup.query(`select count(*)::int n from public.notifications where user_id = $1 and created_at > now() - interval '1 minute'
                                           and (title = '✅ Pago confirmado' or title = 'Pago aprobado') and coalesce(data->>'concept','') is not null
                                           and (message like '%' || $2 || '%' or title = 'Pago aprobado')`, [A04, `Concurrencia QA ${p.slice(0, 8)}`])).rows[0].n;
        caso('P6', 'aprobar vs automática → una sola aprobación (approved_by = persona); se mide el aviso doble',
            s.status === 'paid' && (x.ok ? s.approved_by === A02 : /cobro_no_abierto/.test(x.error)), { mapi: x.ok ? 'aplicó' : x.error, automatica: y.ok ? y.valor : y.error, s, avisos_a_la_familia: avisos });
    }
    // P7: dos registros de efectivo sobre el mismo cobro.
    {
        const p = await cobro({ comprobante: false }); const k1 = await uuid(); const k2 = await uuid(); llaves.push(k1, k2);
        const [x, y] = await Promise.all([
            operacion('efectivo1', EFECTIVO, [A02, A, p, 50000, 0, k1], { sostener: 2500 }),
            operacion('efectivo2', EFECTIVO, [A01, A, p, 50000, 0, k2], { retraso: 1000 }),
        ]);
        const s = await estado(p);
        caso('P7', 'dos efectivos a la vez → el segundo cobro_cambio', unaGanaYLaOtra(x, y, /cobro_cambio/) && Number(s.amount_paid) === 50000, { error: errorDe(x, y), s });
    }
    // P8: sin interbloqueos con muchas operaciones cruzadas.
    {
        const pagos = [await cobro(), await cobro(), await cobro({ comprobante: false })];
        const ops = [];
        for (let i = 0; i < 12; i++) {
            const k = await uuid(); llaves.push(k);
            const p = pagos[i % 3];
            ops.push(i % 3 === 2
                ? operacion(`e${i}`, EFECTIVO, [i % 2 ? A01 : A02, A, p, 1000, 0, k], { retraso: (i * 37) % 120, sostener: 150 })
                : operacion(`a${i}`, APROBAR, [i % 2 ? A01 : A02, p, null, 0, k], { retraso: (i * 37) % 120, sostener: 150 }));
        }
        const rs = await Promise.all(ops);
        const deadlocks = rs.filter((r) => r.code === '40P01');
        caso('P8', '12 operaciones cruzadas → sin 40P01', deadlocks.length === 0, { ok: rs.filter((r) => r.ok).length, errores: [...new Set(rs.filter((r) => !r.ok).map((r) => r.error.split(':')[0]))] });
    }
} finally {
    // Limpieza: el gemelo queda como estaba.
    await setup.query('begin');
    await setup.query('delete from public.pago_operaciones where idempotency_key = any($1::uuid[])', [llaves]);
    await setup.query(`delete from public.notifications where user_id = $1 and created_at > now() - interval '15 minutes'
                       and (message like '%Concurrencia QA%' or title in ('Pago aprobado', 'Pago recibido'))`, [A04]);
    await setup.query(`delete from public.notifications where created_at > now() - interval '15 minutes' and message like '%Concurrencia QA%'`);
    await setup.query('delete from public.payment_audit_logs where payment_id = any($1::uuid[])', [creados]);
    await setup.query('delete from public.payment_adjustments where payment_id = any($1::uuid[])', [creados]).catch(() => {});
    await setup.query('delete from public.payments where id = any($1::uuid[])', [creados]);
    await setup.query('commit');
    await setup.end();
}
const fallas = resultados.filter((r) => !r.pasa).length;
console.log(`\n${resultados.length - fallas}/${resultados.length} casos pasan`);
process.exit(fallas ? 1 : 0);
