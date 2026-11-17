import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Verificação estática (sem Docker) dos invariantes do job de backup do ADR-0012. O comportamento é coberto por
// tests/integration/BackupScriptGuards.test.ts (stubs) e tests/backup (npm run test:backup). Fixtures FICTÍCIAS.
const ROOT = join(import.meta.dirname, '../../..');
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');
/** Remove linhas de comentário (# ou --) e junta continuações com barra invertida. */
const code = (text: string, marker: '#' | '--' = '#'): string =>
  text
    .split('\n')
    .filter((l) => !l.trim().startsWith(marker))
    .join('\n')
    .replace(/\\\n\s*/g, ' ');

const PROD_SCRIPTS = ['scripts/backup/backup-job.sh', 'scripts/backup-prod.sh', 'scripts/restore-encrypted-local.sh'] as const;
const BASH_SCRIPTS = [...PROD_SCRIPTS, 'scripts/test-backup.sh'] as const;
const ALL_SCRIPTS = [...BASH_SCRIPTS, 'scripts/build-backup-image.sh', 'scripts/restore-local.sh'] as const;

describe('ADR-0012: scripts de backup e restauração', () => {
  it.each(BASH_SCRIPTS)('%s usa bash com set -euo pipefail (pipefail não existe no dash)', (p) => {
    const t = read(p);
    expect(t.startsWith('#!/bin/bash\n')).toBe(true);
    expect(code(t)).toMatch(/^set -euo pipefail$/m);
  });

  it.each(ALL_SCRIPTS)('%s não liga xtrace (set -x / -o xtrace / bash -x)', (p) => {
    const c = code(read(p));
    expect(c).not.toMatch(/\bset\s+-[a-z]*x/);
    expect(c).not.toMatch(/xtrace/);
    expect(c).not.toMatch(/\bbash\s+-[a-z]*x/);
  });

  it.each(PROD_SCRIPTS)('%s define umask 077 e nunca usa senha por argv/env (PGPASSWORD, -W, URL com senha)', (p) => {
    const c = code(read(p));
    expect(c).toMatch(/^umask 077$/m);
    expect(c).not.toMatch(/PGPASSWORD|--password\b|\s-W\s/);
    expect(c).not.toMatch(/postgres(ql)?:\/\/[^\s"']*:[^\s"']*@/);
  });

  it('backup-job.sh: pg_dump só em pipe direto para age, sem --file/-f/--dbname=/senha; o único destino em disco é o texto cifrado', () => {
    const c = code(read('scripts/backup/backup-job.sh'));
    const invocations = c.split('\n').filter((l) => /^\s*pg_dump(\s|$)/.test(l));
    expect(invocations).toHaveLength(1);
    const inv = invocations[0] as string;
    expect(inv).toMatch(/^\s*pg_dump\s[^|]*\|\s*age\s+-R\s+"\$SECRETS\/age_recipients"\s+-o\s+"\$TMP"/);
    expect(inv).not.toMatch(/--file|\s-f\s|--dbname=|--password|\s-W\s|PGPASSWORD|:\/\//);
    expect(inv).toContain('--format=custom');
    expect(inv).toContain('--no-password');
    // Nenhuma outra ferramenta grava o dump (nada redireciona a saída do pg_dump a arquivo).
    expect(inv.replace(/2>\/dev\/null/g, '').split('|')[0]).not.toMatch(/>/);
    expect(c).not.toMatch(/\bpg_dumpall\b/);
    // PIPESTATUS é conferido (as duas pontas do pipe).
    expect(c).toMatch(/rc=\("\$\{PIPESTATUS\[@\]\}"\)/);
    expect(c).toMatch(/\$\{rc\[0\]\}.*\$\{rc\[1\]\}/);
  });

  it('backup-job.sh: temporário no mesmo diretório do destino e publicação por ln (sem sobrescrever); nunca mv/cp/install', () => {
    const c = code(read('scripts/backup/backup-job.sh'));
    expect(c).toContain('OUT_DIR=/out');
    expect(c).toMatch(/TMP="\$OUT_DIR\/\.\$NAME\.partial\.\$\$"/);
    expect(c).toMatch(/TMP_SHA="\$OUT_DIR\/\.\$NAME\.sha256\.partial\.\$\$"/);
    expect(c).toMatch(/ln "\$TMP" "\$FINAL"/);
    expect(c).toMatch(/ln "\$TMP_SHA" "\$FINAL_SHA"/);
    expect(c).not.toMatch(/^\s*(mv|cp|install|rsync|tee)\s/m);
    expect(c).not.toMatch(/\bln\s+-[a-zA-Z]*[fs]/); // sem ln -f (sobrescreve) e sem symlink
    // Recusa nome final pré-existente ANTES do pg_dump.
    expect(c.indexOf('final_exists')).toBeGreaterThan(-1);
    expect(c.indexOf('final_exists')).toBeLessThan(c.search(/^\s*pg_dump\s/m));
    // O trap remove os parciais da execução.
    expect(c).toMatch(/trap cleanup EXIT/);
  });

  it('backup-job.sh: a trava de alvo/privilégios (psql) vem antes de qualquer gravação em /out', () => {
    const c = code(read('scripts/backup/backup-job.sh'));
    const guard = c.indexOf('GUARD_SQL=');
    expect(guard).toBeGreaterThan(-1);
    for (const w of ['pg_dump', 'ln "$TMP"', '>"$TMP', '-o "$TMP"', 'rclone copyto']) {
      expect(c.indexOf(w, guard + 10)).toBeGreaterThan(c.indexOf('guard_target_or_privileges_refused'));
    }
    expect(c).toContain('current_database()');
    expect(c).toContain('rolsuper');
  });

  it('backup-job.sh: find só com -maxdepth 1 -type f e padrão estrito; nunca rm recursivo; rm só de nomes montados sobre $OUT_DIR', () => {
    const c = code(read('scripts/backup/backup-job.sh'));
    const finds = c.split('\n').filter((l) => /\bfind\b/.test(l));
    expect(finds.length).toBeGreaterThan(0);
    for (const f of finds) {
      expect(f).toContain('find "$OUT_DIR" -maxdepth 1 -type f');
      expect(f).not.toMatch(/-delete|-exec|-ok\b|-mtime|-newer/);
    }
    expect(finds.some((f) => f.includes('-name "$DB-????????T??????Z.dump.age"'))).toBe(true);
    expect(c).toMatch(/\^\$DB-\(\[0-9\]\{4\}\)\(\[0-9\]\{2\}\)\(\[0-9\]\{2\}\)T\(\[0-9\]\{2\}\)\(\[0-9\]\{2\}\)\(\[0-9\]\{2\}\)Z\\\.dump\\\.age\$/);
    expect(c).not.toMatch(/\brm\s+(-[a-zA-Z]*[rR]|--recursive)/);
    for (const l of c.split('\n').filter((x) => /\brm\b/.test(x))) {
      expect(l).toMatch(/\brm -f -- /);
      expect(l).not.toMatch(/rm -f -- \/(?!out)/);
    }
    expect(c).toContain('RETENTION_DAYS=7');
  });

  it.each(PROD_SCRIPTS)('%s: nenhum rm recursivo e nenhuma operação de prune', (p) => {
    const c = code(read(p));
    expect(c).not.toMatch(/\brm\s+(-[a-zA-Z]*[rR]|--recursive)/);
    expect(c).not.toMatch(/\bprune\b/);
  });

  it.each(ALL_SCRIPTS)('%s: não referencia aegis nem prune em código', (p) => {
    const c = code(read(p));
    expect(c).not.toMatch(/aegis/i);
    expect(c).not.toMatch(/\bprune\b/);
  });

  it('rclone: só copyto e lsjson (nada de delete/deletefile/purge/sync/move/moveto/mkdir/cleanup/rmdir/copy); sem criar bucket', () => {
    for (const p of PROD_SCRIPTS) {
      const c = code(read(p));
      const subs = [...c.matchAll(/\brclone\s+([A-Za-z]+)/g)].map((m) => m[1]);
      for (const s of subs) expect(['copyto', 'lsjson']).toContain(s);
      expect(c).not.toMatch(/\brclone\b[^\n]*\b(delete|deletefile|purge|sync|move|moveto|mkdir|rmdir|cleanup|rcat|bisync|copy)\b/);
    }
    const job = code(read('scripts/backup/backup-job.sh'));
    expect(job).toContain('--s3-no-check-bucket');
    // `--immutable` não protege contra sobrescrita no rclone 1.60.1: a barreira é o HEAD prévio (probe) + --ignore-existing.
    expect(job).not.toContain('--immutable');
    expect(job).toContain('--ignore-existing');
    expect(job).toContain('--error-on-no-transfer');
    expect(job).toMatch(/copyto --dry-run /);
    expect(job).not.toMatch(/--delete-|--backup-dir|--s3-no-head\b|--overwrite/);
  });

  it('backup-job.sh: toda chamada rclone leva --contimeout/--timeout/--retries/--low-level-retries (direto ou via RC_BASE/RC_FLAGS), sem default', () => {
    const job = code(read('scripts/backup/backup-job.sh'));
    const base = /^RC_BASE=\(([^)]*)\)/m.exec(job)?.[1] ?? '';
    for (const [flag, v] of [['--contimeout', 'CONTIMEOUT'], ['--timeout', 'RCTIMEOUT'], ['--retries', 'RETRIES'], ['--low-level-retries', 'LL_RETRIES']] as const) {
      expect(base, flag).toContain(`${flag} "$${v}"`);
    }
    // RC_FLAGS deriva de RC_BASE; cada chamada rclone usa RC_BASE ou RC_FLAGS.
    expect(job).toMatch(/^RC_FLAGS=\("\$\{RC_BASE\[@\]\}"\)/m);
    const calls = job.split('\n').filter((l) => /(^|[\s|;(])rclone\s+[a-z]/.test(l) && !l.includes('command -v'));
    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const l of calls) expect(l, l).toMatch(/\$\{RC_(BASE|FLAGS)\[@\]\}/);
    // Sem default: a variável vem de ${VAR:-} e é validada por regex antes de qualquer conexão.
    for (const v of ['CONTIMEOUT', 'TIMEOUT', 'RETRIES', 'LOW_LEVEL_RETRIES']) expect(job).toContain(`\${RISK_BACKUP_RCLONE_${v}:-}`);
    expect(job).toContain('^[1-9][0-9]{0,5}(ms|s|m)$');
    expect(job).toContain('^[1-9][0-9]{0,3}$');
    expect(job).not.toMatch(/RISK_BACKUP_RCLONE_\w+:-[^}]/); // nenhum valor padrão
    expect(job.indexOf('config_invalid_rclone_low_level_retries')).toBeLessThan(job.indexOf('psql -X'));
    expect(job).toContain('has_any_column_privilege(current_user, c.oid, \'INSERT\')');
    expect(job).toContain('has_any_column_privilege(current_user, c.oid, \'UPDATE\')');
    expect(job).toContain("has_schema_privilege(current_user, n.oid, 'CREATE')");
    expect(job).toContain("has_database_privilege(current_user, current_database(), 'CREATE')");
    expect(job).toContain('rolcreaterole or rolcreatedb or rolreplication or rolbypassrls');
    expect(job).toMatch(/^\s*rclone copyto --error-on-no-transfer "\$\{RC_FLAGS\[@\]\}"/m);
    expect(job).toContain('has_sequence_privilege(current_user, c.oid, \'UPDATE\')');
  });

  it('backup-prod.sh: docker run endurecido (read-only, cap-drop ALL, no-new-privileges, pull never), segredos ro, sem env com valor', () => {
    const c = code(read('scripts/backup-prod.sh'));
    const run = c.split('\n').find((l) => /^\s*docker run /.test(l));
    expect(run).toBeDefined();
    const r = run as string;
    for (const f of ['--rm', '--pull never', '--read-only', '--cap-drop ALL', '--security-opt no-new-privileges', '--user "$UID_NOW:$(id -g)"', '-v "$SECRETS:/run/secrets:ro"', '--entrypoint /usr/local/bin/backup-job.sh']) {
      expect(r).toContain(f);
    }
    expect(r).not.toMatch(/--privileged|--network host|--network=host|docker\.sock|--tmpfs|--cap-add|--pid|--ipc|--device/);
    // `-e` só por nome (valor viaja pelo ambiente do processo), nunca -e NOME=valor.
    const envs = [...r.matchAll(/\s-e\s+(\S+)/g)].map((m) => m[1] as string);
    expect(envs.sort()).toEqual(
      ['RISK_BACKUP_EXPECTED_DB', 'RISK_BACKUP_RCLONE_CONTIMEOUT', 'RISK_BACKUP_RCLONE_LOW_LEVEL_RETRIES', 'RISK_BACKUP_RCLONE_RETRIES', 'RISK_BACKUP_RCLONE_TIMEOUT', 'RISK_BACKUP_S3_BUCKET', 'RISK_BACKUP_S3_PREFIX'],
    );
    expect(r).not.toMatch(/--env-file|--env\b/);
    // O fd do lock não vaza ao contêiner e o lock é não bloqueante.
    expect(r).toMatch(/9>&-\s*$/);
    expect(c).toMatch(/flock -n 9/);
    // Config nunca é executada (source/eval).
    expect(c).not.toMatch(/^\s*(source|eval)\b|^\s*\.\s/m);
    // Todas as validações (config, dirs, secrets, imagem, rede) antecedem o docker run.
    const firstRun = c.search(/^\s*docker run /m);
    expect(c.indexOf('docker image inspect')).toBeLessThan(firstRun);
    expect(c.indexOf('docker network inspect')).toBeLessThan(firstRun);
    expect(c.indexOf('flock -n 9')).toBeLessThan(firstRun);
  });

  it('backup-prod.sh: o trap remove só o contêiner deste job (nome fixo e label); sem prune/volume/network rm', () => {
    const c = code(read('scripts/backup-prod.sh'));
    const cleanup = /cleanup\(\) \{[\s\S]*?\n\}/.exec(c)?.[0] ?? '';
    expect(cleanup).toContain('--filter "name=^${NAME}\\$"');
    expect(cleanup).toContain('--filter "label=$LABEL"');
    expect(cleanup).not.toMatch(/prune|volume rm|network rm|image rm|system/);
    expect(c).not.toMatch(/docker (system|volume|image|network) (prune|rm)/);
  });

  it('restore-encrypted-local.sh: decifra em contêiner sem rede, somente leitura, sem capabilities; identidade montada :ro; guard de _test', () => {
    const c = code(read('scripts/restore-encrypted-local.sh'));
    expect(c).toContain('--network none');
    expect(c).toContain('--read-only');
    expect(c).toContain('--cap-drop ALL');
    expect(c).toContain('--security-opt no-new-privileges');
    expect(c).toContain('-v "$ID:/run/identity/key:ro"');
    expect(c).toMatch(/\*_test\)/);
    expect(c).toContain('guard_url_syntax');
    expect(c).toMatch(/decrypt \| sh "\$ROOT\/scripts\/restore-local\.sh" -/);
    // O dump em claro não vai a arquivo: nenhum redirecionamento de saída de decrypt/age -d.
    expect(c.replace(/2>\/dev\/null/g, '')).not.toMatch(/decrypt[^|\n]*>\s*\S/);
    expect(c).not.toMatch(/\bcp\b|\bmv\b|\btee\b|mktemp/);
    // Checksum conferido antes de decifrar.
    expect(c.indexOf('sha256sum')).toBeLessThan(c.indexOf('magic=$(decrypt'));
  });

  it('restore-local.sh mantém uma única linha pg_restore --exit-on-error e a marcação logo depois', () => {
    const c = code(read('scripts/restore-local.sh'));
    const lines = c.split('\n').filter((l) => /^\s*pg_restore\b/.test(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('--exit-on-error');
    const after = c.slice(c.indexOf(lines[0] as string) + (lines[0] as string).length).split('\n').filter((l) => l.trim() !== '');
    expect(after[0]).toContain('mark-restore-pending.sql');
  });
});

describe('ADR-0012: Dockerfile.backup e .dockerignore', () => {
  const df = read('Dockerfile.backup');
  const c = code(df);

  it('base fixada por digest (FROM via ARG com @sha256:<64 hex>)', () => {
    const arg = /^ARG PG_IMAGE=(\S+)$/m.exec(c)?.[1] ?? '';
    expect(arg).toMatch(/^postgres:14-[a-z]+@sha256:[0-9a-f]{64}$/);
    const froms = c.split('\n').filter((l) => /^FROM /.test(l));
    expect(froms).toEqual(['FROM ${PG_IMAGE}']);
    expect(c).not.toMatch(/:latest/);
  });

  it('apt-get com --no-install-recommends, versão fixada em cada pacote e limpeza de listas', () => {
    expect(c).toContain('apt-get install -y --no-install-recommends');
    const install = /apt-get install[^\n]*/.exec(c)?.[0] ?? '';
    const pkgs = install.replace(/^.*--no-install-recommends\s*/, '').replace(/&&.*$/, '').trim().split(/\s+/);
    expect(pkgs.length).toBeGreaterThanOrEqual(2);
    for (const p of pkgs) expect(p).toMatch(/^"[a-z0-9.+-]+=\$\{[A-Z_]+\}"$/);
    expect(c).toMatch(/^ARG AGE_VERSION=\S+$/m);
    expect(c).toMatch(/^ARG RCLONE_VERSION=\S+$/m);
    expect(c).toContain('rm -rf /var/lib/apt/lists/*');
    expect(c).not.toMatch(/apt-get (upgrade|dist-upgrade)/);
  });

  it('sem curl/wget/ADD remoto/EXPOSE; sem ARG/ENV de credencial; só copia backup-job.sh', () => {
    expect(c).not.toMatch(/\b(curl|wget)\b/);
    expect(c).not.toMatch(/^ADD\b|^EXPOSE\b/m);
    for (const l of c.split('\n').filter((x) => /^(ARG|ENV)\b/.test(x))) {
      expect(l).not.toMatch(/PASS|SECRET|KEY|TOKEN|CRED|RCLONE_CONFIG|PGPASS|AWS_|S3_/i);
    }
    expect(c.split('\n').filter((l) => /^ENV\b/.test(l))).toEqual([]);
    const copies = c.split('\n').filter((l) => /^COPY\b/.test(l));
    expect(copies).toHaveLength(1);
    expect(copies[0]).toContain('scripts/backup/backup-job.sh');
  });

  it('Dockerfile.backup.dockerignore exclui tudo e libera só scripts/backup/backup-job.sh', () => {
    const lines = code(read('Dockerfile.backup.dockerignore')).split('\n').map((l) => l.trim()).filter(Boolean);
    expect(lines[0]).toBe('*');
    for (const l of lines.slice(1)) expect(l).toMatch(/^!scripts\/backup\/(backup-job\.sh)?$/);
    expect(lines).not.toContain('!.env');
  });
});

describe('ADR-0012: exemplos em deploy/backup', () => {
  const FILES = ['backup.env.example', 'crontab.example', 'pgpass.example', 'rclone.conf.example'];

  it.each(FILES)('%s existe, traz NÃO APLICADO e "a definir"', (f) => {
    const p = `deploy/backup/${f}`;
    expect(existsSync(join(ROOT, p))).toBe(true);
    const t = read(p);
    expect(t).toContain('NÃO APLICADO');
    expect(t).toMatch(/a definir/);
  });

  it.each(FILES)('%s não contém segredo real (chave age privada, chave AWS, senha, URL com senha)', (f) => {
    const t = read(`deploy/backup/${f}`);
    expect(t).not.toMatch(/AGE-SECRET-KEY-/);
    expect(t).not.toMatch(/AKIA[0-9A-Z]{12,}/);
    expect(t).not.toMatch(/postgres(ql)?:\/\/[^\s]*:[^\s]*@/);
    expect(t).not.toMatch(/\b[0-9a-f]{32,}\b/i);
    expect(t).not.toMatch(/age1[a-z0-9]{50,}/); // nem recipient real
  });

  it('crontab.example: toda linha de agendamento está comentada (nada instalável)', () => {
    for (const l of read('deploy/backup/crontab.example').split('\n')) {
      if (l.trim() !== '') expect(l.trim().startsWith('#')).toBe(true);
    }
  });

  it('backup.env.example só usa chaves RISK_BACKUP_* conhecidas e o remote do rclone.conf é risk-backup', () => {
    const keys = read('deploy/backup/backup.env.example')
      .split('\n')
      .filter((l) => /^[A-Z]/.test(l))
      .map((l) => l.split('=')[0]);
    expect(keys.sort()).toEqual(
      ['RISK_BACKUP_DIR', 'RISK_BACKUP_DOCKER_NETWORK', 'RISK_BACKUP_EXPECTED_DB', 'RISK_BACKUP_IMAGE', 'RISK_BACKUP_RCLONE_CONTIMEOUT', 'RISK_BACKUP_RCLONE_LOW_LEVEL_RETRIES', 'RISK_BACKUP_RCLONE_RETRIES', 'RISK_BACKUP_RCLONE_TIMEOUT', 'RISK_BACKUP_S3_BUCKET', 'RISK_BACKUP_S3_PREFIX', 'RISK_BACKUP_SECRETS_DIR'].sort(),
    );
    // U5: os 4 valores rclone de produção são decisão do deploy; o exemplo não pode trazer número inventado.
    const example = read('deploy/backup/backup.env.example');
    for (const k of ['CONTIMEOUT', 'TIMEOUT', 'RETRIES', 'LOW_LEVEL_RETRIES']) expect(example).toMatch(new RegExp(`^RISK_BACKUP_RCLONE_${k}=<a definir>$`, 'm'));
    expect(read('deploy/backup/rclone.conf.example')).toMatch(/^\[risk-backup\]$/m);
  });
});

describe('ADR-0012: SQL de provisionamento', () => {
  it('backup-grants.sql concede só USAGE no schema e SELECT em tabelas/sequências à role de backup', () => {
    const sql = code(read('scripts/provision/backup-grants.sql'), '--');
    const grants = sql.split(';').map((s) => s.trim().replace(/\s+/g, ' ')).filter((s) => /^GRANT\b/i.test(s));
    expect(grants.sort()).toEqual(
      [
        'GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO openclaw_risk_backup',
        'GRANT SELECT ON ALL TABLES IN SCHEMA public TO openclaw_risk_backup',
        'GRANT USAGE ON SCHEMA public TO openclaw_risk_backup',
      ].sort(),
    );
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|REFERENCES|TRIGGER|ALL PRIVILEGES|CREATE|DROP|ALTER|REVOKE|GRANT OPTION|SUPERUSER|LOGIN|PASSWORD)\b/i);
    expect(sql).not.toMatch(/openclaw_risk_(owner|runtime)/);
    expect(sql).toMatch(/IF NOT EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'openclaw_risk_backup'\)[\s\S]*RAISE EXCEPTION/);
  });

  it('roles.sql cria openclaw_risk_backup NOLOGIN sem privilégios elevados, sem senha, com CONNECT, idempotente', () => {
    const sql = code(read('scripts/provision/roles.sql'), '--');
    const m = /IF NOT EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'openclaw_risk_backup'\) THEN\s+(CREATE ROLE openclaw_risk_backup [^;]*);/.exec(sql);
    expect(m).not.toBeNull();
    const stmt = m?.[1] ?? '';
    expect(stmt).toMatch(/\bNOLOGIN\b/);
    for (const k of ['NOSUPERUSER', 'NOCREATEDB', 'NOCREATEROLE', 'NOREPLICATION']) expect(stmt).toContain(k);
    expect(stmt).not.toMatch(/PASSWORD|\bLOGIN\b(?<!NOLOGIN)|\bIN ROLE\b|BYPASSRLS/);
    expect(sql).toMatch(/GRANT CONNECT ON DATABASE :"dbname" TO [^;]*openclaw_risk_backup/);
    expect(sql).not.toMatch(/PASSWORD\s+'/i);
    // Nenhum privilégio de escrita é concedido à role de backup aqui nem por membership.
    expect(sql).not.toMatch(/GRANT\s+openclaw_risk_(owner|runtime)\s+TO\s+openclaw_risk_backup/i);
    expect(sql).not.toMatch(/GRANT\s+openclaw_risk_backup\s+TO/i);
  });
});
