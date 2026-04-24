# Sandbox Troubleshooting

- Path denied: ensure path is inside workspace/read/write roots.
- Shell command denied: check allowlist or command chaining restrictions.
- Docker mode failure: verify Docker daemon and image availability.
- Web fetch blocked: confirm `allowedFetchHosts` and note that localhost, private IPs, link-local IPs, and single-label internal hostnames are always denied.

Checks:

- `talon sandbox`
- `talon doctor`
