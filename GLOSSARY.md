# Clearstory connector

How Schreiber Excavating, acting as a subcontractor, tracks changed and extra work it asks general contractors to pay for.

## Language

**Job**:
A Schreiber construction job, identified by its job number, which is the same in Clearstory and HeavyJob. Clearstory calls it a Project.
_Avoid_: Project (except when quoting the API)

**GC**:
The general contractor (or owner) Schreiber contracts with on a Job and sends CORs and T&M Tags to. Clearstory calls it a Customer.
_Avoid_: Customer, client

**COR** (Change Order Request):
Schreiber's priced request to a GC for payment for changed or extra work. It is revised as a chain; only the latest revision counts.
_Avoid_: Change order, CO, PCO

**Draft COR**:
A COR created in Clearstory but not yet sent to the GC. Drafts created through the API are lump-sum uploaded CORs: a title, a total and a description, with no line items.

**Change Order**:
A COR the GC has approved and formally issued (status Approved CO Issued).
_Avoid_: Using it for an unapproved COR

**T&M Tag**:
A field record of time-and-materials work (labor, material, equipment) for one Job and work date, signed by the GC to acknowledge the work happened.
_Avoid_: Ticket, T&M sheet, field ticket

**Change Notification**:
A GC's request to Schreiber, either to price a change or to authorize T&M work, usually with a due date.
_Avoid_: RFI

**Inbox**:
Which side of an exchange Schreiber is on: Sent (Schreiber to GC, the default) or Received (sent to Schreiber).

## COR status

**In Review**:
Submitted to the GC, awaiting decision.

**Approved to Proceed**:
GC has authorized the work but has not yet issued a Change Order.

**Approved CO Issued**:
GC has issued the Change Order.

**Void**:
Rejected or withdrawn; Waived is a kind of Void.
_Avoid_: Rejected

**Ball in Court**:
Which party must act next on a COR.

**Days in Review**:
How long a COR has been waiting on the GC.

**Stale COR**:
A COR In Review for more than 30 days.

**Exposure**:
Money for work Schreiber is owed but not yet covered by a Change Order: In Review amount plus Approved to Proceed amount.
_Avoid_: At risk, pending, outstanding

## Unbilled T&M

**T&M Work**:
Hours on a HeavyJob time card charged to a cost code marked T&M.

**Unbilled T&M**:
T&M Work not yet covered by an approved COR. Always reported by the stage it is stuck at:

- **Untagged**: no T&M Tag exists for it.
- **Unsigned**: a T&M Tag exists but the GC has not signed it.
- **Signed, not on a COR**: signed T&M Tag not included in any COR.
- **On a COR, not approved**: included in a COR that is still In Review.

**Probable match**:
A T&M Tag matched to T&M Work by Job, work date and cost code rather than by the time card link; never counted as certain.
