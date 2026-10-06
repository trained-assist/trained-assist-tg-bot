# Sandbox ingress media buffer

The media buffer is a separate storage-only Worker. It has one dedicated R2 bucket and a shared secret; it has no Telegram, Task Store, workflow, or Runner binding and cannot start or stop tasks. The Telegram sandbox uploads original bytes to this Worker while collecting a draft. The CP independently verifies manifests at admission and reads bytes through its private service binding.

## Provisioning

Create the non-production bucket before deploying:

```sh
npx wrangler r2 bucket create trained-assist-ingress-buffer-sandbox
```

Set the same randomly generated `INGRESS_BUFFER_TOKEN` secret on the buffer Worker, Telegram sandbox Worker, and CP sandbox Worker. Never commit or print the value. Configure CP with a private service binding to `trained-assist-ingress-buffer-sandbox`; configure Telegram sandbox with the same binding and token. Deploy only the sandbox configs:

```sh
npx wrangler secret put INGRESS_BUFFER_TOKEN --config wrangler.ingress-buffer-sandbox.toml
npx wrangler deploy --config wrangler.ingress-buffer-sandbox.toml
npx wrangler secret put INGRESS_BUFFER_TOKEN --config wrangler.sandbox-tg.toml
```

CP's matching secret and service binding must be deployed separately. Do not expose the buffer via `workers_dev`, point it at a production bucket, or enable the production `MEDIA_PIPELINE` while Runner materialization is incomplete. Worker deployment alone does not enable Telegram media collection; verify the sandbox bindings and test `/v1/manifests/verify` before enabling it there.

The buffer accepts immutable artifacts up to 20 MiB, keyed by profile, opaque ref, and SHA-256 version. Its only routes are authenticated upload, manifest verification, and task-independent content retrieval; ingress must remain private through service bindings.
