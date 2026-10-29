import { z } from "zod";
import { isValidPhone } from "@/domain/alerts";
import { parseOptionalNumber } from "@/domain/numbers";

/** Campos numericos ficam como texto no formulario e sao convertidos ao salvar (ver parseOptionalNumber). */
export const alertRuleSchema = z
  .object({
    min: z.string(),
    max: z.string(),
    timeoutMinutes: z.coerce
      .number({ invalid_type_error: "Informe os minutos." })
      .int("Use minutos inteiros.")
      .min(1, "Mínimo de 1 minuto.")
      .max(1440, "Máximo de 1440 minutos (24 h)."),
    level: z.enum(["off", "yellow", "red"]),
  })
  .superRefine((values, ctx) => {
    const min = parseOptionalNumber(values.min);
    const max = parseOptionalNumber(values.max);
    if (min !== null && !Number.isFinite(min)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["min"], message: "Use um número." });
    }
    if (max !== null && !Number.isFinite(max)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["max"], message: "Use um número." });
    }
    if (min !== null && max !== null && Number.isFinite(min) && Number.isFinite(max) && min > max) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["max"], message: "O máximo precisa ser maior que o mínimo." });
    }
    // Ligado sem nenhum limite: o job do banco ignora a variavel, o alerta nunca dispararia.
    if (values.level !== "off" && min === null && max === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["min"], message: "Informe o mínimo e/ou o máximo para ligar o alerta." });
    }
  });
export type AlertRuleFormValues = z.input<typeof alertRuleSchema>;

export const alertContactSchema = z.object({
  name: z.string().trim().max(60, "Use até 60 caracteres."),
  phone: z.string().refine(isValidPhone, "Informe DDD + número (10 ou 11 dígitos)."),
  channel: z.enum(["whatsapp", "whatsapp_call"]),
});
export type AlertContactFormValues = z.infer<typeof alertContactSchema>;
