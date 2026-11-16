-- Pós-restauração (usado por scripts/restore-local.sh): marca restore_pending=true e audita. Idempotente.
-- Aborta se o dump é anterior à migração 0004 (sem a tabela de estado): nesse caso rode `migrate` e depois
-- `mark-restore-pending` (CLI) com o serviço parado, antes de qualquer subida da aplicação.

DO $$
BEGIN
  IF to_regclass('public.risk_operational_state') IS NULL THEN
    RAISE EXCEPTION 'dump anterior a 0004_restore_reconciliation: rode migrate e depois mark-restore-pending (CLI) antes de subir a app';
  END IF;
END $$;

BEGIN;
WITH marked AS (
  UPDATE risk_operational_state
     SET restore_pending = TRUE, restore_marked_at = now(), updated_at = now()
   WHERE singleton AND NOT restore_pending
  RETURNING 1
)
INSERT INTO risk_audit_events (event_id, correlation_id, account_id, proposal_id, decision_id, reservation_id, event_type, details_json, created_at)
SELECT gen_random_uuid(), NULL, NULL, NULL, NULL, NULL, 'RESTORE_PENDING_MARKED', '{"trigger":"restore-local"}'::jsonb, now()
  FROM marked;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM risk_operational_state WHERE singleton AND restore_pending) THEN
    RAISE EXCEPTION 'restore_pending não ficou marcado';
  END IF;
END $$;
COMMIT;
