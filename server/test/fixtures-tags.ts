// T&M Tag fixtures shaped from reference/clearstory-swagger-2026-10-27.json
// (definitions.TMTag, TMTagDetail, TMTagLaborItem, TMTagMaterialItem, TMTagEquipmentItem, TMTagOtherItem, TMTagProject).
import { projectRecord } from "./fixtures.ts";

/** definitions.TMTag (list record). hcssTimecardId is always present, null for non-HCSS tags. */
export function tmTag(over: Record<string, unknown> = {}) {
  return {
    id: 5501,
    companyId: 4821,
    projectId: 7001,
    number: "42",
    paddedTagNumber: "0042",
    title: "Rock removal at MH-7",
    workDescription: "Removed unexpected rock in trench at MH-7.",
    status: "signed",
    costCode: "TM-2100",
    hcssTimecardId: "hj-tc-88123",
    dateOfWorkPerformed: "2026-10-14T00:00:00.000Z",
    dateOfWorkPerformedAdditional: ["2026-10-15T00:00:00.000Z"],
    dateSubmitted: "2026-10-14T21:00:00.000Z",
    customerReferenceNumber: "T-CN-17",
    customerSignerName: "Pat Foreman",
    signedAt: "2026-10-15T13:05:00.000Z",
    subcontractorPrintedName: "Sam Super",
    contractorSignedAt: "2026-10-14T20:55:00.000Z",
    attachmentSignedUrl: "https://example.invalid/tags/5501-signed.pdf",
    changeNotificationId: 610,
    creatorId: 88,
    totalHours: 18.123456,
    totalHoursST: 16,
    totalHoursOT: 2.123456,
    totalHoursDT: 0,
    totalHoursPOT: 0,
    totalHoursPDT: 0,
    createdAt: "2026-10-14T19:00:00.000Z",
    updatedAt: "2026-10-15T13:05:00.000Z",
    ...over,
  };
}

/** definitions.TMTagDetail: the list record plus items, creator, recipients and the Job. */
export function tmTagDetail(over: Record<string, unknown> = {}) {
  return {
    ...tmTag(),
    creator: { id: 88, firstName: "Sam", lastName: "Super", email: "sam@schrex.com" },
    emailTo: ["pat@turner.example"],
    emailCC: ["pm@schrex.com"],
    project: projectRecord(),
    labor: [
      { id: 1, tagId: 5501, date: "2026-10-14T00:00:00.000Z", laborClass: "Operator", workersQuantity: 2, unitQuantity: 8.5, unit: "hr", projectRateId: 301, internalId: "OP1", formGroupRowId: 1 },
    ],
    material: [
      { id: 2, tagId: 5501, date: "2026-10-14T00:00:00.000Z", material: "2A stone", quantity: 12.25, unit: "ton", projectRateId: 302, internalId: "M2A" },
    ],
    equipment: [
      { id: 3, tagId: 5501, date: "2026-10-14T00:00:00.000Z", equipment: "CAT 336 excavator", quantity: 1, unitQuantity: 8, unit: "hr", projectRateId: 303, internalId: "EX336" },
    ],
    other: [
      { id: 4, tagId: 5501, date: "2026-10-14T00:00:00.000Z", other: "Dump fees", quantity: 3, unitQuantity: 1, unit: "load", projectRateId: 304, internalId: "DF" },
    ],
    ...over,
  };
}
