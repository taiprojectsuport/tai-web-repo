/**
 * Numeros digitados em formularios, no padrao brasileiro. Independente de React/navegador.
 *
 * - virgula e o separador decimal: "4,5" -> 4.5; "1.234,5" -> 1234.5
 * - sem virgula, ponto seguido de grupos de 3 digitos e milhar: "1.000" -> 1000
 * - sem virgula, qualquer outro ponto e decimal: "4.5" -> 4.5; "0.500" -> 0.5
 */

const THOUSANDS_ONLY = /^-?[1-9]\d{0,2}(\.\d{3})+$/;

/** Campo numerico opcional: vazio vira null, texto invalido vira NaN. */
export function parseOptionalNumber(input: string): number | null {
  let raw = input.trim().replace(/\s/g, "");
  if (raw === "") return null;
  if (raw.includes(",")) raw = raw.replace(/\./g, "").replace(",", ".");
  else if (THOUSANDS_ONLY.test(raw)) raw = raw.replace(/\./g, "");
  return Number(raw);
}

/** Numero do banco para o campo do formulario, com virgula decimal (volta igual pelo parseOptionalNumber). */
export function formatNumberInput(value: number): string {
  return String(value).replace(".", ",");
}
