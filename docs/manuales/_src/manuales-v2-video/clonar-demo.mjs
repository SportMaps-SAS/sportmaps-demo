// Copia Club Campestre Demo (is_demo) de la base viva al gemelo LOCAL, para que los videos
// de los manuales V2 muestren lo mismo que el PDF: Mauricio Herrera, Sofía, Tomás, los
// partidos contra Halcones FC… (2026-11-04).
//
// Lee con liveReadOnlyClient (cualquier escritura falla con 25006) y escribe SOLO en el
// gemelo (twinClient aborta si no es localhost). La lista de tablas sale del catálogo del
// GEMELO: leer el catálogo de la viva es lo que más Disk IO gasta (ver CLAUDE.md).
// Conserva los ids. Las cuentas que no sean @demo.sportmaps.co quedan anonimizadas.
// Clave de todas las cuentas copiadas: Demo2026!
//
// Reemplaza los datos de la semilla de esa escuela (coach.campestre…): los guiones de los
// videos anteriores vuelven a funcionar con `npm run qa:twin:reset`.
//
//   node docs/manuales/_src/manuales-v2-video/clonar-demo.mjs
import { liveReadOnlyClient, twinClient } from '../../../../scripts/qa-twin/lib.mjs';

const SID = '25a123f0-6d57-48a4-9800-7b1531d61cd2';
const PASS = 'Demo2026!';
// Ruido o volumen que estas pantallas no muestran.
const FUERA = /(user_devices|device_commands|audit|_logs?$|_log_|whatsapp|^wa_|outbox|access_events|^zk_|turnstile|hour_bank|^ai_|^llm|^bot_|webhook|einvoice|^saas_)/

const live = await liveReadOnlyClient();
const twin = await twinClient();

const { rows: conSchool } = await twin.query(`
  select c.table_name t from information_schema.columns c
  join information_schema.tables x on x.table_schema = c.table_schema and x.table_name = c.table_name and x.table_type = 'BASE TABLE'
  where c.table_schema = 'public' and c.column_name = 'school_id' order by 1`);
const { rows: fks } = await twin.query(`
  select cl.relname hijo, a.attname col, pa.relname padre, pn.nspname esquema
  from pg_constraint k
  join pg_class cl on cl.oid = k.conrelid and cl.relnamespace = 'public'::regnamespace
  join pg_class pa on pa.oid = k.confrelid join pg_namespace pn on pn.oid = pa.relnamespace
  join pg_attribute a on a.attrelid = k.conrelid and a.attnum = k.conkey[1]
  join pg_attribute pa2 on pa2.attrelid = k.confrelid and pa2.attnum = k.confkey[1]
  where k.contype = 'f' and array_length(k.conkey, 1) = 1 and pa2.attname = 'id'`);
const colsDe = async (t) => (await twin.query(`
  select attname from pg_attribute where attrelid = $1::regclass and attnum > 0 and not attisdropped and attgenerated = ''
    and attidentity <> 'a'`, [`public."${t}"`])).rows.map((r) => r.attname);

/** Filas de la escuela: tablas con school_id, y dos niveles de tablas colgadas de ellas. */
async function recolectar(db) {
  const filas = new Map(); const errores = [];
  const leer = async (t, where, params) => {
    try {
      const { rows } = await db.query(`select to_jsonb(_fila) j from public."${t}" _fila where ${where}`, params);
      return rows.map((r) => r.j);
    } catch (e) { errores.push(`${t}: ${e.message.slice(0, 90)}`); return []; }
  };
  const sumar = (t, rows) => {
    const m = filas.get(t) ?? new Map();
    for (const r of rows) m.set(r.id ?? JSON.stringify(r), r);
    if (m.size) filas.set(t, m);
  };
  sumar('schools', await leer('schools', 'id = $1', [SID]));
  for (const { t } of conSchool) if (!FUERA.test(t)) sumar(t, await leer(t, 'school_id = $1', [SID]));
  console.log(`  ${db === live ? 'viva' : 'gemelo'}: ${filas.size} tablas con school_id`);
  // Solo lo que no trae school_id, y en el nivel 2 solo lo que colgó del nivel 1.
  const tienenSchool = new Set(conSchool.map((c) => c.t));
  let padres = new Set(filas.keys());
  for (let nivel = 0; nivel < 2; nivel++) {
    const nuevos = new Set();
    for (const { hijo, col, padre, esquema } of fks) {
      if (esquema !== 'public' || FUERA.test(hijo) || tienenSchool.has(hijo) || !padres.has(padre) || padre === 'profiles') continue;
      const ids = [...filas.get(padre).values()].map((r) => r.id).filter(Boolean);
      if (!ids.length) continue;
      const antes = filas.get(hijo)?.size ?? 0;
      sumar(hijo, await leer(hijo, `"${col}" = any($1::uuid[])`, [ids]));
      if ((filas.get(hijo)?.size ?? 0) > antes) nuevos.add(hijo);
    }
    padres = nuevos;
    console.log(`  nivel ${nivel + 1}: ${nuevos.size} tablas colgadas`);
  }
  return { filas, errores, leer, sumar };
}

const origen = await recolectar(live);

// ── Personas: todo id que apunte a profiles o auth.users ─────────────────────
const usuarios = new Set();
for (const { hijo, col, padre } of fks) {
  if (padre !== 'profiles' && padre !== 'users') continue;
  for (const r of origen.filas.get(hijo)?.values() ?? []) if (r[col]) usuarios.add(r[col]);
}
const { rows: perfiles } = await live.query('select to_jsonb(p) j from public.profiles p where id = any($1::uuid[])', [[...usuarios]]);
const { rows: autenticos } = await live.query('select id, email from auth.users where id = any($1::uuid[])', [[...usuarios]]);
const correoAuth = new Map(autenticos.map((u) => [u.id, u.email]));
const esDemo = (c) => /@demo\.sportmaps\.co$/i.test(c ?? '');
let anonimizados = 0;
const personas = perfiles.map(({ j: p }) => {
  const correo = correoAuth.get(p.id) ?? p.email;
  if (esDemo(correo)) return { ...p, email: correo };
  anonimizados++;
  return { ...p, email: `ref-${p.id.slice(0, 8)}@qa.sportmaps.test`, full_name: 'Usuario QA', phone: null, avatar_url: null,
    document_number: null, document_type: null, billing_address: null };
});
// Datos propios de cada cuenta demo (roles, tokens no; lo que cuelgue directo del perfil).
const demos = personas.filter((p) => esDemo(p.email)).map((p) => p.id);
const propias = /^(notifications|user_roles|parent_|athlete_|coach_|user_|child_|kudos|goals)/;
for (const { hijo, col, padre } of fks) {
  if ((padre !== 'profiles' && padre !== 'users') || FUERA.test(hijo) || !propias.test(hijo) || origen.filas.has(hijo)) continue;
  origen.sumar(hijo, await origen.leer(hijo, `"${col}" = any($1::uuid[])`, [demos]));
}
await live.end();

// ── Gemelo: quitar lo anterior de la escuela y cargar ────────────────────────
await twin.query('begin');
await twin.query("set local session_replication_role = replica");
const previo = await recolectar(twin);
for (const [t, m] of [...previo.filas].reverse()) {
  const ids = [...m.values()].map((r) => r.id).filter(Boolean);
  if (ids.length) await twin.query(`delete from public."${t}" where id = any($1::uuid[])`, [ids]);
}
for (const p of personas) {
  await twin.query(`insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    values ($1::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, crypt($3, gen_salt('bf')), now(),
      '{"provider":"email","providers":["email"]}', jsonb_build_object('full_name', $4::text), now(), now())
    on conflict (id) do update set email = excluded.email, encrypted_password = excluded.encrypted_password`, [p.id, p.email, PASS, p.full_name]);
  await twin.query(`insert into auth.identities (id, user_id, provider_id, provider, identity_data, created_at, updated_at, last_sign_in_at)
    values (gen_random_uuid(), $1::uuid, $1::text, 'email', jsonb_build_object('sub', $1::text, 'email', $2::text), now(), now(), now())
    on conflict do nothing`, [p.id, p.email]);
}
origen.filas.set('profiles', new Map(personas.map((p) => [p.id, p])));
const fallos = []; let total = 0;
for (const [t, m] of origen.filas) {
  const cols = (await colsDe(t)).map((c) => `"${c}"`).join(', ');
  await twin.query('savepoint s');
  try {
    const r = await twin.query(`insert into public."${t}" (${cols}) select ${cols}
      from jsonb_populate_recordset(null::public."${t}", $1::jsonb) on conflict do nothing`, [JSON.stringify([...m.values()])]);
    total += r.rowCount; await twin.query('release savepoint s');
    if (m.size > 20) console.log(`  ${t}: ${r.rowCount}/${m.size}`);
  } catch (e) { await twin.query('rollback to savepoint s'); fallos.push(`${t}: ${e.message.slice(0, 110)}`); }
}
// Los videos dejan una foto de los cobros la primera vez (comun.mjs): se rehace tras copiar.
await twin.query('drop table if exists public.qa_cobros_foto');
// Nombres de prueba de los torneos.
await twin.query(`update public.events set title = regexp_replace(title, ' Demo [0-9]+', ' Demo') where title ~ ' Demo [0-9]{6,}'`);
// Supabase Auth responde 500 si estas columnas quedan en NULL (cuentas creadas por SQL).
await twin.query(`update auth.users set confirmation_token=coalesce(confirmation_token,''), recovery_token=coalesce(recovery_token,''), email_change=coalesce(email_change,''), email_change_token_new=coalesce(email_change_token_new,''), email_change_token_current=coalesce(email_change_token_current,''), phone_change=coalesce(phone_change,''), phone_change_token=coalesce(phone_change_token,''), reauthentication_token=coalesce(reauthentication_token,'') where confirmation_token is null or recovery_token is null or email_change is null`);
await twin.query('commit');
await twin.end();
console.log(`✅ ${origen.filas.size} tablas, ${total} filas, ${personas.length} cuentas (${anonimizados} anonimizadas)`);
console.log('Cuentas demo:', personas.filter((p) => esDemo(p.email)).map((p) => p.email).join(', '));
if (fallos.length) console.log('Tablas que no cargaron:\n  ' + fallos.join('\n  '));
if (origen.errores.length) console.log('Lecturas fallidas:\n  ' + origen.errores.slice(0, 15).join('\n  '));
