# Rollback

> Nada foi implantado; este é o procedimento planejado. Executar em produção requer aprovação do usuário.

## Princípios

- **Imagem:** o rollback da aplicação é voltar para a **tag anterior** da imagem (`openclaw-risk-engine:<versão-anterior>`, mantida localmente ou restaurada de um `docker save`). A imagem é local; não há registry. Mantenha a tag anterior disponível antes de implantar a nova.
- **Migrações são forward-only.** Não existe migração "down". Uma migração aplicada é imutável (o runner recusa checksum alterado). Mudança de schema = nova migração `NNNN_*.sql`.
- **Expand/contract.** Para que a imagem N-1 funcione com o schema N: primeiro uma migração *expand* (só adiciona: colunas anuláveis, tabelas, índices), depois o código que usa o novo schema, e só numa versão posterior uma migração *contract* (remove o que nenhuma imagem em uso precisa mais). Nunca combine remoção com a versão que deixa de usar o objeto.
- **Regra de grants no expand (N-1).** O inspetor de privilégios da imagem N-1 é fixo: ele conhece só os grants das migrações que ele embala. Uma migração *expand* que **amplie os grants do runtime** (novo `INSERT`/`UPDATE`/`SELECT` fora do que a N-1 conhece, nova tabela com grant ao runtime) faz a imagem N-1 ver "privilégio acima do mínimo": o boot sai com exit 1 e a readiness fica `privileges: fail`. Logo, **se o rollback para N-1 precisa funcionar, o expand não pode ampliar grants do runtime**; migrações que ampliam grants só são reversíveis para uma imagem que já conheça o novo conjunto (ou exigem decisão do usuário, ver abaixo). Revogar o grant novo por SQL manual como "atalho" de rollback é proibido (ver "O que não fazer").
- **Readiness aceita migração extra (N-1).** `/health/ready` exige que cada migração **da imagem** esteja aplicada com o mesmo checksum, mas **aceita** migrações aplicadas que a imagem não conhece. Logo, a imagem anterior fica `ready` sobre um schema mais novo. O contrário (imagem nova sobre schema sem a migração) fica `schema: fail`.

## Procedimento

1. Confirme com o usuário que o rollback é necessário e anote a causa (logs `http.request` por status, `db.client_error`, ver `alarmes.md`).
2. Se a nova imagem **ainda não migrou** o banco: basta voltar a tag. Nada mais.
3. Se a nova imagem **já migrou**: volte a tag anterior. Isso só é seguro se as migrações aplicadas foram *expand*. Se a migração mudou semântica de forma incompatível, **não** reverta com SQL manual improvisado: escale ao usuário. Opções (decisão do usuário): corrigir para frente com uma nova migração, ou restaurar backup (ver `backup-restauracao.md`, que exige reconciliação de reservas).
4. Suba a tag anterior com os mesmos secrets. Confirme `GET /health/ready` = 200 e, se possível, `verify-runtime-privileges`.
5. Fail-closed: durante a troca, o serviço fora do ar resulta em 503/indisponível para o cliente, **nunca** em autorização.

## O que não fazer

- Não editar nem apagar migrações já aplicadas; não "apagar" a linha em `schema_migrations`.
- Não conceder privilégios extras ao login de runtime para contornar um rollback (o boot recusa).
- Não limpar `restore_pending` por SQL manual: use `reconcile-after-restore` (ver `backup-restauracao.md`). Uma imagem anterior à `0004` não conhece a flag nem a respeita: após uma restauração, não suba imagem N-1 sem migração `0004` aplicada e reconciliada.
- Não rodar `migrate` no boot nem com a credencial de runtime.

## A definir

`rollback_config` e `update_config` do Swarm, número de réplicas e critério automático de rollback: a definir pelo usuário.
