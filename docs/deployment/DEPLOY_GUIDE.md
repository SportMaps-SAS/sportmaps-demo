# 🚀 Guía de Deploy — SportMaps MVP

## Pre-requisitos

- Cuenta Supabase en plan **Pro** (necesario para RLS + Edge Functions + PITR backups)
- Cuenta Vercel (frontend)
- Cuenta Wompi (Colombia) con credenciales de producción
- GitHub Actions configurado (secrets en el repo)

---

## PASO 1: Configurar Variables de Entorno Locales

```bash
# Copiar el template
cp frontend/.env.example frontend/.env.local

# Editar con tus credenciales reales
nano frontend/.env.local
```

Contenido de `frontend/.env.local`:
```
VITE_SUPABASE_URL=https://tu-proyecto.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=tu_anon_key_aqui
VITE_WOMPI_PUBLIC_KEY=pub_test_xxxx   # En producción: pub_stg_xxx
VITE_SENTRY_DSN=https://xxx@sentry.io/xxx
VITE_SENTRY_ENVIRONMENT=development
```

---

## PASO 2: Ejecutar Migración SQL (RLS + Índices)

> ⚠️ HACER BACKUP PRIMERO en Supabase → Settings → Database → Backups

```bash
# Opción A: Usando Supabase CLI (recomendado)
npx supabase db push

# Opción B: Copiar y pegar en Supabase SQL Editor
# → Abrir supabase/migrations/20260218_rls_policies_and_indexes.sql
# → Ejecutar en STAGING primero
# → Verificar datos visibles correctamente por rol
# → Ejecutar en PRODUCCIÓN
```

**Verificación post-migración:**
```sql
-- Probar que RLS está activo (con usuario anon no debe retornar nada)
SELECT * FROM children LIMIT 1;  -- Debe retornar 0 filas con anon key

-- Verificar índices creados
SELECT indexname FROM pg_indexes
WHERE tablename IN ('children','payments','school_members','enrollments');
```

---

## PASO 3: Desplegar Edge Functions de Supabase

```bash
# Instalar Supabase CLI si no está instalado
npm install -g supabase

# Login
supabase login

# Link con tu proyecto
supabase link --project-ref tu-project-ref

# Configurar secrets de las Edge Functions
supabase secrets set WOMPI_INTEGRITY_SECRET=tu_integrity_secret_de_wompi   # lo usa wompi-sign
# WOMPI_EVENTS_SECRET NO va aquí: el webhook de Wompi lo recibe el BFF (ver abajo)
supabase secrets set RESEND_API_KEY=re_xxxx_tu_api_key
supabase secrets set ENVIRONMENT=production

# Desplegar las funciones
supabase functions deploy wompi-sign
supabase functions deploy send-email
supabase functions deploy payment-reminders-cron
supabase functions deploy send-push-notification
supabase functions deploy analyze-receipt

# Verificar que están activas
supabase functions list
```

> No hay Edge Function `wompi-webhook` (retirada el 2026-10-27): el webhook de Wompi lo recibe el BFF.
> `send-push-notification` sigue en uso por el trigger legacy de web push hasta completar
> docs/migraciones-pendientes-2026-10-27/LEEME.md.

**Configurar webhook en Wompi (receptor = BFF):**
1. Ir a dashboard.wompi.co → Configuración → Webhooks
2. URL del webhook: `https://<host-del-bff>/api/v1/webhooks/wompi/webhook`
   (el sufijo `/webhook` es obligatorio; sin él el BFF responde 401 y los eventos se pierden en silencio).
   Código: `bff/src/routes/wompi.ts`.
3. Eventos: `transaction.updated`
4. El **Events Secret** de cada escuela se guarda con sus credenciales de pasarela (Configuración de pagos);
   el de la cuenta agregadora va en la variable `WOMPI_EVENTS_SECRET` del BFF (Render), no en `supabase secrets`.

---

## PASO 4: Configurar Variables en Vercel

```
Dashboard Vercel → tu-proyecto → Settings → Environment Variables

Variables necesarias (en Producción):
├── VITE_SUPABASE_URL          = https://tu-proyecto.supabase.co
├── VITE_SUPABASE_PUBLISHABLE_KEY = tu_anon_key
├── VITE_WOMPI_PUBLIC_KEY      = pub_stg_xxxxx  (producción)
├── VITE_SENTRY_DSN            = https://xxx@sentry.io/xxx
└── VITE_SENTRY_ENVIRONMENT    = production
```

---

## PASO 5: Configurar GitHub Actions Secrets

```
GitHub → tu-repo → Settings → Secrets and variables → Actions

Secrets necesarios:
├── VITE_SUPABASE_URL_STAGING           (staging)
├── VITE_SUPABASE_PUBLISHABLE_KEY_STAGING
├── VITE_WOMPI_PUBLIC_KEY               (sandbox key para tests)
├── VITE_SENTRY_DSN
├── VERCEL_TOKEN
├── VERCEL_ORG_ID
├── VERCEL_PROJECT_ID
├── STAGING_URL                         (URL de staging en Vercel)
├── E2E_TEST_EMAIL                      (usuario de test para E2E)
└── E2E_TEST_PASSWORD
```

---

## PASO 6: Configurar Environment en GitHub (Aprobación manual para Producción)

```
GitHub → Settings → Environments → "production"
→ Required reviewers: [tu usuario]
→ Deployment branches: main
```

---

## PASO 7: Verificar que todo funciona

### Checklist de verificación:

**Autenticación:**
- [ ] Login con email/password
- [ ] onboarding_completed funciona por rol
- [ ] Logout limpia sesión correctamente

**Multitenancy:**
- [ ] Admin escuela A NO puede ver estudiantes de escuela B
- [ ] Padre solo ve sus hijos
- [ ] Coach solo ve estudiantes de sus programas

**Pagos:**
- [ ] Widget de Wompi abre correctamente
- [ ] La firma se solicita al servidor (Edge Function)
- [ ] Webhook actualiza status del pago en BD
- [ ] Notificación in-app aparece después de pago aprobado

**Performance:**
- [ ] Bundle inicial < 300KB gzip (verificar en DevTools → Network)
- [ ] Dashboard carga en < 3 segundos

**CI/CD:**
- [ ] Push a `develop` → deploy automático a staging
- [ ] PR a `main` → requiere aprobación → deploy manual a producción

---

## Secrets Supabase — Referencia

```bash
# Ver secrets activos (no muestra valores)
supabase secrets list

# Actualizar un secret
supabase secrets set WOMPI_INTEGRITY_SECRET=nuevo_valor

# Eliminar un secret
supabase secrets unset NOMBRE_SECRET
```

---

## Troubleshooting

**"Policy violated"** al hacer query:
→ El usuario no tiene membresía activa en `school_members`. Verificar que su `status = 'active'`.

**Edge Function retorna 500:**
→ Verificar: `supabase functions logs <nombre-de-la-funcion>`

**El webhook de Wompi no concilia pagos:**
→ Revisar los logs del BFF en Render (ruta `/api/v1/webhooks/wompi/webhook`) y que la URL del dashboard de Wompi termine en `/webhook`.

**Bundle sigue siendo grande:**
→ Verifica que `npm run build` usa las importaciones lazy de `App.tsx`.
→ Analiza con: `npx vite-bundle-visualizer` en el directorio frontend.
