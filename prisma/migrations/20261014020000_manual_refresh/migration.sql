BEGIN;

-- One global reservation for owner-triggered refreshes. No row means no request yet.
CREATE TABLE public."RefreshControl" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "lastRequestedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RefreshControl_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "RefreshControl_singleton" CHECK ("id" = 1)
);

-- Uses database UTC time and a fixed interval: callers cannot bypass the cooldown.
-- INSERT ... ON CONFLICT serializes concurrent claims on the singleton row.
-- Keep the reservation after dispatch failure/timeout because GitHub may have accepted it.
CREATE FUNCTION public.claim_manual_refresh()
RETURNS TABLE ("claimed" BOOLEAN, "nextAllowedAt" TIMESTAMP(3))
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    last_claim TIMESTAMP(3);
    did_claim BOOLEAN;
BEGIN
    INSERT INTO public."RefreshControl" AS control ("id", "lastRequestedAt")
    VALUES (1, clock_timestamp() AT TIME ZONE 'UTC')
    ON CONFLICT ("id") DO UPDATE
    SET "lastRequestedAt" = EXCLUDED."lastRequestedAt"
    WHERE control."lastRequestedAt" <= EXCLUDED."lastRequestedAt" - INTERVAL '10 minutes'
    RETURNING control."lastRequestedAt" INTO last_claim;

    did_claim := FOUND;
    IF NOT did_claim THEN
        SELECT control."lastRequestedAt" INTO last_claim
        FROM public."RefreshControl" AS control
        WHERE control."id" = 1;
    END IF;

    RETURN QUERY SELECT did_claim, (last_claim + INTERVAL '10 minutes')::TIMESTAMP(3);
END;
$$;

COMMENT ON FUNCTION public.claim_manual_refresh() IS
    'Atomically reserve a manual refresh for ten minutes; returns claimed and UTC nextAllowedAt. Never release after an uncertain dispatch outcome.';

-- No public execution and no direct web writes. The definer performs only this
-- fixed singleton operation; its safe search_path and qualified table prevent shadowing.
REVOKE ALL ON FUNCTION public.claim_manual_refresh() FROM PUBLIC;
REVOKE ALL ON TABLE public."RefreshControl" FROM PUBLIC;

-- Fresh development databases may not have the production read-only role yet.
-- If that role is created later, explicitly grant SELECT on this table and
-- EXECUTE on this function; never grant INSERT, UPDATE, or DELETE to the web role.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'teetime_web') THEN
        REVOKE ALL ON TABLE public."RefreshControl" FROM teetime_web;
        GRANT SELECT ON TABLE public."RefreshControl" TO teetime_web;
        GRANT EXECUTE ON FUNCTION public.claim_manual_refresh() TO teetime_web;
    END IF;
END;
$$;

COMMIT;
