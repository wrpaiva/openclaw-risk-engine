# Backup e restauração

> Estratégia de backup de **produção decidida no ADR-0012** (2026-11-15): `pg_dump` dedicado diário via `cron` + contêiner descartável, cifrado com `age` (chave privada fora da VPS), cópia na VPS e em bucket S3-compatível, retenção de 7 dias, restauração só com aprovação do usuário e teste de recuperação mensal. O job de produção está **implementado e testado só em banco `*_test` descartável** (`npm run test:backup`); **nada foi executado em produção** (role, secret, diretório, bucket e cron dependem de aprovação no deploy). Backup/restauração e teste de recuperação precisam constar do aceite de implantação (SPEC §7.3).

## Scripts locais (somente bancos `*_test`)

Existem para provar o procedimento em ambiente descartável. Ambos recusam host não local e banco cujo nome não termine em `_test`; executam `pg_dump`/`pg_restore` 14 dentro de um contêiner `postgres:14-alpine` descartável (labels `com.openclaw-risk-engine.test=1` e uma label própria por execução, `backup-run=<pid>`/`restore-run=<pid>`; o trap remove só o contêiner da própria execução) e recebem a URL por variável de ambiente (nunca em argumento nem impressa).

```bash
# backup (formato custom, --no-owner); recusa sobrescrever arquivo existente
RISK_BACKUP_URL=postgres://user:senha@127.0.0.1:PORTA/<banco>_test sh scripts/backup-local.sh /caminho/arquivo.dump

# restauração em banco NOVO e VAZIO (sem tabelas em public); recusa restaurar sobre dados
RISK_RESTORE_URL=postgres://admin:senha@127.0.0.1:PORTA/<novo>_test sh scripts/restore-local.sh /caminho/arquivo.dump
```

Estes scripts **não** servem para produção: o alvo `*_test` e o host local são travas deliberadas.

O `restore-local.sh` executa, nesta ordem (o `admin` da URL deve ser superusuário do alvo):

0. valida a URL (recusa `?`, `host=`, `hostaddr=`, `dbname=`, `service=` e percent-encoding) e a **conexão efetiva** (`current_database()` terminando em `_test`, servidor em endereço local/privado) antes de qualquer escrita; `backup-local.sh` e `provision-db.sh` fazem as mesmas duas checagens;
1. `scripts/provision/roles.sql` (idempotente) **antes** do `pg_restore`: o dump traz `GRANT` para `openclaw_risk_runtime`, que precisa existir; em seguida **revoga o `CONNECT` do runtime** até o fim;
2. `pg_restore --no-owner --role=openclaw_risk_owner`: os objetos nascem com o dono correto (o dump é feito com `--no-owner`);
3. **imediatamente** `scripts/provision/mark-restore-pending.sql`: marca `restore_pending=true` (e audita `RESTORE_PENDING_MARKED`). Se o dump for anterior à migração `0004` (sem a tabela de estado), o script falha com instrução e o `CONNECT` segue revogado: rode `migrate` e depois `mark-restore-pending` (CLI) antes de subir a app;
4. `scripts/provision/post-restore.sql`: corrige e **verifica** que todo objeto de `public` pertence a `openclaw_risk_owner` (aborta se sobrar outro dono); assim migrações futuras com a conta de migração funcionam;
5. `roles.sql` de novo (reconcede o `CONNECT` ao runtime; a app permanece not-ready por `restore_pending`).

O login de runtime (membro de `openclaw_risk_runtime`) é criado à parte pelo operador; os `GRANT`s do dump valem para o grupo.

## Produção (ADR-0012)

Decisões em [ADR-0012](../adr/0012-backup-da-base-dedicada.md); implementação: `scripts/backup-prod.sh` (host, disparado pelo `cron`) + `scripts/backup/backup-job.sh` (dentro da imagem `openclaw-risk-backup`). **Não executar em produção sem aprovação do usuário.** A instância PostgreSQL é compartilhada (ADR-0008); a revisão de capacidade e backup faz parte do aceite.

### Componentes

| Peça | Papel |
|---|---|
| `Dockerfile.backup` / `npm run image:build:backup` | Imagem local `openclaw-risk-backup:<versão>`: base `postgres:14-bookworm` por digest + `age` e `rclone` do apt Debian com versão fixada (ver cabeçalho do Dockerfile). Sem credenciais, sem portas. Reconstrução periódica: cadência a definir (U16) |
| `scripts/provision/roles.sql` | Cria a role de grupo `openclaw_risk_backup` (NOLOGIN) com `CONNECT`. Idempotente |
| `scripts/provision/backup-grants.sql` | `USAGE` em `public` e `SELECT` em tabelas e sequências para `openclaw_risk_backup`. **Reaplicar após cada `migrate`** (tabela nova não herda privilégio). Recusa se a role não existe |
| `scripts/backup-prod.sh <backup.env>` | Valida a configuração, toma `flock`, roda o contêiner descartável (`--read-only`, `--cap-drop ALL`, `no-new-privileges`, `--user` do host, sem `tmpfs`) |
| `scripts/backup/backup-job.sh` | Trava de alvo e privilégios, `pg_dump -Fc \| age`, publicação sem sobrescrever, retenção local, upload |
| `scripts/restore-encrypted-local.sh` | Ensaio de restauração a partir do `.age`, só em `*_test` |

### Credencial de backup (a criar no deploy, com aprovação)

Role de grupo `openclaw_risk_backup` (via `roles.sql` + `backup-grants.sql`) e um **login próprio** membro só dela, **nunca** de `openclaw_risk_owner`/`openclaw_risk_runtime`. Snippet (nome do login, `pg_hba`, `CONNECTION LIMIT`: a definir, U12; a senha é gerada no deploy e vai só no `pgpass`):

```sql
CREATE ROLE <login de backup> LOGIN INHERIT PASSWORD '<gerada no deploy>' IN ROLE openclaw_risk_backup;
ALTER ROLE <login de backup> SET default_transaction_read_only = on;  -- recomendado
```

O job recusa (exit 2, **antes de gravar qualquer coisa**) se: `current_database()` diferir de `RISK_BACKUP_EXPECTED_DB`; o login tiver `SUPERUSER`, `CREATEROLE`, `CREATEDB`, `REPLICATION` ou `BYPASSRLS`; for membro de **qualquer** role além de `openclaw_risk_backup` (allowlist; `pg_has_role MEMBER` ignora `INHERIT`, então `NOINHERIT` + `SET ROLE` também é pego); ou tiver, em qualquer schema não-sistema, `INSERT/UPDATE/DELETE/TRUNCATE` em tabela/view, `INSERT/UPDATE` em coluna, `UPDATE` ou `USAGE` em sequência (`SELECT` em sequência segue aceito), `CREATE` em schema ou `CREATE` no banco; ou for dono do banco, de schema ou de objeto (relação, sequência, função, procedimento ou tipo). `TEMP` não é recusado (não persiste dados; `roles.sql` o revoga de PUBLIC).

### Arquivos de secret (0400 em diretório 0700; nunca em argv, env ou log)

`pgpass` (uma linha `host:porta:banco:login:senha`; host/porta/login vêm daqui), `age_recipients` (só chaves públicas `age1...`) e `rclone.conf` (remote `risk-backup`). Exemplos com "a definir": `deploy/backup/`. O diretório e os arquivos precisam ser do uid que roda o cron.

### Fluxo do job

1. Valida configuração e secrets; confere o alvo e os privilégios (psql). Falha = exit 2, nada gravado.
2. `pg_dump --format=custom --no-owner` encadeado direto em `age -R age_recipients -o <parcial>`: o dump em claro **nunca** toca o disco. Exige `PIPESTATUS` zerado, tamanho > 0 e cabeçalho `age-encryption.org/v1`.
3. Gera `.sha256` e publica **sem sobrescrever** (`ln`): primeiro o `.sha256`, por último o `.age` (o `.age` final sinaliza backup completo). Nome: `<banco>-<YYYYMMDDTHHMMSSZ>.dump.age`. Nome já existente: recusa (exit 4).
4. Retenção local (constante de 7 dias do ADR, não configurável): remove par `.age` + `.sha256` com timestamp do **nome** anterior a agora - 7x24 h; só depois de sucesso local, mesmo se o upload falhar; nunca o arquivo recém-criado; só em `/out`; `.partial` órfãos só geram aviso (`partial_orphans_found`).
5. Upload do `.age` e do `.sha256` com `rclone copyto --ignore-existing --no-traverse --s3-no-check-bucket` (não cria bucket, não apaga), precedido por um HEAD do objeto exato (`rclone copyto --dry-run --ignore-existing --no-traverse --error-on-no-transfer`, decidido só pelo código de saída: 0 não existe, 9 existe; sem listar o prefixo, que exigiria ListBucket): se o objeto já existe o job **não envia**, loga `upload_target_exists` e sai com 5 (cópia local mantida); erro no HEAD também sai com 5 (fail-closed). `--immutable` não impede sobrescrita no rclone 1.60.1, por isso não é a barreira. O envio real também usa `--error-on-no-transfer` (rc 9 = objeto surgiu entre o HEAD e o PUT, vira `upload_target_exists`), mas a janela HEAD→PUT é irredutível no 1.60.1 (sem PUT condicional): a imutabilidade real vem de versionamento/Object Lock no bucket (U4/U15). **A credencial precisa de HEAD/GetObject ANTES do envio**; na AWS S3 um HEAD de chave inexistente sem `s3:ListBucket` devolve 403 e o job sairia sempre 5 (`upload_head_failed`): confirmar no provedor (U4). Todas as chamadas levam `--contimeout --timeout --retries --low-level-retries` das variáveis obrigatórias `RISK_BACKUP_RCLONE_*` (sem default; valores de produção: U5). Verificação do tamanho remoto ao final. **O job nunca apaga no bucket**: a retenção lá é regra de ciclo de vida do provedor (U15; a definir).

### Códigos de saída

| Código | Significado |
|---|---|
| 0 | Backup local e upload verificados |
| 2 | Configuração ou trava recusada antes de gravar |
| 3 | Outra execução em andamento (`flock`) |
| 4 | Falha de dump/cifragem/publicação local, nome existente, ou falha do docker; sem arquivo final |
| 5 | Cópia local OK; upload ou verificação falhou |
| 6 | Backup OK; falha na retenção local |

Qualquer código diferente de 0 é falha e deve alertar (destino a definir, U6).

### Ensaio de restauração e teste mensal (na estação do operador; a chave privada nunca fica na VPS)

```bash
# 1. traga o .age e o .sha256 da VPS ou do bucket para a estação; crie um banco *_test NOVO e VAZIO em um Postgres 14 descartável
# 2. restaure (confere o .sha256 antes de decifrar; o dump em claro só existe no pipe)
RISK_RESTORE_URL=postgres://admin:senha@127.0.0.1:PORTA/<novo>_test \
RISK_RESTORE_AGE_IDENTITY_FILE=/caminho/identidade.txt \
  bash scripts/restore-encrypted-local.sh /caminho/<banco>-<UTC>.dump.age
# 3. migrate (se preciso) -> reconcile-after-restore -> verify-runtime-privileges -> /health/ready = 200 (procedimento abaixo)
```

A identidade precisa ser 0400/0600 do uid atual e **nunca** é copiada. `restore-local.sh` também aceita `-` (dump em claro pela entrada padrão) e é o que o script cifrado usa. Chave errada ou arquivo adulterado: recusa **antes** de provisionar/alterar o banco de destino.

### Perda da chave privada

**Perder a chave privada torna todos os backups irrecuperáveis.** Custódia, recipients múltiplos (cópia da chave) e rotação: a definir pelo usuário (U9). Chave comprometida: gere novo par, troque o `age_recipients` e trate os backups antigos como legíveis por quem a obteve.

### A definir no deploy

Provedor/bucket/região/prefixo e permissões (U4); rede até o Postgres e `sslmode` (U3); horário/fuso e timeouts (U5); destino do alerta (U6); RTO (U7); diretório, uid e monitoramento de disco (U8); custódia das chaves (U9); login, `pg_hba`, `CONNECTION LIMIT` (U12); cadência de reconstrução da imagem (U16).

## Procedimento pós-restauração (decisão do usuário, 2026-11-14)

Regra: **após restaurar um backup, o serviço fica indisponível (not-ready) até reconciliar; as reservas `ACTIVE` anteriores ao ponto de restauração são expiradas antes de o serviço voltar.**

Motivo: o dump reflete um instante passado. Uma reserva que estava `ACTIVE` no dump pode ter sido consumida, liberada ou expirada depois dele, e esse estado foi perdido. Se o serviço voltasse sem reconciliar, uma autorização já usada poderia reaparecer como `ACTIVE` e ser consumida de novo (rompendo a regra de uma ordem por autorização), ou capacidade já liberada seguiria ocupada de forma incorreta.

### Mecanismo

- A tabela de linha única `risk_operational_state` (migração `0004`) guarda `restore_pending`, `restore_marked_at` e `restore_cleared_at`; cada mudança fica em `risk_operational_state_history` (append-only). O runtime só tem `SELECT`.
- Com `restore_pending=true`: `/health/ready` devolve 503 com `reconciliation: fail`, **e** evaluate, consume e release devolvem `UNAVAILABLE` (503), porque a flag é lida dentro da transação, sob o lock da conta. Tráfego direto não contorna a readiness. A leitura ausente ou com falha também é fail-closed.
- `expire-reservations` (varredura de vencidas) **não** substitui a reconciliação. Com a flag ativa ele **falha de forma determinística (exit 1)**, mesmo sem reservas vencidas: a checagem de `restore_pending` é a primeira coisa da varredura, antes de qualquer lock de conta.

### Passos

1. **Pare a app** (nenhuma réplica) e restaure o dump em banco vazio com as roles provisionadas: `scripts/restore-local.sh` em `*_test`; em produção, o equivalente aprovado (D-10): `roles.sql`, `pg_restore --role=openclaw_risk_owner`, `post-restore.sql`, marcação.
2. **Garanta `restore_pending=true`.** O `restore-local.sh` já marca. Em outro caminho, ou se o dump for anterior à `0004`: `migrate` (credencial de migração) e depois `mark-restore-pending`. É seguro repetir.
3. **Mantenha a app parada.** Só se for imprescindível observar o estado, suba **uma** instância isolada (sem tráfego do cliente) e confirme: `GET /health/ready` = 503 com `reconciliation: fail` (e `database`/`schema`/`privileges` `ok`); evaluate/consume/release devolvem 503. Pare-a antes de reconciliar.
4. **Reconcilie**, com a credencial de migração: `node dist/interfaces/cli/main.js reconcile-after-restore`. Em uma transação: expira **todas** as reservas `ACTIVE`, audita cada uma (`RESERVATION_EXPIRED`, `details.trigger='post-restore-reconciliation'`), limpa `restore_pending` e grava `RESTORE_RECONCILED` (com a contagem). Exit 0 e `reconciliação concluída; reservas expiradas: <n>`. Registre `<n>` no relatório do incidente. Idempotente: repetir devolve "nada a reconciliar".
5. **Verifique privilégios**: `verify-runtime-privileges` com o login de runtime (exit 0).
6. **Confirme `ready`**: `GET /health/ready` = 200 com todos os checks `ok`. Comunique o incidente ao usuário: decisões, reservas e consumos posteriores ao ponto de restauração foram perdidos. **Não** oriente os clientes a usar chaves de idempotência novas por padrão: isso só é aceitável depois de **confirmar, por fonte externa (o executor), que a ordem correspondente não foi executada** (ver "Risco residual" abaixo).

### Risco residual: decisões e consumos posteriores ao backup (I-04)

A reconciliação expira as reservas `ACTIVE` do dump, mas **não recupera** o que aconteceu depois do backup: decisões `ALLOW_PAPER`, reservas e **consumos** (`CONSUMED`) posteriores ao ponto de restauração desaparecem do banco, e o executor pode já ter recebido a ordem. Consequências:

- Uma proposta cuja decisão se perdeu, **reenviada com a mesma chave de idempotência**, é avaliada de novo e pode gerar um **novo `ALLOW_PAPER`** (nova reserva, novo `reservationId`) para algo que já foi autorizado e talvez executado. O banco restaurado não tem como saber.
- Um consumo perdido pode ser repetido contra uma nova reserva da mesma proposta.
- **A deduplicação precisa existir também no executor** (D-09, decisão pendente do usuário): o executor deve recusar uma segunda ordem para a mesma proposta/ordem lógica independentemente do estado deste banco. Sem isso, a restauração de backup mantém um risco de ordem duplicada em paper que este componente sozinho não elimina.
- Antes de reenviar qualquer proposta após a restauração, **confirme no executor** (e nos logs) se a ordem foi executada. Só então, e por decisão do usuário, defina se o cliente reavalia com a mesma chave (replay vira nova avaliação) ou com uma chave nova.

### Observações

- O critério "anteriores ao ponto de restauração" é aplicado como "todas as `ACTIVE` no banco restaurado", porque todas são, por definição, anteriores ao ponto. Reservas criadas **depois** da reconciliação não são tocadas por uma nova execução (a flag já está limpa).
- A reconciliação toma o lock por conta de todas as contas antes de expirar, para esperar transações em voo; mesmo assim, mantenha a app parada até concluir.
- Não limpe `restore_pending` por SQL manual: perde-se a expiração e a auditoria.
- **Restauração interrompida (`restore-local.sh` falhou ou foi cancelado):** o `CONNECT` do runtime fica **revogado** durante toda a restauração (o script o reconcede só no último passo) e `restore_pending` é marcado logo após o `pg_restore`. Se a interrupção ocorreu **depois do `pg_restore` e antes dessa marcação**, o banco pode estar restaurado **sem** a flag. Não suba a app: marque **manualmente** (`mark-restore-pending`, com a credencial de migração e os três `RISK_DB_*_TIMEOUT_MS`; se o dump for anterior à `0004`, rode `migrate` antes), conclua `post-restore.sql` e `roles.sql` à mão, ou descarte o banco e refaça. Em dúvida, trate como "marcação pendente".

## Teste de recuperação

O procedimento acima (backup, restauração em banco `*_test` novo, `migrate` se necessário, `verify-runtime-privileges`, reconciliação, `ready`) deve ser ensaiado em ambiente descartável antes do aceite. Os testes automatizados cobrem a restauração (`tests/e2e/regression/item-09`) e a migração `0004`/CLI.
