# ADR-0002 — Adotar domínio determinístico e arquitetura hexagonal moderada

- **Status:** Proposto (pendente de aprovação)
- **Data:** 2026-11-13
- **Projeto:** OpenClaw Trading Risk Engine
- **Referência normativa:** `SPEC_OPENCLAW_RISK_ENGINE.md` v1.0.0
- **Escopo:** Fase 2 / paper trading

## Contexto
LLMs podem propor operações, mas suas saídas são não determinísticas. Regras de autorização requerem previsibilidade, rastreabilidade e testes isolados.

## Decisão proposta
Usar TypeScript strict e um núcleo puro com regras `RiskRule` (Strategy), orquestração de caso de uso, portas para relógio, políticas, dados de mercado, identidade, contas e transações, e adaptadores de infraestrutura nas bordas. Avaliadores retornam violações estruturadas, jamais autorizam diretamente.

## Alternativas consideradas
- Regras escritas em prompts de IA: rejeitada por falta de garantias.
- Serviço monolítico com SQL e HTTP dentro das regras: rejeitada por acoplamento.
- Framework pesado de regras: adiado, sem evidência de necessidade.

## Justificativa e consequências
+ Testes determinísticos com fixtures e relógio injetado.
+ Evolução individual das regras de risco sem reescrever contratos.
- Mais interfaces; limitar abstrações a fronteiras reais.

## Restrições, riscos e mitigação
Evitar excesso de abstrações e exceptions silenciosas. Qualquer exceção na regra deve falhar sem autorização. Garantir ordenação explícita e sem efeitos colaterais.

## Critérios de validação
- Testes por regra e de orquestração, incluindo exceções.
- Sem chamadas de rede ou banco a partir de `src/domain` ou `src/rules`.
- Resultado de cada execução reproduzível com mesmo contexto, política e relógio.

## Relação com a especificação
Seções 1, 5, 6 e 9.

## Revisão da decisão
- **Gatilhos para revisão:** necessidade comprovada de regras configuráveis em runtime ou múltiplas linguagens
- **Dependências em aberto:** D-02 a D-07
- **Responsável pela aprovação:** a definir; nenhuma decisão proposta é automaticamente aprovada.
