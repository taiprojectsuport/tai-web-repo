/** Nivel do alerta de uma variavel. `off` = nao monitorada (o job do banco ignora). */
export type AlertLevel = "off" | "yellow" | "red";

/** Como o contato e avisado. Ligacao so acontece em alerta vermelho. */
export type AlertChannel = "whatsapp" | "whatsapp_call";

export type AlertEventStatus = "pending" | "sent" | "failed";

/** Limites de alerta de uma variavel complementar de maquina (tabela `variables`). */
export interface AlertRule {
  variableId: string;
  machineId: string;
  machineName: string;
  sectorId: string;
  variableName: string;
  unit?: string;
  currentValue: number | null;
  min: number | null;
  max: number | null;
  /** Minutos fora (ou de volta) da faixa antes de avisar (ou de zerar o alerta). */
  timeoutMinutes: number;
  level: AlertLevel;
  outOfRangeSince: string | null;
  alertCount: number;
}

export interface AlertContact {
  id: string;
  companyId: string;
  name: string;
  /** So digitos: DDD + numero (10 ou 11 digitos). */
  phone: string;
  channel: AlertChannel;
}

export interface AlertEvent {
  id: string;
  triggeredAt: string;
  /** Contato avisado: o job grava um alerta por contato. So digitos. */
  contactPhone: string;
  machineName: string;
  sectorName: string;
  variableName: string;
  value: number | null;
  unit?: string;
  min: number | null;
  max: number | null;
  level: AlertLevel;
  status: AlertEventStatus;
  channel: AlertChannel;
}
