-- =============================================================================
-- DATOS PENDIENTES — Monster's Volley Club · cobro de servicio unificado
-- *** BORRADORES. NO APLICAR sin el OK de la persona dueña del dato. ***
-- Plan: docs/specs/pago-manual-de-servicio.md §6 (correcciones c, d, f, g).
-- Requiere la migración 20261111114349_cobro_servicio_unificado.sql YA aplicada
-- (usa ligar_cobro_a_servicio). Las correcciones a, b, e del plan NO están aquí.
--
-- CÓMO ESTÁ ARMADO (seguro por defecto)
--   · Cada bloque es una transacción: SELECT previo → cambio → SELECT posterior → REVERSO
--     comentado. Todos terminan en ROLLBACK: correrlos tal cual NO deja nada. Para aplicar
--     de verdad, cambiar ese ROLLBACK por COMMIT, de a UN bloque, tras mirar el SELECT posterior.
--   · Las RPC de la escuela exigen una sesión de admin (auth.uid()). Desde el CLI no la hay,
--     así que cada bloque la simula con request.jwt.claims (sub = el owner/admin de Monster,
--     que se busca en la base: no hay ids pegados). Es la misma simulación de las pruebas.
--   · Una sola sesión aplica (el ítem y los cobros se bloquean fila a fila).
--   · NO se escribe ningún dato personal en este archivo: lo que se mueve se copia con SQL.
--
-- Ids (de la base, 2026-11-11):
--   escuela Monster          eb3ebc77-4ea4-4992-96c8-3c8ec574578c
--   ítem «Clínica de armadores y atacantes»   16766d2e-f8b0-4285-88e3-b1e67dda6d45
--   lote de cobros           930cfc4e-6ba2-4ed2-a637-50d7d2b1f5b1   (6 cobros «Clínica Jorge Mesa — …», $175.000, categoría «otro»)
--   equipo Mixto Mayores Profundización       444bca9a-26cb-4ef9-a719-9c6cbf32fd4e   (5 cobros)
--   equipo Mayores Masculino                  39b009d2-ba60-48d2-af75-ef934630fbbe   (Daniel Becerra, 1 cobro)
-- =============================================================================


-- =============================================================================
-- 1. LIGAR LOS 5 COBROS DE MIXTO AL ÍTEM, con el descuento 'equipo30' (30 %)
--    Cada cobro conserva su monto ($175.000 = 250.000 − 30 %): NO se cambia amount;
--    solo se estampan lista 250.000 / descuento 75.000 / 30 % y la categoría pasa
--    de «otro» a clase_extra. La RPC rechaza (monto_no_cuadra) cualquiera que no cuadre.
--    Cobros: Valery Martínez 51ed6b0a (deportista sin cuenta) · Diego Vanegas fcb09417 ·
--    Néstor Piracón b81cafa1 · Carlos Martínez 772e15f2 (YA pagado) · Gabriela Varela 7a2ef199
--    (comprobante por aprobar). Con esto el grupo cuenta 5 para el mínimo.
-- =============================================================================
BEGIN;

-- SELECT previo: esperado 5 filas, todas 'otro', sin lista, sin enlace, 175000, equipo 444bca9a.
SELECT p.id, p.concept, p.amount, p.status, p.payment_category, p.list_amount, p.discount_pct, p.team_id,
       public._servicio_pago_ligado(p.id) AS ya_ligado_a
  FROM public.payments p
 WHERE p.charge_batch_id = '930cfc4e-6ba2-4ed2-a637-50d7d2b1f5b1'
   AND p.team_id = '444bca9a-26cb-4ef9-a719-9c6cbf32fd4e'
 ORDER BY p.created_at;

-- Sesión del admin de Monster (el owner más antiguo).
SELECT set_config('request.jwt.claims', json_build_object(
  'sub', (SELECT sm.profile_id::text FROM public.school_members sm
           WHERE sm.school_id = 'eb3ebc77-4ea4-4992-96c8-3c8ec574578c' AND sm.status = 'active'
             AND sm.role IN ('owner', 'admin', 'school_admin') ORDER BY sm.created_at LIMIT 1),
  'role', 'authenticated')::text, true);

-- Cambio: una llamada por cobro (cada una devuelve {ok:true,…} o {ok:false,codigo}).
SELECT p.id,
       public.ligar_cobro_a_servicio(p.id, '16766d2e-f8b0-4285-88e3-b1e67dda6d45',
                                     'Cobro creado por la escuela por equipo; se liga a la clínica con el 30 % de grupo', 'equipo30') AS resultado
  FROM public.payments p
 WHERE p.id IN ('51ed6b0a-4c1d-44a1-8ddb-a1a63f31b8ae', 'fcb09417-0c73-46e0-bf24-ae02bc0c4baf',
                'b81cafa1-05d1-4f8a-9ed6-196602991801', '772e15f2-df6b-48e1-94dd-5b8907c2fdcf',
                '7a2ef199-b295-43e4-92b0-e511c705c51c');

-- SELECT posterior: esperado 5 filas clase_extra, 175000 intactos, lista 250000, descuento 75000, 30 %,
-- enlace origen 'ligado_escuela' con clave equipo30, y el grupo cumple (true).
SELECT p.id, p.amount, p.status, p.payment_category, p.list_amount, p.discount_amount, p.discount_pct,
       c.origen, c.descuento_clave, c.team_id
  FROM public.payments p JOIN public.cobros_servicio_item c ON c.payment_id = p.id
 WHERE c.item_id = '16766d2e-f8b0-4285-88e3-b1e67dda6d45' ORDER BY p.created_at;
SELECT public._servicio_grupo_cumple('16766d2e-f8b0-4285-88e3-b1e67dda6d45', '444bca9a-26cb-4ef9-a719-9c6cbf32fd4e', 0) AS grupo_mixto_cumple;
SELECT public._servicio_cupos_vivos('16766d2e-f8b0-4285-88e3-b1e67dda6d45') AS cupos_vivos_del_item;

-- REVERSO (si hace falta deshacerlo DESPUÉS de un COMMIT; en una sola transacción basta el ROLLBACK):
--   UPDATE public.payments SET payment_category = 'otro', list_amount = NULL, discount_amount = 0, discount_pct = NULL
--    WHERE id IN ('51ed6b0a-4c1d-44a1-8ddb-a1a63f31b8ae','fcb09417-0c73-46e0-bf24-ae02bc0c4baf',
--                 'b81cafa1-05d1-4f8a-9ed6-196602991801','772e15f2-df6b-48e1-94dd-5b8907c2fdcf',
--                 '7a2ef199-b295-43e4-92b0-e511c705c51c');
--   DELETE FROM public.cobros_servicio_item
--    WHERE payment_id IN ('51ed6b0a-4c1d-44a1-8ddb-a1a63f31b8ae','fcb09417-0c73-46e0-bf24-ae02bc0c4baf',
--                         'b81cafa1-05d1-4f8a-9ed6-196602991801','772e15f2-df6b-48e1-94dd-5b8907c2fdcf',
--                         '7a2ef199-b295-43e4-92b0-e511c705c51c');

ROLLBACK;   -- ← cambiar por COMMIT al aprobar, de a un bloque


-- =============================================================================
-- 1b. DANIEL BECERRA NEIRA (cobro 31984ffa) — DECISIÓN PENDIENTE (plan §7.2)
--     Queda SIN descuento de grupo: su equipo es Mayores Masculino (no Mixto) y el
--     descuento de $175.000 se le aplicó por error a $250.000 de lista. Su cobro actual
--     es de $175.000. NO se liga hasta decidir (ligarlo tal cual lo registraría como
--     «precio acordado 175.000» con motivo, que quizá no es lo que se quiere).
--     Opción A (queda en $250.000, lo que corresponde sin grupo): repreciar y luego ligar.
--     Opción B (se respeta $175.000 como acuerdo de la escuela): ligar sin repreciar.
--     Todo comentado; descomentar UNA opción tras la decisión de la escuela.
-- =============================================================================
-- BEGIN;
-- SELECT p.id, p.concept, p.amount, p.status, p.payment_category, p.team_id, p.list_amount
--   FROM public.payments p WHERE p.id = '31984ffa-edf7-4732-bef7-90ab3507420c';   -- esperado: 175000, pending/overdue, 'otro'
--
-- SELECT set_config('request.jwt.claims', json_build_object(
--   'sub', (SELECT sm.profile_id::text FROM public.school_members sm
--            WHERE sm.school_id = 'eb3ebc77-4ea4-4992-96c8-3c8ec574578c' AND sm.status = 'active'
--              AND sm.role IN ('owner', 'admin', 'school_admin') ORDER BY sm.created_at LIMIT 1),
--   'role', 'authenticated')::text, true);
--
-- -- Opción A: reprecio a 250.000 (cobro sin pagos: amount_paid nulo; si ya tuviera abonos NO se hace) y ligar sin descuento.
-- UPDATE public.payments SET amount = 250000
--  WHERE id = '31984ffa-edf7-4732-bef7-90ab3507420c' AND status IN ('pending', 'overdue') AND COALESCE(amount_paid, 0) = 0;
-- SELECT public.ligar_cobro_a_servicio('31984ffa-edf7-4732-bef7-90ab3507420c', '16766d2e-f8b0-4285-88e3-b1e67dda6d45',
--        'Daniel queda sin descuento de grupo: otro equipo, 250.000 de afiliado', NULL);
--
-- -- Opción B: ligar tal cual ($175.000 queda como precio acordado, con este motivo).
-- -- SELECT public.ligar_cobro_a_servicio('31984ffa-edf7-4732-bef7-90ab3507420c', '16766d2e-f8b0-4285-88e3-b1e67dda6d45',
-- --        'La escuela acordó 175.000 para Daniel pese a ser de otro equipo', NULL);
--
-- SELECT p.id, p.amount, p.payment_category, c.precio_lista, c.precio_acordado, c.motivo_precio
--   FROM public.payments p JOIN public.cobros_servicio_item c ON c.payment_id = p.id
--  WHERE p.id = '31984ffa-edf7-4732-bef7-90ab3507420c';
-- -- REVERSO: UPDATE public.payments SET amount = 175000, payment_category = 'otro' WHERE id = '31984ffa-edf7-4732-bef7-90ab3507420c';
-- --          DELETE FROM public.cobros_servicio_item WHERE payment_id = '31984ffa-edf7-4732-bef7-90ab3507420c';
-- ROLLBACK;


-- =============================================================================
-- 2. KAREN RESTREPO RODRÍGUEZ — lead 24473e26: teléfono 3112540145 (plan §6d)
--    Hoy el lead guarda un marcador manual en vez del teléfono. OJO: el lead
--    1e8d19ca-f9e8-4434-a6ec-31081528b006 (Paola Aguirre) YA tiene ese mismo teléfono
--    (decisión pendiente: ¿fusionar? plan §7.6). No hay índice único sobre
--    school_signup_leads.phone, así que el UPDATE no falla, pero dejaría DOS fichas con el mismo
--    número y el bot resolvería al contacto por cualquiera. Aplicar solo con la decisión tomada.
-- =============================================================================
BEGIN;

-- SELECT previo: el lead de Karen y quién más tiene ese número (esperado: Karen con marcador, y Paola con el número).
SELECT l.id, l.full_name, l.phone, l.status FROM public.school_signup_leads l
 WHERE l.id = '24473e26-148c-4fa0-8159-0417b8b1bf50'
    OR (l.school_id = 'eb3ebc77-4ea4-4992-96c8-3c8ec574578c' AND l.phone LIKE '%3112540145%');

-- Guarda el valor anterior en la ficha (para el reverso) y pone el teléfono.
UPDATE public.school_signup_leads
   SET source_detail = COALESCE(source_detail, '{}'::jsonb)
                       || jsonb_build_object('telefono_anterior', phone, 'telefono_corregido_at', now()),
       phone = '3112540145'
 WHERE id = '24473e26-148c-4fa0-8159-0417b8b1bf50'
   AND school_id = 'eb3ebc77-4ea4-4992-96c8-3c8ec574578c';

-- SELECT posterior: esperado phone = 3112540145 y telefono_anterior = el marcador.
SELECT l.id, l.full_name, l.phone, l.source_detail->>'telefono_anterior' AS telefono_anterior
  FROM public.school_signup_leads l WHERE l.id = '24473e26-148c-4fa0-8159-0417b8b1bf50';

-- REVERSO:
--   UPDATE public.school_signup_leads
--      SET phone = source_detail->>'telefono_anterior',
--          source_detail = source_detail - 'telefono_anterior' - 'telefono_corregido_at'
--    WHERE id = '24473e26-148c-4fa0-8159-0417b8b1bf50';

ROLLBACK;   -- ← cambiar por COMMIT al aprobar


-- =============================================================================
-- 3. LIMPIEZA DE DATOS PERSONALES — pago 3bb21414 (Gabriela Galvis Garzón) (plan §5.6 y §6g)
--    payments.notes trae datos personales de la deportista y de su acudiente; cualquier staff,
--    coaches incluidos, lo lee por API directa. Se MUEVEN a la ficha del prospecto
--    (school_signup_leads.source_detail, solo staff de la escuela) y se reemplazan por un texto
--    sin datos. El lead es a000b934-5800-4388-99fb-456bbca6577f (el pago lo referencia en
--    signup_lead_id y es el único lead «Galvis» de Monster; el SELECT previo lo confirma).
--    OJO — rastro: trg_audit_payments copia la fila anterior a audit_logs / payment_audit_logs,
--    así que el texto viejo QUEDA en esas tablas. Purgarlo es una tarea aparte (no se hace aquí:
--    son bitácoras). Revisar con:  select id from audit_logs where table_name='payments'
--    and record_id='3bb21414-…'  (los nombres de columnas dependen de la bitácora).
-- =============================================================================
BEGIN;

-- SELECT previo: esperado 1 fila; el pago apunta a ESE lead, el lead existe y notes tiene texto (254 caracteres).
SELECT p.id AS pago, p.signup_lead_id, length(p.notes) AS largo_notes, l.full_name AS lead,
       (l.source_detail ? 'notas_del_pago') AS ya_movidas
  FROM public.payments p
  JOIN public.school_signup_leads l ON l.id = p.signup_lead_id
 WHERE p.id = '3bb21414-ea2d-46f5-ac5c-a10b603c0239'
   AND p.school_id = 'eb3ebc77-4ea4-4992-96c8-3c8ec574578c'
   AND l.id = 'a000b934-5800-4388-99fb-456bbca6577f';

-- 3a. Mover las notas a la ficha (copia con SQL: el texto no pasa por este archivo).
UPDATE public.school_signup_leads l
   SET source_detail = COALESCE(l.source_detail, '{}'::jsonb)
                       || jsonb_build_object('notas_del_pago', p.notes,
                                             'notas_del_pago_pago_id', p.id,
                                             'notas_del_pago_movidas_at', now())
  FROM public.payments p
 WHERE p.id = '3bb21414-ea2d-46f5-ac5c-a10b603c0239'
   AND p.school_id = 'eb3ebc77-4ea4-4992-96c8-3c8ec574578c'
   AND l.id = p.signup_lead_id
   AND l.id = 'a000b934-5800-4388-99fb-456bbca6577f'
   AND p.notes IS NOT NULL
   AND NOT (COALESCE(l.source_detail, '{}'::jsonb) ? 'notas_del_pago');

-- 3b. Reemplazar notes por un texto sin datos personales (SOLO si 3a movió algo).
UPDATE public.payments p
   SET notes = 'Pago de la clínica registrado a mano por la escuela. Los datos del deportista están en la ficha del prospecto.'
 WHERE p.id = '3bb21414-ea2d-46f5-ac5c-a10b603c0239'
   AND p.school_id = 'eb3ebc77-4ea4-4992-96c8-3c8ec574578c'
   AND EXISTS (SELECT 1 FROM public.school_signup_leads l
                WHERE l.id = 'a000b934-5800-4388-99fb-456bbca6577f'
                  AND l.source_detail->>'notas_del_pago_pago_id' = p.id::text);

-- SELECT posterior: esperado notes = el texto nuevo (sin datos), la ficha con 'notas_del_pago' (largo 254) y el pago
-- con el mismo monto/estado de antes (partial, 150000 de 300000).
SELECT p.id, p.status, p.amount, p.amount_paid, p.notes AS notes_nuevo,
       length(l.source_detail->>'notas_del_pago') AS largo_notas_movidas
  FROM public.payments p JOIN public.school_signup_leads l ON l.id = p.signup_lead_id
 WHERE p.id = '3bb21414-ea2d-46f5-ac5c-a10b603c0239';

-- REVERSO (devuelve el texto original desde la ficha y limpia las tres marcas):
--   UPDATE public.payments p SET notes = l.source_detail->>'notas_del_pago'
--     FROM public.school_signup_leads l
--    WHERE p.id = '3bb21414-ea2d-46f5-ac5c-a10b603c0239' AND l.id = 'a000b934-5800-4388-99fb-456bbca6577f';
--   UPDATE public.school_signup_leads
--      SET source_detail = source_detail - 'notas_del_pago' - 'notas_del_pago_pago_id' - 'notas_del_pago_movidas_at'
--    WHERE id = 'a000b934-5800-4388-99fb-456bbca6577f';

ROLLBACK;   -- ← cambiar por COMMIT al aprobar


-- =============================================================================
-- 4. (OPCIONAL, plan §6f) PAGOS DE CLÍNICA HECHOS A MANO SIN ENLACE — SOLO VISTA PREVIA
--    Karen 2a4d28fe · Gabriela Galvis 3bb21414 · Silvana La Rotta 46bb3df8 ·
--    M.ª Alejandra Martínez ad59ddd6 · Valentina Rincón 694a65d0.
--    Ya están en clase_extra por $300.000 (los afiliados pagaron 300.000 cuando su lista era 250.000;
--    los prospectos, 300.000 de externo). Ligarlos cuenta cupos y reportes, pero a los afiliados les deja
--    «precio acordado 300.000» con motivo: ¿se acepta, o hay devolución/saldo a favor por la diferencia? Eso lo decide
--    la escuela; por eso NO hay cambio aquí, solo la vista previa de lo que la RPC haría:
-- =============================================================================
-- SELECT p.id, p.concept, p.amount, p.amount_paid, p.status, p.payment_category,
--        public._servicio_pago_ligado(p.id) AS ya_ligado_a
--   FROM public.payments p
--  WHERE p.id::text LIKE ANY (ARRAY['2a4d28fe%','3bb21414%','46bb3df8%','ad59ddd6%','694a65d0%']);
-- -- Cuando se decida, por cada uno (con la sesión simulada del bloque 1):
-- -- SELECT public.ligar_cobro_a_servicio('<id completo>', '16766d2e-f8b0-4285-88e3-b1e67dda6d45',
-- --        'Pago de clínica registrado a mano; se liga al ítem', NULL);
