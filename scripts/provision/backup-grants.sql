-- Grants da role de backup (ADR-0012, decisão U2 opção A). Idempotente; NÃO executar em produção sem aprovação.
-- Pré-requisito: scripts/provision/roles.sql (cria openclaw_risk_backup). Reaplique APÓS CADA `migrate`: tabelas e
-- sequências novas não herdam privilégio (ALTER DEFAULT PRIVILEGES não serve: a migração não faz SET ROLE).
-- Executar como dono do schema (openclaw_risk_owner) ou superusuário/administrador do alvo:
--   psql -X -v ON_ERROR_STOP=1 -f scripts/provision/backup-grants.sql <banco>
-- Só concede leitura: USAGE no schema public, SELECT em tabelas e sequências. Nenhum INSERT/UPDATE/DELETE/TRUNCATE.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openclaw_risk_backup') THEN
    RAISE EXCEPTION 'role openclaw_risk_backup não existe: execute scripts/provision/roles.sql';
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO openclaw_risk_backup;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO openclaw_risk_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO openclaw_risk_backup;
