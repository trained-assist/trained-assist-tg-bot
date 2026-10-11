# Sandbox ingress media buffer

The media buffer is a separate storage-only Worker. It has one dedicated R2 bucket and a shared secret; it has no Telegram, Task Store, workflow, or Runner binding and cannot start or stop tasks. The Telegram sandbox uploads original bytes to this Worker while collecting a draft. The CP independently verifies manifests at admission and reads bytes through its private service binding.

## Provisioning

Create the non-production bucket before deploying:

```sh
npx wrangler r2 bucket create trained-assist-ingress-buffer-sandbox
```

The existing `INGRESS_BUFFER_TOKEN` continues to serve its current sandbox consumers. For the isolated sandbox3 lane, set a separate randomly generated `INGRESS_BUFFER_TOKEN_SANDBOX3` on the buffer Worker, then set that same value as `INGRESS_BUFFER_TOKEN` on sandbox3 TG and CP. Do not rotate the established token. Never commit or print either value. Both TG and CP use private service bindings to `trained-assist-ingress-buffer-sandbox`; production remains disabled. Deploy only the sandbox configs:

```sh
npx wrangler secret put INGRESS_BUFFER_TOKEN --config wrangler.ingress-buffer-sandbox.toml
npx wrangler deploy --config wrangler.ingress-buffer-sandbox.toml
npx wrangler secret put INGRESS_BUFFER_TOKEN --config wrangler.sandbox-tg.toml
npx wrangler secret put INGRESS_BUFFER_TOKEN_SANDBOX3 --config wrangler.ingress-buffer-sandbox.toml
npx wrangler secret put INGRESS_BUFFER_TOKEN --config wrangler.sandbox-tg-sandbox3.toml
```

CP's sandbox3 secret and service binding must be deployed separately. The protected workflow **Deploy passive ingress buffer sandbox** deploys only the buffer Worker and its sandbox3 credential. Do not expose the buffer via `workers_dev`, point it at a production bucket, or enable the production `MEDIA_PIPELINE`. The sandbox3 `MEDIA_PIPELINE=ingress-buffer` path remains unavailable until TG, CP and buffer credentials/bindings are all installed. Worker deployment alone does not prove media readiness; verify authenticated upload, CP manifest verification, task-scoped byte reads, Runner materialization and result delivery in the same lane.

Telegram `/health` reports `capabilities.mediaIntake` separately from general
Worker readiness: `disabled` in direct mode, `not_configured` in batch mode
without both the service binding and token, and `configured` only when both are
present. The `configured` capability reports only that those bindings exist; it
does not probe their authentication or object I/O. A general
`readiness: configured` response does not prove media intake works. Direct mode
must refuse files explicitly instead of converting them to a text task. Before
claiming file-to-Agent E2E, verify upload, manifest verification, task-scoped
byte reads, run acceptance, and result delivery in the same sandbox lane.

The buffer accepts immutable artifacts up to 20 MiB, keyed by profile, opaque ref, and SHA-256 version. Its only routes are authenticated upload, manifest verification, and task-independent content retrieval; ingress must remain private through service bindings.
