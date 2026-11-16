-- Etapa 2.5: privilégio mínimo para a role de runtime (achado B8 da 2.4; ADR-0008).
-- Executada pela conta de MIGRAÇÃO (dona das tabelas), nunca pela conta de runtime.
-- A role `openclaw_risk_runtime` (NOLOGIN, grupo) é criada por scripts/provision/roles.sql, fora das migrações.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openclaw_risk_runtime') THEN
    RAISE EXCEPTION 'role openclaw_risk_runtime não existe: execute scripts/provision/roles.sql antes de migrar'
      USING ERRCODE = 'invalid_authorization_specification';
  END IF;
  -- A conta de migração nunca pode ser a de runtime (nem herdá-la): evita migrar com credencial de runtime.
  IF current_user = 'openclaw_risk_runtime' OR EXISTS (
    WITH RECURSIVE memberships(roleid) AS (
      SELECT m.roleid FROM pg_auth_members m WHERE m.member = (SELECT oid FROM pg_roles WHERE rolname = current_user)
      UNION
      SELECT m.roleid FROM pg_auth_members m JOIN memberships s ON m.member = s.roleid
    )
    SELECT 1 FROM memberships WHERE roleid = (SELECT oid FROM pg_roles WHERE rolname = 'openclaw_risk_runtime')
  ) THEN
    RAISE EXCEPTION 'migração recusada: current_user (%) é ou herda openclaw_risk_runtime; use a conta de migração', current_user
      USING ERRCODE = 'insufficient_privilege';
  END IF;
END $$;

-- Ponto de partida fechado: ninguém além do dono recebe nada por padrão.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC, openclaw_risk_runtime;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, openclaw_risk_runtime;
GRANT USAGE ON SCHEMA public TO openclaw_risk_runtime;

-- Somente leitura: configuração e identidade (escritas por provisionamento/administração, não pelo runtime).
GRANT SELECT ON risk_accounts, risk_policies, risk_access_grants, schema_migrations TO openclaw_risk_runtime;

-- Append-only: o runtime lê e insere; UPDATE/DELETE/TRUNCATE nunca.
GRANT SELECT, INSERT ON trade_proposals, risk_decisions, risk_audit_events, risk_outbox TO openclaw_risk_runtime;

-- Reserva: única mutação do runtime é o fechamento ACTIVE -> CONSUMED|EXPIRED|RELEASED.
GRANT SELECT, INSERT ON risk_reservations TO openclaw_risk_runtime;
GRANT UPDATE (status, closed_at, paper_order_id) ON risk_reservations TO openclaw_risk_runtime;

-- TRUNCATE não dispara triggers de linha (risk_forbid_mutation etc.): bloqueio explícito por statement.
CREATE FUNCTION risk_forbid_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'TRUNCATE proibido na tabela %', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
END $$;

CREATE TRIGGER risk_accounts_no_truncate BEFORE TRUNCATE ON risk_accounts
  FOR EACH STATEMENT EXECUTE FUNCTION risk_forbid_truncate();
CREATE TRIGGER risk_policies_no_truncate BEFORE TRUNCATE ON risk_policies
  FOR EACH STATEMENT EXECUTE FUNCTION risk_forbid_truncate();
CREATE TRIGGER risk_access_grants_no_truncate BEFORE TRUNCATE ON risk_access_grants
  FOR EACH STATEMENT EXECUTE FUNCTION risk_forbid_truncate();
CREATE TRIGGER trade_proposals_no_truncate BEFORE TRUNCATE ON trade_proposals
  FOR EACH STATEMENT EXECUTE FUNCTION risk_forbid_truncate();
CREATE TRIGGER risk_decisions_no_truncate BEFORE TRUNCATE ON risk_decisions
  FOR EACH STATEMENT EXECUTE FUNCTION risk_forbid_truncate();
CREATE TRIGGER risk_reservations_no_truncate BEFORE TRUNCATE ON risk_reservations
  FOR EACH STATEMENT EXECUTE FUNCTION risk_forbid_truncate();
CREATE TRIGGER risk_audit_events_no_truncate BEFORE TRUNCATE ON risk_audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION risk_forbid_truncate();
CREATE TRIGGER risk_outbox_no_truncate BEFORE TRUNCATE ON risk_outbox
  FOR EACH STATEMENT EXECUTE FUNCTION risk_forbid_truncate();
