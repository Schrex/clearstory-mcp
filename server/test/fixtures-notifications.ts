// Change Notification fixtures shaped from reference/clearstory-swagger-2026-10-27.json definitions.
// Due dates are relative to now so "overdue" tests don't rot.

const DAY = 86_400_000;
/** ISO timestamp `days` from now (negative = in the past). */
export const daysFromNow = (days: number) => new Date(Date.now() + days * DAY).toISOString();

/** definitions.ChangeNotificationCorContract (a COR Schreiber sent in response). */
export function cnCor(over: Record<string, unknown> = {}) {
  return {
    uuid: "c0r-0001", number: "COR-014", title: "Extra rock excavation", status: "in_review", stage: "",
    total: 18450.555, contractId: 9001, changeNotificationId: 5501, customerReferenceNumber: "CN-22",
    customerCoNumber: "", dateSubmitted: "2026-10-05T14:00:00.000Z", approvedToProceedDate: "", coIssueDate: "", voidDate: "",
    createdAt: "2026-10-04T14:00:00.000Z", updatedAt: "2026-10-06T14:00:00.000Z",
    ...over,
  };
}

/** definitions.ChangeNotificationEmbedded */
export function cnEmbedded(over: Record<string, unknown> = {}) {
  return {
    id: 5501, title: "Price added rock removal at MH-4", type: "pricing_request", typeId: 1,
    customerReferenceNumber: "CN-22", description: "Rock encountered at MH-4; price removal.", emailMessage: "Please price by the due date.",
    dueDate: daysFromNow(-3), dateReceived: "2026-10-01T13:00:00.000Z",
    customer: { id: 301, name: "Turner Construction" },
    sentBy: { id: 77, firstName: "Pat", lastName: "Doe", email: "pat@turner.example" },
    response: {},
    createdAt: "2026-10-01T13:00:00.000Z", updatedAt: "2026-10-02T13:00:00.000Z",
    ...over,
  };
}

/** definitions.ChangeNotificationContractorView: a received Change Notification (one per contract). */
export function cnReceived(over: Record<string, unknown> = {}, cn: Record<string, unknown> = {}) {
  return {
    id: 8801, contractId: 9001, projectId: 7001, hasResponded: false, noCostImpact: false, cor: null,
    contract: { id: 9001, name: "Prime Sitework", contractValue: 1250000.46, contractorProjectId: 7001, customerProjectId: 6001 },
    changeNotification: cnEmbedded(cn),
    createdAt: "2026-10-01T13:00:00.000Z", updatedAt: "2026-10-02T13:00:00.000Z",
    ...over,
  };
}

/** definitions.ChangeNotificationProject */
const cnProject = {
  id: 7001, companyId: 4821, jobNumber: "23104", projectTitle: "Route 30 Sewer Extension", customerId: 301,
  customerName: "Turner Construction", customerInternalId: "TURN", customerJobNumber: "T-889", division: "Utilities",
  officeId: 12, contractValue: 1250000.46, isArchived: false, createdAt: "2026-02-01T12:00:00.000Z", updatedAt: "2026-10-20T09:30:00.000Z",
};

/** definitions.ChangeNotificationDetailResponse */
export function cnResponse(over: Record<string, unknown> = {}) {
  return {
    id: 8802, contractId: 9101, projectId: 7101, hasResponded: true, noCostImpact: false,
    contract: { id: 9101, name: "Paving Sub", contractValue: 80000, contractorProjectId: 7101, customerProjectId: 7001 },
    cor: cnCor({ number: "P-3", title: "Paving patch", total: 2200, contractId: 9101 }),
    createdAt: "2026-10-01T13:00:00.000Z", updatedAt: "2026-10-03T13:00:00.000Z",
    ...over,
  };
}

/** definitions.ChangeNotificationSent: one Schreiber sent (Schreiber acting as the GC to its own subs). */
export function cnSent(over: Record<string, unknown> = {}) {
  return {
    id: 6601, title: "T&M authorization for paving patch", type: "authorize_tm_work", typeId: 2, status: "submitted",
    customerReferenceNumber: "S-5", emailMessage: "", dueDate: daysFromNow(-1), dateSubmitted: "2026-10-01T13:00:00.000Z",
    statusChangedAt: "2026-10-01T13:00:00.000Z", costImpact: 0, estimate: 2500, projectedCost: 2200,
    totalSubmitted: 2, totalResponded: 1, project: cnProject,
    responses: [cnResponse(), cnResponse({ id: 8803, contractId: 9102, hasResponded: false, cor: null })],
    sentBy: { id: 12, firstName: "Sumanth", lastName: "Thota", email: "sumanth@schrex.example" },
    createdAt: "2026-10-01T13:00:00.000Z", updatedAt: "2026-10-03T13:00:00.000Z",
    ...over,
  };
}
