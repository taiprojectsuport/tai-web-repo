# Tai Project — Painel Web Administrativo

Painel web administrativo da plataforma industrial **Tai Project**, feito com
React + Vite + TypeScript (modo `strict`).

Repositório: https://github.com/taiprojectsuport/tai-web-repo

O painel roda sobre o **Supabase** de produção ("TAI"), o mesmo banco usado pelo
sistema legado (`app.smarttai.com.br`), pelas máquinas e pelos jobs do pg_cron.
Ele usa o schema que já existia (`Empresas`, `User`, `Sala`, `Maquinas`,
`variables`, `dashboard_configs`, `Apontamentos`, `Ordem de serviço`,
`Relatório`, `OEE geral`, `alert_contacts`, `alert_events`). Não há dados
mockados: tudo é lido e gravado no banco.

## Como instalar e executar

Pré-requisitos: Node.js 18+ e npm, e as variáveis de ambiente do Supabase.

```bash
git clone https://github.com/taiprojectsuport/tai-web-repo.git
cd tai-web-repo
cp .env.example .env   # preencha VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY
npm install
npm run dev
```

A aplicação sobe em `http://localhost:5173`.

Outros scripts:

```bash
npm run build       # typecheck (tsc -b) + build de produção (vite build)
npm run preview     # serve o build de produção localmente
npm run lint        # ESLint (sem warnings permitidos)
npm run typecheck   # só checagem de tipos
npm run test        # testes unitários (Vitest)
```

Para testar mudanças de banco sem tocar em produção, use um branch do Supabase:
veja `supabase/README.md`.

## Autenticação e perfis

O login usa o Supabase Auth (`auth.signInWithPassword`). O perfil do usuário
(empresa, nome, papel) vem da tabela `User`, ligada ao `auth.users` por `idRef`.
A sessão é guardada pelo próprio client do Supabase.

- Usuário com `Status` inativo (`inativo`, `inactive` ou `desativado`) tem o
  login bloqueado com mensagem própria.
- Criar um acesso em Configurações também cria a conta no Auth, pela Edge
  Function `create-auth-user` (roda com a service role; só Admin/Master chamam).
- Papéis (`User.tipo`): **Master** vê todas as empresas e o Painel Master;
  **Admin** gerencia a própria empresa; **Operator** lança apontamentos e O.S.;
  qualquer outro tipo (Cliente, Vendedor...) só lê. As regras ficam em
  `src/domain/permissions.ts`.
- `/painel-master` só abre para Master; outros perfis vão para `/acesso-negado`.

## Telas

1. **Login** (`/login`): Supabase Auth, mostrar/ocultar senha, validação Zod e
   aviso de usuário desativado.
2. **Dashboard** (`/dashboard`): indicadores de OEE, Disponibilidade,
   Produtividade e Qualidade; cards por máquina com as variáveis escolhidas na
   configuração do card; filtros por setor, máquina e status. Atualiza a cada
   5 segundos. O detalhe da máquina permite registrar perdas (minutos por
   categoria), que recalculam o OEE.
3. **Apontamentos** (`/apontamentos`): listagem paginada com filtros (período,
   setor, máquina, lançador) na URL, criação, edição e conclusão. Atualiza em
   tempo real (Supabase Realtime).
4. **Ordem de Serviço** (`/ordens-de-servico`): listagem com busca e filtros,
   criação, edição e detalhes; status Lançado, Realizado, Concluído e Atrasado.
   Também em tempo real.
5. **Relatórios** (`/relatorios`): histórico da tabela `Relatório` com filtros
   por período, setor e máquina, e exportação em CSV.
6. **Alertas** (`/alertas`): alertas por WhatsApp das variáveis das máquinas.
   - *Limites*: mínimo, máximo, tolerância em minutos e nível (Amarelo avisa uma
     vez; Vermelho avisa até 4 vezes e liga para quem tem ligação).
   - *Contatos* (só Master/Admin): quem recebe, por WhatsApp ou WhatsApp + ligação.
   - *Histórico*: alertas disparados, um por contato.
   - O Master escolhe a empresa no topo da página.
   - Quem dispara é o banco: o job `checar-variaveis` (função `check_thresholds`,
     a cada minuto) grava em `alert_events`, e um webhook manda para o Make.
7. **Configurações** (`/configuracoes`): logotipo da empresa (PNG, JPG ou SVG,
   até 2 MB) e usuários (criar, editar, ativar/desativar, remover).
8. **Painel Master** (`/painel-master`): empresas, setores e máquinas (criar,
   editar, excluir), com as variáveis complementares de cada máquina.
9. **Acesso negado** (`/acesso-negado`) e **404** (`*`).

Os números digitados nos formulários seguem o padrão brasileiro: `4,5` é quatro
e meio e `1.000` é mil (`src/domain/numbers.ts`).

## Estrutura do projeto

```text
src/
  app/              # bootstrap da aplicação (App, providers globais)
  components/
    ui/             # design system (Button, Input, Dialog, Select pesquisável...)
    layout/         # Sidebar, AppShell, ProtectedRoute, RoleGuard, drawer mobile
  features/         # uma pasta por tela: auth, dashboard, appointments,
                    # work-orders, reports, alerts, settings, companies, errors
    <feature>/
      <feature>-page.tsx   # página (rota)
      queries.ts           # hooks do TanStack Query (leitura/escrita)
      components/          # componentes da tela (formulários, cards, diálogos)
  domain/
    entities/       # tipos de domínio (Company, User, Machine, Appointment, Alert...)
    schemas/        # validações Zod + tipos dos formulários
    types/          # enums (status, perfis...)
    *.ts            # regras puras: permissões, alertas, números, horários
  data/
    contracts/      # interfaces dos repositórios
    repositories/
      supabase/     # implementação sobre o Supabase (+ realtime e tipos do banco)
      index.ts      # ponto único de onde a app pega os repositórios
  hooks/            # paginação, filtros na URL, invalidação ao vivo, toast...
  lib/              # utilitários (cn, csv, labels, storage, client do Supabase)
  routes/           # React Router (páginas carregadas sob demanda)
  styles/           # CSS global + tokens Tailwind
supabase/
  migrations/             # histórico do schema (para criar um banco igual ao de produção)
  migrations-pendentes/   # mudanças preparadas e ainda NÃO aplicadas
  seed.sql                # dados fictícios para branch de teste
```

Regras de arquitetura:

- Telas nunca falam direto com o Supabase: toda leitura e escrita passa pelas
  interfaces de `data/contracts`, resolvidas em `data/repositories/index.ts`.
- `domain/` não importa nada de React nem do navegador: são módulos puros em
  TypeScript, com testes, prontos para um pacote compartilhado com o futuro app
  React Native.

## Sobre o schema do Supabase

O schema é legado, em português, e já estava em produção antes deste painel.
Por isso os adaptadores fazem algumas traduções:

- **Setor é identificado pelo nome**: `Sala.sala` (texto) é a chave usada por
  `Maquinas.IDsala`, `Apontamentos.Setor` e `"Ordem de serviço".setor`.
- **Máquina e usuário são referenciados por nome em `Apontamentos` e
  `"Ordem de serviço"`**: os adaptadores resolvem isso em
  `data/repositories/supabase/company-lookups.ts`.
- **`Empresas` não tem colunas de e-mail nem de status.** O e-mail mostrado vem
  do usuário Master/Admin da empresa.
- **`Relatório`** (cópia horária das máquinas, feita por job) e **`OEE geral`**
  guardam o histórico usado em Relatórios e no Dashboard.
- **Alertas**: os limites ficam na própria `variables` (`min_val`, `max_val`,
  `timeout_min`, `level`); `alert_events` não tem coluna de empresa e é filtrada
  pela máquina da variável.

### Situação de segurança do banco

Hoje as tabelas têm políticas de RLS abertas: com a anon key é possível ler e
gravar dados de qualquer empresa. Os filtros por empresa feitos no front não
protegem nada. As correções estão prontas, mas **não aplicadas** em produção:

- `supabase/migrations-pendentes/20261015_rls_isolamento_por_empresa.sql`:
  isolamento por empresa e permissão por papel nas tabelas principais (testada
  num branch do Supabase).
- `supabase/migrations-pendentes/20261029_alertas_rls_e_check_thresholds.sql`:
  RLS de `alert_contacts`/`alert_events` e correção do job de alertas. Depende
  da anterior.

Antes de aplicar, siga o roteiro e as pendências de
`supabase/migrations-pendentes/LEIA-ME.md`.

## O que pode ser compartilhado com o futuro app React Native

Sem dependência de DOM/navegador:

- `src/domain/` inteiro (entities, schemas Zod, enums e regras).
- `src/data/contracts/` (interfaces dos repositórios).
- `src/lib/utils.ts` e `src/lib/labels.ts`. Evitar `lib/csv.ts` e
  `lib/storage.ts`, que usam APIs do navegador.

Não compartilhar: `components/ui`, `components/layout`, `features/**/*-page.tsx`
e tudo que usa Tailwind/DOM. No React Native essas camadas são refeitas, usando
os mesmos hooks de `queries.ts` sempre que possível.

## Decisões de design

- Tema escuro industrial (fundo azul-marinho, cards azul-acinzentados, azul
  elétrico como cor primária, verde/laranja/vermelho para sucesso/alerta/erro).
- Select pesquisável próprio (`components/ui/searchable-select.tsx`) em todos os
  filtros e formulários, com `@radix-ui/react-popover` para o dropdown nunca
  ser cortado.
- Sidebar recolhível no desktop (estado salvo) e drawer no mobile.
- Tabelas com rolagem horizontal controlada; nenhuma função fica escondida no
  mobile.
