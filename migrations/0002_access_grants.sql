-- Concessões de acesso (etapa 2.4): quem (principal autenticado) pode agir em qual conta, e com qual papel.
-- Append-only: a única mutação permitida é a revogação (revoked_at/revoked_by de NULL para valor).

CREATE TABLE risk_access_grants (
  grant_id     UUID PRIMARY KEY,
  principal_id TEXT NOT NULL CHECK (principal_id ~ '^[!-~]{1,128}$'),
  role         TEXT NOT NULL CHECK (role IN ('AGENT', 'PAPER_EXECUTOR')),
  account_id   TEXT NOT NULL REFERENCES risk_accounts (account_id),
  granted_at   TIMESTAMPTZ NOT NULL,
  granted_by   TEXT NOT NULL,
  revoked_at   TIMESTAMPTZ,
  revoked_by   TEXT,
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL)),
  CHECK (revoked_at IS NULL OR revoked_at >= granted_at)
);
-- No máximo uma concessão ativa por (principal, papel, conta).
CREATE UNIQUE INDEX risk_access_grants_one_active
  ON risk_access_grants (principal_id, role, account_id) WHERE revoked_at IS NULL;

CREATE FUNCTION risk_access_grants_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'concessões não podem ser apagadas' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF (NEW.grant_id, NEW.principal_id, NEW.role, NEW.account_id, NEW.granted_at, NEW.granted_by)
     IS DISTINCT FROM
     (OLD.grant_id, OLD.principal_id, OLD.role, OLD.account_id, OLD.granted_at, OLD.granted_by)
     OR OLD.revoked_at IS NOT NULL
     OR NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'concessão só pode ser revogada, uma vez' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER risk_access_grants_guard BEFORE UPDATE OR DELETE ON risk_access_grants
  FOR EACH ROW EXECUTE FUNCTION risk_access_grants_guard();
