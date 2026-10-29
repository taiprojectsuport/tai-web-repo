# RLS por empresa: migração pendente

> **Status: NÃO APLICADA.** Nada aqui foi executado no banco. O banco "TAI"
> (`nmoyvzglbzamguzapoag`) é de produção e compartilhado com o sistema legado
> (`app.smarttai.com.br`). Aplique primeiro num **branch do Supabase**, siga o
> roteiro da seção 6 e só depois leve para produção.

Arquivo: `20261015_rls_isolamento_por_empresa.sql`. A sintaxe foi conferida com o
parser oficial do Postgres (libpg-query 17): são 95 comandos, mais 11 no rollback.
O parser não valida o SQL montado dentro dos blocos `DO`.

---

## 0. Resultado do teste no branch (15/10/2026)

Branch `teste-rls` criado do esquema inicial (`supabase/migrations/`) mais o `supabase/seed.sql`.
Primeiro foi testado sem a migração, depois com ela. **Produção não foi tocada.**

**Antes da migração** (estado igual ao de produção), confirmando as brechas:
- A anon key, sem login, leu todas as tabelas (exceto `variables`) e **criou uma empresa**.
- Admin A **virou Master** sozinho e **renomeou máquinas da Empresa B**.
- Operador A lançou apontamento **na Empresa B**; Vendedor e Cliente gravaram apontamentos.
- O token de um usuário **inativo** continuava lendo tudo.

**Depois da migração: 30/30 checagens de API OK.**

| Quem | Resultado |
|---|---|
| anon (sem login) | 0 linhas em todas as tabelas; insert negado |
| master | vê as 2 empresas; edita setor da B; **exclui empresa pelo Painel Master** |
| admin-a | vê só a A (máquinas, apontamentos, usuários); não vira Master; 0 linhas ao tentar alterar máquina da B; troca o logo da própria empresa |
| operador-a | lança apontamento na A; insert na B negado; **registra perda (UPDATE em Maquinas) e o trigger recalcula o OEE geral das duas empresas** |
| vendedor-a / cliente-a | leem a A; gravar é negado |
| inativo-a | token válido lê 0 máquinas; o login mostra "Este usuário está desativado" |
| admin-b | vê só usuários e relatórios da B |

Telas conferidas no tai-web apontado para o branch: dashboard, Apontamentos (Admin A vê só os 7
da A), Configurações (só os 6 usuários da A), login do inativo e Painel Master (lista, contagens
e exclusão).

Ajuste que saiu do teste: o Supabase avisou que `tai_private.rls_policies_backup` ficava sem RLS.
A migração agora liga o RLS nela (sem policies: só o dono acessa).

Observação: o conector do Supabase usado pelo Claude barra SQL com `DELETE`/`DROP`, mesmo dentro
de corpo de função. Essas partes foram rodadas pelo SQL Editor do painel, no branch.

## 1. O que foi conferido no banco (15/10/2026, só leitura)

| Item | Resultado | Efeito na migração |
|---|---|---|
| RLS | ligado nas 12 tabelas de `public` | o `enable` é só garantia |
| Policies atuais | 10 abertas (`true` para `public`); `variables` aberta para `authenticated`; 3 com condição (veja abaixo) | todas as policies das 10 tabelas são removidas (com cópia) |
| Tipos | `idRef`, `idEmpresa`, `id_empresa` e `"User".idRef` são **uuid**; ids de máquina são bigint | comparação direta em uuid, sem `::text` |
| `"User".Status` | **17 de 20 usuários com `''` (vazio)**, 3 com `'ativo'` | a regra de ativo é igual à do app: só bloqueia `'inativo'`/`'inactive'`/`'desativado'`. Exigir `Status = 'ativo'` cortaria 17 usuários, entre eles **todos os Admins** |
| `"User".tipo` | Operator 10, Admin 4, **Vendedor 4**, Cliente 1, Master 1 | Vendedor e Cliente = visitante (só leitura), como no app |
| Auth sem linha em `User` | 13 contas, **nenhuma com login nos últimos 30 dias** | perdem acesso aos dados (já não entram no tai-web) |
| `Sala.sala` | `UNIQUE (sala)` **global**; `Maquinas.IDsala` tem FK com `ON UPDATE CASCADE ON DELETE CASCADE` | o C3 não vazava entre empresas (o filtro fica como defesa); excluir setor apaga as máquinas dele |
| Triggers | 6 triggers `AFTER UPDATE` em `Maquinas`, todos **SECURITY INVOKER**; um deles (`tg_atualiza_oee`) reescreve `"OEE geral"` | **passo 2 da migração** (veja a seção 3) |
| pg_cron | 6 jobs (copiar Maquinas → Relatório de hora em hora, limpeza, `check_thresholds` por minuto…), todos como dono | não são afetados |
| Conexões | máquinas via `postgres`/Supavisor; API via `authenticator` | as máquinas não são afetadas |
| Logs de API (24h) | anon só em `/auth/v1/token` (login). Todo acesso a dados veio **logado**, do legado (supabase-js 2.117.3) e do tai-web local (2.116.0), e **só pelo usuário Master** | nenhum uso de anon para dados nessa janela |
| Edge Function `create-auth-user` | `verify_jwt: true`; exige que quem chama seja `admin` ou `master` | ok, com ressalvas (seção 4) |

Policies com condição que existiam e são substituídas:
- `dashboard_configs` **"Admin write access"**: Admin da empresa **ou `nomeUser = 'Master'`**,
  sem checar Status. Bastava alguém se chamar "Master" para gravar.
- `dashboard_configs` **"Empresa read access"**: qualquer usuário da empresa, sem checar Status.
- `variables` **"master full access"**: uid fixo `d7244bae-…` (o único Master atual).

Elas não podem ficar: policies permissivas valem em OR, então qualquer uma reabriria acesso.

---

## 2. Tabelas que o tai-web acessa

Levantamento feito em `src/data/repositories/supabase/*.ts`. "Filtro de empresa" é o
filtro que o **front** aplica hoje. Ele não protege nada: qualquer cliente pode omiti-lo.

| Tabela | select | insert | update | delete | Filtro de empresa no front | Quem faz no app |
|---|---|---|---|---|---|---|
| `Empresas` | ✅ | ✅ | ✅ (nome, `logo_url`) | ✅ | `idEmpresa = id` (Master lista todas) | Master (Painel Master); Admin troca o logo |
| `User` | ✅ | ✅ (depois da Edge Function) | ✅ (nome, e-mail, tipo, Status) | ✅ | `idEmpresa = companyId` (Master sem filtro); login lê por `idRef = auth.uid()` | Master/Admin |
| `Sala` | ✅ | ✅ | ✅ | ✅ | `idRef = companyId` (agora também no update/delete) | só Master |
| `Maquinas` | ✅ | ✅ | ✅ | ✅ | `idRef` na listagem; **update/delete por `id`** | criar/excluir: Master; editar: Master/Admin; **registrar perda (OEE): Operador também** |
| `variables` | ✅ | ✅ | ✅ | ✅ | nenhum, só `maquina_id` | Master/Admin; exclusão junto com máquina ou setor |
| `dashboard_configs` | ✅ | ✅ | ✅ | ❌ | `id_empresa` | Master/Admin |
| `Apontamentos` | ✅ | ✅ | ✅ | ❌* | `idRef` na listagem; **update por `id`** | Master/Admin/Operador |
| `Ordem de serviço` | ✅ | ✅ | ✅ | ❌* | `idRef` na listagem; **update por `id`** | Master/Admin/Operador |
| `Relatório` | ✅ | ❌ | ❌ | ❌ | `idRef` (Master sem filtro) | leitura |
| `OEE geral` | ✅ | ❌ | ❌ | ❌ | `idRef` | leitura |

\* O repositório tem `remove()`, mas nenhuma tela usa.

Outros acessos: **Realtime** em `Apontamentos` e `Ordem de serviço` (respeita RLS, passa
a entregar só as linhas visíveis) e a **Edge Function** `create-auth-user` (service role).

Fora do escopo: `alert_events` e `alert_contacts` (sistema de alertas) continuam com
policy `allow all` para `public`. O tai-web não as usa, mas elas também estão abertas
à anon key.

---

## 3. O que a migração faz

0. Copia **todas** as policies atuais das 10 tabelas para
   `tai_private.rls_policies_backup`, só na primeira execução.
1. Cria funções auxiliares no schema `tai_private`, que não é exposto pela API:

   | Função | O que devolve |
   |---|---|
   | `is_active_status(text)` | regra de ativo do app (só `'inativo'`/`'inactive'`/`'desativado'` são inativos) |
   | `user_company()` | `"idEmpresa"` (uuid) do usuário logado, só se ativo; senão NULL |
   | `user_role()` | `tipo` do usuário logado, só se ativo |
   | `is_master()` / `is_manager()` / `is_writer()` | {Master} / {Master, Admin} / {Master, Admin, Operator} |

   As funções que leem `User` são `SECURITY DEFINER`, para não cair em recursão
   nas policies de `User`. Nas policies elas aparecem dentro de `(select …)`, para o
   Postgres calcular uma vez por consulta e não uma vez por linha.
2. **`atualizar_oee_geral()` passa a ser `SECURITY DEFINER`.** Todo UPDATE em
   `Maquinas` dispara `tg_atualiza_oee` → `calcular_oee_geral()`, que apaga e
   reinsere o `"OEE geral"` de todas as empresas. Hoje isso roda como o usuário do
   app. Sem este passo, o INSERT em `"OEE geral"` seria barrado e **toda edição de
   máquina pelo app falharia** (editar máquina, registrar perda no dashboard). Com
   ele, a função roda como `postgres`, exatamente como funciona hoje (com RLS aberto).
   É a **única alteração em objeto do legado**; o rollback desfaz.
3. `ENABLE ROW LEVEL SECURITY` em cada tabela, **sem `FORCE`**: máquinas e jobs
   gravam como `postgres` (dono), e o `FORCE` passaria a bloqueá-los.
4. Remove todas as policies que não são `tai_*` dessas 10 tabelas.
5. Cria as policies `tai_*`.

### O que cada policy faz

Todas são para `authenticated`. **Nenhuma** vale para `anon`: depois da migração, a
anon key sozinha não lê nem grava nada nessas 10 tabelas.

| Tabela | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| `Empresas` | própria; Master todas | Master | Master; Admin só a própria | Master |
| `User` | **a própria linha sempre** (até inativa, para o login mostrar "desativado"); usuários da própria empresa; Master todos | Master; Admin na própria empresa e **nunca com tipo Master** | Master; Admin na própria empresa, em linhas não-Master, sem promover a Master | Master; Admin na própria empresa, exceto Masters |
| `Sala` | própria; Master todas | Master | Master | Master |
| `Maquinas` | própria; Master todas | Master | Master; Admin **e Operador** da própria | Master |
| `variables` | via máquina da própria empresa; Master todas | Master; Admin da empresa da máquina | idem | idem |
| `dashboard_configs` | própria; Master todas | Master; Admin da própria | idem | — (negado; a FK apaga junto com a máquina) |
| `Apontamentos` | própria; Master todas | Master; Admin/Operador na própria | idem | Master; Admin da própria (*legado*) |
| `Ordem de serviço` | própria; Master todas | Master; Admin/Operador na própria | idem | Master; Admin da própria (*legado*) |
| `Relatório` | própria; Master todas | — | — | — |
| `OEE geral` | própria; Master todas | — | — | — |

Usuário inativo, ou sem linha em `User`: não lê nem grava nada (exceto a própria linha de `User`).

**Limitação conhecida (Maquinas):** RLS não restringe colunas. O Operador recebe UPDATE
na tabela inteira da própria empresa, porque o registro de perda grava as colunas de OEE
com a sessão dele. Para fechar isso, troque `registerMachineLoss` por uma função
`SECURITY DEFINER` que só some os minutos (isso também resolve a corrida de atualização,
I6) e limite o UPDATE de `Maquinas` a `is_manager()`.

---

## 4. Edge Functions (fora deste SQL, não implementado)

**`create-auth-user` (existente):** exige JWT válido e `tipo` admin/master. Ressalvas:
- **Não checa `Status`**: um Admin desativado com token ainda válido cria contas no Auth.
  Corrigir com `is_active_status` equivalente antes do `createUser`.
- Não recebe nem valida a empresa: a linha em `User` é criada pelo front e, com esta
  migração, a policy de INSERT garante a empresa e o tipo. Se o INSERT falhar, a conta no
  Auth fica órfã (I5). O ideal é a função criar as duas coisas.

**Desativar e remover acesso (C2):** hoje "remover usuário" apaga só a linha em `User`
(a FK `User.idRef → auth.users` tem cascade no sentido contrário, então a conta no Auth
fica), e "desativar" só muda `Status`. Com esta migração, o token de um usuário inativo
ou removido **não lê mais nada**, mas a conta continua emitindo tokens. O ideal é uma
Edge Function `manage-auth-user` (service role) que:
- valide que quem chama é Master, ou Admin **ativo** da mesma empresa do alvo;
- **desativar**: `auth.admin.updateUserById(id, { ban_duration: '876000h' })` e
  `Status = 'inativo'`; **reativar**: `ban_duration: 'none'` e `Status = 'ativo'`;
- **remover**: `auth.admin.deleteUser(id)`. A FK com `ON DELETE CASCADE` já apaga a
  linha em `User` junto;
- o front (`user.repository.supabase.ts`: `setStatus`/`remove`) passa a chamar essa função.

---

## 5. Riscos para o sistema legado e o que ainda conferir

Nos logs de 24h, o legado só acessou dados **logado** e só com o usuário Master. Isso é
pouco para concluir como ele se comporta com Admin, Operador, Vendedor e Cliente.

| Se o legado... | O que quebra | Como conferir / mitigar |
|---|---|---|
| usa a **anon key sem login** em alguma tela (ex.: tela pública, TV de fábrica) | leituras vazias, escritas com erro 42501 | revisar os logs de **7–14 dias** (a janela vista foi de 24h): `edge_logs` com `role = anon` fora de `/auth/` |
| tem tela que **lê várias empresas** com usuário não-Master | passa a ver só a própria empresa | perguntar a quem mantém o legado |
| tem **Vendedor** gravando algo (4 usuários) | escrita negada (Vendedor = visitante) | perguntar o que o papel Vendedor faz no legado; se escrever, incluir em `is_writer()` |
| **exclui** apontamentos ou O.S. com Operador | delete negado | trocar `is_manager()` por `is_writer()` nas duas policies de delete |
| **cria setores ou máquinas** com Admin | insert negado | liberar `is_manager()` + própria empresa nessas policies |
| apaga `dashboard_configs` | delete negado | adicionar policy de delete para managers |
| grava `Relatório`/`OEE geral` via API | insert negado | pelos jobs e triggers vistos, isso é feito como `postgres`: risco baixo |
| usa outras funções `SECURITY INVOKER` chamadas via `/rpc` que escrevem nessas tabelas | passam a respeitar as policies | 21 funções em `public`, todas INVOKER; conferir quais o legado chama por `/rpc` (logs com path `/rest/v1/rpc/`) |

---

## 6. Roteiro de teste (branch do Supabase)

1. **Antes:** revisar logs de 7–14 dias (anon e `/rpc/`) e conversar com quem mantém o
   legado sobre Vendedor, exclusões e telas multiempresa.
2. **Criar um branch** do projeto TAI seguindo `supabase/README.md`: o branch nasce do
   esquema inicial (`supabase/migrations/`), sem dados, então é preciso um seed com pelo
   menos 2 empresas, setores, máquinas, apontamentos, O.S. e relatórios em cada uma.
3. **Usuários de teste** no branch: `master@`, `admin-a@`, `operador-a@`, `vendedor-a@`
   e `cliente-a@` (empresa A, Status `''` para reproduzir produção), `admin-b@`
   (empresa B) e `inativo-a@` (Status `'inativo'`).
4. **Aplicar** o SQL no branch. Conferir os `NOTICE` (13 policies removidas) e rodar:
   ```sql
   select tablename, policyname, cmd from pg_policies
   where schemaname='public' and tablename not like 'alert_%' order by 1,2;
   -- devem sobrar só as tai_*
   ```
5. **Testar pelo tai-web** apontado para o branch (`VITE_SUPABASE_URL`/`ANON_KEY` do branch):

   | Usuário | Esperado |
   |---|---|
   | master | vê todas as empresas; Painel Master cria/edita/exclui empresa, setor e máquina |
   | admin-a | vê só a A; troca o logo; cria e remove usuário (não consegue criar Master); configura cards; **edita máquina e o OEE geral é recalculado** (passo 2) |
   | operador-a | cria e edita apontamento e O.S.; **registra perda no drilldown** (OEE da máquina e OEE geral mudam); não troca logo nem cria usuário |
   | vendedor-a / cliente-a | só leitura; qualquer escrita falha |
   | admin-b | não enxerga nada da A |
   | inativo-a | o login mostra "Este usuário está desativado" |

6. **Testar direto na API** (supabase-js ou curl):
   - anon key **sem login**: `select` em cada tabela retorna `[]`; `insert` falha.
   - admin-a: `update "User" set tipo='Master'` na própria linha → falha.
   - admin-a: `update "Maquinas"` numa máquina da B → 0 linhas.
   - operador-a: `insert "Apontamentos"` com `idRef` da B → falha.
   - inativo-a, com token ainda válido: `select` em `Maquinas` → `[]`.
7. **Realtime:** abrir Apontamentos como admin-a; um apontamento novo na A atualiza a
   tela, um na B não chega.
8. **Jobs e máquinas:** esperar uma virada de hora e confirmar que `copiar_dados_maquinas_para_relatorio`
   inseriu em `Relatório`; simular uma gravação de máquina como `postgres`.
9. **Legado:** apontar o legado para o branch (se possível) e percorrer as telas com
   um usuário de cada tipo, **inclusive Vendedor**.
10. **Rollback:** rodar o bloco de rollback no branch e confirmar que as 13 policies
    originais voltaram iguais e que `atualizar_oee_geral` voltou a INVOKER:
    ```sql
    select prosecdef from pg_proc where proname = 'atualizar_oee_geral'; -- false
    ```
11. Só então agendar a aplicação em produção, num horário de pouco uso, com o rollback à mão.

---

## 7. Achados extras do banco (não tratados aqui)

- **Renomear setor deixa o histórico com o nome antigo:** o rename propaga para
  `Maquinas.IDsala` (FK com cascade), mas não para `Apontamentos.Setor`,
  `"Ordem de serviço".setor` e `"Relatório".IDsala`, que são texto sem FK.
  Depois de renomear, os filtros por setor deixam de achar os registros antigos.
- **Security advisor:** 21 funções com `search_path` mutável, proteção contra senha
  vazada desligada no Auth, e o Postgres (17.4.1.074) com patches de segurança pendentes.
- `alert_events`/`alert_contacts` abertos para anon (seção 2).

## 8. Próximos passos depois desta migração

- Função `registrar_perda_maquina(maquina_id, categoria, minutos)` `SECURITY DEFINER`
  para tirar o UPDATE de `Maquinas` do Operador (e resolver I6).
- Edge Function de desativar e remover acesso; checagem de Status em `create-auth-user`.
- Gerar os tipos do banco (`supabase gen types`) e tipar o cliente (I16).

---

## 9. Alertas: `20261029_alertas_rls_e_check_thresholds.sql` (pendente)

Fecha o item "`alert_events`/`alert_contacts` abertos para anon" (seções 2 e 7) e corrige o job.
**Aplicar depois** de `20261015_rls_isolamento_por_empresa.sql`: usa as funções `tai_private.*`.

| Tabela | SELECT | INSERT / UPDATE / DELETE |
|---|---|---|
| `alert_contacts` | Master; Admin da própria empresa | idem |
| `alert_events` | Master; qualquer usuário ativo da empresa da variável | ninguém pela API (o job grava como `postgres`) |

`check_thresholds` passa a ignorar variável com `number_value` NULL ou `type = 'bool'`.
Antes, `NULL >= min_val` dava NULL e o job disparava alertas para essas variáveis.

**Conferir antes de aplicar:**
1. O cenário do **Make** atualiza `alert_events.status` pela API? Com qual chave? Com a anon
   key, essa escrita passa a ser negada (com a service_role continua funcionando).
2. O **legado** lê ou grava `alert_contacts`/`alert_events` com usuário não-Master?
3. Em produção, as variáveis booleanas usam mesmo `type = 'bool'`?
   (`select type, count(*) from variables group by 1;`)

**Teste no branch:** anon lê `[]` nas duas tabelas; admin-a lê só os contatos da A e não
consegue alterar contato da B (0 linhas); operador-a não lê contatos; o histórico de
alertas do tai-web mostra só os eventos da própria empresa; uma variável float com limites
e `number_value` NULL não gera `alert_events` depois do tempo de tolerância.
