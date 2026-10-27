// COR summary fixtures shaped from reference/clearstory-swagger-2026-10-27.json definitions
// (COROverview / CORStatusSummary, CORContractSummary / CORContractSummaryValues, CORSent).
import { corSent } from "./fixtures-cors.ts";

/** definitions.CORStatusSummary */
export const statusSummary = (status: string, totalCount: number, totalAmount: number, over: Record<string, unknown> = {}) => ({
  status, totalCount, totalAmount, requestedTotal: totalAmount, valueCompleted: 0, marginTotal: 0,
  laborTotal: 0, premiumLaborTotal: 0, standardTime: 0, overTime: 0, doubleTime: 0, premiumOverTime: 0, premiumDoubleTime: 0, ...over,
});

/** definitions.COROverview (Void filtered out by statuses → rejected empty). */
export function corOverview(over: Record<string, unknown> = {}) {
  return {
    in_review: statusSummary("in_review", 3, 42000.123),
    approved_to_proceed: statusSummary("approved_to_proceed", 2, 15500.5),
    approved_co_issued: statusSummary("approved_co_issued", 4, 88000),
    placeholder: statusSummary("placeholder", 0, 0),
    rejected: statusSummary("rejected", 0, 0),
    averageDaysInReview: 21.456789, averageRequestedValue: 16166.73, marginTotal: 0,
    totalAmountRemaining: 0, totalCount: 9, totalRequestedAmount: 145500.62, totalStatusAmount: 145500.62, totalTags: 7, valueCompleted: 0,
    ...over,
  };
}

/** definitions.CORSent In Review, submitted `days` calendar days before `asOf` (late in the UTC day). */
export function inReviewCor(id: number, asOf: string, days: number, over: Record<string, unknown> = {}) {
  const submitted = new Date(Date.parse(`${asOf}T00:00:00.000Z`) - days * 864e5).toISOString().slice(0, 10);
  return corSent({
    id, corNumber: `COR-${id}`, status: "in_review", stage: "in_review", ballInCourt: "customer",
    requestedAmount: 1000, inReviewAmount: 1000, approvedToProceedAmount: 0,
    dateSubmitted: `${submitted}T22:30:00.000Z`, daysInReview: 999, ...over,
  });
}

/** definitions.CORContractSummary */
export function contractSummary(values: Record<string, number> = {}, over: Record<string, unknown> = {}) {
  return {
    originalContractValue: 1250000.456, pendingContractValue: 1307500.62,
    contractSummaryValues: { in_review: 42000.12, approved_to_proceed: 15500.5, approved_co_issued: 88000, placeholder: 0, rejected: 3000, ...values },
    ...over,
  };
}
