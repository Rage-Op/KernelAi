# Git hook templates (tracked, reproducible)

Git hooks live under `.git/hooks/` which is **not** version-controlled, so the canonical
copies are tracked here and installed into the repos they protect.

## `kernel-memory-pre-push.sh` — finance-leak prevention, layer (b) of the FIN-04 stack

Installs into the **kernel-memory/** repo (its own git repo — finance data only ever lives
there). It scans the **added content bytes** of a push (the `+` diff lines only, never git
metadata) and aborts on a finance path or a finance-shaped value (dollar amounts,
account/card-number runs). Bypassing it at push time is forbidden by project policy.

Install (run once after cloning, and any time this template changes):

```sh
cp daemon/scripts/hooks/kernel-memory-pre-push.sh kernel-memory/.git/hooks/pre-push
chmod +x kernel-memory/.git/hooks/pre-push
```

The deliberate-abort proof is `daemon/test/finance-leakguard.test.ts`; the startup
`git ls-files` assertion (layer d) is `daemon/src/safety/leakguard.ts`.
