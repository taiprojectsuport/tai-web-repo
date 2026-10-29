-- =============================================================================
-- Alertas: RLS em alert_contacts/alert_events e correcao do job check_thresholds
-- =============================================================================
-- STATUS: PENDENTE. NAO APLICAR EM PRODUCAO SEM TESTAR NUM BRANCH (ver LEIA-ME.md, secao 9).
-- DEPENDE de 20261015_rls_isolamento_por_empresa.sql (funcoes tai_private.* e as
-- policies de variables/Maquinas usadas no join do historico). Aplicar depois dela.
--
-- O que este arquivo faz:
--   1. Guarda copia das policies atuais de alert_contacts/alert_events (rollback).
--   2. Troca as policies "allow all ... to public" por policies tai_* para authenticated:
--      - alert_contacts: Master todas; Admin so da propria empresa (ler e gravar).
--        Operador e visitante nao leem: os telefones so aparecem para quem gerencia.
--      - alert_events: leitura pela empresa da variavel; ninguem grava pela API.
--        Quem grava e o job check_thresholds (pg_cron, como postgres: nao passa por RLS).
--   3. check_thresholds ignora variavel booleana e variavel sem valor. Antes, com
--      number_value NULL, "NULL >= min_val" dava NULL, o IF caia no ramo "fora da faixa"
--      e o job disparava alertas (vermelho: 4 rodadas, rearmando) para algo que a tela
--      nem mostra.
--
-- ATENCAO (conferir antes de aplicar): o cenario Make que envia o WhatsApp atualiza
-- alert_events.status ('enviado'/'falhou')? Se ele grava pela API com a anon key, essa
-- escrita passa a ser negada. Com a service_role key continua funcionando.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. Copia das policies atuais (mesma tabela de backup da migracao de RLS)
-- -----------------------------------------------------------------------------
insert into tai_private.rls_policies_backup (tablename, policyname, permissive, roles, cmd, qual, with_check)
select p.tablename, p.policyname, p.permissive, p.roles, p.cmd, p.qual, p.with_check
from pg_policies p
where p.schemaname = 'public'
  and p.tablename in ('alert_contacts', 'alert_events')
on conflict (tablename, policyname) do nothing;

-- -----------------------------------------------------------------------------
-- 2. RLS
-- -----------------------------------------------------------------------------
alter table public.alert_contacts enable row level security;
alter table public.alert_events   enable row level security;

do $$
declare
  r record;
begin
  for r in
    select p.policyname, p.tablename
    from pg_policies p
    where p.schemaname = 'public'
      and p.tablename in ('alert_contacts', 'alert_events')
      and p.policyname not like 'tai\_%'
  loop
    execute format('drop policy %I on public.%I', r.policyname, r.tablename);
    raise notice 'Removida policy: %.%', r.tablename, r.policyname;
  end loop;
end
$$;

-- alert_contacts.empresa_id e text (as outras colunas de empresa sao uuid).
drop policy if exists tai_alert_contacts_select on public.alert_contacts;
create policy tai_alert_contacts_select on public.alert_contacts
  for select to authenticated
  using ((select tai_private.is_master()) or ((select tai_private.is_manager()) and empresa_id = (select tai_private.user_company())::text));

drop policy if exists tai_alert_contacts_insert on public.alert_contacts;
create policy tai_alert_contacts_insert on public.alert_contacts
  for insert to authenticated
  with check ((select tai_private.is_master()) or ((select tai_private.is_manager()) and empresa_id = (select tai_private.user_company())::text));

drop policy if exists tai_alert_contacts_update on public.alert_contacts;
create policy tai_alert_contacts_update on public.alert_contacts
  for update to authenticated
  using ((select tai_private.is_master()) or ((select tai_private.is_manager()) and empresa_id = (select tai_private.user_company())::text))
  with check ((select tai_private.is_master()) or ((select tai_private.is_manager()) and empresa_id = (select tai_private.user_company())::text));

drop policy if exists tai_alert_contacts_delete on public.alert_contacts;
create policy tai_alert_contacts_delete on public.alert_contacts
  for delete to authenticated
  using ((select tai_private.is_master()) or ((select tai_private.is_manager()) and empresa_id = (select tai_private.user_company())::text));

-- alert_events nao tem coluna de empresa: herda da variavel -> maquina.
drop policy if exists tai_alert_events_select on public.alert_events;
create policy tai_alert_events_select on public.alert_events
  for select to authenticated
  using (
    (select tai_private.is_master())
    or exists (
      select 1
      from public.variables v
      join public."Maquinas" m on m.id = v.maquina_id
      where v.id = alert_events.variable_id and m."idRef" = (select tai_private.user_company())
    )
  );
-- Sem INSERT/UPDATE/DELETE para authenticated (ver ATENCAO no cabecalho).

-- -----------------------------------------------------------------------------
-- 3. check_thresholds: igual a producao, so com o filtro novo no WHERE do loop
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.check_thresholds()
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE
  v RECORD;
  c RECORD;
  _seconds_out numeric;
  _seconds_back numeric;
  _should_alert boolean;
BEGIN
  FOR v IN
    SELECT
      var.id, var.name, var.number_value, var.grandeza,
      var.min_val, var.max_val, var.timeout_min, var.level,
      var.last_alert_at, var.out_of_range_since, var.alert_count,
      var.back_in_range_since,
      m.maquina, m."IDsala",
      e.nome AS empresa_nome, e."idEmpresa" AS empresa_id
    FROM variables var
    LEFT JOIN "Maquinas" m ON m.id = var.maquina_id
    LEFT JOIN "Empresas" e ON e."idEmpresa" = m."idRef"
    WHERE (var.min_val IS NOT NULL OR var.max_val IS NOT NULL)
    AND var.level IN ('amarela', 'vermelha')
    -- Booleana nao tem faixa; sem valor nao da para comparar (NULL cairia no ramo "fora da faixa").
    AND var.number_value IS NOT NULL
    AND coalesce(var.type, '') <> 'bool'
  LOOP

    IF (v.min_val IS NULL OR v.number_value >= v.min_val)
    AND (v.max_val IS NULL OR v.number_value <= v.max_val) THEN

      IF v.back_in_range_since IS NULL AND v.out_of_range_since IS NOT NULL THEN
        UPDATE variables SET back_in_range_since = now() WHERE id = v.id;
        CONTINUE;
      END IF;

      IF v.back_in_range_since IS NOT NULL THEN
        _seconds_back := extract(epoch from (now() - v.back_in_range_since));
        IF _seconds_back >= (v.timeout_min * 60) THEN
          UPDATE variables
          SET out_of_range_since = null,
              back_in_range_since = null,
              alert_count = 0,
              last_alert_at = null
          WHERE id = v.id;
        END IF;
      END IF;

      CONTINUE;
    END IF;

    IF v.back_in_range_since IS NOT NULL THEN
      UPDATE variables SET back_in_range_since = null WHERE id = v.id;
    END IF;

    IF v.out_of_range_since IS NULL THEN
      UPDATE variables SET out_of_range_since = now() WHERE id = v.id;
      CONTINUE;
    END IF;

    _seconds_out := extract(epoch from (now() - v.out_of_range_since));
    IF _seconds_out < (v.timeout_min * 60) THEN
      CONTINUE;
    END IF;

    _should_alert := false;

    IF v.alert_count = 0 THEN
      _should_alert := true;
    ELSIF v.level = 'vermelha' THEN
      IF v.alert_count IN (1, 2) THEN
        IF extract(epoch from (now() - v.last_alert_at)) >= 600 THEN
          _should_alert := true;
        END IF;
      ELSIF v.alert_count = 3 THEN
        IF extract(epoch from (now() - v.last_alert_at)) >= 3600 THEN
          _should_alert := true;
        END IF;
      END IF;
    END IF;

    IF _should_alert THEN

      FOR c IN
        SELECT telefone, envio
        FROM alert_contacts
        WHERE empresa_id = v.empresa_id::text
      LOOP
        INSERT INTO alert_events (
          variable_id, triggered_at, empresa_nome, empresa_telefone,
          setor, maquina, variable_name, value_at_trigger,
          grandeza, min_val, max_val, timeout_min,
          level, hora_evento, dia_evento, status, envio
        ) VALUES (
          v.id, now(), v.empresa_nome, c.telefone,
          v."IDsala", v.maquina, v.name, v.number_value,
          v.grandeza, v.min_val, v.max_val, v.timeout_min,
          v.level,
          to_char(now() AT TIME ZONE 'America/Sao_Paulo', 'HH24:MI'),
          to_char(now() AT TIME ZONE 'America/Sao_Paulo', 'DD/MM/YYYY'),
          'pendente',
          CASE
            WHEN v.level = 'vermelha' AND c.envio = 'zap&call' THEN 'zap&call'
            ELSE 'zap'
          END
        );
      END LOOP;

      UPDATE variables
      SET last_alert_at = now(),
          alert_count = v.alert_count + 1
      WHERE id = v.id;

    END IF;

  END LOOP;
END;
$function$
;

commit;


-- =============================================================================
-- ROLLBACK (comentado). Rodar como uma unica transacao.
-- =============================================================================
-- begin;
-- drop policy if exists tai_alert_contacts_select on public.alert_contacts;
-- drop policy if exists tai_alert_contacts_insert on public.alert_contacts;
-- drop policy if exists tai_alert_contacts_update on public.alert_contacts;
-- drop policy if exists tai_alert_contacts_delete on public.alert_contacts;
-- drop policy if exists tai_alert_events_select on public.alert_events;
-- create policy "allow all" on public.alert_contacts as permissive for all to public using (true) with check (true);
-- create policy "allow all" on public.alert_events as permissive for all to public using (true) with check (true);
-- -- check_thresholds: recriar a versao do esquema inicial
-- -- (supabase/migrations/20260901000000_esquema_inicial.sql), sem as 3 linhas do filtro novo.
-- commit;
