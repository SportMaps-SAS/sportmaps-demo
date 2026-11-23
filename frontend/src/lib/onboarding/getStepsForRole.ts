import { USER_ROLES } from '../../constants/roles';
import { isBranchConfirmed } from './schoolOnboardingRules';
import { Building, Users, Award, Bell, Activity, Shield, TrendingUp, Trophy, UserCircle, Calendar, Plus, Heart, ShoppingBag, CreditCard, Tag, Layers } from 'lucide-react';

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

            // Wizard guiado: sede → (modelo) → equipo/plan → coach → atleta → pagos.
            // Cada href lleva a la pantalla donde se resuelve el paso: este mismo
            // listado es el checklist del panel después del asistente, y antes
            // todos apuntaban a /dashboard (un clic que no hacía nada).
            // El modelo (teams|plans|both) se elige en onboarding y vive en
            // schools.business_model. Si esta vacio el paso lo pregunta.
            const businessModel = status.business_model as 'teams' | 'plans' | 'both' | undefined;
            const wizardSteps: Array<{ id: string; title: string; description: string; completed: boolean; href: string; icon: any }> = [
                { id: 'confirm_branch', title: 'Tu Sede',  description: 'Confirma la dirección de tu sede principal.', completed: isBranchConfirmed(status), href: '/branches', icon: Building },
            ];

            if (!businessModel) {
                wizardSteps.push({ id: 'choose_model', title: 'Modelo', description: '¿Tu academia trabaja por equipos o por planes/membresías?', completed: false, href: '/teams', icon: Award });
            } else {
                if (businessModel === 'teams' || businessModel === 'both') {
                    wizardSteps.push({ id: 'create_team', title: 'Primer Equipo', description: 'Crea tu primer grupo o equipo deportivo.', completed: !!status.has_teams, href: '/teams', icon: Trophy });
                }
                if (businessModel === 'plans' || businessModel === 'both') {
                    wizardSteps.push({ id: 'create_plan', title: 'Primer Plan', description: 'Crea tu primera mensualidad o paquete.', completed: !!status.has_plans, href: '/offerings', icon: TrendingUp });
                }
            }

            wizardSteps.push(
                { id: 'invite_staff',    title: 'Entrenador',    description: 'Invita a tu primer entrenador.',                  completed: !!status.has_staff,                  href: '/staff', icon: Users },
                { id: 'add_student',     title: 'Primer Atleta', description: 'Registra a tu primer deportista.',                completed: !!status.has_students,               href: '/students', icon: Bell },
                { id: 'setup_payments',  title: 'Cobros',        description: 'Configura cómo recibir pagos.',                   completed: status.payment_setup_completed === true, href: '/payments-automation?tab=config', icon: CreditCard },
            );
            return wizardSteps;
        }

        case USER_ROLES.PARENT: {
            const parentSteps = [];

            // Only show accept_invite if there's a pending invitation or it was already accepted
            if (status.has_pending_invitation || status.has_accepted_invite) {
                parentSteps.push({ id: 'accept_invite', title: 'Aceptar Invitación', description: 'Vinculate a la escuela de tu hijo.', completed: status.has_accepted_invite, href: '/notifications', icon: Bell });
            }

            parentSteps.push(
                { id: 'add_child', title: 'Perfil del Deportista', description: 'Crea la ficha de tu hijo.', completed: status.has_children, href: '/children', icon: Users },
                { id: 'medical_info', title: 'Ficha Médica', description: 'Sube EPS y datos de salud.', completed: status.has_medical_records, href: '/children', icon: Heart }
            );
            return parentSteps;
        }

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
