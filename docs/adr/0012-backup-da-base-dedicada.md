# ADR-0012 — Backup da base dedicada

- **Status:** Aceito — decidido pelo usuário (wrpaiva@gmail.com) em 2026-11-15
- **Data:** 2026-11-15
- **Projeto:** OpenClaw Trading Risk Engine
- **Relacionada à SPEC:** seções 7.3, 12 (D-10)
- **Decisores:** usuário responsável pelo projeto

## Contexto

A D-10 (SPEC §12) cobre a estratégia de implantação e de backup da base dedicada. A parte de rede e transporte foi decidida no ADR-0011. Esta ADR decide o backup.

A base `openclaw_risk` fica na instância PostgreSQL 14 compartilhada (ADR-0008). Ela guarda decisões, reservas e auditoria. Até a etapa 2.5 existem só scripts locais de backup e restauração, restritos a bancos `*_test`, e o procedimento pós-restauração aprovado em 2026-11-14 (serviço indisponível com `restore_pending` até `reconcile-after-restore`, que expira as reservas `ACTIVE`).

## Decisão

Decidida pelo usuário em 2026-11-15:

| Item | Decisão |
|---|---|
| Ferramenta | `pg_dump` dedicado, só da base `openclaw_risk`, formato custom (`-Fc`), com credencial própria de backup somente leitura |
| Agendamento | `cron` do host da VPS disparando um contêiner descartável `postgres:14` (`docker run --rm`); nada fica rodando entre execuções |
| Frequência | Diária (RPO de até ~24 h) |
| Cifragem | `age`, com a **chave pública** na VPS e a **chave privada fora da VPS**, sob custódia do usuário. O dump é cifrado antes de ser gravado em disco ou enviado |
| Destino | Cópia cifrada na VPS **e** cópia cifrada em bucket S3-compatível externo |
| Retenção | 7 dias |
| Restauração em produção | Só com aprovação do usuário. Segue o procedimento pós-restauração vigente |
| Teste de recuperação | Mensal: restaurar o último dump num banco `*_test` descartável e rodar `migrate` se preciso, `reconcile-after-restore`, `verify-runtime-privileges` e conferir `ready` |

A definir no deploy (não fixados aqui):
- provedor, bucket e região do S3-compatível; a credencial de envio deve ser só de escrita, sem listar nem apagar quando o provedor permitir;
- horário do cron;
- como a retenção de 7 dias é aplicada no bucket (regra de ciclo de vida do provedor ou remoção pelo job);
- diretório na VPS (proposto: dentro de `/opt/openclaw-risk-engine`, com permissão restrita);
- destino e forma do alerta de falha do backup e do teste mensal;
- RTO.

## Alternativas consideradas

| Opção | Por que não |
|---|---|
| Backup existente da instância compartilhada | Não se sabe se existe; restaurar só esta base fica difícil e depende de quem opera a instância |
| PITR (WAL/pgBackRest) | Opera na instância inteira; exige mexer na configuração do PostgreSQL compartilhado de produção |
| Cópia só na VPS | Não sobrevive à perda da VPS |
| Cifragem com senha simétrica em secret | Quem compromete a VPS também lê os backups |
| `systemd timer` ou serviço Swarm agendado | Equivalentes ou mais complexos; o `cron` com contêiner descartável é o mais simples e visível |

## Justificativa e consequências

- O `pg_dump` dedicado isola esta base das demais da instância e reaproveita o procedimento de restauração já testado na regressão final (`item-09`).
- Com a chave privada fora da VPS, um invasor da VPS não lê backups antigos. Em contrapartida, **perder a chave privada torna todos os backups irrecuperáveis**, e a restauração depende do usuário fornecê-la.
- RPO diário: numa restauração, decisões, reservas e consumos de até ~24 h se perdem. O risco residual de ordem duplicada descrito em `docs/operacao/backup-restauracao.md` (I-04) continua valendo, e a deduplicação no executor (D-09) segue necessária.
- O job de backup é código novo (script de produção, credencial de backup, documentação). Ele não existe ainda e será implementado em tarefa separada, com aprovação.

## Restrições, riscos e mitigação

- **Credencial de backup:** login próprio, somente leitura na base `openclaw_risk`, via arquivo de secret com permissão restrita; nunca em argumento nem em log. Criá-la em produção exige aprovação.
- **Dump em claro:** proibido em disco. O `pg_dump` é encadeado direto no `age`; arquivos temporários não cifrados não são criados.
- **Falha silenciosa:** o job deve sair com código diferente de zero em qualquer falha (pipefail) e não deixar arquivo parcial com nome final. O alerta fica a definir no deploy.
- **Carga na instância compartilhada:** horário fora de pico, a definir no deploy.
- **Retenção no bucket:** se a credencial for só de escrita, a remoção deve ser feita por regra de ciclo de vida do provedor.

## Critérios de validação

- Teste automatizado do script de backup contra banco `*_test`: gera arquivo cifrado com `age`, nunca grava dump em claro, falha com código diferente de zero se o `pg_dump` ou o `age` falharem, recusa sobrescrever e recusa alvo que não seja o esperado.
- Ensaio de restauração a partir do arquivo cifrado em banco `*_test` novo, seguido de `reconcile-after-restore` e `ready`.
- No deploy: primeiro backup real conferido e primeiro teste de recuperação executado antes do aceite (SPEC §7.3).

## Relação com a especificação

Resolve a parte de backup da D-10 (SPEC §12). Junto com o ADR-0011, encerra a D-10, restando os itens marcados "a definir no deploy".

## Revisão da decisão

Revisar se o volume de dados ou a criticidade exigirem RPO menor (PITR), se a instância PostgreSQL deixar de ser compartilhada ou se o destino externo mudar.
