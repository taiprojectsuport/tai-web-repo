/**
 * Regras dos alertas por WhatsApp. Independente de React/navegador.
 *
 * Quem dispara e o job `checar-variaveis` do banco (funcao check_thresholds, a cada minuto):
 * - so olha variaveis com nivel amarelo/vermelho e com minimo e/ou maximo;
 * - fora da faixa por `timeoutMinutes` minutos -> cria um alerta por contato da empresa;
 * - amarelo avisa uma vez; vermelho avisa ate 4 vezes (na hora, +10 min, +10 min, +1 h);
 * - de volta a faixa por `timeoutMinutes` minutos -> zera e pode avisar de novo depois.
 */
import type { AlertChannel, AlertLevel } from "@/domain/entities/alert";

export const alertLevelLabels: Record<AlertLevel, string> = {
  off: "Desligado",
  yellow: "Amarelo",
  red: "Vermelho",
};

export const alertChannelLabels: Record<AlertChannel, string> = {
  whatsapp: "WhatsApp",
  whatsapp_call: "WhatsApp + ligação",
};

/** Explicacao curta de cada nivel, para a tela. */
export const alertLevelHints: Record<AlertLevel, string> = {
  off: "Não gera alertas.",
  yellow: "Avisa uma vez por WhatsApp.",
  red: "Avisa até 4 vezes (na hora, +10 min, +10 min e +1 h) e liga para quem tem ligação.",
};

/** So os digitos do telefone. */
export function phoneDigits(input: string): string {
  return input.replace(/\D/g, "");
}

/** DDD + 8 ou 9 digitos, sem codigo do pais (formato ja usado no banco). */
export function isValidPhone(input: string): boolean {
  const digits = phoneDigits(input);
  return digits.length === 10 || digits.length === 11;
}

/** "21999998888" -> "(21) 99999-8888". Fora do padrao, devolve como veio. */
export function formatPhone(input: string): string {
  const d = phoneDigits(input);
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return input.trim();
}

/** "21999998888" -> "(21) •••••-8888": para quem nao gerencia a empresa e nao ve os telefones. */
export function maskPhone(input: string): string {
  const d = phoneDigits(input);
  if (d.length < 6) return "•••";
  return `(${d.slice(0, 2)}) ${"•".repeat(d.length - 6)}-${d.slice(-4)}`;
}

/** O valor atual esta fora da faixa configurada? (sem limites ou sem valor = nao esta) */
export function isOutOfRange(value: number | null, min: number | null, max: number | null): boolean {
  if (value === null) return false;
  if (min !== null && value < min) return true;
  if (max !== null && value > max) return true;
  return false;
}

/**
 * Nivel que de fato vale: sem minimo nem maximo o job do banco ignora a variavel, mesmo com nivel
 * amarelo/vermelho gravado (o padrao da coluna `level` e 'amarela').
 */
export function effectiveLevel(rule: { level: AlertLevel; min: number | null; max: number | null }): AlertLevel {
  return rule.min === null && rule.max === null ? "off" : rule.level;
}

/** Texto da faixa para a tela: "10 – 80 bar", "≥ 10 bar", "≤ 80 bar" ou "Sem limites". */
export function formatRange(min: number | null, max: number | null, unit?: string): string {
  const suffix = unit ? ` ${unit}` : "";
  if (min !== null && max !== null) return `${min} – ${max}${suffix}`;
  if (min !== null) return `≥ ${min}${suffix}`;
  if (max !== null) return `≤ ${max}${suffix}`;
  return "Sem limites";
}
