import type { MachineFilters, MachineRepository } from "@/data/contracts/machine.repository";
import type {
  Machine,
  MachineCardSettings,
  MachineCustomVariable,
  MachineLossBreakdown,
  MachineLossMetric,
  MachineOption,
  MachineProductionConfig,
  MachineVariableType,
} from "@/domain/entities/machine";
import { AffectedSegment, MachineStatus } from "@/domain/types/enums";
import { formatNumberInput, parseOptionalNumber } from "@/domain/numbers";
import { supabase } from "@/lib/supabase-client";
import type { TablesUpdate } from "@/data/repositories/supabase/database.types";
import {
  dbVariableKeyToDomainKey,
  domainVariableKeyToDbKey,
  fetchAllRows,
  findVariableValue,
  flagsFromMachineStatus,
  hhmmToMinutes,
  hoursTextToNumber,
  machineCode,
  machineStatusFromFlags,
  minutesToHHMM,
  numberToHoursText,
} from "@/data/repositories/supabase/helpers";

const HIGH_VIBRATION_THRESHOLD = 0.55;
const HIGH_TEMPERATURE_THRESHOLD = 40;

interface MaquinaRow {
  id: number;
  IDsala: string;
  maquina: string | null;
  producao: boolean | null;
  parado: boolean | null;
  emergencia: boolean | null;
  horimetro: number | null;
  idRef: string;
  Temperatura: number | null;
  Vibração: number | null;
  unidProducao: string | null;
  OEE: number | null;
  OEE_disponibilidade: number | null;
  OEE_produtividade: number | null;
  OEE_qualidade: number | null;
  OEE_disp_quebra_falhas: string | null;
  OEE_disp_setup: string | null;
  OEE_disp_ociosidade: string | null;
  OEE_produt_peq_falhas: string | null;
  OEE_produt_qued_veloc: string | null;
  OEE_produt_def_mat_prima: string | null;
  OEE_qualidad_prod_nao_conform: string | null;
  OEE_qualidad_refugo: string | null;
  OEE_qualidad_retrabalho: string | null;
  OEE_Config_Unid_Med: string | null;
  VelocidadeAtual: number | null;
  ProdAtual: number | null;
  turno: string | null;
  OEE_Config_horas_Prod_prog: string | null;
  OEE_Config_Qnt_Produzida: number | null;
  OEE_Config_Tempo_Produz_seg: number | null;
  VelocidadeMax: number | null;
}

const MAQUINA_COLUMNS = [
  "id",
  "IDsala",
  "maquina",
  "producao",
  "parado",
  "emergencia",
  "horimetro",
  "idRef",
  "Temperatura",
  "Vibração",
  "unidProducao",
  "OEE",
  "OEE_disponibilidade",
  "OEE_produtividade",
  "OEE_qualidade",
  "OEE_disp_quebra_falhas",
  "OEE_disp_setup",
  "OEE_disp_ociosidade",
  "OEE_produt_peq_falhas",
  "OEE_produt_qued_veloc",
  "OEE_produt_def_mat_prima",
  "OEE_qualidad_prod_nao_conform",
  "OEE_qualidad_refugo",
  "OEE_qualidad_retrabalho",
  "OEE_Config_Unid_Med",
  "VelocidadeAtual",
  "ProdAtual",
  "turno",
  "OEE_Config_horas_Prod_prog",
  "OEE_Config_Qnt_Produzida",
  "OEE_Config_Tempo_Produz_seg",
  "VelocidadeMax",
].join(", ");

interface VariableRow {
  id: number;
  maquina_id: number;
  name: string | null;
  type: string | null;
  grandeza: string | null;
  number_value: number | null;
  bool_value: boolean | null;
}

interface DashboardConfigRow {
  id: string;
  id_empresa: string;
  maquina_id: number;
  selection: string[] | null;
  bottom_selection: string[] | null;
  bottom_enabled: boolean[] | null;
  top_enabled: boolean[] | null;
  oee_enabled: boolean | null;
  oee_graph_variable: string | null;
}

interface Extras {
  variablesByMachine: Map<number, VariableRow[]>;
  /** Uma maquina pode ter configs de mais de uma empresa (ex: visao do Master); ver `ownerConfig`. */
  configsByMachine: Map<number, DashboardConfigRow[]>;
  historyByMachine: Map<number, number[]>;
  reportVariablesByMachine: Map<number, Record<string, unknown>[]>;
}

interface HistoryRow {
  maquina_id: number;
  OEE: number | null;
  variables: Record<string, unknown> | null;
}

/** Trechos (minusculos) que identificam cada variavel fixa nas chaves de `Relatório.variables`. */
const BUILTIN_REPORT_MATCHERS: Record<string, string[]> = {
  horimeter: ["horímetro", "horimetro"],
  vibration: ["vibra"],
  temperature: ["temperatura"],
  speed: ["velocidade"],
  production: ["produção", "producao", "produc"],
};

function graphHistoryFor(
  key: string,
  customVariables: MachineCustomVariable[],
  reportVariables: Record<string, unknown>[],
): number[] {
  const custom = customVariables.find((v) => v.id === key);
  const matchers = BUILTIN_REPORT_MATCHERS[key] ?? (custom?.label ? [custom.label.toLowerCase()] : []);
  const hasMatch = (variables: Record<string, unknown>) =>
    Object.keys(variables).some((k) => matchers.some((m) => k.toLowerCase().includes(m)));
  return matchers.length === 0 ? [] : reportVariables.filter(hasMatch).map((v) => findVariableValue(v, matchers));
}

async function loadExtras(companyId: string | undefined, machineIds: number[]): Promise<Extras> {
  const variablesByMachine = new Map<number, VariableRow[]>();
  const configsByMachine = new Map<number, DashboardConfigRow[]>();
  const historyByMachine = new Map<number, number[]>();
  const reportVariablesByMachine = new Map<number, Record<string, unknown>[]>();
  if (machineIds.length === 0) return { variablesByMachine, configsByMachine, historyByMachine, reportVariablesByMachine };

  let configsQuery = supabase
    .from("dashboard_configs")
    .select("id, id_empresa, maquina_id, selection, bottom_selection, bottom_enabled, top_enabled, oee_enabled, oee_graph_variable")
    .in("maquina_id", machineIds);
  if (companyId) configsQuery = configsQuery.eq("id_empresa", companyId);

  let historyQuery = supabase
    .from("Relatório")
    .select("maquina_id, OEE, variables, created_at")
    .in("maquina_id", machineIds)
    .order("created_at", { ascending: false })
    .limit(machineIds.length * 12);
  if (companyId) historyQuery = historyQuery.eq("idRef", companyId);

  const [variablesRes, configsRes, historyRes] = await Promise.all([
    supabase
      .from("variables")
      .select("id, maquina_id, name, type, grandeza, number_value, bool_value")
      .in("maquina_id", machineIds),
    configsQuery,
    historyQuery,
  ]);
  if (variablesRes.error) throw new Error(variablesRes.error.message);
  if (configsRes.error) throw new Error(configsRes.error.message);
  if (historyRes.error) throw new Error(historyRes.error.message);

  for (const row of (variablesRes.data ?? []) as VariableRow[]) {
    const list = variablesByMachine.get(row.maquina_id) ?? [];
    list.push(row);
    variablesByMachine.set(row.maquina_id, list);
  }
  for (const row of (configsRes.data ?? []) as DashboardConfigRow[]) {
    const list = configsByMachine.get(row.maquina_id) ?? [];
    list.push(row);
    configsByMachine.set(row.maquina_id, list);
  }
  const historyDesc = new Map<number, number[]>();
  const reportVariablesDesc = new Map<number, Record<string, unknown>[]>();
  for (const row of (historyRes.data ?? []) as HistoryRow[]) {
    const list = historyDesc.get(row.maquina_id) ?? [];
    const variablesList = reportVariablesDesc.get(row.maquina_id) ?? [];
    if (list.length < 12) {
      list.push(Math.round((row.OEE ?? 0) * 100));
      variablesList.push(row.variables ?? {});
    }
    historyDesc.set(row.maquina_id, list);
    reportVariablesDesc.set(row.maquina_id, variablesList);
  }
  for (const [machineId, list] of historyDesc.entries()) {
    historyByMachine.set(machineId, [...list].reverse());
  }
  for (const [machineId, list] of reportVariablesDesc.entries()) {
    reportVariablesByMachine.set(machineId, [...list].reverse());
  }

  return { variablesByMachine, configsByMachine, historyByMachine, reportVariablesByMachine };
}

function toCustomVariable(row: VariableRow): MachineCustomVariable {
  const type = (row.type ?? "float") as MachineVariableType;
  return {
    id: String(row.id),
    label: row.name ?? "",
    type,
    unit: row.grandeza ?? undefined,
    value: type === "bool" ? String(!!row.bool_value) : formatNumberInput(row.number_value ?? 0),
    visible: true,
  };
}

function defaultCardSettings(): MachineCardSettings {
  return {
    showOeeCircle: true,
    topVariableKeys: ["horimeter", "vibration", "temperature"],
    topVariableVisible: [true, true, true],
    bottomVariableKeys: ["speed", "production"],
    bottomVariableVisible: [true, true],
  };
}

/** Prefere a config da empresa dona da maquina, que e onde `upsertCardSettings` grava. */
function ownerConfig(configs: DashboardConfigRow[] | undefined, ownerCompanyId: string): DashboardConfigRow | undefined {
  return configs?.find((c) => c.id_empresa === ownerCompanyId) ?? configs?.[0];
}

function toCardSettings(row: DashboardConfigRow | undefined): MachineCardSettings {
  if (!row) return defaultCardSettings();
  const top = (row.selection ?? []).map(dbVariableKeyToDomainKey);
  const bottom = (row.bottom_selection ?? []).map(dbVariableKeyToDomainKey);
  const topVisible = row.top_enabled ?? [true, true, true];
  const visible = row.bottom_enabled ?? [true, true];
  const fallback = defaultCardSettings();
  return {
    showOeeCircle: row.oee_enabled ?? true,
    topVariableKeys: [top[0] ?? fallback.topVariableKeys[0], top[1] ?? fallback.topVariableKeys[1], top[2] ?? fallback.topVariableKeys[2]],
    topVariableVisible: [topVisible[0] ?? true, topVisible[1] ?? true, topVisible[2] ?? true],
    bottomVariableKeys: [bottom[0] ?? fallback.bottomVariableKeys[0], bottom[1] ?? fallback.bottomVariableKeys[1]],
    bottomVariableVisible: [visible[0] ?? true, visible[1] ?? true],
    graphVariableKey: row.oee_graph_variable
      ? dbVariableKeyToDomainKey(row.oee_graph_variable)
      : (top[0] ?? fallback.topVariableKeys[0]),
  };
}

function toLossBreakdown(row: MaquinaRow): MachineLossBreakdown {
  return {
    availability: [
      { key: "breakdown", label: AffectedSegment.QUEBRAS_FALHAS, minutes: hhmmToMinutes(row.OEE_disp_quebra_falhas) },
      { key: "setup", label: AffectedSegment.SETUP, minutes: hhmmToMinutes(row.OEE_disp_setup) },
      { key: "idle", label: AffectedSegment.OCIOSIDADE, minutes: hhmmToMinutes(row.OEE_disp_ociosidade) },
    ],
    productivity: [
      { key: "small_stops", label: AffectedSegment.PEQUENAS_FALHAS, minutes: hhmmToMinutes(row.OEE_produt_peq_falhas) },
      { key: "reduced_speed", label: AffectedSegment.QUEDA_VELOCIDADE, minutes: hhmmToMinutes(row.OEE_produt_qued_veloc) },
      { key: "raw_material_defect", label: AffectedSegment.DEFEITO_MATERIA_PRIMA, minutes: hhmmToMinutes(row.OEE_produt_def_mat_prima) },
    ],
    quality: [
      { key: "non_conforming_product", label: AffectedSegment.PRODUTO_NAO_CONFORME, minutes: hhmmToMinutes(row.OEE_qualidad_prod_nao_conform) },
      { key: "scrap", label: AffectedSegment.REFUGO, minutes: hhmmToMinutes(row.OEE_qualidad_refugo) },
      { key: "rework", label: AffectedSegment.RETRABALHO, minutes: hhmmToMinutes(row.OEE_qualidad_retrabalho) },
    ],
  };
}

function toProductionConfig(row: MaquinaRow): MachineProductionConfig {
  return {
    shiftHours: hoursTextToNumber(row.turno),
    dailyProductionHours: hoursTextToNumber(row.OEE_Config_horas_Prod_prog),
    productUnit: row.OEE_Config_Unid_Med ?? "",
    producedQuantity: row.OEE_Config_Qnt_Produzida ?? 0,
    secondsPerUnit: row.OEE_Config_Tempo_Produz_seg ?? 0,
    maxSpeed: row.VelocidadeMax ?? 0,
  };
}

function toMachine(row: MaquinaRow, extras: Extras): Machine {
  const customVariables = (extras.variablesByMachine.get(row.id) ?? []).map(toCustomVariable);
  const cardSettings = toCardSettings(ownerConfig(extras.configsByMachine.get(row.id), row.idRef));
  const name = row.maquina ?? "";
  return {
    id: String(row.id),
    companyId: row.idRef,
    sectorId: row.IDsala,
    name,
    code: machineCode(name || String(row.id)),
    status: machineStatusFromFlags(row),
    oeePercent: Math.round((row.OEE ?? 0) * 100),
    availabilityPercent: Math.round((row.OEE_disponibilidade ?? 0) * 100),
    productivityPercent: Math.round((row.OEE_produtividade ?? 0) * 100),
    qualityPercent: Math.round((row.OEE_qualidade ?? 0) * 100),
    variables: {
      horimeterHours: row.horimetro ?? 0,
      vibrationMm: row.Vibração ?? 0,
      temperatureC: row.Temperatura ?? 0,
      speed: row.VelocidadeAtual ?? 0,
      speedUnit: "m/s",
      productionAmount: row.ProdAtual ?? 0,
      productionUnit: row.unidProducao ?? row.OEE_Config_Unid_Med ?? "un",
    },
    complementaryCount: customVariables.length,
    oeeHistory: extras.historyByMachine.get(row.id) ?? Array.from({ length: 12 }, () => 0),
    graphHistory: graphHistoryFor(
      cardSettings.graphVariableKey ?? cardSettings.topVariableKeys[0],
      customVariables,
      extras.reportVariablesByMachine.get(row.id) ?? [],
    ),
    customVariables,
    cardSettings,
    lossBreakdown: toLossBreakdown(row),
    productionConfig: toProductionConfig(row),
  };
}

/** `number_value` e numerico no banco; o formulario guarda texto. Vazio vira NULL, texto nao numerico e recusado. */
function numberValueToDb(variable: MachineCustomVariable): number | null {
  const parsed = parseOptionalNumber(variable.value);
  if (parsed === null) return null;
  if (!Number.isFinite(parsed)) throw new Error(`Valor inválido para a variável "${variable.label}": use um número.`);
  return parsed;
}

async function syncCustomVariables(machineId: number, customVariables: MachineCustomVariable[]): Promise<void> {
  const { data: existing, error } = await supabase.from("variables").select("id").eq("maquina_id", machineId);
  if (error) throw new Error(error.message);
  const existingIds = new Set((existing ?? []).map((r) => r.id as number));
  const incomingIds = new Set<number>();

  for (const variable of customVariables) {
    const numericId = Number(variable.id);
    const isExisting = Number.isFinite(numericId) && existingIds.has(numericId);
    const payload = {
      maquina_id: machineId,
      name: variable.label,
      type: variable.type,
      grandeza: variable.unit ?? null,
      number_value: variable.type === "bool" ? null : numberValueToDb(variable),
      bool_value: variable.type === "bool" ? variable.value === "true" : null,
      // Booleana nao tem faixa numerica: sem limites o job check_thresholds ignora a variavel
      // (com number_value NULL ele a trataria como fora da faixa e dispararia alertas).
      ...(variable.type === "bool" ? { min_val: null, max_val: null } : {}),
    };
    if (isExisting) {
      incomingIds.add(numericId);
      const { error: updateError } = await supabase.from("variables").update(payload).eq("id", numericId);
      if (updateError) throw new Error(updateError.message);
    } else {
      const { error: insertError } = await supabase.from("variables").insert(payload);
      if (insertError) throw new Error(insertError.message);
    }
  }

  const toDelete = [...existingIds].filter((id) => !incomingIds.has(id));
  if (toDelete.length > 0) {
    const { error: deleteError } = await supabase.from("variables").delete().in("id", toDelete);
    if (deleteError) throw new Error(deleteError.message);
  }
}

async function upsertCardSettings(companyId: string, machineId: number, cardSettings: MachineCardSettings): Promise<void> {
  const selection = cardSettings.topVariableKeys.map(domainVariableKeyToDbKey);
  const bottomSelection = cardSettings.bottomVariableKeys.map(domainVariableKeyToDbKey);
  const { data: existing, error } = await supabase
    .from("dashboard_configs")
    .select("id, oee_graph_variable")
    .eq("id_empresa", companyId)
    .eq("maquina_id", machineId)
    .maybeSingle();
  if (error) throw new Error(error.message);

  const payload = {
    selection,
    bottom_selection: bottomSelection,
    bottom_enabled: cardSettings.bottomVariableVisible,
    top_enabled: cardSettings.topVariableVisible,
    oee_enabled: cardSettings.showOeeCircle,
    oee_graph_variable: cardSettings.graphVariableKey
      ? domainVariableKeyToDbKey(cardSettings.graphVariableKey)
      : (existing?.oee_graph_variable ?? selection[0]),
    updated_at: new Date().toISOString(),
  };

  if (existing) {
    const { error: updateError } = await supabase.from("dashboard_configs").update(payload).eq("id", existing.id);
    if (updateError) throw new Error(updateError.message);
  } else {
    const { error: insertError } = await supabase
      .from("dashboard_configs")
      .insert({ id_empresa: companyId, maquina_id: machineId, ...payload });
    if (insertError) throw new Error(insertError.message);
  }
}

const DEFAULT_DAILY_PRODUCTION_HOURS = 8;

/** Coluna hhmm (texto) de cada categoria de perda, agrupadas pelo pilar de OEE que elas afetam. */
type LossColumn =
  | "OEE_disp_quebra_falhas"
  | "OEE_disp_setup"
  | "OEE_disp_ociosidade"
  | "OEE_produt_peq_falhas"
  | "OEE_produt_qued_veloc"
  | "OEE_produt_def_mat_prima"
  | "OEE_qualidad_prod_nao_conform"
  | "OEE_qualidad_refugo"
  | "OEE_qualidad_retrabalho";

const LOSS_COLUMN_BY_METRIC_CATEGORY: Record<MachineLossMetric, Record<string, LossColumn>> = {
  availability: {
    breakdown: "OEE_disp_quebra_falhas",
    setup: "OEE_disp_setup",
    idle: "OEE_disp_ociosidade",
  },
  productivity: {
    small_stops: "OEE_produt_peq_falhas",
    reduced_speed: "OEE_produt_qued_veloc",
    raw_material_defect: "OEE_produt_def_mat_prima",
  },
  quality: {
    non_conforming_product: "OEE_qualidad_prod_nao_conform",
    scrap: "OEE_qualidad_refugo",
    rework: "OEE_qualidad_retrabalho",
  },
};

/** % do pilar = 100 - (minutos perdidos / minutos de producao programada por dia), limitado a [0, 100]. */
function pillarPercentFromLossMinutes(lossMinutes: number, baselineMinutes: number): number {
  if (baselineMinutes <= 0) return 100;
  return Math.max(0, Math.min(100, Math.round(100 - (lossMinutes / baselineMinutes) * 100)));
}

async function registerMachineLoss(
  machineId: number,
  metric: MachineLossMetric,
  categoryKey: string,
  minutesToAdd: number,
): Promise<void> {
  const column = LOSS_COLUMN_BY_METRIC_CATEGORY[metric]?.[categoryKey];
  if (!column) throw new Error("Categoria de perda inválida.");

  const { data, error } = await supabase
    .from("Maquinas")
    .select(
      "id, OEE_disp_quebra_falhas, OEE_disp_setup, OEE_disp_ociosidade, OEE_produt_peq_falhas, OEE_produt_qued_veloc, OEE_produt_def_mat_prima, OEE_qualidad_prod_nao_conform, OEE_qualidad_refugo, OEE_qualidad_retrabalho, OEE_Config_horas_Prod_prog, turno",
    )
    .eq("id", machineId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Máquina não encontrada.");
  const current = data as unknown as MaquinaRow;

  const updatedMinutes = hhmmToMinutes(current[column] as string | null) + Math.max(0, Math.round(minutesToAdd));
  const minutesFor = (key: keyof MaquinaRow) =>
    key === column ? updatedMinutes : hhmmToMinutes(current[key] as string | null);

  const availabilityLoss =
    minutesFor("OEE_disp_quebra_falhas") + minutesFor("OEE_disp_setup") + minutesFor("OEE_disp_ociosidade");
  const productivityLoss =
    minutesFor("OEE_produt_peq_falhas") + minutesFor("OEE_produt_qued_veloc") + minutesFor("OEE_produt_def_mat_prima");
  const qualityLoss =
    minutesFor("OEE_qualidad_prod_nao_conform") +
    minutesFor("OEE_qualidad_refugo") +
    minutesFor("OEE_qualidad_retrabalho");

  const baselineMinutes =
    hoursTextToNumber(current.OEE_Config_horas_Prod_prog) * 60 || hoursTextToNumber(current.turno) * 60 || 480;

  const availabilityPercent = pillarPercentFromLossMinutes(availabilityLoss, baselineMinutes);
  const productivityPercent = pillarPercentFromLossMinutes(productivityLoss, baselineMinutes);
  const qualityPercent = pillarPercentFromLossMinutes(qualityLoss, baselineMinutes);
  const oeePercent = Math.round((availabilityPercent * productivityPercent * qualityPercent) / 10000);

  const payload: TablesUpdate<"Maquinas"> = {
    OEE_disponibilidade: availabilityPercent / 100,
    OEE_produtividade: productivityPercent / 100,
    OEE_qualidade: qualityPercent / 100,
    OEE: oeePercent / 100,
  };
  payload[column] = minutesToHHMM(updatedMinutes);

  const { error: updateError } = await supabase.from("Maquinas").update(payload).eq("id", machineId);
  if (updateError) throw new Error(updateError.message);
}

export class SupabaseMachineRepository implements MachineRepository {
  async listByCompany(companyId: string | undefined, filters?: MachineFilters): Promise<Machine[]> {
    let query = supabase.from("Maquinas").select(MAQUINA_COLUMNS);
    if (companyId) query = query.eq("idRef", companyId);
    if (filters?.sectorId) query = query.eq("IDsala", filters.sectorId);
    if (filters?.machineId) query = query.eq("id", Number(filters.machineId));

    const { data, error } = await query;
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as unknown as MaquinaRow[];
    const extras = await loadExtras(companyId, rows.map((r) => r.id));

    let machines = rows.map((row) => toMachine(row, extras));
    if (filters?.status) machines = machines.filter((m) => m.status === filters.status);
    if (filters?.highVibration) {
      machines = machines.filter((m) => m.variables.vibrationMm >= HIGH_VIBRATION_THRESHOLD);
    }
    if (filters?.highTemperature) {
      machines = machines.filter((m) => m.variables.temperatureC >= HIGH_TEMPERATURE_THRESHOLD);
    }
    return machines.sort((a, b) => a.name.localeCompare(b.name));
  }

  async listOptions(companyId: string | undefined): Promise<MachineOption[]> {
    // Sem variaveis, configs e historico de relatorios: so o que as listas de selecao usam.
    const rows = await fetchAllRows<Pick<MaquinaRow, "id" | "maquina" | "IDsala" | "idRef">>((from, to) => {
      let query = supabase.from("Maquinas").select('id, maquina, "IDsala", "idRef"');
      if (companyId) query = query.eq("idRef", companyId);
      return query.order("id").range(from, to);
    });
    return rows
      .map((row) => ({ id: String(row.id), companyId: row.idRef, sectorId: row.IDsala, name: row.maquina ?? "" }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async getById(id: string): Promise<Machine | null> {
    const { data, error } = await supabase
      .from("Maquinas")
      .select(MAQUINA_COLUMNS)
      .eq("id", Number(id))
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return null;
    const row = data as unknown as MaquinaRow;
    const extras = await loadExtras(row.idRef, [row.id]);
    return toMachine(row, extras);
  }

  async create(data: { companyId: string; sectorId: string; name: string }): Promise<Machine> {
    const flags = flagsFromMachineStatus(MachineStatus.PARADO);
    const { data: row, error } = await supabase
      .from("Maquinas")
      .insert({
        idRef: data.companyId,
        IDsala: data.sectorId,
        maquina: data.name,
        ...flags,
        horimetro: 0,
        Temperatura: 0,
        Vibração: 0,
        VelocidadeAtual: 0,
        ProdAtual: 0,
        OEE: 0,
        OEE_disponibilidade: 0,
        OEE_produtividade: 0,
        OEE_qualidade: 0,
        // Sempre gravado: um valor que nao seja hh:mm aqui derruba o reset diario de OEE de todas as maquinas.
        OEE_Config_horas_Prod_prog: numberToHoursText(DEFAULT_DAILY_PRODUCTION_HOURS),
      })
      .select(MAQUINA_COLUMNS)
      .single();
    if (error) throw new Error(error.message);
    const createdRow = row as unknown as MaquinaRow;
    const extras = await loadExtras(data.companyId, [createdRow.id]);
    return toMachine(createdRow, extras);
  }

  async remove(id: string): Promise<void> {
    const numericId = Number(id);
    const { error: variablesError } = await supabase.from("variables").delete().eq("maquina_id", numericId);
    if (variablesError) throw new Error(variablesError.message);
    const { error } = await supabase.from("Maquinas").delete().eq("id", numericId);
    if (error) throw new Error(error.message);
  }

  async update(
    id: string,
    data: Partial<Pick<Machine, "name" | "sectorId" | "customVariables" | "cardSettings" | "productionConfig">>,
  ): Promise<Machine> {
    const numericId = Number(id);
    const { data: currentRow, error: fetchError } = await supabase
      .from("Maquinas")
      .select("id, idRef")
      .eq("id", numericId)
      .maybeSingle();
    if (fetchError) throw new Error(fetchError.message);
    if (!currentRow) throw new Error("Máquina não encontrada.");

    const patch: TablesUpdate<"Maquinas"> = {};
    if (data.name !== undefined) patch.maquina = data.name;
    if (data.sectorId !== undefined) patch.IDsala = data.sectorId;
    if (data.productionConfig !== undefined) {
      const cfg = data.productionConfig;
      patch.turno = numberToHoursText(cfg.shiftHours);
      patch.OEE_Config_horas_Prod_prog = numberToHoursText(cfg.dailyProductionHours);
      patch.OEE_Config_Unid_Med = cfg.productUnit;
      patch.OEE_Config_Qnt_Produzida = Math.round(cfg.producedQuantity);
      patch.OEE_Config_Tempo_Produz_seg = cfg.secondsPerUnit;
      patch.VelocidadeMax = cfg.maxSpeed;
    }
    if (Object.keys(patch).length > 0) {
      const { error } = await supabase.from("Maquinas").update(patch).eq("id", numericId);
      if (error) throw new Error(error.message);
    }

    if (data.customVariables !== undefined) {
      await syncCustomVariables(numericId, data.customVariables);
    }
    if (data.cardSettings !== undefined) {
      await upsertCardSettings(currentRow.idRef as string, numericId, data.cardSettings);
    }

    const updated = await this.getById(id);
    if (!updated) throw new Error("Máquina não encontrada.");
    return updated;
  }

  async updateCardSettingsForAll(companyId: string, cardSettings: MachineCardSettings): Promise<Machine[]> {
    const { data: machines, error } = await supabase.from("Maquinas").select("id").eq("idRef", companyId);
    if (error) throw new Error(error.message);
    const ids = (machines ?? []).map((m) => m.id as number);
    await Promise.all(ids.map((machineId) => upsertCardSettings(companyId, machineId, cardSettings)));
    return this.listByCompany(companyId);
  }

  async registerLoss(machineId: string, metric: MachineLossMetric, categoryKey: string, minutes: number): Promise<Machine> {
    const numericId = Number(machineId);
    await registerMachineLoss(numericId, metric, categoryKey, minutes);
    const updated = await this.getById(machineId);
    if (!updated) throw new Error("Máquina não encontrada.");
    return updated;
  }
}
