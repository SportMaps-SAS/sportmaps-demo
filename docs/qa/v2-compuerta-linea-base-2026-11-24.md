# Compuerta V2 — 2026-11-24

| Regla | Qué pide | V2 (`*/v2/`) | Resto |
|---|---|---|---|
| `px-fijo` | Cero píxeles fijos: usar tokens (docs/design-tokens.md) | 0 | 84 |
| `texto-chico` | Texto mínimo 12px (text-xs) | 0 | 1438 |
| `color-fijo` | Colores por token (hsl(var(--…))): un hex fijo rompe dark mode y la marca de la escuela | 0 | 331 |
| `seguro` | Deshacer en vez de «¿Seguro?» (useAccionConDeshacer, 8 s) | 0 | 35 |
| `voseo` | Español de Colombia de «tú», sin voseo (V2Palabras) | 0 | 0 |

## Pantallas V2 con hallazgos

Ninguna.

## Resto de la app: archivos con más hallazgos

| Archivo | Total | Detalle |
|---|---|---|
| `frontend/src/pages/RegisterPage.tsx` | 196 | px-fijo 9 · texto-chico 28 · color-fijo 159 |
| `frontend/src/pages/LoginPage.tsx` | 97 | px-fijo 9 · texto-chico 13 · color-fijo 75 |
| `frontend/src/components/school/TacticalBoard.tsx` | 76 | px-fijo 12 · texto-chico 64 |
| `frontend/src/pages/PaymentsAutomationPage.tsx` | 58 | texto-chico 58 |
| `frontend/src/pages/AttendanceSupervisionPage.tsx` | 39 | texto-chico 36 · color-fijo 3 |
| `frontend/src/components/payment/RegisterCashPaymentModal.tsx` | 36 | texto-chico 36 |
| `frontend/src/components/athlete/SessionExecution.tsx` | 34 | texto-chico 34 |
| `frontend/src/components/universal/OfferingsManagement.tsx` | 33 | texto-chico 31 · color-fijo 2 |
| `frontend/src/components/cards/AthleteIdCard.tsx` | 32 | px-fijo 1 · texto-chico 31 |
| `frontend/src/pages/CoachAttendancePage.tsx` | 30 | texto-chico 27 · color-fijo 3 |
| `frontend/src/components/trainer/BlockBuilder.tsx` | 25 | texto-chico 25 |
| `frontend/src/components/wellness/WellnessModule.tsx` | 25 | texto-chico 25 |
| `frontend/src/pages/booking/PublicTrialClassBookingPage.tsx` | 21 | texto-chico 19 · seguro 2 |
| `frontend/src/pages/trainer/TrainerRoutineDetail.tsx` | 20 | texto-chico 18 · seguro 2 |
| `frontend/src/components/trainer/CompleteSessionModal.tsx` | 19 | texto-chico 19 |
| `frontend/src/pages/OnboardingRolePage.tsx` | 19 | px-fijo 1 · texto-chico 1 · color-fijo 17 |
| `frontend/src/components/biomech/BiomechResultCard.tsx` | 18 | texto-chico 18 |
| `frontend/src/components/school/FootballDashboardModal.tsx` | 17 | texto-chico 15 · seguro 2 |
| `frontend/src/components/school/LineupModal.tsx` | 17 | px-fijo 3 · texto-chico 14 |
| `frontend/src/pages/AdminSubscriptionsPage.tsx` | 16 | texto-chico 16 |
| `frontend/src/pages/PrivacyPage.tsx` | 16 | color-fijo 16 |
| `frontend/src/pages/StatsPage.tsx` | 16 | texto-chico 16 |
| `frontend/src/pages/TeamsPage.tsx` | 15 | texto-chico 13 · color-fijo 2 |
| `frontend/src/pages/MyPaymentsPageClassic.tsx` | 14 | texto-chico 14 |
| `frontend/src/pages/SchoolFacilitiesPage.tsx` | 14 | texto-chico 13 · seguro 1 |

## Todos los `seguro` (35)

- `frontend/src/components/athlete/AthleteClassBooking.tsx:322` `¿Estás seguro`
- `frontend/src/components/coach/SessionFormDialog.tsx:298` `window.confirm(`
- `frontend/src/components/coach-activity/CoachDetailSheet.tsx:236` `window.confirm(`
- `frontend/src/components/school/ExercisePacksTab.tsx:96` `window.confirm(`
- `frontend/src/components/school/FootballDashboardModal.tsx:83` `window.confirm(`
- `frontend/src/components/school/FootballDashboardModal.tsx:83` `¿Estás seguro`
- `frontend/src/components/school/schoolVideos/VideoLibraryTab.tsx:48` `window.confirm(`
- `frontend/src/components/students/ClasePruebaPanel.tsx:66` `window.confirm(`
- `frontend/src/components/tournaments/TeamPlayersDialog.tsx:51` `window.confirm(`
- `frontend/src/components/tournaments/TeamPlayersDialog.tsx:57` `window.confirm(`
- `frontend/src/components/tournaments/TournamentContentPanel.tsx:85` `window.confirm(`
- `frontend/src/components/tournaments/TournamentContentPanel.tsx:90` `window.confirm(`
- `frontend/src/components/tournaments/TournamentSponsorsPanel.tsx:76` `window.confirm(`
- `frontend/src/components/tournaments/TournamentTeamsPanel.tsx:107` `window.confirm(`
- `frontend/src/components/tournaments/TournamentTeamsPanel.tsx:154` `window.confirm(`
- `frontend/src/components/trainer/EditClientModal.tsx:152` `window.confirm(`
- `frontend/src/pages/CalendarPage.tsx:547` `window.confirm(`
- `frontend/src/pages/CertificateTemplatesPage.tsx:107` `window.confirm(`
- `frontend/src/pages/MyEnrollmentsPage.tsx:2042` `¿Estás seguro`
- `frontend/src/pages/ProgramsManagementPage.tsx:67` `¿Estás seguro`
- `frontend/src/pages/SchoolBranchesManagementPage.tsx:118` `window.confirm(`
- `frontend/src/pages/SchoolFacilitiesPage.tsx:1020` `¿Estás seguro`
- `frontend/src/pages/SchoolJoinQRsPage.tsx:203` `window.confirm(`
- `frontend/src/pages/SchoolStudentsManagementPage.tsx:924` `window.confirm(`
- `frontend/src/pages/TrainingPage.tsx:633` `¿Seguro`
- `frontend/src/pages/admin/AdminWhatsAppPlataformaPage.tsx:163` `window.confirm(`
- `frontend/src/pages/booking/PublicTrialClassBookingPage.tsx:1527` `¿Estás seguro`
- `frontend/src/pages/booking/PublicTrialClassBookingPage.tsx:1766` `¿Estás seguro`
- `frontend/src/pages/events/TournamentTeamInvitePage.tsx:88` `window.confirm(`
- `frontend/src/pages/organizer/CreateEventPage.tsx:110` `¿Estás seguro`
- `frontend/src/pages/organizer/EventManagementPage.tsx:575` `¿Estás seguro`
- `frontend/src/pages/school/AttendanceSheetIntakePage.tsx:228` `window.confirm(`
- `frontend/src/pages/school/SchoolEquipmentPage.tsx:87` `window.confirm(`
- `frontend/src/pages/trainer/TrainerRoutineDetail.tsx:139` `window.confirm(`
- `frontend/src/pages/trainer/TrainerRoutineDetail.tsx:139` `¿Seguro`

## Todos los `voseo` (0)

