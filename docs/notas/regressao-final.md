# Relatório da regressão final (SPEC §9.4, ADR-0009)

- **Projeto:** OpenClaw Trading Risk Engine (SPEC-TRADING-RISK-001)
- **Marco:** final da etapa 2.5
- **Data:** 2026-11-14
- **Versão avaliada:** imagem local `openclaw-risk-engine:0.1.0`. O digest fica registrado na seção de execução final, já que não há repositório git.
- **Status:** concluída em 2026-11-14 e aprovada pelo usuário em 2026-11-15.

## Como a regressão foi executada

- **Camada (a), imagem real:** `npm run test:e2e` (`scripts/test-e2e.sh`) sobe, com label exclusiva:
  - um PostgreSQL 14 descartável em tmpfs;
  - as roles criadas por `scripts/provision/roles.sql`;
  - a migração rodada pela própria imagem, com a credencial de migração;
  - a aplicação pela imagem, em `--read-only`, com `--cap-drop ALL` e conectada com o login de runtime de privilégio mínimo.
  
  Com fontes `Unconfigured`, a imagem real só emite `BLOCK`, como previsto.
- **Camada (b), composição de teste:** `tests/e2e/support/composition.ts` usa o servidor HTTP real, os casos de uso reais e o PostgreSQL real conectado como login de runtime, com fontes de mercado falsas que existem só em `tests/`. É ela que prova `ALLOW_PAPER`, consumo e concorrência. A imagem não tem modo fixture.
- **Suítes locais:** `typecheck`, `lint`, `test:unit`, `test:contract`, `test:integration` (inclui concorrência) e `test:e2e`.

## Matriz §9.4

| # | Cenário (§9.4) | Testes | Evidência | Lacunas declaradas |
|---|---|---|---|---|
| 1 | OpenClaw emite proposta de agente permitido | `tests/e2e/regression/item-01` | Os 7 agentes de fixture com grant recebem decisão vinculada a conta, agente, hash, política, snapshot e `marketDataAsOf`. São recusados, sem nada gravado: agente sem grant, token desconhecido ou ausente, executor em `/evaluations` e agente A emitindo como B. Grant revogado dá 403 | O OpenClaw real não foi tocado; o simulador é um cliente HTTP. Os IDs reais dos agentes ainda não foram informados |
| 2 | Proposta inválida bloqueada com auditoria | `item-02` | BLOCK por stop-loss, escala, validade e `createdAt` futuro, com auditoria `DECISION_RECORDED`. Contrato inválido dá 422, 400 ou 413 sem linha no banco; o 422 vai só para o log, com `violationCodes` (decisão do usuário) | — |
| 3 | Só `ALLOW_PAPER` com reserva atômica | `item-03` | Todo ALLOW tem reserva ACTIVE com o mesmo vencimento e auditoria. Uma falha injetada antes do COMMIT dá 503 e nada gravado. O banco rejeita ALLOW incoerente (CHECK e FK diferida). A imagem real dá BLOCK para propostas válidas | ALLOW só é provado na composição: fontes reais dependem de D-02/D-03/D-05 |
| 4 | Executor consome uma vez | `item-04` | Consumo único: a mesma ordem repete o resultado, outra ordem dá 409. `paper_order_id` é único. Em 10 consumos concorrentes, 1 vence. Vencimento, hash errado, conta errada, token de agente e reserva liberada nunca dão 200 | Ordem simulada, posição e P&L não existem (D-05/D-09) |
| 5 | Repetição e concorrência sem duplicatas | `item-05`, `tests/concurrency` | 20 requisições simultâneas geram 1 decisão, 1 reserva e 19 replays. Mesma chave com payload diferente dá 409. 30 propostas sob limite de 3,5 geram exatamente 3 ALLOW (I-03). Consume e release concorrentes têm um vencedor | Duplicata de ordem não é observável sem executor |
| 6 | Falha de dependência impede aprovação | `item-06`, `health.e2e`, `clientDeadline.e2e` | Política ausente, desativada ou vencida dá BLOCK. Fonte que lança dá 503 sem gravar. Banco fora ou congelado (`docker pause`) dá 503 em tempo finito: ready 503, live 200, recuperação automática. Crash de backend sob carga não deixa nenhum ALLOW sem reserva | Mercado e snapshot reais não existem; as falhas são injetadas |
| 7 | Receiver e Pixel não influenciam | `item-07`, `tests/unit/architecture/boundaries.test.ts` | O grafo de imports transitivo não tem pixel nem receiver. As dependências externas se limitam a `pg`, `decimal.js`, `zod` e `node:*`. A imagem não menciona Pixel. O outbox nunca é publicado | Painel e receiver reais não foram exercitados: "sem regressão do painel" não está provado |
| 8 | Reinício sem perda nem duplicata | `item-08` | `docker kill -s KILL` da app sob carga, seguido de `docker start`. Os replays são idênticos, não há duplicata, proposta e decisão ficam 1:1 e não sobra transação órfã. Na composição, os ALLOW sobrevivem com consumo ainda único | O reinício do PostgreSQL não é testado (tmpfs); o crash do backend fica coberto no item 6 |
| 9 | Rollback e restauração | `item-09` | O backup e o restore locais reais recusam alvos não locais ou não `*_test`. O banco restaurado nasce com `restore_pending` e fica not-ready, com 503 nos casos de uso, até `reconcile-after-restore`. Esse comando expira todas as ACTIVE anteriores (`post-restore-reconciliation`) e grava auditoria. Checksums, grants e triggers são preservados, `verify-runtime-privileges` sai com 0, o replay é idêntico e o consumo não se repete. Com checksum divergente, ready dá 503 | O rollback N-1 é simulado com uma linha extra em `schema_migrations`, porque não existe imagem N-1 real. A estratégia de backup em produção é D-10. Risco residual de I-04: consumos posteriores ao ponto de backup se perdem, e só a deduplicação no executor (D-09) evita uma ordem repetida |
| 10 | Sem credenciais nem caminho real | `item-10`, `image.test.ts` | O ambiente, as camadas da imagem e o `node_modules` não têm credencial nem SDK de exchange. Não há cliente de rede de saída. Rotas de ordem e execução dão 404. O banco recusa conta não PAPER. A config recusa nomes de credencial e `LIVE` (exit 2) | A prova é por ausência. Não há firewall de saída |

## Invariantes I-01..I-08

`tests/unit/traceability.test.ts` exige que UT-001..UT-020 e I-01..I-08 apareçam nos testes e falha diante de uma tag inexistente. A tag não prova a força da asserção, então a cobertura abaixo foi conferida pela equipe e pelo revisor.

| Invariante | Onde é coberta |
|---|---|
| I-01 | `ReservationLifecycle`, e2e itens 3 e 4 |
| I-02 | `RiskDecision.test`, e2e itens 1, 3 e 7. Aparece só em cabeçalhos de arquivo, não em títulos de teste |
| I-03 | `tests/concurrency`, e2e item 5 |
| I-04 | `ReservationLifecycle`, `tests/concurrency`, e2e itens 4, 5, 8 e 9, com o risco residual pós-restauração declarado |
| I-05 | `EvaluateTradeRisk` (UT-014), `RiskEvaluator`, e2e itens 2, 6 e 10 |
| I-06 | `RiskDecision.test`, e2e itens 1 e 2 |
| I-07 | `RiskEvaluator` (UT-016), `ReservationLifecycle` (UT-020), e2e itens 3, 4 e 10 |
| I-08 | `boundaries.test`, e2e item 7. Cobre apenas a ausência de dependência |

## Defeitos encontrados e corrigidos na etapa 2.5

| Origem | Defeito | Correção |
|---|---|---|
| Tester (onda 2) | Um cliente pg em uso que perdia a conexão derrubava o processo | `guardClient` em todos os `pool.connect()` |
| Tester (regressão) | `/health/ready` pendurava com o banco congelado | `clientLease`: prazos do lado do cliente derivados da config existente |
| Tester (regressão) | O procedimento pós-restauração decidido pelo usuário não existia | Migração 0004, check `reconciliation`, `RestorePendingError` e os comandos de CLI `reconcile-after-restore` e `mark-restore-pending` |
| Tester (regressão) | O log do 422 saía sem códigos; a imagem levava `.js.map` | Corrigidos |
| Revisor e auditor (onda 5) | M1–M7, B1–B6, W1–W4, S1, S4 (ver a seção seguinte) | Corrigidos no código ou documentados em `docs/operacao/`, com testes novos |
| Tester (onda 5) | Teste do item 2 instável: um `requestId` UUID podia conter `1e3` | Asserção corrigida |

## Revisão final (onda 5)

- **Revisor:** nenhum achado CRÍTICO ou ALTO. MÉDIOS:
  - M1: janela sem `restore_pending` no restore.
  - M2: sombreamento de schema não detectado pelo inspetor.
  - M3: CLI de migração sem prazo.
  - M4: rollback N-1 contra a allowlist fixa do inspetor.
  - M5: risco residual de I-04 não documentado.
  - M6: readiness sem auth pode esgotar o pool.
  - M7: `expire-reservations` com a flag ligada.
  - M8: este relatório.

  Mais BAIXOS B1 a B6.
- **Security-auditor:** nenhum CRITICAL.
  - `npm audit` de produção: 0 vulnerabilidades. Desenvolvimento: 7 moderate, só no lint, não exploráveis.
  - trivy: 0 segredos e 0 misconfig. As CVEs do SO Debian não têm correção e não são exploráveis no contexto; as do npm embutido na base foram eliminadas removendo o npm do runtime.
  - WARNINGs:
    - W1: travas de banco local contornáveis por query na URL.
    - W2: regra futura para funções `SECURITY DEFINER`.
    - W3: permissão dos segredos do e2e.
    - W4: documentação desatualizada.
  - SUGGESTIONs: S1 a S7.

## Execução final

Executada pelo líder em 2026-11-14 às 23:30 -03:00.

| Verificação | Resultado |
|---|---|
| `npm run typecheck` / `npm run lint` | limpos |
| `npm run image:build` | `openclaw-risk-engine:0.1.0`, id `sha256:0faa4211f7373cee7504354ebebf7bd2be63f305fdd460a1714812f1b735bce4`, 234 MB, `User 1000:1000`, sem npm/npx/corepack/yarn |
| `npm run test:unit` | 771 testes em 22 arquivos, todos passando |
| `npm run test:contract` | 178 testes em 4 arquivos, todos passando |
| `npm run test:integration` (inclui concorrência) | 409 testes em 22 arquivos, todos passando; o tester rodou 2 vezes e o líder 1 |
| `npm run test:e2e` (imagem real e composição) | 142 testes em 13 arquivos, todos passando, sem `skip`/`todo`/`fails`; o tester rodou 2 vezes e o líder 1 |
| Segurança | `npm audit --omit=dev`: 0. trivy: 0 segredos e 0 misconfig; CVEs do SO Debian sem correção, não exploráveis no contexto |
| Recursos Docker | nenhum contêiner com a label do projeto ao final; nenhum `prune` |

**Observação de ambiente:** às vezes o daemon Docker deste host recusa publicar uma porta de loopback com `address already in use`, mesmo sem nenhum listener nela. Aconteceu na porta padrão 55442 e logo depois em outras. O script aceita `RISK_E2E_DB_PORT` e `RISK_E2E_APP_PORT`, e a execução final usou 55471/55472. O problema não está no código do projeto.

**Achado conhecido (BAIXO, não corrigido):** `migrate(pool, dir, timeouts)` deixa `statement_timeout` e `lock_timeout` na sessão da conexão que volta ao pool. Na CLI isso não tem efeito, porque o processo termina em seguida. Só passaria a importar se o pool fosse reutilizado no mesmo processo. A correção é um `RESET` ou `release(true)`.

## Pendências do usuário (não bloqueiam a entrega da 2.5, mas bloqueiam a implantação)

- **Implantação:** aprovação explícita para VPS, `/opt/openclaw-risk-engine`, Swarm, rede, secrets, Traefik e SQL em produção.
- **ADR-0011 (rede/TLS):** aceito em 2026-11-15 (O2, overlay dedicada e cifrada; Swarm de um nó). Falta implementar `RISK_HTTP_BIND_SCOPE` e confirmar o `sslmode` no deploy.
- **D-10 (backup):** decidido no ADR-0012 (2026-11-15). Falta implementar o job de produção e definir no deploy provedor/bucket, horário, retenção no bucket, diretório, alerta e RTO.
- **Prazo de migração:** a migração usa `RISK_DB_STATEMENT_TIMEOUT_MS`, e uma DDL longa falharia com rollback. Decidir se as migrações precisam de um prazo próprio.
- **Valores operacionais:** variáveis numéricas `RISK_*`, grace period, healthcheck, réplicas, agenda do `expire-reservations`, retenção de logs, decisões e auditoria, destino e limiares de alertas, nível de log em produção, limites HTTP extras e `statement_timeout` de migração, se necessário.
- **D-08:** quem concede grants e quem é DBA desta base.
- **Agentes:** IDs reais dos sete agentes.
- **Pendências herdadas da 2.4:** unicidade do `proposalId` por conta e vínculo do release (D-09).
- **Habilitar `ALLOW_PAPER` em produção:** depende de D-01 a D-09 (SPEC §12).
