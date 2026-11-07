/**
 * Bloques de la familia para colgar de las pantallas existentes (un solo punto de enganche cada uno):
 *  - `BloqueFamiliaHijo`: ficha de un hijo (Hijos V2).
 *  - `BloqueFamiliaAdulto`: «Mis inscripciones» del deportista adulto.
 * Cada uno junta «plan» (pausa / retiro / reactivación) y «soportes del deportista».
 */
import { PlanDelDeportista, type InscripcionPlan } from './plan/PlanDelDeportista';
import { SoportesDelDeportista } from './soportes/SoportesDelDeportista';

interface HijoLike {
    id: string;
    full_name: string;
    school_id?: unknown;
    enrollments?: Array<{
        id: string;
        status: string | null;
        teams?: { name: string | null } | null;
        offering_plans?: { name: string | null } | null;
    }> | null;
}

export function BloqueFamiliaHijo({ hijo }: { hijo: HijoLike }) {
    const inscripciones: InscripcionPlan[] = (hijo.enrollments ?? []).map((e) => ({
        id: e.id,
        status: e.status,
        etiqueta: e.teams?.name ?? e.offering_plans?.name ?? undefined,
    }));
    const schoolId = typeof hijo.school_id === 'string' ? hijo.school_id : null;
    return (
        <div className="space-y-3">
            <PlanDelDeportista nombre={hijo.full_name} inscripciones={inscripciones} />
            <SoportesDelDeportista schoolId={schoolId} tipoSujeto="child" sujetoId={hijo.id} nombre={hijo.full_name} />
        </div>
    );
}

interface InscripcionAdulto {
    id: string;
    status: string;
    school_id: string | null;
    team?: { name: string } | null;
    offering_plan?: { name: string } | null;
}

export function BloqueFamiliaAdulto({ usuarioId, nombre, inscripciones }: {
    usuarioId: string | null | undefined;
    nombre: string;
    inscripciones: InscripcionAdulto[];
}) {
    const planes: InscripcionPlan[] = inscripciones.map((e) => ({
        id: e.id,
        status: e.status,
        etiqueta: e.team?.name ?? e.offering_plan?.name ?? undefined,
    }));
    const escuelas = [...new Set(inscripciones.map((e) => e.school_id).filter((s): s is string => !!s))];
    return (
        <div className="space-y-3">
            <PlanDelDeportista nombre={nombre} inscripciones={planes} />
            {escuelas.map((id) => (
                <SoportesDelDeportista key={id} schoolId={id} tipoSujeto="profile" sujetoId={usuarioId} nombre={nombre} />
            ))}
        </div>
    );
}
