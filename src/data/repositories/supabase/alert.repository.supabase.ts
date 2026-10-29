import type { AlertContactInput, AlertRepository, AlertRuleUpdate } from "@/data/contracts/alert.repository";
import type { PagedResult } from "@/data/contracts/appointment.repository";
import type { AlertChannel, AlertContact, AlertEvent, AlertEventStatus, AlertLevel, AlertRule } from "@/domain/entities/alert";
import { phoneDigits } from "@/domain/alerts";
import { supabase } from "@/lib/supabase-client";
import type { Tables } from "@/data/repositories/supabase/database.types";
import { fetchAllRows, RANGE_NOT_SATISFIABLE } from "@/data/repositories/supabase/helpers";

// Os textos gravados no banco sao os mesmos que o job check_thresholds e o webhook do Make leem.
const LEVEL_FROM_DB: Record<string, AlertLevel> = { branca: "off", amarela: "yellow", vermelha: "red" };
const LEVEL_TO_DB: Record<AlertLevel, string> = { off: "branca", yellow: "amarela", red: "vermelha" };
const CHANNEL_FROM_DB: Record<string, AlertChannel> = { zap: "whatsapp", "zap&call": "whatsapp_call" };
const CHANNEL_TO_DB: Record<AlertChannel, string> = { whatsapp: "zap", whatsapp_call: "zap&call" };
const STATUS_FROM_DB: Record<string, AlertEventStatus> = { pendente: "pending", enviado: "sent", falhou: "failed" };

const levelFromDb = (level: string | null): AlertLevel => LEVEL_FROM_DB[level ?? ""] ?? "off";
const channelFromDb = (envio: string | null): AlertChannel => CHANNEL_FROM_DB[envio ?? ""] ?? "whatsapp";

type MachineRow = Pick<Tables<"Maquinas">, "id" | "maquina" | "IDsala">;
type VariableRow = Pick<
  Tables<"variables">,
  "id" | "maquina_id" | "name" | "type" | "grandeza" | "number_value" | "min_val" | "max_val" | "timeout_min" | "level" | "out_of_range_since" | "alert_count"
>;
type ContactRow = Pick<Tables<"alert_contacts">, "id" | "empresa_id" | "nome" | "telefone" | "envio">;
type EventRow = Pick<
  Tables<"alert_events">,
  | "id"
  | "triggered_at"
  | "empresa_telefone"
  | "maquina"
  | "setor"
  | "variable_name"
  | "value_at_trigger"
  | "grandeza"
  | "min_val"
  | "max_val"
  | "level"
  | "status"
  | "envio"
>;

const CONTACT_COLUMNS = "id, empresa_id, nome, telefone, envio";
// alert_events nao tem coluna de empresa: o join obrigatorio (!inner) com variavel -> maquina filtra pela empresa.
const EVENT_SELECT =
  "id, triggered_at, empresa_telefone, maquina, setor, variable_name, value_at_trigger, grandeza, min_val, max_val, level, status, envio, variables!inner(Maquinas!inner(idRef))";

function toContact(row: ContactRow): AlertContact {
  return {
    id: row.id,
    companyId: row.empresa_id,
    name: row.nome ?? "",
    phone: phoneDigits(row.telefone),
    channel: channelFromDb(row.envio),
  };
}

function toEvent(row: EventRow): AlertEvent {
  return {
    id: row.id,
    triggeredAt: row.triggered_at,
    contactPhone: phoneDigits(row.empresa_telefone ?? ""),
    machineName: row.maquina ?? "",
    sectorName: row.setor ?? "",
    variableName: row.variable_name ?? "",
    value: row.value_at_trigger,
    unit: row.grandeza ?? undefined,
    min: row.min_val,
    max: row.max_val,
    level: levelFromDb(row.level),
    status: STATUS_FROM_DB[row.status] ?? "pending",
    channel: channelFromDb(row.envio),
  };
}

function contactPayload(data: AlertContactInput) {
  return { nome: data.name.trim() || null, telefone: phoneDigits(data.phone), envio: CHANNEL_TO_DB[data.channel] };
}

async function listCompanyMachines(companyId: string): Promise<MachineRow[]> {
  return fetchAllRows<MachineRow>((from, to) =>
    supabase.from("Maquinas").select('id, maquina, "IDsala"').eq("idRef", companyId).order("id").range(from, to),
  );
}

async function listVariables(machineIds: number[]): Promise<VariableRow[]> {
  if (machineIds.length === 0) return [];
  return fetchAllRows<VariableRow>((from, to) =>
    supabase
      .from("variables")
      .select("id, maquina_id, name, type, grandeza, number_value, min_val, max_val, timeout_min, level, out_of_range_since, alert_count")
      .in("maquina_id", machineIds)
      .order("id")
      .range(from, to),
  );
}

export class SupabaseAlertRepository implements AlertRepository {
  async listRules(companyId: string): Promise<AlertRule[]> {
    const machines = await listCompanyMachines(companyId);
    const machineById = new Map(machines.map((m) => [m.id, m]));
    const variables = await listVariables(machines.map((m) => m.id));
    return variables
      // Variavel booleana nao tem faixa numerica: o job do banco compara numeros.
      .filter((v) => v.type !== "bool" && v.maquina_id !== null)
      .map((v) => {
        const machine = machineById.get(v.maquina_id as number);
        return {
          variableId: String(v.id),
          machineId: String(v.maquina_id),
          machineName: machine?.maquina ?? "",
          sectorId: machine?.IDsala ?? "",
          variableName: v.name ?? "",
          unit: v.grandeza ?? undefined,
          currentValue: v.number_value,
          min: v.min_val,
          max: v.max_val,
          timeoutMinutes: v.timeout_min ?? 1,
          level: levelFromDb(v.level),
          outOfRangeSince: v.out_of_range_since,
          alertCount: v.alert_count ?? 0,
        };
      })
      .sort((a, b) => a.machineName.localeCompare(b.machineName) || a.variableName.localeCompare(b.variableName));
  }

  async updateRule(variableId: string, rule: AlertRuleUpdate): Promise<void> {
    const { data, error } = await supabase
      .from("variables")
      .update({
        min_val: rule.min,
        max_val: rule.max,
        timeout_min: rule.timeoutMinutes,
        level: LEVEL_TO_DB[rule.level],
        // Com a regra nova, a contagem de alertas recomeca do zero.
        alert_count: 0,
        last_alert_at: null,
        out_of_range_since: null,
        back_in_range_since: null,
      })
      .eq("id", Number(variableId))
      .select("id");
    if (error) throw new Error(error.message);
    // Sem erro e sem linha: a variavel foi apagada ou o usuario nao pode altera-la (RLS).
    if (!data?.length) throw new Error("A variável não foi encontrada ou você não tem permissão para alterá-la.");
  }

  async listContacts(companyId: string): Promise<AlertContact[]> {
    const { data, error } = await supabase
      .from("alert_contacts")
      .select(CONTACT_COLUMNS)
      .eq("empresa_id", companyId)
      .order("created_at");
    if (error) throw new Error(error.message);
    return ((data ?? []) as ContactRow[]).map(toContact);
  }

  async createContact(companyId: string, data: AlertContactInput): Promise<AlertContact> {
    const { data: row, error } = await supabase
      .from("alert_contacts")
      .insert({ empresa_id: companyId, ...contactPayload(data) })
      .select(CONTACT_COLUMNS)
      .single();
    if (error) throw new Error(error.message);
    return toContact(row as ContactRow);
  }

  async updateContact(id: string, data: AlertContactInput): Promise<AlertContact> {
    const { data: row, error } = await supabase
      .from("alert_contacts")
      .update(contactPayload(data))
      .eq("id", id)
      .select(CONTACT_COLUMNS)
      .single();
    if (error) throw new Error(error.message);
    return toContact(row as ContactRow);
  }

  async removeContact(id: string): Promise<void> {
    const { data, error } = await supabase.from("alert_contacts").delete().eq("id", id).select("id");
    if (error) throw new Error(error.message);
    if (!data?.length) throw new Error("O contato não foi encontrado ou você não tem permissão para removê-lo.");
  }

  async listEvents(companyId: string, page: number, pageSize: number): Promise<PagedResult<AlertEvent>> {
    const start = (page - 1) * pageSize;
    const { data, error, count } = await supabase
      .from("alert_events")
      .select(EVENT_SELECT, { count: "exact" })
      .eq("variables.Maquinas.idRef", companyId)
      .order("triggered_at", { ascending: false })
      .order("id", { ascending: false })
      .range(start, start + pageSize - 1);
    if (error?.code === RANGE_NOT_SATISFIABLE) return { items: [], total: count ?? 0, page, pageSize };
    if (error) throw new Error(error.message);
    return { items: ((data ?? []) as EventRow[]).map(toEvent), total: count ?? 0, page, pageSize };
  }
}
