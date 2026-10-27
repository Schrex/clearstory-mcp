// COR fixtures shaped from reference/clearstory-swagger-2026-10-27.json definitions
// (CORSent, CORDetail, CORLineItems/CORLineItem, CORSentRevision, CORAssociatedTag).

/** definitions.CORAssociatedTag */
export function corTag(over: Record<string, unknown> = {}) {
  return {
    id: 5101, uuid: "tag-uuid-5101", number: "41", paddedTagNumber: "0041", title: "Extra trench rock",
    status: "signed", dateOfWorkPerformed: "2026-09-14T00:00:00.000Z", dateOfWorkPerformedAdditional: [],
    dateSubmitted: "2026-09-15T13:00:00.000Z", signedAt: "2026-09-16T15:00:00.000Z", contractorSignedAt: "2026-09-15T13:00:00.000Z",
    hasAssociatedCor: true, totalHours: 12.33333, customerReferenceNumber: "", changeNotificationId: null, ...over,
  };
}

/** definitions.CORSent (list record; latest revision only). */
export function corSent(over: Record<string, unknown> = {}) {
  return {
    id: 6201, uuid: "cor-uuid-6201", originalCorId: 6200, version: 2,
    corNumber: "COR-017", title: "Rock excavation at MH-4",
    companyId: 4821, contractorName: "Schreiber Excavating, Inc.",
    projectId: 7001, projectName: "Route 30 Sewer Extension", jobNumber: "23104", customerJobNumber: "T-889",
    customer: { id: 301, name: "Turner Construction", internalId: "TURN", customerCompanyId: 990, customerOfficeId: 991 },
    customerName: "Turner Construction", contractId: 9001,
    status: "in_review", stage: "in_review", ballInCourt: "customer", statusChangedAt: "2026-09-20T12:00:00.000Z",
    requestedAmount: 18450.456, inReviewAmount: 18450.456, approvedToProceedAmount: 0, approvedCoIssuedAmount: 0, voidAmount: 0,
    dateSubmitted: "2026-09-20T12:00:00.000Z", daysInReview: 37, coIssueDate: null, approvedToProceedDate: null, voidDate: null, approvedOrVoidDate: null,
    customerCoNumber: "", customerReferenceNumber: "PCO-88", changeNotificationId: 7701, entryMethod: "web",
    labels: [{ id: 81, name: "Rock", active: true, companyStandard: false, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }],
    reasonCategory: { id: "rc-1", name: "Differing Site Condition", description: "", isArchived: false, isDefault: false, sortOrder: 1,
      reasonCategoryGroup: { id: "rg-1", name: "Field", isArchived: false, isDefault: false, sortOrder: 1 } },
    responsibleParty: { id: "rp-1", name: "Owner", assigneeType: "customer" },
    tmTagCount: 2, tmTags: [corTag(), corTag({ id: 5102, number: "42", paddedTagNumber: "0042", totalHours: 6.5 })],
    manualTmTag: "", internalNotes: "", subcontractorCorItems: [],
    createdAt: "2026-09-18T10:00:00.000Z", updatedAt: "2026-10-01T08:00:00.000Z",
    ...over,
  };
}

/** definitions.CORLineItem */
export const lineItem = (over: Record<string, unknown> = {}) => ({
  description: "Operator", internalId: "OP1", quantity: 10.123456, unit: "HR", rate: 95.556, actualRate: 95.556, total: 967.3376, ...over,
});

/** definitions.CORLineItems */
export const corLineItems = (over: Record<string, unknown> = {}) => ({
  corId: 6201,
  labor: [lineItem()],
  materials: [lineItem({ description: "#57 stone", internalId: "M57", quantity: 40, unit: "TON", rate: 22.5, actualRate: 22.5, total: 900 })],
  equipment: [lineItem({ description: "CAT 336 excavator", internalId: "E336", quantity: 8, unit: "HR", rate: 210, actualRate: 210, total: 1680 })],
  others: [lineItem({ description: "Disposal fee", internalId: "", quantity: 1, unit: "LS", rate: 350, actualRate: 350, total: 350 })],
  subcontractors: [],
  markups: [{ id: 1, description: "OH&P", internalId: "", markedUpSection: "labor", rate: 15, rateType: "percent", total: 145.1 }],
  ...over,
});

/** definitions.CORDetail */
export function corDetail(over: Record<string, unknown> = {}) {
  const { customer: _c, ...sent } = corSent();
  return {
    ...sent,
    description: "Rock encountered at MH-4 below design grade; hammered and hauled off.",
    isLatestVersion: true,
    lineItems: corLineItems(),
    totalHours: 18.623456, totalHoursST: 10.123456, totalHoursOT: 8.5, totalHoursDT: 0, totalHoursPOT: 0, totalHoursPDT: 0,
    totalST: 967.34, totalOT: 1200.0, totalDT: 0, totalPOT: 0, totalPDT: 0,
    integrationMetadata: null,
    ...over,
  };
}

/** definitions.CORSentRevision */
export const corRevision = (over: Record<string, unknown> = {}) => ({ ...corSent(), isLatestVersion: true, ...over });
