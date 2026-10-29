# Read-only is enforced by the connector, not by Clearstory

Clearstory's API applications have no scopes: a client ID/secret can read and change everything for the whole company. So v0.1 allows only GET requests in the Clearstory client code and blocks every POST/PATCH/DELETE, rather than relying on credentials. Any future write tool (draft COR/T&M Tag) must be added deliberately to that allowlist, with a confirmation step.

Superseded in part by [ADR 0003](0003-draft-cor-create-only-write.md): creating a draft COR (`POST /cors`) is the one allowed write.
