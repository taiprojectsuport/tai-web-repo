import { describe, expect, it } from "vitest";
import { effectiveLevel, formatPhone, formatRange, isOutOfRange, isValidPhone, maskPhone, phoneDigits } from "@/domain/alerts";
import { formatNumberInput, parseOptionalNumber } from "@/domain/numbers";
import { alertContactSchema, alertRuleSchema } from "@/domain/schemas/alert.schema";

describe("telefone", () => {
  it("aceita DDD + 8 ou 9 digitos, com ou sem mascara", () => {
    expect(isValidPhone("21999998888")).toBe(true);
    expect(isValidPhone("(21) 99999-8888")).toBe(true);
    expect(isValidPhone(" 2133334444")).toBe(true);
    expect(isValidPhone("999998888")).toBe(false);
    expect(isValidPhone("5521999998888")).toBe(false);
  });

  it("formata e extrai digitos", () => {
    expect(phoneDigits(" (21) 99999-8888")).toBe("21999998888");
    expect(formatPhone("21999998888")).toBe("(21) 99999-8888");
    expect(formatPhone("2133334444")).toBe("(21) 3333-4444");
    expect(formatPhone("123")).toBe("123");
  });

  it("mascara o telefone para quem nao gerencia", () => {
    expect(maskPhone("21999998888")).toBe("(21) •••••-8888");
    expect(maskPhone("2133334444")).toBe("(21) ••••-4444");
  });
});

describe("faixa", () => {
  it("converte campo opcional", () => {
    expect(parseOptionalNumber("")).toBeNull();
    expect(parseOptionalNumber(" 4,5 ")).toBe(4.5);
    expect(parseOptionalNumber("abc")).toBeNaN();
  });

  it("le numeros no padrao brasileiro", () => {
    expect(parseOptionalNumber("1.000")).toBe(1000);
    expect(parseOptionalNumber("1.234,5")).toBe(1234.5);
    expect(parseOptionalNumber("-2.500.000")).toBe(-2500000);
    expect(parseOptionalNumber("4.5")).toBe(4.5);
    expect(parseOptionalNumber("0.500")).toBe(0.5);
    expect(parseOptionalNumber("1,2,3")).toBeNaN();
  });

  it("valor do banco volta igual depois de passar pelo formulario", () => {
    for (const n of [12.345, 1000, 0.5, -3.25, 7]) expect(parseOptionalNumber(formatNumberInput(n))).toBe(n);
  });

  it("detecta valor fora da faixa", () => {
    expect(isOutOfRange(5, 10, null)).toBe(true);
    expect(isOutOfRange(90, null, 80)).toBe(true);
    expect(isOutOfRange(50, 10, 80)).toBe(false);
    expect(isOutOfRange(null, 10, 80)).toBe(false);
    expect(isOutOfRange(50, null, null)).toBe(false);
  });

  it("sem limites o alerta nao vale, qualquer que seja o nivel gravado", () => {
    expect(effectiveLevel({ level: "yellow", min: null, max: null })).toBe("off");
    expect(effectiveLevel({ level: "red", min: 10, max: null })).toBe("red");
  });

  it("descreve a faixa", () => {
    expect(formatRange(10, 80, "bar")).toBe("10 – 80 bar");
    expect(formatRange(10, null)).toBe("≥ 10");
    expect(formatRange(null, 80, "°C")).toBe("≤ 80 °C");
    expect(formatRange(null, null)).toBe("Sem limites");
  });
});

describe("alertRuleSchema", () => {
  const base = { min: "10", max: "80", timeoutMinutes: "2", level: "yellow" as const };

  it("aceita uma regra valida e converte os minutos", () => {
    const result = alertRuleSchema.safeParse(base);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.timeoutMinutes).toBe(2);
  });

  it("recusa minimo maior que maximo", () => {
    expect(alertRuleSchema.safeParse({ ...base, min: "90" }).success).toBe(false);
  });

  it("recusa ligar o alerta sem nenhum limite", () => {
    expect(alertRuleSchema.safeParse({ ...base, min: "", max: "" }).success).toBe(false);
    expect(alertRuleSchema.safeParse({ ...base, min: "", max: "", level: "off" }).success).toBe(true);
  });

  it("recusa texto nos limites e tolerancia fora do intervalo", () => {
    expect(alertRuleSchema.safeParse({ ...base, max: "muito" }).success).toBe(false);
    expect(alertRuleSchema.safeParse({ ...base, timeoutMinutes: "0" }).success).toBe(false);
  });
});

describe("alertContactSchema", () => {
  it("valida telefone e envio", () => {
    expect(alertContactSchema.safeParse({ name: "Turno A", phone: "(21) 99999-8888", channel: "whatsapp" }).success).toBe(true);
    expect(alertContactSchema.safeParse({ name: "", phone: "123", channel: "whatsapp" }).success).toBe(false);
  });
});
