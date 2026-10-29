# Banco de dados (Supabase "TAI")

O banco de produção (`nmoyvzglbzamguzapoag`) é compartilhado com o sistema legado
(`app.smarttai.com.br`), com as máquinas e com os jobs do pg_cron. **Nada nesta pasta
deve ser rodado em produção sem revisão.**

## Pastas

| Pasta | O que é |
|---|---|
| `migrations/` | Histórico do schema. Serve para criar um banco **novo** igual à produção (branch de teste, ambiente local). |
| `migrations-pendentes/` | Mudanças preparadas e **não aplicadas** (hoje: RLS por empresa e RLS dos alertas). Ver o LEIA-ME de lá. |
| `seed.sql` | Dados fictícios para um branch de teste vazio. Nunca para produção. |

### `migrations/`

| Arquivo | Situação em produção |
|---|---|
| `20260901000000_esquema_inicial.sql` | **Não roda em produção:** produção já tem tudo isso. É o retrato do schema em 15/10/2026 (tabelas, constraints, funções, triggers, RLS/policies atuais, grants, Realtime, pg_cron). |
| `20260923113829_add_top_enabled_to_dashboard_configs.sql` | já aplicada (registrada no histórico) |
| `20261009131818_apontamentos_concluido_em.sql` | já aplicada |
| `20261009141844_corrige_default_horas_prod_prog.sql` | já aplicada |

Antes do esquema inicial, as tabelas tinham sido criadas pelo painel, sem migration.
Por isso um branch do Supabase nascia vazio. O esquema inicial tem data anterior às 3
migrations registradas, e elas são idempotentes. Num banco novo, a ordem
esquema inicial → 3 migrations roda sem erro.

O que **não** está no esquema inicial, de propósito:
- **Dados:** nenhuma linha. Um branch precisa de dados de teste (seed).
- **Webhook de `alert_events` → Make (alertas de WhatsApp):** fica comentado no fim
  do arquivo e sem as credenciais. Num branch, ele mandaria alertas reais.
- **Objetos dos schemas gerenciados pelo Supabase** (`auth`, `storage`, `realtime`…)
  e a Edge Function `create-auth-user`.

Verificação feita: os 21 corpos de função batem por md5 com produção (ignorando
espaços no fim das linhas), e os 4 arquivos passam no parser oficial do Postgres.

## Criar um branch de teste

O branch é um banco separado, com URL e chaves próprias: o que for feito nele não
chega em produção. Ele é cobrado por hora enquanto existe, então **apague depois do teste**.

1. Criar o branch (painel do Supabase → Branches, ou pela API/MCP).
2. Conferir o que o Supabase aplicou nele. O branch reaplica o histórico **registrado
   em produção**, que hoje tem só as 3 migrations antigas. Sem as tabelas, a primeira
   delas falha. Se isso acontecer, aplicar **no branch**, nesta ordem, os 4 arquivos
   de `migrations/`.
3. Carregar os dados de teste rodando `supabase/seed.sql` **no branch**: 2 empresas, setores,
   máquinas, apontamentos, O.S., relatórios das últimas 72h e um usuário de cada papel
   (senha `Teste@123`). O script aborta se o banco já tiver empresas, então não roda em produção.
4. Apontar o tai-web local para o branch, num `.env.local` com a URL e a anon key do branch.
5. Testar a migração de `migrations-pendentes/` seguindo o roteiro do LEIA-ME de lá.
6. Apagar o branch.

Para que os próximos branches já nasçam com o esquema inicial, ele precisa constar no
histórico de produção. Isso é feito com
`supabase migration repair --status applied 20260901000000`, que grava só uma linha em
`supabase_migrations.schema_migrations` e não muda tabela nenhuma. Mesmo assim é uma
escrita em produção: só com aprovação.

## Tipos do TypeScript

`src/data/repositories/supabase/database.types.ts` é gerado a partir deste schema.
Regere quando o banco mudar (`supabase gen types typescript --project-id nmoyvzglbzamguzapoag`).
