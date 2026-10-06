# Repository instructions

Read [README.md](README.md) for the gateway boundary and sandbox procedures. Shared architecture lives in [trained-agent-architecture](https://github.com/trained-assist/trained-agent-architecture). Документы содержат действующие требования, контракты и инструкции. Планы выполнения, статусы, ревью прошлых версий и evidence ведутся в GitHub issues/PR/Project. Целевая модель не является утверждением о текущем deployment; его готовность проверяется по конкретным SHA и приёмке.

Use a dedicated branch/worktree and PR; preserve the existing git hooks and immutable-PR policy. Do not edit another session's branch, shared webhook, endpoint, credential or deployment. Tests must use scoped test profiles/bots. Source and deployment acceptance are separate.

Retiring GCP VM is not a development or fallback target. Use the own Agent Run API and serverless by default; a necessary persistent service belongs on the existing French VM. Other Google services remain allowed. Exit coordination: https://github.com/trained-assist/trained-agent-architecture/issues/145.
