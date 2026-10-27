// Fixtures shaped from reference/clearstory-swagger-2026-10-27.json definitions.

/** definitions.CompanyDetail */
export const company = {
  id: 4821,
  name: "Schreiber Excavating, Inc.",
  domain: "schrex.com",
  address: "1000 Example Rd",
  address2: "",
  city: "Example",
  state: "PA",
  zipCode: "00000",
  country: "US",
  phone: "555-0100",
  fax: "",
  tzName: "America/New_York",
  divisionsEnabled: true,
  logoSignedUrl: "https://example.invalid/logo.png",
  createdAt: "2021-03-04T15:00:00.000Z",
  updatedAt: "2026-09-30T12:00:00.000Z",
};

/** definitions.Office */
export const office = {
  id: 12, name: "Main Office", businessName: "Schreiber Excavating, Inc.", address: "1000 Example Rd", city: "Example", state: "PA",
  zipCode: "00000", country: "US", phone: "555-0100", fax: "", customId: "MAIN", regionId: "", tzName: "America/New_York",
  lat: 40.1, lng: -76.2, createdAt: "2021-03-04T15:00:00.000Z", updatedAt: "2026-01-02T12:00:00.000Z",
};

/** definitions.ProjectRecord (also the shape of definitions.Project). */
export function projectRecord(over: Record<string, unknown> = {}) {
  return {
    id: 7001,
    companyId: 4821,
    creatorCompanyId: 4821,
    projectTitle: "Route 30 Sewer Extension",
    jobNumber: "23104",
    customer: "Turner Construction",
    customerId: 301,
    customerInternalId: "TURN",
    customerJobNumber: "T-889",
    contractValue: 1250000.456,
    contractWithCustomer: { id: 9001, name: "Prime Sitework", contractValue: 1250000.456, contractorProjectId: 7001, customerProjectId: 8001 },
    contracts: [{ id: 9001, name: "Prime Sitework", contractValue: 1250000.456, contractorProjectId: 7001, customerProjectId: 8001 }],
    division: "Utilities",
    office,
    officeId: 12,
    originType: "contractor",
    archived: false,
    address: { streetAddress: "1 Route 30", city: "Example", state: "PA", zipCode: "00000", postalCode: "00000", country: "US", projectAddress: "1 Route 30, Example, PA", latitude: 40.1, longitude: -76.2 },
    startDate: "2026-03-01T00:00:00.000Z",
    endDate: "2026-12-15T00:00:00.000Z",
    createdAt: "2026-02-10T14:00:00.000Z",
    updatedAt: "2026-10-20T09:30:00.000Z",
    ...over,
  };
}

/** definitions.ListEnvelope-* (count = total matching). */
export const envelope = (records: unknown[], count = records.length, offset = 0, limit = 100) => ({ count, limit, offset, records });

/** definitions.ContractDetail */
export function contractDetail(over: Record<string, unknown> = {}) {
  return {
    id: 9001, name: "Prime Sitework", contractValue: 1250000.456, contractorProjectId: 7001, customerProjectId: 8001,
    createdAt: "2026-02-10T14:00:00.000Z", updatedAt: "2026-09-01T10:00:00.000Z", ...over,
  };
}

/** definitions.ProjectIntegrationsResponse */
export const integrations = (list: { provider: string; externalProjectId?: string; externalProjectName?: string }[]) => ({
  integrations: list.map((i) => ({
    number: "1", createdAt: "2026-02-11T00:00:00.000Z", updatedAt: "2026-02-11T00:00:00.000Z",
    externalProjectId: "ext-1", externalProjectName: "23104 Route 30", ...i,
  })),
});
