import { useMemo, useState } from "react";
import { BellRing, Pencil, Phone, Plus, Trash2 } from "lucide-react";
import { format, parseISO } from "date-fns";
import { cn } from "@/lib/utils";
import { Breadcrumb } from "@/components/layout/breadcrumb";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Pagination } from "@/components/ui/pagination";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { useAuth } from "@/features/auth/use-auth";
import { useCompanies } from "@/features/companies/queries";
import { canManageCompany } from "@/domain/permissions";
import { UserRole } from "@/domain/types/enums";
import { useDisclosure } from "@/hooks/use-disclosure";
import { usePageTitle } from "@/hooks/use-page-title";
import { toast } from "@/hooks/use-toast";
import {
  useAlertContacts,
  useAlertEvents,
  useAlertRules,
  useRemoveAlertContact,
  useSaveAlertContact,
  useUpdateAlertRule,
} from "@/features/alerts/queries";
import { AlertRuleDialog } from "@/features/alerts/components/alert-rule-dialog";
import { AlertContactDialog } from "@/features/alerts/components/alert-contact-dialog";
import { alertChannelLabels, alertLevelLabels, effectiveLevel, formatPhone, formatRange, isOutOfRange, maskPhone } from "@/domain/alerts";
import type { AlertContact, AlertEventStatus, AlertLevel, AlertRule } from "@/domain/entities/alert";
import type { AlertRuleUpdate } from "@/data/contracts/alert.repository";
import type { AlertContactFormValues } from "@/domain/schemas/alert.schema";

type Tab = "rules" | "contacts" | "history";
const EVENTS_PAGE_SIZE = 20;

const levelTone: Record<AlertLevel, "neutral" | "warning" | "danger"> = { off: "neutral", yellow: "warning", red: "danger" };
const statusLabel: Record<AlertEventStatus, string> = { pending: "Pendente", sent: "Enviado", failed: "Falhou" };
const statusTone: Record<AlertEventStatus, "neutral" | "success" | "danger"> = { pending: "neutral", sent: "success", failed: "danger" };

function formatDateTime(iso: string): string {
  try {
    return format(parseISO(iso), "dd/MM/yyyy HH:mm");
  } catch {
    return "-";
  }
}

export function AlertsPage() {
  usePageTitle("Alertas");
  const { user } = useAuth();
  const isMaster = user?.role === UserRole.MASTER;
  const canManage = canManageCompany(user?.role);
  const [tab, setTab] = useState<Tab>("rules");
  // Contatos e limites sao por empresa: o Master escolhe qual empresa configurar.
  const [selectedCompanyId, setSelectedCompanyId] = useState("");
  const companiesQuery = useCompanies("");
  const companyOptions = useMemo(
    () => (isMaster ? (companiesQuery.data ?? []).map((c) => ({ value: c.id, label: c.name })) : []),
    [isMaster, companiesQuery.data],
  );
  const companyId = isMaster ? selectedCompanyId || user?.companyId || "" : (user?.companyId ?? "");

  const tabs: { id: Tab; label: string }[] = [
    { id: "rules", label: "Limites" },
    // Telefones so para quem gerencia a empresa.
    ...(canManage ? [{ id: "contacts" as const, label: "Contatos" }] : []),
    { id: "history", label: "Histórico" },
  ];

  return (
    <div className="space-y-6">
      <div>
        <Breadcrumb current="Alertas" />
        <h1 className="font-display mt-1 text-2xl font-bold text-white sm:text-3xl">Alertas</h1>
        <p className="mt-1 text-sm text-muted">
          Avisos por WhatsApp quando uma variável de máquina sai da faixa definida. O banco confere as variáveis a cada minuto.
        </p>
      </div>

      {isMaster && (
        <div className="max-w-sm">
          <label htmlFor="alertas-empresa" className="label-caps mb-1.5 block">Empresa</label>
          <SearchableSelect
            id="alertas-empresa"
            options={companyOptions}
            value={companyId}
            onChange={setSelectedCompanyId}
            placeholder="Selecione a empresa"
            className="font-bold"
          />
        </div>
      )}

      <div className="flex gap-2" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              "rounded-xl px-4 py-2 text-xs font-bold uppercase tracking-wide transition-colors",
              tab === t.id ? "bg-brand text-white" : "bg-white/5 text-slate-300 hover:bg-white/10",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* key: ao trocar de empresa (Master), a pagina do historico e o dialogo abertos recomecam. */}
      {tab === "rules" && <RulesTab key={companyId} companyId={companyId} canManage={canManage} />}
      {tab === "contacts" && canManage && <ContactsTab key={companyId} companyId={companyId} />}
      {tab === "history" && <HistoryTab key={companyId} companyId={companyId} canManage={canManage} />}
    </div>
  );
}

function RulesTab({ companyId, canManage }: { companyId: string; canManage: boolean }) {
  const rulesQuery = useAlertRules(companyId);
  const updateRule = useUpdateAlertRule();
  const ruleDialog = useDisclosure();
  const [editing, setEditing] = useState<AlertRule | null>(null);

  const byMachine = useMemo(() => {
    const groups = new Map<string, AlertRule[]>();
    for (const rule of rulesQuery.data ?? []) {
      const list = groups.get(rule.machineId) ?? [];
      list.push(rule);
      groups.set(rule.machineId, list);
    }
    return [...groups.values()];
  }, [rulesQuery.data]);

  const handleSubmit = async (data: AlertRuleUpdate) => {
    if (!editing) return;
    try {
      await updateRule.mutateAsync({ variableId: editing.variableId, data });
      toast({ title: "Alerta salvo.", variant: "success" });
      ruleDialog.close();
    } catch (err) {
      toast({ title: "Não foi possível salvar o alerta.", description: err instanceof Error ? err.message : undefined, variant: "error" });
    }
  };

  if (rulesQuery.isLoading) return <Skeleton className="h-64 w-full" />;
  if (rulesQuery.isError) return <ErrorState message={rulesQuery.error instanceof Error ? rulesQuery.error.message : "Erro desconhecido."} onRetry={() => rulesQuery.refetch()} />;
  if (byMachine.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={<BellRing className="h-10 w-10" />}
          title="Nenhuma variável para monitorar"
          description="Os alertas usam as variáveis complementares das máquinas. Cadastre-as no formulário da máquina."
        />
      </Card>
    );
  }

  return (
    <>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {byMachine.map((rules) => (
          <Card key={rules[0]!.machineId} className="overflow-hidden">
            <div className="border-b border-panel-border px-5 py-3">
              <p className="text-sm font-bold text-white">{rules[0]!.machineName}</p>
              <p className="text-xs text-muted">{rules[0]!.sectorId}</p>
            </div>
            <ul className="divide-y divide-panel-border">
              {rules.map((rule) => {
                const level = effectiveLevel(rule);
                const hasLimits = rule.min !== null || rule.max !== null;
                const outOfRange = level !== "off" && isOutOfRange(rule.currentValue, rule.min, rule.max);
                return (
                  <li key={rule.variableId} className="flex items-center justify-between gap-3 px-5 py-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-slate-100">{rule.variableName}</p>
                      <p className="text-xs text-muted">
                        Atual:{" "}
                        <span className={cn("font-semibold", outOfRange ? "text-danger-light" : "text-slate-300")}>
                          {rule.currentValue ?? "-"}
                          {rule.unit ? ` ${rule.unit}` : ""}
                        </span>
                        {" · "}Faixa: {formatRange(rule.min, rule.max, rule.unit)}
                        {level !== "off" && ` · ${rule.timeoutMinutes} min`}
                      </p>
                      {rule.outOfRangeSince && level !== "off" && (
                        <p className="text-xs text-warning-light">Fora da faixa desde {formatDateTime(rule.outOfRangeSince)}</p>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Badge tone={levelTone[level]}>{hasLimits ? alertLevelLabels[level] : "Sem limite"}</Badge>
                      {canManage && (
                        <button
                          onClick={() => {
                            setEditing(rule);
                            ruleDialog.open();
                          }}
                          className="rounded-lg bg-white/5 p-2 text-muted transition-colors hover:bg-brand/10 hover:text-brand"
                          aria-label={`Editar alerta de ${rule.variableName} em ${rule.machineName}`}
                        >
                          <Pencil className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </Card>
        ))}
      </div>

      <AlertRuleDialog
        rule={editing}
        open={ruleDialog.isOpen}
        onOpenChange={ruleDialog.close}
        onSubmit={handleSubmit}
        isSubmitting={updateRule.isPending}
      />
    </>
  );
}

function ContactsTab({ companyId }: { companyId: string }) {
  const contactsQuery = useAlertContacts(companyId);
  const saveContact = useSaveAlertContact();
  const removeContact = useRemoveAlertContact();
  const contactDialog = useDisclosure();
  const removeDialog = useDisclosure();
  const [editing, setEditing] = useState<AlertContact | null>(null);
  const [removing, setRemoving] = useState<AlertContact | null>(null);

  const handleSubmit = async (values: AlertContactFormValues) => {
    try {
      await saveContact.mutateAsync({ id: editing?.id, companyId, data: values });
      toast({ title: editing ? "Contato atualizado." : "Contato cadastrado.", variant: "success" });
      contactDialog.close();
    } catch (err) {
      toast({ title: "Não foi possível salvar o contato.", description: err instanceof Error ? err.message : undefined, variant: "error" });
    }
  };

  const handleRemove = async () => {
    if (!removing) return;
    try {
      await removeContact.mutateAsync(removing.id);
      toast({ title: "Contato removido.", variant: "success" });
      removeDialog.close();
    } catch (err) {
      toast({ title: "Não foi possível remover o contato.", description: err instanceof Error ? err.message : undefined, variant: "error" });
    }
  };

  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between border-b border-panel-border px-6 py-4">
        <p className="text-sm font-semibold uppercase tracking-wide text-slate-200">Quem recebe os alertas</p>
        <Button
          onClick={() => {
            setEditing(null);
            contactDialog.open();
          }}
          className="h-auto gap-2 rounded-xl border-0 bg-brand/10 px-4 py-2 text-[11px] font-black uppercase tracking-wide text-brand hover:bg-brand hover:text-white"
        >
          <Plus className="h-3.5 w-3.5" /> Novo contato
        </Button>
      </div>

      <div className="space-y-3 p-4">
        {contactsQuery.isLoading && Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-16 w-full rounded-2xl" />)}
        {contactsQuery.isError && (
          <ErrorState message={contactsQuery.error instanceof Error ? contactsQuery.error.message : "Erro desconhecido."} onRetry={() => contactsQuery.refetch()} />
        )}
        {contactsQuery.isSuccess && contactsQuery.data.length === 0 && (
          <EmptyState
            icon={<Phone className="h-10 w-10" />}
            title="Nenhum contato cadastrado"
            description="Sem contatos, nenhum alerta é enviado, mesmo com limites configurados."
          />
        )}
        {contactsQuery.data?.map((contact) => (
          <div
            key={contact.id}
            className="flex items-center justify-between gap-3 rounded-2xl border border-panel-border bg-white/[0.03] p-4"
          >
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-slate-100">{contact.name || formatPhone(contact.phone)}</p>
              <p className="truncate text-xs text-muted">
                {contact.name ? `${formatPhone(contact.phone)} · ` : ""}
                {alertChannelLabels[contact.channel]}
              </p>
            </div>
            <div className="flex shrink-0 gap-2">
              <button
                onClick={() => {
                  setEditing(contact);
                  contactDialog.open();
                }}
                className="rounded-lg bg-white/5 p-2 text-muted transition-colors hover:bg-brand/10 hover:text-brand"
                aria-label={`Editar contato ${contact.name || formatPhone(contact.phone)}`}
              >
                <Pencil className="h-4 w-4" />
              </button>
              <button
                onClick={() => {
                  setRemoving(contact);
                  removeDialog.open();
                }}
                className="rounded-lg bg-white/5 p-2 text-muted transition-colors hover:bg-danger/10 hover:text-danger-light"
                aria-label={`Remover contato ${contact.name || formatPhone(contact.phone)}`}
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          </div>
        ))}
      </div>

      <AlertContactDialog
        contact={editing}
        open={contactDialog.isOpen}
        onOpenChange={contactDialog.close}
        onSubmit={handleSubmit}
        isSubmitting={saveContact.isPending}
      />
      <ConfirmDialog
        open={removeDialog.isOpen}
        onOpenChange={removeDialog.close}
        title="Remover contato"
        description={`Remover ${removing?.name || (removing ? formatPhone(removing.phone) : "")}? Ele deixa de receber os alertas.`}
        onConfirm={handleRemove}
        isLoading={removeContact.isPending}
        confirmLabel="Remover"
        variant="danger"
      />
    </Card>
  );
}

function HistoryTab({ companyId, canManage }: { companyId: string; canManage: boolean }) {
  const [page, setPage] = useState(1);
  const eventsQuery = useAlertEvents(companyId, page, EVENTS_PAGE_SIZE);
  const events = eventsQuery.data?.items ?? [];

  if (eventsQuery.isLoading) return <Skeleton className="h-64 w-full" />;
  if (eventsQuery.isError) return <ErrorState message={eventsQuery.error instanceof Error ? eventsQuery.error.message : "Erro desconhecido."} onRetry={() => eventsQuery.refetch()} />;

  return (
    <Card className="overflow-hidden">
      {events.length === 0 ? (
        <EmptyState icon={<BellRing className="h-10 w-10" />} title="Nenhum alerta disparado" />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="border-b border-panel-border text-[11px] font-bold uppercase tracking-wider text-muted">
              <tr>
                <th className="px-4 py-3">Quando</th>
                <th className="px-4 py-3">Máquina / Setor</th>
                <th className="px-4 py-3">Variável</th>
                <th className="px-4 py-3">Valor</th>
                <th className="px-4 py-3">Faixa</th>
                <th className="px-4 py-3">Nível</th>
                <th className="px-4 py-3">Contato</th>
                <th className="px-4 py-3">Envio</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-panel-border">
              {events.map((event) => (
                <tr key={event.id} className="text-slate-200">
                  <td className="whitespace-nowrap px-4 py-3">{formatDateTime(event.triggeredAt)}</td>
                  <td className="px-4 py-3">
                    <p className="font-semibold">{event.machineName}</p>
                    <p className="text-xs text-muted">{event.sectorName}</p>
                  </td>
                  <td className="px-4 py-3">{event.variableName}</td>
                  <td className="whitespace-nowrap px-4 py-3">
                    {event.value ?? "-"}
                    {event.unit ? ` ${event.unit}` : ""}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-muted">{formatRange(event.min, event.max, event.unit)}</td>
                  <td className="px-4 py-3">
                    <Badge tone={levelTone[event.level]}>{alertLevelLabels[event.level]}</Badge>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3">
                    {/* O job grava um alerta por contato: sem esta coluna as linhas pareceriam repetidas. */}
                    {event.contactPhone ? (canManage ? formatPhone(event.contactPhone) : maskPhone(event.contactPhone)) : "-"}
                  </td>
                  <td className="px-4 py-3">
                    <Badge tone={statusTone[event.status]}>{statusLabel[event.status]}</Badge>
                    <p className="mt-1 text-xs text-muted">{alertChannelLabels[event.channel]}</p>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pagination page={page} pageSize={EVENTS_PAGE_SIZE} total={eventsQuery.data?.total ?? 0} onPageChange={setPage} />
    </Card>
  );
}
