import { useEffect } from "react";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { FieldError, FieldLabel, Input } from "@/components/ui/input";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { alertRuleSchema, type AlertRuleFormValues } from "@/domain/schemas/alert.schema";
import { alertLevelHints, alertLevelLabels, effectiveLevel } from "@/domain/alerts";
import { formatNumberInput, parseOptionalNumber } from "@/domain/numbers";
import type { AlertRuleUpdate } from "@/data/contracts/alert.repository";
import type { AlertLevel, AlertRule } from "@/domain/entities/alert";

const levelOptions = (Object.keys(alertLevelLabels) as AlertLevel[]).map((level) => ({
  value: level,
  label: alertLevelLabels[level],
}));

function toFormValues(rule: AlertRule | null): AlertRuleFormValues {
  return {
    min: rule?.min != null ? formatNumberInput(rule.min) : "",
    max: rule?.max != null ? formatNumberInput(rule.max) : "",
    timeoutMinutes: rule?.timeoutMinutes ?? 1,
    // Mesmo nivel do card: sem limites o nivel gravado (padrao 'amarela') nao vale.
    level: rule ? effectiveLevel(rule) : "off",
  };
}

export function AlertRuleDialog({
  rule,
  open,
  onOpenChange,
  onSubmit,
  isSubmitting,
}: {
  rule: AlertRule | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (data: AlertRuleUpdate) => Promise<void>;
  isSubmitting: boolean;
}) {
  const {
    register,
    handleSubmit,
    control,
    reset,
    watch,
    formState: { errors },
  } = useForm<AlertRuleFormValues>({ resolver: zodResolver(alertRuleSchema), defaultValues: toFormValues(rule) });

  useEffect(() => {
    if (open) reset(toFormValues(rule));
  }, [open, rule, reset]);

  const level = watch("level");
  const unit = rule?.unit ? ` (${rule.unit})` : "";

  const submit = handleSubmit((values) =>
    onSubmit({
      min: parseOptionalNumber(values.min),
      max: parseOptionalNumber(values.max),
      timeoutMinutes: Number(values.timeoutMinutes),
      level: values.level,
    }),
  );

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Alerta de ${rule?.variableName ?? "variável"}`}
      description={rule ? `${rule.machineName} · ${rule.sectorId}` : undefined}
      size="sm"
      footer={
        <Button form="alert-rule-form" type="submit" isLoading={isSubmitting} className="w-full rounded-2xl py-5 text-sm font-black uppercase">
          Salvar alerta
        </Button>
      }
    >
      <form id="alert-rule-form" onSubmit={submit} noValidate className="space-y-5">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <FieldLabel>Mínimo{unit}</FieldLabel>
            <Input inputMode="decimal" placeholder="Sem mínimo" error={errors.min?.message} className="h-auto px-4 py-3" {...register("min")} />
            <FieldError message={errors.min?.message} />
          </div>
          <div>
            <FieldLabel>Máximo{unit}</FieldLabel>
            <Input inputMode="decimal" placeholder="Sem máximo" error={errors.max?.message} className="h-auto px-4 py-3" {...register("max")} />
            <FieldError message={errors.max?.message} />
          </div>
        </div>

        <div>
          <FieldLabel>Tolerância (minutos fora da faixa antes de avisar)</FieldLabel>
          <Input type="number" min={1} max={1440} error={errors.timeoutMinutes?.message} className="h-auto px-4 py-3" {...register("timeoutMinutes")} />
          <FieldError message={errors.timeoutMinutes?.message} />
        </div>

        <div>
          <FieldLabel>Nível</FieldLabel>
          <Controller
            control={control}
            name="level"
            render={({ field }) => (
              <SearchableSelect
                options={levelOptions}
                value={field.value}
                onChange={field.onChange}
                searchable={false}
                className="h-auto rounded-xl px-4 py-3 text-sm font-bold"
              />
            )}
          />
          <p className="mt-1.5 text-xs text-muted">{alertLevelHints[level]}</p>
        </div>

        {rule && rule.currentValue !== null && (
          <p className="rounded-xl border border-white/5 bg-white/[0.03] px-4 py-3 text-xs text-muted">
            Valor atual: <span className="font-semibold text-slate-200">{rule.currentValue}{rule.unit ? ` ${rule.unit}` : ""}</span>.
            Ao salvar, a contagem de avisos desta variável recomeça do zero.
          </p>
        )}
      </form>
    </Dialog>
  );
}
