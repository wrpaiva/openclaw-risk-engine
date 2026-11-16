-- Etapa 2.5: estado operacional de reconciliação pós-restauração (decisão do usuário, 2026-11-14).
-- Após restaurar um backup o serviço fica indisponível até as reservas ACTIVE serem expiradas por
-- `reconcile-after-restore`. Escrita só pela conta de MIGRAÇÃO (operador); o runtime apenas lê.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openclaw_risk_runtime') THEN
    RAISE EXCEPTION 'role openclaw_risk_runtime não existe: execute scripts/provision/roles.sql antes de migrar'
      USING ERRCODE = 'invalid_authorization_specification';
  END IF;
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

-- Linha única: a coluna `singleton` só admite TRUE e é a chave primária.
CREATE TABLE risk_operational_state (
  singleton            BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  restore_pending      BOOLEAN NOT NULL,
  restore_marked_at    TIMESTAMPTZ,
  restore_cleared_at   TIMESTAMPTZ,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (NOT restore_pending OR restore_marked_at IS NOT NULL)
);
-- Estado inicial: nada pendente. Ausência da linha é tratada como falha (fail-closed) pela aplicação.
INSERT INTO risk_operational_state (singleton, restore_pending) VALUES (TRUE, FALSE);

-- Histórico append-only de cada mudança de estado (quem, quando).
CREATE TABLE risk_operational_state_history (
  history_id       BIGSERIAL PRIMARY KEY,
  restore_pending  BOOLEAN NOT NULL,
  changed_by       TEXT NOT NULL DEFAULT current_user,
  changed_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE FUNCTION risk_operational_state_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'o estado operacional não pode ser apagado' USING ERRCODE = 'integrity_constraint_violation';
END $$;
CREATE TRIGGER risk_operational_state_no_delete BEFORE DELETE ON risk_operational_state
  FOR EACH ROW EXECUTE FUNCTION risk_operational_state_guard();

CREATE FUNCTION risk_operational_state_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO risk_operational_state_history (restore_pending) VALUES (NEW.restore_pending);
  RETURN NEW;
END $$;
CREATE TRIGGER risk_operational_state_history_audit AFTER INSERT OR UPDATE ON risk_operational_state
  FOR EACH ROW EXECUTE FUNCTION risk_operational_state_audit();
-- O INSERT inicial acima já ocorreu antes do trigger: registra o estado de partida.
INSERT INTO risk_operational_state_history (restore_pending) VALUES (FALSE);

CREATE TRIGGER risk_operational_state_history_immutable BEFORE UPDATE OR DELETE ON risk_operational_state_history
  FOR EACH ROW EXECUTE FUNCTION risk_forbid_mutation();

CREATE TRIGGER risk_operational_state_no_truncate BEFORE TRUNCATE ON risk_operational_state
  FOR EACH STATEMENT EXECUTE FUNCTION risk_forbid_truncate();
CREATE TRIGGER risk_operational_state_history_no_truncate BEFORE TRUNCATE ON risk_operational_state_history
  FOR EACH STATEMENT EXECUTE FUNCTION risk_forbid_truncate();

-- Grants explícitos (sem ALTER DEFAULT PRIVILEGES): o runtime só lê o estado; o histórico é só do dono.
REVOKE ALL ON risk_operational_state, risk_operational_state_history FROM PUBLIC, openclaw_risk_runtime;
REVOKE ALL ON SEQUENCE risk_operational_state_history_history_id_seq FROM PUBLIC, openclaw_risk_runtime;
GRANT SELECT ON risk_operational_state TO openclaw_risk_runtime;
