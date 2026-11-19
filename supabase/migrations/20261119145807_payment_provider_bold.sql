-- =============================================================================
-- 20261119145807_payment_provider_bold.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-19   Versión anterior: 20261119141857
-- Objetivo: Bold (API de Link de pagos) como pasarela de cobros.
--   Spec: docs/specs/pasarela-bold-y-adaptador-de-proveedores.md
--   Plan: docs/specs/pasarela-bold-plan-de-migraciones.md (migración A)
--
-- DEPLOY FIRST, standalone: ALTER TYPE ... ADD VALUE no puede usarse en la misma
-- transacción que lo agrega (gate G-ENUM). Nada en este lote lo referencia.
-- No hay funciones, policies ni GRANT: no hay nada que revisar de seguridad.
-- Sin reversa limpia (Postgres no borra valores de enum); un valor sin uso no estorba.
-- =============================================================================

ALTER TYPE public.payment_provider ADD VALUE IF NOT EXISTS 'bold';
