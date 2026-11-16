# ADR-0011 — Rede e TLS do canal transacional

- **Status:** Aceito — aprovado pelo usuário (wrpaiva@gmail.com) em 2026-11-15
- **Data:** 2026-11-14 (proposta) · 2026-11-15 (aceite)
- **Projeto:** OpenClaw Trading Risk Engine
- **Relacionada à SPEC:** seções 8.2, 9.3, 11.1, 12 (D-10)
- **Decisores:** usuário responsável pelo projeto (aprovador desta ADR)

## Contexto

O ADR-0007 separa o canal transacional (propostas, consumo e liberação) do canal SSE de observabilidade. Ele exige "TLS/rede privada conforme infraestrutura aprovada", mas não decide qual. A decisão D-10 da SPEC §12 também está aberta.

Até a etapa 2.5, o processo HTTP:
- escuta só em IP literal de loopback. O `loadConfig` rejeita `0.0.0.0`, `::` e `localhost`;
- autentica com token Bearer opaco por principal, sem TLS no processo.

Com isso, o serviço fica inalcançável por outro contêiner em rede bridge/overlay. Isso inclui o OpenClaw, que roda como serviço Swarm. A regressão da etapa 2.5 contorna o problema com `--network host`, que não serve para implantação.

A decisão do usuário de 2026-11-14 foi adiar a escolha: a 2.5 mantém loopback, e as opções ficam registradas aqui para decisão antes de qualquer implantação.

## Decisão

Aprovada em 2026-11-15: **O2 — rede overlay privada, dedicada e cifrada.**

- O canal transacional usa uma rede overlay Swarm **nova e dedicada**, criada com `--opt encrypted`, à qual se anexam somente o risk engine e o consumidor autorizado (OpenClaw; depois, o paper executor). Nenhum outro serviço entra nessa rede.
- O processo continua em HTTP sem TLS próprio. A autenticação continua por token Bearer por principal, com grants agente×conta.
- Nenhuma porta é publicada (`ports:` ausente) e o Traefik não participa (O5 rejeitada).
- Topologia informada pelo usuário: o Swarm da VPS tem **um único nó**. O tráfego da overlay não sai do host; a cifragem da overlay é defesa adicional e passa a ser obrigatória se um segundo nó for adicionado.

Mecanismo no código (a implementar em tarefa separada, com aprovação):
- Variável `RISK_HTTP_BIND_SCOPE=loopback|private-network`, com default `loopback`.
- `private-network` só é aceito com opt-in nominal e explícito do transporte O2 (texto claro em overlay cifrada). Configuração ausente, parcial ou ambígua impede o boot (exit 2).
- O teste de arquitetura que proíbe curingas de bind passa a aceitar o curinga apenas nesse caminho.

Fora desta decisão, ainda pendente:
- **TLS do PostgreSQL (`sslmode`)**: será confirmado no deploy conforme a instância compartilhada ofereça TLS (`require` ou `verify-full`). Nenhum valor é fixado aqui; se a instância não oferecer TLS, a escolha volta ao usuário antes do deploy.
- Nome da rede, criação dela e anexação do OpenClaw: mudanças em produção que exigem aprovação explícita no momento do deploy.

## Alternativas consideradas

| Opção | Descrição | Prós | Contras e exigências |
|---|---|---|---|
| O1 | Manter loopback; o consumidor roda no mesmo host com `network_mode: host` | Nenhuma mudança de código | Acopla o OpenClaw ao host e é incompatível com serviço Swarm em rede overlay. Mudar o OpenClaw exige aprovação |
| O2 | Rede overlay privada e cifrada (`--opt encrypted`), HTTP sem TLS no processo, bind em todas as interfaces por opt-in | Simples, sem PKI | O Bearer trafega em claro dentro da overlay; a cifragem fica no transporte entre nós. Criar ou anexar a rede Swarm exige aprovação. Relaxa a regra de bind da 2.4 |
| O3 | TLS no processo (`node:https`), com certificado e chave via Docker Secret e Bearer mantido | Cifra fim a fim até o processo | Exige definir quem emite o certificado, a CA e a rotação. O OpenClaw precisa confiar na CA, e mudá-lo exige aprovação |
| O4 | mTLS (certificado por agente e por executor) mais Bearer | Identidade forte no transporte | Maior custo operacional: PKI e rotação por principal |
| O5 | TLS terminado no Traefik | — | Contraria "não tocar o Traefik" e "nenhum endpoint publicado por padrão". Não recomendado |

A mesma decisão deve cobrir o TLS da conexão com o PostgreSQL (`sslmode`), já que o banco fica numa instância compartilhada (ADR-0008).

## Justificativa e consequências

O2 é a opção mais simples que permite a integração com o OpenClaw como serviço Swarm sem PKI. Com um único nó, o tráfego não cruza a rede física; o risco residual é um serviço indevido anexado à rede, mitigado por rede dedicada e pelo Bearer + grants. O3/O4 ficam como evolução se surgir um segundo nó fora de rede confiável ou exigência de identidade no transporte.

Consequências:
- Relaxa a regra de bind da 2.4, mas só por opt-in explícito validado no boot; o default continua `loopback`.
- O OpenClaw precisará ser anexado à nova rede, o que é mudança em `openclaw-trading_openclaw` e exige aprovação no deploy.
- Até a implementação do mecanismo e a aprovação do deploy, o serviço continua inalcançável fora do host.

Até 2026-11-14 a decisão estava adiada (o serviço mantinha só loopback); a análise das opções O1–O5 acima é preservada como histórico.

## Restrições, riscos e mitigação

- **Relaxar o bind desfaz uma proteção da 2.4.** Mitigação: opt-in explícito, validação no boot e testes que provem a recusa de configuração parcial.
- **Bearer em texto claro dentro da overlay (O2, escolhida).** Mitigação: rede cifrada, tokens rotacionáveis (o arquivo de principals já aceita vários hashes), rede dedicada sem outros serviços e nenhuma porta publicada.
- **Segundo nó no Swarm.** Se a topologia deixar de ser de um nó, revisar esta ADR; a cifragem da overlay deixa de ser opcional.
- **PKI (O3/O4).** Mitigação: definir responsável, validade e rotação antes da implantação. Nenhum valor é inventado aqui.

## Critérios de validação

- Teste de configuração: escopo `private-network` sem transporte declarado impede o boot.
- E2E: um cliente em outro contêiner alcança o serviço apenas pela rede escolhida, e um cliente sem credencial ou certificado válido é recusado.
- A verificação de segurança da etapa de implantação confirma que não há porta publicada.

## Relação com a especificação

Resolve, quando aprovada, a parte de rede e transporte da D-10 (SPEC §12) e o requisito de canal autenticado da §9.3. Não trata backup, que é a outra parte da D-10.

## Revisão da decisão

Revisar quando o OpenClaw for integrado ao canal transacional, quando o paper executor existir (D-09) ou se a topologia Swarm mudar.
