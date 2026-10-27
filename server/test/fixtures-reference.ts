// Reference-data fixtures shaped from reference/clearstory-swagger-2026-10-27.json definitions.
import { office } from "./fixtures.ts";

/** definitions.Office */
export const officeRecord = (over: Record<string, unknown> = {}) => ({ ...office, ...over });

/** definitions.CompanyDivisionRecord */
export const divisionRecord = (division: string) => ({ division, createdAt: "2022-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" });

/** definitions.Customer (a GC) */
export const customerRecord = (over: Record<string, unknown> = {}) => ({
  id: 301, name: "Turner Construction", internalId: "TURN", address: "375 Hudson St", city: "New York", state: "NY",
  zipCode: "10014", country: "US", phone: "555-0200", fax: "", creatorId: 55,
  createdAt: "2022-05-01T12:00:00.000Z", updatedAt: "2026-08-01T12:00:00.000Z", ...over,
});

/** definitions.CustomerDetail */
export const customerDetail = (over: Record<string, unknown> = {}) => ({ ...customerRecord(), offices: [office], ...over });

const rateGroup = { id: 4, name: "Union 2026" };

/** definitions.LaborRate */
export const laborRate = (over: Record<string, unknown> = {}) => ({
  id: 501, internalId: "OP-1", laborClass: "Operator Class 1", straightTimeRate: 95.505, overTimeRate: 130.25,
  doubleTimeRate: 165, premiumOverTimeRate: 140, premiumDoubleTimeRate: 175, standardItem: 0, rateGroupId: 4, rateGroup,
  createdAt: "2025-01-01T00:00:00.000Z", updatedAt: "2026-02-01T00:00:00.000Z", ...over,
});

/** definitions.EquipmentRate (Material/Other differ only in the name field: material / other) */
export const equipmentRate = (over: Record<string, unknown> = {}) => ({
  id: 601, internalId: "EX-320", equipment: "CAT 320 Excavator", unit: "hr", rate: 185.004, standardAmount: 0,
  autoCalculateTotal: true, standardItem: 0, rateGroupId: 4, rateGroup,
  createdAt: "2025-01-01T00:00:00.000Z", updatedAt: "2026-02-01T00:00:00.000Z", ...over,
});

export const materialRate = (over: Record<string, unknown> = {}) => {
  const { equipment: _e, ...rest } = equipmentRate({ id: 701, internalId: "STONE-2A", unit: "ton", rate: 28.5 });
  return { ...rest, material: "2A Modified Stone", ...over };
};

/** definitions.ProjectLaborRate (per-Job rate; no rateGroup, ids are projectRateId / companyRateId) */
export const projectLaborRate = (over: Record<string, unknown> = {}) => ({
  projectRateId: 8801, companyRateId: 501, inheritCompanyRateChanges: false, internalId: "OP-1", laborClass: "Operator Class 1",
  straightTimeRate: 99, overTimeRate: 135, doubleTimeRate: 170, premiumOverTimeRate: 0, premiumDoubleTimeRate: 0, standardItem: 0,
  createdAt: "2026-03-01T00:00:00.000Z", updatedAt: "2026-03-02T00:00:00.000Z", ...over,
});

/** definitions.Label */
export const labelRecord = (over: Record<string, unknown> = {}) => ({
  id: 41, name: "Rock", active: true, companyStandard: true, createdAt: "2024-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", ...over,
});

/** definitions.ReasonCategory */
export const reasonCategory = (over: Record<string, unknown> = {}) => ({
  id: "rc-1", name: "Owner Directed Change", description: "Change directed by the owner", isArchived: false, isDefault: false, sortOrder: 1,
  reasonCategoryGroup: { id: "rg-1", name: "Owner", isArchived: false, isDefault: false, sortOrder: 1, createdAt: "2024-01-01T00:00:00.000Z", updatedAt: "2024-01-01T00:00:00.000Z" },
  createdAt: "2024-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", ...over,
});

/** definitions.ReasonCategoryList (not paged: { count, records }) */
export const reasonCategoryList = (records: unknown[]) => ({ count: records.length, records });

/** definitions.User */
export const userRecord = (over: Record<string, unknown> = {}) => ({
  id: 77, companyId: 4821, email: "pm@schrex.com", firstName: "Pat", lastName: "Miller", roleId: 2, roleName: "Project Manager",
  offices: [office], createdAt: "2023-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", ...over,
});
