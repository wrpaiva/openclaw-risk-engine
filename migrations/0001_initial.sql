-- SPEC §7.1 / ADR-0006. Banco dedicado openclaw_risk; nenhuma tabela de saldo/posição (D-05 em aberto):
-- o snapshot da carteira vem de porta externa. Este schema guarda apenas o que o motor é dono.

CREATE TABLE risk_accounts (
  account_id   TEXT PRIMARY KEY,
  -- Contas reais não podem sequer existir neste banco (ADR-0003, ADR-0010).
  environment  TEXT NOT NULL CHECK (environment = 'PAPER'),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE risk_policies (
  policy_id    TEXT NOT NULL,
  version      TEXT NOT NULL,
  account_id   TEXT NOT NULL REFERENCES risk_accounts (account_id),
  policy_json  JSONB NOT NULL,
  policy_hash  TEXT NOT NULL CHECK (policy_hash ~ '^sha256:[0-9a-f]{64}$'),
  valid_from   TIMESTAMPTZ NOT NULL,
  valid_until  TIMESTAMPTZ,
  active       BOOLEAN NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (policy_id, version),
  UNIQUE (account_id, version)
);
-- No máximo uma política ativa por conta: nunca escolher entre versões concorrentes.
CREATE UNIQUE INDEX risk_policies_one_active_per_account ON risk_policies (account_id) WHERE active;

CREATE TABLE trade_proposals (
  proposal_id      UUID PRIMARY KEY,
  account_id       TEXT NOT NULL,
  agent_id         TEXT NOT NULL,
  idempotency_key  TEXT NOT NULL,
  proposal_hash    TEXT NOT NULL CHECK (proposal_hash ~ '^sha256:[0-9a-f]{64}$'),
  payload_json     JSONB NOT NULL,
  correlation_id   TEXT NOT NULL,
  received_at      TIMESTAMPTZ NOT NULL,
  UNIQUE (account_id, idempotency_key)
);
CREATE INDEX trade_proposals_correlation ON trade_proposals (correlation_id);

CREATE TABLE risk_decisions (
  decision_id              UUID PRIMARY KEY,
  proposal_id              UUID NOT NULL UNIQUE REFERENCES trade_proposals (proposal_id),
  account_id               TEXT NOT NULL,
  agent_id                 TEXT NOT NULL,
  status                   TEXT NOT NULL CHECK (status IN ('ALLOW_PAPER', 'BLOCK')),
  violations_json          JSONB NOT NULL,
  policy_id                TEXT,
  policy_version           TEXT,
  policy_hash              TEXT,
  market_data_as_of        TIMESTAMPTZ,
  snapshot_version         TEXT,
  reservation_id           UUID,
  authorization_expires_at TIMESTAMPTZ,
  evaluated_at             TIMESTAMPTZ NOT NULL,
  decision_json            JSONB NOT NULL,
  -- Invariantes da SPEC §4.4 também no banco.
  CHECK (
    (status = 'ALLOW_PAPER' AND jsonb_array_length(violations_json) = 0 AND reservation_id IS NOT NULL
      AND authorization_expires_at > evaluated_at AND policy_hash IS NOT NULL AND snapshot_version IS NOT NULL
      AND market_data_as_of IS NOT NULL)
    OR
    (status = 'BLOCK' AND jsonb_array_length(violations_json) > 0 AND reservation_id IS NULL
      AND authorization_expires_at IS NULL)
  )
);

CREATE TABLE risk_reservations (
  reservation_id  UUID PRIMARY KEY,
  decision_id     UUID NOT NULL UNIQUE REFERENCES risk_decisions (decision_id) DEFERRABLE INITIALLY DEFERRED,
  account_id      TEXT NOT NULL,
  instrument      TEXT NOT NULL,
  strategy_id     TEXT NOT NULL,
  exposure_base   NUMERIC NOT NULL CHECK (exposure_base > 0),
  risk_base       NUMERIC NOT NULL CHECK (risk_base >= 0),
  status          TEXT NOT NULL CHECK (status IN ('ACTIVE', 'CONSUMED', 'EXPIRED', 'RELEASED')),
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL,
  closed_at       TIMESTAMPTZ,
  paper_order_id  TEXT,
  CHECK ((status = 'ACTIVE') = (closed_at IS NULL)),
  CHECK ((status = 'CONSUMED') = (paper_order_id IS NOT NULL))
);
CREATE INDEX risk_reservations_active ON risk_reservations (account_id) WHERE status = 'ACTIVE';
-- Uma ordem simulada consome no máximo uma autorização (I-04).
CREATE UNIQUE INDEX risk_reservations_paper_order ON risk_reservations (paper_order_id) WHERE paper_order_id IS NOT NULL;

ALTER TABLE risk_decisions
  ADD CONSTRAINT risk_decisions_reservation_fk
  FOREIGN KEY (reservation_id) REFERENCES risk_reservations (reservation_id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE risk_audit_events (
  event_id        UUID PRIMARY KEY,
  correlation_id  TEXT,
  account_id      TEXT,
  proposal_id     UUID,
  decision_id     UUID,
  reservation_id  UUID,
  event_type      TEXT NOT NULL,
  details_json    JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL
);
CREATE INDEX risk_audit_events_proposal ON risk_audit_events (proposal_id);

CREATE TABLE risk_outbox (
  event_id      UUID PRIMARY KEY,
  aggregate_id  TEXT NOT NULL,
  event_type    TEXT NOT NULL,
  payload_json  JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL,
  published_at  TIMESTAMPTZ
);
CREATE INDEX risk_outbox_unpublished ON risk_outbox (created_at) WHERE published_at IS NULL;

-- Histórico imutável: registros de política, proposta, decisão e auditoria nunca mudam nem somem.
CREATE FUNCTION risk_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'tabela % é imutável (%)', TG_TABLE_NAME, TG_OP USING ERRCODE = 'integrity_constraint_violation';
END $$;

CREATE TRIGGER trade_proposals_immutable BEFORE UPDATE OR DELETE ON trade_proposals
  FOR EACH ROW EXECUTE FUNCTION risk_forbid_mutation();
CREATE TRIGGER risk_decisions_immutable BEFORE UPDATE OR DELETE ON risk_decisions
  FOR EACH ROW EXECUTE FUNCTION risk_forbid_mutation();
CREATE TRIGGER risk_audit_events_immutable BEFORE UPDATE OR DELETE ON risk_audit_events
  FOR EACH ROW EXECUTE FUNCTION risk_forbid_mutation();

-- Política: conteúdo imutável; apenas `active` pode ser desligado (aposentadoria). Nunca apagar.
CREATE FUNCTION risk_policies_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'políticas não podem ser apagadas' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF (NEW.policy_id, NEW.version, NEW.account_id, NEW.policy_json, NEW.policy_hash, NEW.valid_from, NEW.valid_until, NEW.created_at)
     IS DISTINCT FROM
     (OLD.policy_id, OLD.version, OLD.account_id, OLD.policy_json, OLD.policy_hash, OLD.valid_from, OLD.valid_until, OLD.created_at)
     OR (NEW.active AND NOT OLD.active) THEN
    RAISE EXCEPTION 'versão de política é imutável; crie nova versão' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER risk_policies_guard BEFORE UPDATE OR DELETE ON risk_policies
  FOR EACH ROW EXECUTE FUNCTION risk_policies_guard();

-- Reserva: única transição ACTIVE → CONSUMED|EXPIRED|RELEASED; demais colunas imutáveis.
CREATE FUNCTION risk_reservations_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'reservas não podem ser apagadas' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status <> 'ACTIVE' OR NEW.status = 'ACTIVE' THEN
    RAISE EXCEPTION 'transição de reserva inválida: % -> %', OLD.status, NEW.status USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF (NEW.reservation_id, NEW.decision_id, NEW.account_id, NEW.instrument, NEW.strategy_id, NEW.exposure_base, NEW.risk_base, NEW.expires_at, NEW.created_at)
     IS DISTINCT FROM
     (OLD.reservation_id, OLD.decision_id, OLD.account_id, OLD.instrument, OLD.strategy_id, OLD.exposure_base, OLD.risk_base, OLD.expires_at, OLD.created_at) THEN
    RAISE EXCEPTION 'campos da reserva são imutáveis' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER risk_reservations_guard BEFORE UPDATE OR DELETE ON risk_reservations
  FOR EACH ROW EXECUTE FUNCTION risk_reservations_guard();
