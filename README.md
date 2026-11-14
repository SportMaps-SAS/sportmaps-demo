# SportMaps

Plataforma de gestion deportiva para escuelas, entrenadores, padres y atletas.

## Stack

| Capa | Tecnologia |
|------|-----------|
| Frontend | React 18, TypeScript, Vite, TailwindCSS, shadcn/ui |
| BFF | Express 5, Node.js, pg |
| Base de datos | Supabase (PostgreSQL 15 + RLS) |
| Auth | Supabase Auth (email + Google OAuth) |
| Pagos | Wompi (gateway), transferencia manual con comprobante |
| Email | Resend (via Edge Function `send-email`) |
| Deploy | Vercel (frontend) + Supabase Cloud |

## Estructura del repositorio

```
sportmaps-demo/
  frontend/          React SPA (~88 paginas, PWA)
  bff/               Express API REST (/api/v1/*)
  supabase/
    functions/       Edge Functions (send-email, payment-reminders-cron, wompi-sign, etc.; el webhook de Wompi vive en el BFF)
    migrations/      Migraciones SQL
  docs/              Documentacion del proyecto
```

## Roles del sistema

| Rol | Descripcion | Estado MVP |
|-----|------------|------------|
| school (owner) | Administrador de la academia | Funcional completo |
| parent | Padre/acudiente de atletas | Funcional completo |
| coach | Entrenador asignado a equipos | Funcional completo |
| athlete | Deportista inscrito | Funcional completo |
| school_admin | Admin de sede especifica | Funcional (misma UI que school) |
| wellness_professional | Profesional de salud | Solo demo |
| store_owner | Dueño de tienda deportiva | Solo demo |
| organizer | Organizador de eventos | Solo demo |

## Funcionalidades core (MVP)

### Escuela
- Onboarding guiado paso a paso (wizard)
- Gestion de sedes, equipos, staff
- Inscripciones y matriculas
- Pagos: configuracion, automatizacion, recordatorios (email + WhatsApp)
- Asistencia: supervision y auditoria
- Reportes financieros y operativos

### Padre
- Vinculacion por invitacion
- Ver hijos, asistencias, pagos
- Pagar mensualidades (Wompi o transferencia)
- Reservar clases para sus hijos
- Mensajeria con la escuela

### Coach
- Equipos asignados con estudiantes
- Toma de asistencia por sesion
- Planes de entrenamiento (CRUD)
- Registro de resultados de partidos
- Agenda de clases y disponibilidad
- Reportes de rendimiento

### Atleta
- Perfil deportivo
- Reserva de clases y canchas
- Calendario de actividades
- Explorar escuelas e inscribirse
- Registro de entrenamientos y objetivos

## Setup local

### Frontend
```bash
cd frontend
npm install
npm run dev          # http://localhost:3001
```

### BFF
```bash
cd bff
npm install
npm run dev          # http://localhost:3002
```

### Variables de entorno

**Frontend** (`frontend/.env`):
```
VITE_SUPABASE_URL=https://luebjarufsiadojhvxgi.supabase.co
VITE_SUPABASE_ANON_KEY=<anon key>
VITE_BFF_URL=http://localhost:3002
VITE_WOMPI_PUBLIC_KEY=<wompi public key>
```

**BFF** (`bff/.env`):
```
SUPABASE_URL=https://luebjarufsiadojhvxgi.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service role key>
PORT=3002
SENTRY_DSN=<dsn del proyecto Node en Sentry>
```

## Deploy

**Frontend:** Vercel — configurado con `frontend/` como root directory, build command `npm run build`, output `build/`.

**BFF:** Desplegable en cualquier servicio Node.js (Railway, Render, etc.)

**Supabase:** Cloud — migraciones en `supabase/migrations/`, Edge Functions en `supabase/functions/`.

Para deploy detallado ver `docs/deployment/DEPLOY_GUIDE.md`.

## Documentacion

| Doc | Contenido |
|-----|-----------|
| `docs/deployment/DEPLOY_GUIDE.md` | Guia completa de deploy a Vercel + Supabase |
| `docs/guides/DEMO_CREDENTIALS.md` | Cuentas demo con credenciales |
| `docs/guides/NAMING_DICTIONARY.md` | Mapeo de tablas y convenciones |
| `docs/architecture/` | Arquitectura frontend, backend, seguridad, API specs |
| `CLAUDE.md` | Instrucciones para Claude Code |
