import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Verificação estática (sem Docker) dos invariantes de scripts/ e Dockerfile da etapa 2.5. O comportamento em execução é
// coberto por tests/e2e e tests/integration/ScriptGuards.test.ts.
const ROOT = join(import.meta.dirname, '../../..');
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');
const code = (text: string): string =>
  text
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n');

describe('scripts/test-e2e.sh', () => {
  const script = code(read('scripts/test-e2e.sh'));

  it('contêineres de migração e de aplicação rodam com o uid:gid do host (--user), nunca root implícito', () => {
    expect(script).toMatch(/RUN_USER="\$\(id -u\):\$\(id -g\)"/);
    const runs = script.split(/\n(?=docker run )/).filter((b) => b.startsWith('docker run') && /(--entrypoint node|"\$IMAGE")/.test(b));
    expect(runs.length).toBeGreaterThanOrEqual(2);
    for (const r of runs.filter((b) => b.includes('$IMAGE'))) expect(r).toContain('--user "$RUN_USER"');
  });

  it('segredos 0400 em diretório 0700, montados somente leitura', () => {
    expect(script).toContain('chmod 0700 "$SECRETS"');
    expect(script).toContain('chmod 0400 "$SECRETS"/*');
    expect(script).toMatch(/umask 077/);
    expect(script).toContain('-v "$SECRETS:/run/secrets:ro"');
    const modes = [...script.matchAll(/chmod\s+(\S+)/g)].map((m) => m[1]);
    expect(modes.sort()).toEqual(['0400', '0700']);
  });

  it('label por ciclo com o pid do script, exportada em RISK_E2E_LABEL; o teardown remove só por ela', () => {
    expect(script).toContain('LABEL_KV="com.openclaw-risk-engine.e2e-run=$$"');
    expect(script).toContain('RISK_E2E_LABEL="$LABEL_KV"');
    const cleanup = /cleanup\(\) \{[\s\S]*?\n\}/.exec(script)?.[0] ?? '';
    expect(cleanup).toContain('--filter "label=$LABEL_KV"');
    expect(cleanup).not.toContain('GENERIC_LABEL');
    expect(cleanup).not.toMatch(/prune|system|volume rm|image rm/);
    // `docker network rm` só é aceito sobre redes listadas pela label do ciclo e depois do `docker rm -f` dos contêineres.
    const netRm = cleanup.indexOf('docker network rm');
    if (netRm !== -1) {
      expect(cleanup).toMatch(/docker network ls -q --filter "label=\$LABEL_KV"/);
      expect(cleanup.indexOf('docker network ls')).toBeLessThanOrEqual(netRm);
      expect(cleanup.indexOf('docker rm -f')).toBeGreaterThan(-1);
      expect(cleanup.indexOf('docker rm -f')).toBeLessThan(netRm);
      expect(cleanup.match(/docker network rm/g)?.length).toBe(1);
    }
  });

  it('se o script criar rede: duas labels, --internal e checagem de pré-existência por nome', () => {
    const creates = script.match(/docker network create[^\n]*(\\\n[^\n]*)*/g) ?? [];
    for (const c of creates) {
      expect(c).toContain('--internal');
      expect(c).toContain('--label "$LABEL_KV"');
      expect(c).toContain('--label "$GENERIC_LABEL"');
      const before = script.slice(0, script.indexOf(c));
      expect(before).toMatch(/docker network (inspect\b[^\n]*|ls\b[^\n]*name[^\n]*)/);
    }
    expect(script).not.toMatch(/docker network (prune|disconnect)/);
    // `connect` só sobre a rede criada pelo próprio script (variável) e um contêiner do ciclo (variável do banco/app).
    for (const m of script.matchAll(/docker network connect([^\n]*)/g)) {
      expect(creates.length, 'connect exige que o script crie a rede').toBeGreaterThan(0);
      const args = (m[1] ?? '').trim();
      expect(args, args).toMatch(/^(--alias\s+\S+\s+)?"\$\{?(NET|NET_NAME|NETWORK|NETWORK_NAME)\}?"\s+"\$\{?(DB_NAME|APP_NAME)\}?"\s*(>\/dev\/null.*)?$/);
    }
  });

  it('nunca usa prune, nem nomes de contêineres alheios, e roda os testes sem paralelismo de arquivos', () => {
    expect(script).not.toMatch(/\bprune\b/);
    expect(script).not.toMatch(/aegis/i);
    expect(script).toContain('--no-file-parallelism');
  });

  it('banco do ciclo é *_test, só em 127.0.0.1, em tmpfs, e a app usa --read-only --cap-drop ALL no-new-privileges', () => {
    expect(script).toContain('DB=openclaw_risk_e2e_test');
    expect(script).toContain('-p "127.0.0.1:${DB_PORT}:5432"');
    expect(script).toContain('--tmpfs /var/lib/postgresql/data');
    expect(script.match(/--read-only/g)?.length).toBeGreaterThanOrEqual(2);
    expect(script.match(/--cap-drop ALL/g)?.length).toBeGreaterThanOrEqual(2);
    expect(script.match(/no-new-privileges/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('passa os três prazos de banco à migração e à aplicação', () => {
    for (const name of ['RISK_DB_CONNECTION_TIMEOUT_MS', 'RISK_DB_STATEMENT_TIMEOUT_MS', 'RISK_DB_LOCK_TIMEOUT_MS']) {
      expect(script.match(new RegExp(`-e ${name}=[0-9]+`, 'g'))?.length, name).toBe(2);
    }
  });
});

describe('Dockerfile (estágio de runtime)', () => {
  const docker = read('Dockerfile');
  const runtime = docker.slice(docker.indexOf('AS runtime'));
  const instructions = code(runtime);

  it('ENTRYPOINT, HEALTHCHECK e CMD usam só node (sem npm, npx, corepack ou yarn)', () => {
    for (const line of instructions.split('\n').filter((l) => /^(ENTRYPOINT|HEALTHCHECK|CMD)\b/.test(l))) {
      expect(line, line).not.toMatch(/\b(npm|npx|corepack|yarn|yarnpkg)\b/);
      expect(line).toContain('node');
    }
  });

  it('remove npm, npx, corepack e yarn (diretórios e links) antes do USER final', () => {
    const rm = /RUN rm -rf[\s\S]*?(?=\n[A-Z#])/.exec(instructions)?.[0] ?? '';
    for (const target of ['/usr/local/lib/node_modules/npm', '/usr/local/lib/node_modules/corepack', '/usr/local/bin/npm', '/usr/local/bin/npx', '/usr/local/bin/corepack', '/usr/local/bin/yarn', '/usr/local/bin/yarnpkg']) {
      expect(rm, target).toContain(target);
    }
    expect(rm).toMatch(/\/opt\/yarn-v/);
    expect(instructions.indexOf('RUN rm -rf')).toBeLessThan(instructions.indexOf('USER 1000:1000'));
  });

  it('o runtime não executa npm/npx depois da remoção e termina em USER numérico não-root 1000:1000', () => {
    const afterRemoval = instructions.slice(instructions.indexOf('RUN rm -rf') + 10);
    expect(afterRemoval).not.toMatch(/\bRUN\b[^\n]*\b(npm|npx|corepack|yarn)\b/);
    expect(instructions).toMatch(/^USER 1000:1000$/m);
    expect(instructions.trim().split('\n').filter((l) => l.startsWith('USER')).at(-1)).toBe('USER 1000:1000');
  });

  it('não embute credenciais nem portas (ARG/ENV/EXPOSE)', () => {
    expect(instructions).not.toMatch(/^EXPOSE\b/m);
    expect(instructions).not.toMatch(/^(ENV|ARG)\s+\S*(KEY|SECRET|PASSWORD|TOKEN|DATABASE_URL)/im);
  });
});

describe('scripts/lib/guard-url.sh e scripts que o usam', () => {
  const lib = read('scripts/lib/guard-url.sh');

  it.each(['scripts/backup-local.sh', 'scripts/restore-local.sh', 'scripts/provision-db.sh'])('%s carrega a trava, valida a sintaxe e a conexão efetiva antes de escrever', (file) => {
    const text = code(read(file));
    expect(text).toContain('guard-url.sh');
    expect(text).toMatch(/guard_url_syntax/);
    expect(text).toMatch(/effective_conn_check/);
    expect(text.indexOf('guard_url_syntax')).toBeLessThan(text.search(/\b(docker run|psql "\$RISK_PROVISION_URL" -v)/));
  });

  it('a trava recusa ?, host=, hostaddr=, dbname=, service= e %', () => {
    for (const token of ['*\\?*', '*host=*', '*hostaddr=*', '*dbname=*', '*service=*', '*%*']) expect(lib).toContain(token);
  });

  it('restore-local.sh: revoga CONNECT do runtime, restaura, marca restore_pending IMEDIATAMENTE e só então roda post-restore e roles.sql', () => {
    const text = code(read('scripts/restore-local.sh'));
    const at = (needle: string): number => {
      const i = text.indexOf(needle);
      expect(i, needle).toBeGreaterThan(-1);
      return i;
    };
    const revoke = at('REVOKE CONNECT ON DATABASE');
    const restore = at('pg_restore --exit-on-error');
    const mark = at('-f /prov/mark-restore-pending.sql');
    const post = at('-f /prov/post-restore.sql');
    const lastRoles = text.lastIndexOf('-f /prov/roles.sql');
    expect(revoke).toBeLessThan(restore);
    expect(restore).toBeLessThan(mark);
    expect(mark).toBeLessThan(post);
    expect(post).toBeLessThan(lastRoles);
    // Nada entre o pg_restore e a marcação (o comentário é removido por code()).
    const between = text.slice(restore, mark).split('\n').filter((l) => l.trim() !== '');
    expect(between.length).toBe(2); // a linha do pg_restore e o prefixo do próprio psql da marcação
    expect(between[1]).toMatch(/^\s*psql "\$RISK_RESTORE_URL" .*ON_ERROR_STOP=1 $/);
  });
});
