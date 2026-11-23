import { USER_ROLES } from '../../constants/roles';
import { buildSchoolChecklist, buildParentChecklist, hasViewedPayments, type ChecklistItem } from './onboardingChecklists';
import { Building, Bell, Activity, Shield, Trophy, UserCircle, Circle, Heart, CreditCard, Tag, GraduationCap, Receipt, UserPlus, HeartHandshake, Link2, Eye } from 'lucide-react';

// Ícono por paso: la lista (ids, textos, hrefs y si está hecho) vive en onboardingChecklists.ts.
const ICONOS: Record<string, any> = {
    create_plan: Tag, add_student: GraduationCap, see_charge: Receipt, payment_method: CreditCard,
    invite_families: HeartHandshake, invite_staff: UserPlus,
    connect_school: Link2, review_athlete: Heart, see_payments: Eye,
};
const conIcono = (items: ChecklistItem[]) => items.map((i) => ({ ...i, icon: ICONOS[i.id] ?? Circle }));

export const getStepsForRole = (role: string, status: any) => {
    switch (role) {
        case USER_ROLES.SCHOOL:
        case USER_ROLES.SCHOOL_ADMIN:
        case USER_ROLES.ADMIN: {
            // If the user is the Owner (no school created yet)
            if (!status.has_school && role === USER_ROLES.SCHOOL) {
                return [
                    { id: 'create_school', title: 'Registrar Academia', description: 'Nombre, logo y dirección fiscal.', completed: false, href: '/setup/school', icon: Building },
                ];
            }

            // Checklist del panel: plan → deportista → cobro → medio de pago →
            // familias → entrenador. Cada paso se marca por lo que existe en la base
            // y su href lleva a la pantalla donde se resuelve (nunca a /dashboard).
            // `has_families` llega de get_onboarding_checklist_extras, mezclado en `status`.
            return conIcono(buildSchoolChecklist(status, { has_families: status.has_families }));
        }

        case USER_ROLES.PARENT:
            return conIcono(buildParentChecklist(status, { viewedPayments: hasViewedPayments() }));

        case USER_ROLES.COACH:
            return [
                { id: 'accept_invite', title: 'Vincular Academia', description: 'Acepta la invitación de tu escuela.', completed: status.has_accepted_invite, href: '/notifications', icon: Building },
                { id: 'complete_profile', title: 'Perfil Profesional', description: 'Sube tu experiencia y certificaciones.', completed: status.has_professional_profile, href: '/profile', icon: UserCircle }
            ];

        case USER_ROLES.ATHLETE: {
            const athleteSteps = [];

            // Paso 1: Verificar correo (si está pendiente)
            if (!status.email_verified) {
                athleteSteps.push({ id: 'verify_email', title: 'Verifica tu correo', description: 'Confirma tu dirección de email para activar tu cuenta.', completed: false, href: '/settings', icon: Shield });
            }

            // Paso 2: Completar perfil deportivo
            athleteSteps.push({ id: 'complete_profile', title: 'Completa tu perfil', description: 'Datos personales, documento y nivel de experiencia.', completed: status.profile_complete, href: '/settings', icon: UserCircle });

            // Paso 3: Foto de perfil (opcional pero recomendado)
            if (!status.has_avatar) {
                athleteSteps.push({ id: 'upload_avatar', title: 'Foto de perfil', description: 'Sube una foto para que te reconozcan.', completed: false, href: '/settings', icon: UserCircle });
            }

            // Paso 4: Seleccionar deporte de interés
            athleteSteps.push({ id: 'select_sport', title: 'Elige tu deporte', description: 'Selecciona los deportes que te interesan.', completed: status.has_sports_interest, href: '/settings', icon: Activity });

            // Paso 5: Inscribirse o aceptar invitación
            if (status.has_pending_invitation || status.has_accepted_invite) {
                athleteSteps.push({ id: 'accept_invite', title: 'Aceptar invitación', description: 'Vincúlate con tu academia deportiva.', completed: status.has_accepted_invite, href: '/notifications', icon: Bell });
            }
            athleteSteps.push({ id: 'enroll_program', title: 'Inscribirse en programa', description: 'Busca una academia y únete a un equipo.', completed: status.has_accepted_invite || status.has_enrollment, href: '/explore', icon: Trophy });

            return athleteSteps;
        }

        default:
            return [];
    }
};
