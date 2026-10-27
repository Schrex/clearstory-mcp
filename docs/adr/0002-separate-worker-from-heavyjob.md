# Separate Worker from the HeavyJob connector

Clearstory runs as its own Cloudflare Worker (`schrex-clearstory-mcp`), not merged into the HeavyJob Worker, even though the main use case (unbilled T&M) joins the two. Keeping secrets apart limits blast radius and lets either be revoked alone. In v0.1 Claude joins the two connectors' results; a combined reconcile tool is deferred until that join proves unreliable.
