-- =============================================================================
-- 20261119145819_payment_links_enlace_del_proveedor.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-19   Versión anterior: 20261119145807
-- Objetivo: poder reabrir el link que la pasarela creó por API sin crear otro.
--   Hoy la URL de Wompi se firma al vuelo y no se guarda; la de Bold se crea con
--   POST /online/link/v1 (LNK_…) y hay que recordarla.
--   Spec: docs/specs/pasarela-bold-y-adaptador-de-proveedores.md
--   Plan: docs/specs/pasarela-bold-plan-de-migraciones.md (migración B)
--
-- Aditiva: columnas nullable sin DEFAULT (ADD COLUMN instantáneo en PG15, no
-- reescribe la tabla), sin backfill. Sin funciones ni policies nuevas: las columnas
-- heredan los privilegios de payment_links (anon sin grants; solo la policy
-- payment_links_select_by_school, verificado antes de aplicar).
-- Reversa: DROP COLUMN en una migración nueva, solo si no hay links de Bold creados.
-- =============================================================================

BEGIN;

ALTER TABLE public.payment_links
    ADD COLUMN IF NOT EXISTS provider_link_id text,
    ADD COLUMN IF NOT EXISTS checkout_url     text;

COMMENT ON COLUMN public.payment_links.provider_link_id IS
    'Id del link creado en la pasarela por API (Bold: LNK_…). Nulo si la pasarela firma la URL al vuelo (Wompi) o no usa links (MP).';
COMMENT ON COLUMN public.payment_links.checkout_url IS
    'URL de pago creada por la pasarela. Nulo si se firma al vuelo. Solo https (se valida en el BFF).';

-- Para buscar por el LNK_ (webhook que lo trae en metadata.reference) y consultar la API.
-- NO único: la unicidad ya vive en idx_payment_links_provider_ref (payment_provider, provider_reference).
CREATE INDEX IF NOT EXISTS idx_payment_links_provider_link_id
    ON public.payment_links (payment_provider, provider_link_id)
    WHERE provider_link_id IS NOT NULL;

COMMIT;
