-- Pós-restauração (usado por scripts/restore-local.sh): garante que todo objeto de `public` pertença a
-- openclaw_risk_owner (o dump é feito com --no-owner), para que migrações futuras com a conta de migração funcionem.
-- Executado como administrador do alvo. Idempotente; aborta (ON_ERROR_STOP) se restar objeto com outro dono.

DO $$
DECLARE
  r record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openclaw_risk_owner') THEN
    RAISE EXCEPTION 'role openclaw_risk_owner não existe: execute scripts/provision/roles.sql';
  END IF;
  -- Relações (sequências ligadas a coluna seguem o dono da tabela e não podem ser alteradas à parte).
  FOR r IN
    SELECT c.oid::regclass AS name, c.relkind
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
       AND pg_get_userbyid(c.relowner) <> 'openclaw_risk_owner'
       AND NOT (c.relkind = 'S' AND EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype IN ('a', 'i')))
  LOOP
    EXECUTE format('ALTER %s %s OWNER TO openclaw_risk_owner',
      CASE r.relkind WHEN 'S' THEN 'SEQUENCE' WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' ELSE 'TABLE' END, r.name);
  END LOOP;
  FOR r IN
    SELECT p.oid::regprocedure AS name
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND pg_get_userbyid(p.proowner) <> 'openclaw_risk_owner'
  LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO openclaw_risk_owner', r.name);
  END LOOP;
  -- Verificação final.
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S') AND pg_get_userbyid(c.relowner) <> 'openclaw_risk_owner'
  ) OR EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND pg_get_userbyid(p.proowner) <> 'openclaw_risk_owner'
  ) THEN
    RAISE EXCEPTION 'ownership pós-restauração incompleto';
  END IF;
END $$;
