# Third-Party Notices

This project includes vendored third-party code. Each vendored file is unmodified
(except for a provenance header comment) and lives under `vendor/`.

## vendor/edgetunnel/_worker.js

- **Upstream**: https://github.com/cmliu/edgetunnel
- **License**: GNU General Public License v2.0 (GPL-2.0)
- **Pinned commit**: `fb3212257e3527447d7368010b378f7e449444b4`
- **Upstream version string**: `2026-08-11 14:45:22`

The tunnel core (VLESS over WebSocket, admin panel, subscription generation,
preferred-IP handling) is vendored from this project. This repository as a whole
is therefore distributed under GPL-2.0; see `LICENSE`.

## vendor/yonggekkk/_worker.js

- **Upstream**: https://github.com/yonggekkk/Cloudflare-vless-trojan
  (file `Vless_workers_pages/_worker明.js`)
- **License**: none published upstream (all rights reserved by the author)
- **Pinned commit**: `43fad05dcdae3b723c53c226f8181fc5bd47223e`
  (per the file's `<!--GAMFC-->` provenance marker)

Used solely as an alternative subscription format (`/sub/yonggekkk`).
Vendored unmodified. If you are the upstream author and want this file removed,
please open an issue.

## CIDR list

`src/subscription/cidr.ts` embeds a snapshot of the Cloudflare IPv4 CIDR list
from https://github.com/cmliu/CF-CIDR.txt (public Cloudflare address ranges,
facts not copyrightable in substance; snapshot dated 2026-09).
