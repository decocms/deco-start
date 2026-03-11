# Client-Facing Incident Report Template

Use this template for customer communications. Adapt tone and detail level based on relationship and incident severity.

---

## Email Template (Standard)

```markdown
**Assunto:** [Status] Incidente de [Tipo] - [Nome do Site/Cliente]

Prezado(a) [Nome],

[Agradecemos por nos comunicar | Entramos em contato proativamente] sobre o incidente ocorrido em [data].

**Resumo do que aconteceu:**

[Explicação em 2-3 frases, sem jargão técnico. Foque no que o cliente experimentou, não nos detalhes internos.]

**Impacto no seu site:**

- [Impacto específico 1 - ex: "Aproximadamente X% das requisições retornaram erro"]
- [Impacto específico 2 - ex: "O problema durou X minutos"]
- [Se houve exposição de dados: detalhar exatamente o que foi exposto]

**O que fizemos para resolver:**

1. [Ação imediata tomada]
2. [Verificação realizada]
3. [Resultado: "Após essas ações, o problema foi resolvido e verificamos que..."]

**O que estamos fazendo para evitar que isso aconteça novamente:**

- [Medida preventiva 1 - seja específico]
- [Medida preventiva 2]
- [Medida preventiva 3 se aplicável]

**Próximos passos:**

[Se houver ações pendentes do lado deco ou do cliente]

Permanecemos à disposição para quaisquer esclarecimentos adicionais.

Atenciosamente,

**[Nome]**  
[Cargo], Deco.cx  
[Email] | [WhatsApp se apropriado]
```

---

## Email Template (Security/Data Exposure - Formal)

```markdown
**Assunto:** Comunicado de Segurança - Incidente em [Data]

Prezado(a) [Nome],

Entramos em contato para informá-lo(a) sobre um incidente de segurança que afetou [escopo].

**O que aconteceu:**

Em [data], identificamos [descrição não-técnica do problema]. [Duração do problema].

**Quais dados foram potencialmente afetados:**

- [Tipo de dado 1 - ex: "Conteúdo HTML das páginas"]
- [Tipo de dado 2 - ex: "Dados de carrinho de compras"]
- [Esclarecer o que NÃO foi afetado se relevante]

**Impacto no seu ambiente:**

[Descrição específica para este cliente]

**Ações tomadas:**

1. [Correção aplicada]
2. [Verificação de segurança]
3. [Limpeza de cache/dados se aplicável]

**Medidas preventivas implementadas:**

1. [Medida técnica 1]
2. [Medida técnica 2]
3. [Medida de monitoramento]

**Recomendações para sua equipe:**

- [Se houver ações recomendadas do lado do cliente]

**Contatos para o comitê de investigação (se aplicável):**

| Nome | Função | E-mail | WhatsApp |
|------|--------|--------|----------|
| [Nome] | [Cargo] | [email] | [telefone] |

Lamentamos profundamente qualquer inconveniente causado e reafirmamos nosso compromisso com a segurança dos dados de nossos clientes.

Atenciosamente,

**[Nome do Executivo/Co-fundador]**  
[Cargo], Deco.cx
```

---

## Email Template (Performance Degradation)

```markdown
**Assunto:** Relatório de Incidente - Degradação de Performance em [Data]

Prezado(a) [Nome],

Gostaríamos de compartilhar detalhes sobre o incidente de performance que afetou [site/serviço] em [data].

**O que aconteceu:**

Durante [período], observamos [descrição do problema - ex: "um aumento significativo no tempo de resposta" ou "erros intermitentes 502"].

**Números do impacto:**

- Período afetado: [horário início] às [horário fim]
- Taxa de erro: [X% das requisições]
- Tempo médio de resposta: [se aplicável]

**Causa identificada:**

[Explicação simplificada - ex: "Um aumento inesperado de tráfego excedeu a capacidade de memória alocada para o serviço"]

**Ações tomadas:**

1. [Ação de mitigação]
2. [Ajuste de capacidade]
3. [Monitoramento intensificado]

**Melhorias implementadas:**

- [Ajuste de infraestrutura]
- [Novo alerta configurado]
- [Processo atualizado]

Continuamos monitorando ativamente e estamos à disposição para qualquer esclarecimento.

Atenciosamente,

**[Nome]**  
[Cargo], Deco.cx
```

---

## Writing Guidelines for Client Reports

### DO

- Start with the current status (resolved/ongoing)
- Acknowledge the impact on their business
- Be specific about what happened and what was done
- Provide concrete prevention measures
- Include contact information for follow-up
- Use "we" language (we identified, we fixed)

### DON'T

- Use technical jargon without explanation
- Be defensive or make excuses
- Blame third parties (even if true)
- Minimize the impact
- Make promises you can't keep
- Share internal details that don't help the customer

### Tone Calibration

| Severity | Tone | Signer |
|----------|------|--------|
| P0 Critical | Formal, executive-level | Co-founder/CEO |
| P1 High | Professional, detailed | Engineering Lead |
| P2 Medium | Professional, concise | Support/Account Manager |
| P3 Low | Friendly, informative | Support Team |

### Translation Notes (PT-BR)

- "Incidente" not "problema" or "bug"
- "Identificamos" not "descobrimos"
- "Implementamos medidas" not "consertamos"
- "Lamentamos o inconveniente" (use sparingly, once per email)
