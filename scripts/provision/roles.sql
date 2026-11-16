-- Provisionamento de roles e do banco (idempotente). Uso, conectado como superusuário/administrador do alvo:
--   psql -v ON_ERROR_STOP=1 -v dbname=<banco> -f scripts/provision/roles.sql <banco>
-- Nunca contém senha. O login de runtime é criado à parte (ver scripts/provision-db.sh e a documentação):
--   CREATE ROLE <login> LOGIN INHERIT PASSWORD ...;  GRANT openclaw_risk_runtime TO <login>;
-- O login de runtime NÃO pode ser membro de openclaw_risk_owner. O login de backup (ADR-0012) é membro só de openclaw_risk_backup.

\if :{?dbname}
\else
  \echo 'defina -v dbname=<banco>'
  \quit 1
\endif

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openclaw_risk_owner') THEN
    -- Dono do schema e executor das migrações. LOGIN para a conta de migração; a senha é definida fora do arquivo.
    CREATE ROLE openclaw_risk_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openclaw_risk_runtime') THEN
    -- Role de grupo: sem login; logins de runtime herdam dela.
    CREATE ROLE openclaw_risk_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openclaw_risk_backup') THEN
    -- Role de grupo de backup (ADR-0012): sem login, somente leitura. Os SELECTs vêm de scripts/provision/backup-grants.sql
    -- (reaplicado após cada migrate). O login de backup é criado à parte e NUNCA é membro de owner/runtime.
    -- Precisa existir antes do pg_restore: o dump traz GRANTs para ela.
    CREATE ROLE openclaw_risk_backup NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
END $$;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO openclaw_risk_owner;

REVOKE CONNECT, TEMP ON DATABASE :"dbname" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"dbname" TO openclaw_risk_owner, openclaw_risk_runtime, openclaw_risk_backup;
