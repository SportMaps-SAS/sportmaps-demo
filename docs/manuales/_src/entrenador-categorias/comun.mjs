// Datos compartidos por las capturas y el video de guia-entrenadores-asignar-categoria
// (2026-10-22). Gemelo local, Club Campestre Demo, entrenador Andrés Vélez, equipo
// «Fútbol Sub-12». Idempotente: deja el interruptor «Coaches pueden remover
// deportistas de sus equipos» apagado (el default) y a Juan Pablo Henao registrado
// en la escuela pero sin categoría, para inscribirlo y removerlo en cámara.
import { sql } from '../_video/lib.mjs';

export const ESCUELA = '25a123f0-6d57-48a4-9800-7b1531d61cd2';
export const EQUIPO = '00000000-0000-4000-9e00-000000000201';
export const JUAN_PABLO = '00000000-0000-4000-8c00-000000000210';
const MATEO = '00000000-0000-4000-8c00-000000000101';

export function reiniciar() {
  sql(`begin;
    insert into children
    select (jsonb_populate_record(null::children, to_jsonb(c) || jsonb_build_object(
      'id', '${JUAN_PABLO}', 'full_name', 'Juan Pablo Henao', 'parent_id', null))).*
    from children c where c.id = '${MATEO}'
    on conflict (id) do nothing;
    delete from payments where child_id = '${JUAN_PABLO}';
    delete from enrollments where child_id = '${JUAN_PABLO}';
    update school_settings set coach_can_remove_enrollments = false where school_id = '${ESCUELA}';
    commit;`);
}

/** Interruptor de la escuela, para las capturas que lo necesitan prendido. */
export function permitirRemover(si) {
  sql(`update school_settings set coach_can_remove_enrollments = ${si ? 'true' : 'false'} where school_id = '${ESCUELA}';`);
}
