// Ayudas de los videos de los manuales V2 (2026-11-04). Gemelo local con Club Campestre Demo
// copiada por clonar-demo.mjs: vertical de celular, contra el build servido en :3102.
//
//   BASE_URL=http://localhost:3102 node docs/manuales/_src/manuales-v2-video/<guion>.mjs
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { grabar, sql } from '../_video/lib.mjs';

export { sql };
export const here = path.dirname(fileURLToPath(import.meta.url));
export const ACUDIENTE = 'mherrera@demo.sportmaps.co';
export const DEPORTISTA = 'vcruz@demo.sportmaps.co';
export const ENTRENADOR = 'entrenador.futbol@demo.sportmaps.co';
export const DUENO = 'gerencia@demo.sportmaps.co';
export const ESCUELA = '25a123f0-6d57-48a4-9800-7b1531d61cd2';
export const TOMAS = '7167931e-0798-43e8-a286-d4985b0965b6';
export const SOFIA = 'fcf4d2d1-eb3c-4b09-8f08-a7777f11768e';
export const HALCONES = '09674a04-aefd-478a-9625-eb6300d24389';
export const SUB15 = '658d014e-26b9-44dd-bfde-8eed0a3a14ac';

/** El partido contra Halcones FC en el futuro, sin responder y con avisos con su fecha nueva. */
export function reiniciarConvocatoria() {
  sql(`begin; set local session_replication_role = replica;
    update match_results set match_date = date '2026-11-14', kickoff_at = timestamptz '2026-11-14 15:00+00' where id = '${HALCONES}';
    update calendar_events set start_time = timestamptz '2026-11-14 15:00+00', end_time = timestamptz '2026-11-14 17:00+00'
      where id = '5569a4a2-c50a-45b3-8b83-30d8c3e91b4f';
    delete from match_callup_responses where child_id = '${TOMAS}';
    update notifications set message = replace(replace(message, '31/10/2026', '14/11/2026'), '31/10', '14/11')
      where school_id = '${ESCUELA}' and message like '%31/10%';
    commit;`);
}

/** Lo que la escuela comparte con las familias: reportes y evaluaciones de partido. */
export function compartirPartidos() {
  sql(`update school_settings set share_match_reports = true, share_match_evaluations = true where school_id = '${ESCUELA}';`);
}

export const NUEVA = 'familia.nueva@demo.sportmaps.co';
const ID_NUEVA = '00000000-0000-4000-a000-00000000d001';
/** Cuenta de acudiente sin escuela y sin solicitudes, para el flujo del código (idempotente). */
export function reiniciarCuentaNueva() {
  sql(`begin; set local session_replication_role = replica;
    delete from notifications where user_id = '${ID_NUEVA}';
    delete from payments where child_id in (select id from children where parent_id = '${ID_NUEVA}');
    delete from enrollments where child_id in (select id from children where parent_id = '${ID_NUEVA}');
    delete from children where parent_id = '${ID_NUEVA}';
    delete from school_join_requests where requester_profile_id = '${ID_NUEVA}';
    delete from school_members where profile_id = '${ID_NUEVA}';
    insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
      confirmation_token, recovery_token, email_change, email_change_token_new, email_change_token_current, phone_change, phone_change_token, reauthentication_token)
    values ('${ID_NUEVA}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', '${NUEVA}', crypt('Demo2026!', gen_salt('bf')), now(),
      '{"provider":"email","providers":["email"]}', '{"full_name":"Paula Mejía"}', now(), now(), '', '', '', '', '', '', '', '')
    on conflict (id) do nothing;
    insert into auth.identities (id, user_id, provider_id, provider, identity_data, created_at, updated_at, last_sign_in_at)
    values (gen_random_uuid(), '${ID_NUEVA}', '${ID_NUEVA}', 'email', jsonb_build_object('sub', '${ID_NUEVA}', 'email', '${NUEVA}'), now(), now(), now())
    on conflict do nothing;
    insert into profiles (id, email, full_name, role, is_demo, phone, onboarding_completed) values ('${ID_NUEVA}', '${NUEVA}', 'Paula Mejía', 'parent', true, '3001234567', true)
    on conflict (id) do update set full_name = excluded.full_name, onboarding_completed = true;
    commit;`);
}

/** Deja los cobros de la escuela como los copió clonar-demo.mjs (foto exacta de la primera vez). */
export function reiniciarPagos() {
  sql(`create table if not exists public.qa_cobros_foto as
      select id, status, receipt_url, payment_method from payments where school_id = '${ESCUELA}';
    update payments p set status = f.status, receipt_url = f.receipt_url, payment_method = f.payment_method
      from public.qa_cobros_foto f where f.id = p.id and p.status is distinct from f.status;`);
}

export const video = ({ nombre, ...o }) => grabar({ nombre, movil: true, trabajo: path.join(here, 'trabajo', nombre, 'video-raw'), ...o });

/** Pestaña de la barra de abajo. */
export const pestana = (page, nombre) => page.locator('nav').last().getByText(nombre, { exact: true });
/** Texto visible (el primero). */
export const texto = (page, t, exact = false) => page.getByText(t, { exact }).first();
export const dialogo = (page) => page.getByRole('dialog').last();
