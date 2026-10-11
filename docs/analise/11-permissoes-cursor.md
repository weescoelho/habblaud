# 11 — Runbook do fluxo de permissões do Cursor (sem travar)

Este runbook acompanha a implementação em `.specs/features/cursor-permissoes/` (spec, design e
tarefas). Ele descreve as **duas camadas** que evitam que o agente do Cursor pare a toda hora:

1. **Camada base — Run Modes/auto-run nativo do Cursor** (configuração do próprio Cursor): deixa
   passar o que é rotineiro **antes** de qualquer hook.
2. **Camada do Habblaud — política local do hook** (`mod/habblaud-cursor/hook.mjs` +
   `mod/habblaud-cursor/policy.mjs`): decide na hora, sem passar pelo escritório, o que casa uma
   regra `allow`/`deny`; o resto vai ao escritório como antes.

O objetivo da feature: o Cursor **para só quando realmente precisa de você**. Antes, o hook pedia
decisão em 4 eventos — inclusive `preToolUse` (toda ferramenta) e `beforeReadFile` (toda leitura),
que geravam centenas de aprovações triviais por sessão.

> Escopo: só o Cursor. O Codex e o Claude Code não mudam (no Codex, "sempre permitir" continua
> `unsupported`).

## Pré-requisitos

- Cursor instalado (de preferência 3.x; o runbook do Cursor cita **Settings > Agents > Approvals &
  Execution**).
- Node.js `>= 22.12`.
- Repositório do Habblaud na branch `cursor-poc`, com `npm install` rodado.
- Todos os comandos abaixo partem da **raiz do repositório**.

### Variáveis e caminhos

- **Configuração/política do hook**: `~/.habblaud/cursor-hook.json` (opcional; o instalador de
  hooks **não** grava este arquivo — ele nasce sozinho no "sempre permitir" ou é escrito à mão).
- **Registro local de decisões**: `~/.habblaud/cursor-decisions.jsonl` (best-effort).
- **Porta do Habblaud**: `4747` (padrão). `HABBLAUD_PORT` vale como reserva se o arquivo não existir.
- **Depuração do hook**: `HABBLAUD_HOOK_DEBUG=1` escreve o que acontece no `stderr` (exporte antes
  de abrir o Cursor — o processo da IDE herda o ambiente).
- Ao passar opções por `npm run`, use o separador `--`.

---

## 1. Camada base — Run Modes/auto-run do Cursor

A primeira camada de "não parar" é nativa do Cursor: os **Run Modes** decidem quando o agente
executa sem perguntar. Configure em **Settings > Agents > Approvals & Execution**.

| Modo | O que roda sem perguntar | Sandbox | Classificador |
| --- | --- | --- | --- |
| **Auto-review** (recomendado) | Chamadas na allowlist; demais comandos de shell no sandbox quando possível; o resto passa por um classificador. | Sim (shell) | Sim |
| **Allowlist** | Só a allowlist; com sandbox, comandos suportados rodam nele. | Opcional | Não |
| **Run Everything** | Tudo. | Não | Não |

Passos:

1. Abra **Settings > Agents > Approvals & Execution** e escolha o modo. Para "não parar" com
   segurança, **Auto-review** é o padrão recomendado; **Allowlist** dá comportamento determinístico
   para um conjunto pequeno de comandos de confiança.
2. (Opcional) Em **Auto-review**, refine com o arquivo **`permissions.json`** (instruções em
   português/inglês simples):
   - `~/.cursor/permissions.json` — todos os projetos da máquina.
   - `<projeto>/.cursor/permissions.json` — só um projeto (versione se for o caso).

   ```json
   {
     "autoRun": {
       "allow_instructions": ["Deixe passar `npm test` e `npm run build`."],
       "block_instructions": ["Toda chamada de AWS CLI deve pedir aprovação antes."]
     }
   }
   ```
3. Os **Run Modes** cobrem shell, MCP e Fetch. As proteções de **File-Deletion Protection** e
   **External-File Protection** continuam podendo pedir aprovação mesmo em auto-run.

> **O hook do Habblaud decide independentemente do Run Mode** (CPERM-15): quando o Cursor chama os
> hooks de decisão, é o hook que responde `allow`/`deny` naquele evento. A camada base reduz o
> volume; a política local (abaixo) evita que o *seu* comando repetido vire uma ida ao escritório.
> (Lacuna C1: o schema/semântica exata dos hooks do Cursor ainda será confirmada na máquina real.)

---

## 2. Camada do Habblaud — o hook e a política local

### Instalação dos hooks

```bash
npm run cursor:install     # acrescenta o hook em ~/.cursor/hooks.json (backup antes)
npm run cursor:install -- --project <dir>   # em <dir>/.cursor/hooks.json
npm run cursor:status      # eventos de decisão, nº de regras e nº de decisões locais
npm run cursor:uninstall   # remove só o hook do Habblaud
```

### Arquivo de política `~/.habblaud/cursor-hook.json`

```jsonc
{
  "port": 4747,                          // já existia
  "decisionTimeoutS": 25,                // já existia (entre 5 e 120)
  "decisionEvents": ["beforeShellExecution", "beforeMCPExecution"], // opcional; padrão = só esses dois
  "rules": [                             // opcional; escrito pelo "sempre permitir" (ou à mão)
    { "tool": "Shell", "pattern": "^npm test(\\s|$)", "effect": "allow", "note": "npm test" },
    { "tool": "Shell", "pattern": "^rm -rf",          "effect": "deny",  "note": "destrutivo" }
  ]
}
```

Arquivo ausente, ilegível ou com JSON malformado = **sem regras** (o hook segue o fluxo anterior,
sem lançar). Regra malformada é descartada; regra com regex que não compila é ignorada.

### Formato das `rules`

| Campo | Obrigatório | Descrição |
| --- | --- | --- |
| `tool` | sim | Ferramenta do Cursor (`"Shell"`, `"Read"`, `"MCP:<nome>"`) ou `"*"` para qualquer uma. |
| `pattern` | sim | Expressão regular (sem flags) testada contra o **sujeito** do pedido. |
| `effect` | sim | `"allow"` ou `"deny"`; quando as duas casam, **`deny` vence**. |
| `note` | não | Texto legível (o que a regra cobre); vira o `user_message` no `deny`. |

O **sujeito** depende da ferramenta: `Shell` → `command`; `Read` → `file_path`; `MCP:<nome>` → o
nome da ferramenta; demais → o JSON dos argumentos.

Ordem de avaliação de um evento de decisão:

1. Casou uma regra `deny` → recusa na hora (sem contato), com o `note` em `user_message`.
2. Senão, casou uma regra `allow` → aprova na hora (sem contato).
3. Senão → registra no escritório e espera a decisão (comportamento anterior).

---

## 3. Eventos: decisão vs observação

Por padrão, só os eventos de **maior risco** pedem decisão:

| Evento | Padrão | Observação |
| --- | --- | --- |
| `beforeShellExecution` | **decisão** | Comando de shell (com `command`). |
| `beforeMCPExecution` | **decisão** | Chamada de MCP (ferramenta `MCP:<nome>`). |
| `preToolUse` | observação | Dispara para **toda** ferramenta (centenas por sessão). |
| `beforeReadFile` | observação | Dispara para **toda** leitura de arquivo. |
| `sessionStart`/`sessionEnd`/`beforeSubmitPrompt`/`postToolUse`/`postToolUseFailure`/`afterShellExecution`/`afterMCPExecution`/`afterFileEdit`/`afterAgentResponse`/`afterAgentThought`/`stop` | observação | Só alimentam o escritório (sem decisão). |

Para **reativar** eventos de decisão (ex.: voltar a decidir leituras), use `decisionEvents`:

```jsonc
{ "decisionEvents": ["beforeShellExecution", "beforeMCPExecution", "beforeReadFile"] }
```

Um array vazio ou inválido volta ao padrão. Sem `command` (ex.: `beforeShellExecution` sem
`command`), o evento segue o fluxo anterior — o hook não inventa sujeito nem regra.

---

## 4. "Sempre permitir" no Cursor (emulação de `updatedPermissions`)

O Cursor **não** tem `updatedPermissions`. O Habblaud emula assim:

1. O hook deriva uma regra `allow` do pedido (`Shell(npm test)`) e a manda no `suggest_rule`.
2. No cartão do Habblaud, escolha **"Aprovar e não perguntar de novo"**. A decisão vale na hora e o
   servidor **grava a regra** em `rules` de `~/.habblaud/cursor-hook.json` (escrita atômica).
3. Na próxima vez, o hook casa a regra e aprova **sem** contatar o escritório (registra a decisão
   local; ver abaixo).

O botão só aparece quando há uma regra derivável (`suggest_rule` presente). O `effect` persistido é
sempre `allow`; para **recusar** um comando, acrescente uma regra `deny` à mão (o `deny` sempre
vence o `allow`).

### Desligar de vez os pedidos de comando (padrão "não perguntar nada")

Quem quer que `cd`, comandos fixos (`npm run build`) e scripts próprios **nunca** peçam, sem
precisar aprovar um a um, configura duas camadas:

1. **Base do Cursor** — `~/.cursor/permissions.json` + Run Mode **Auto-review** (Settings > Agents >
   Approvals & Execution): uma `allow_instructions` cobre `cd`, `pwd`, `ls`, `git status/branch/log/diff`,
   os scripts de `package.json` (`npm run`/`pnpm`/`yarn`) e versões; uma `block_instructions` guarda
   `rm`, `sudo`, `chmod`, force push e `curl … | sh`.
2. **Habblaud (com o escritório aberto)** — `rules` de `~/.habblaud/cursor-hook.json`: uma regra
   `deny` para o que não pode, e uma regra-curinga `allow` no fim (o `deny` sempre vence o `allow`):

```jsonc
{
  "rules": [
    { "tool": "Shell", "pattern": "^rm(\\s|$)", "effect": "deny", "note": "apagar arquivos" },
    { "tool": "Shell", "pattern": "^sudo(\\s|$)", "effect": "deny", "note": "sudo" },
    { "tool": "Shell", "pattern": "^chmod(\\s|$)", "effect": "deny", "note": "permissões" },
    { "tool": "Shell", "pattern": "^git push.*-f(\\s|$)", "effect": "deny", "note": "force push" },
    { "tool": "Shell", "pattern": "\\|\\s*(sh|bash)(\\s|$)", "effect": "deny", "note": "script baixado na hora" },
    { "tool": "Shell", "pattern": ".*", "effect": "allow", "note": "demais comandos" }
  ]
}
```

Com isso, com o escritório aberto é o hook que decide tudo (allow para o resto, deny para a lista
de guarda) — nenhum cartão de shell. Com o escritório fechado, quem decide é a camada base do
Cursor (Auto-review). MCP continua pedindo (evento de decisão): acrescente
`{ "tool": "*", "pattern": ".*", "effect": "allow" }` se quiser o mesmo para ferramentas MCP
(o `tool: "*"` casa qualquer ferramenta; os `deny` continuam vencendo).

Exemplo do resultado de um "sempre permitir" para `npm test`:

```jsonc
{ "tool": "Shell", "pattern": "^npm test(\\s|$)", "effect": "allow", "note": "npm test" }
```

---

## 5. Observabilidade

- **`~/.habblaud/cursor-decisions.jsonl`**: uma linha JSON por decisão tomada por regra local
  (`{at, event, tool, effect, pattern}`). Nunca escreve no `stdout` do hook (o Cursor só aceita a
  decisão). É best-effort: falha de escrita não atrapalha a IDE.
- **`npm run cursor:status`**: mostra os eventos de decisão vigentes (config ou padrão), o nº de
  `rules` válidas e o nº de decisões locais registradas:

  ```
  • ~/.cursor/hooks.json: instalado em 15 de 15 eventos
  Configuração do hook: ~/.habblaud/cursor-hook.json → eventos de decisão: beforeShellExecution, beforeMCPExecution (padrão); regras locais: 0; decisões locais: 0; porta 4747 e espera 25 s por padrão.
  ```
- **`HABBLAUD_HOOK_DEBUG=1`**: o hook escreve no `stderr` o que classificou (evento observado,
  regra local aplicada, resposta do escritório).

### Rotação

`cursor-decisions.jsonl` cresce com o uso; é seguro apagá-lo ou rotacioná-lo. O `status` conta as
linhas do arquivo atual ("desde a última rotação"). O teto de regras é de **200** (as mais antigas
saem quando estoura).

---

## 6. Verificação (checklist)

- [ ] `npm run cursor:install` e `npm run cursor:status` mostram o hook instalado e os eventos de
      decisão (padrão: `beforeShellExecution`, `beforeMCPExecution`).
- [ ] Uma leitura de arquivo no Cursor **não** abre cartão no Habblaud (`beforeReadFile` é
      observação).
- [ ] "Sempre permitir" num `npm test` grava a regra e um novo `npm test` é aprovado na hora (o
      `status` mostra a regra e uma decisão local a mais; o escritório não recebe pedido).
- [ ] Um comando coberto por regra `deny` é recusado na hora, com o `note` como motivo.
- [ ] `rules` com JSON malformado ou regex inválida não quebra a IDE (volta ao fluxo anterior).
- [ ] No Codex, "sempre permitir" continua indisponível (`unsupported`).

---

## Referências

- Spec/design/tarefas: `.specs/features/cursor-permissoes/` (`AD-002`).
- Roteiro: `docs/analise/06-arquitetura-proposta.md` §6.4 e §6.8 (pasta de análise do workspace).
- Cursor — Terminal: <https://cursor.com/docs/agent/tools/terminal>.
- Cursor — Run Modes (Auto-review/Allowlist/Run Everything, sandbox e `permissions.json`):
  <https://cursor.com/docs/agent/security/run-modes>.
