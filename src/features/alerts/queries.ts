import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { repositories } from "@/data/repositories";
import type { AlertContactInput, AlertRuleUpdate } from "@/data/contracts/alert.repository";

const KEY = "alerts";

export function useAlertRules(companyId: string) {
  return useQuery({
    queryKey: [KEY, "rules", companyId],
    queryFn: () => repositories.alerts.listRules(companyId),
    enabled: !!companyId,
  });
}

export function useAlertContacts(companyId: string) {
  return useQuery({
    queryKey: [KEY, "contacts", companyId],
    queryFn: () => repositories.alerts.listContacts(companyId),
    enabled: !!companyId,
  });
}

export function useAlertEvents(companyId: string, page: number, pageSize: number) {
  return useQuery({
    queryKey: [KEY, "events", companyId, page, pageSize],
    queryFn: () => repositories.alerts.listEvents(companyId, page, pageSize),
    enabled: !!companyId,
    placeholderData: keepPreviousData,
  });
}

export function useUpdateAlertRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ variableId, data }: { variableId: string; data: AlertRuleUpdate }) =>
      repositories.alerts.updateRule(variableId, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY, "rules"] }),
  });
}

export function useSaveAlertContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, companyId, data }: { id?: string; companyId: string; data: AlertContactInput }) =>
      id ? repositories.alerts.updateContact(id, data) : repositories.alerts.createContact(companyId, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY, "contacts"] }),
  });
}

export function useRemoveAlertContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => repositories.alerts.removeContact(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY, "contacts"] }),
  });
}
