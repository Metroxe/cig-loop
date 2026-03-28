# Notes

## Techstack
- Language: TypeScript
- Framework: Next.js
- CSS: Tailwind CSS
- Runtime: Node.js
- Package Manager: npm
- CI/CD: GitHub Actions
- Database: PostgreSQL
- ORM: Drizzle

## Dev Server
- Start Command: npm run dev
- Port: 3000
- Test Command: npm test

## Deployment
- Type: docker-compose
- Registry: ghcr.io
- Production URL: (not yet configured)

### VPS
- SSH Alias: (not yet provisioned)

### Docker Services
All services run as Docker containers via docker-compose:
- **App** — the main application container, image pulled from ghcr.io
- **Cloudflared** — `cloudflare/cloudflared:latest` container, provides a Cloudflare Tunnel for public URL routing without opening ports on the VPS
- **Watchtower** — `containrrr/watchtower` container, monitors ghcr.io for new images and auto-restarts containers when updates are available

### CI/CD Flow
- Workflow: (not yet configured)
1. Deployer triggers the GitHub Actions workflow via `gh workflow run` when the PRD reaches Deployment
2. GitHub Actions builds Docker image and pushes to ghcr.io
3. Watchtower on VPS detects new image, pulls it, and restarts the container

### Deploy Verification
After triggering the build:
1. Wait for GitHub Actions to complete: `gh run watch`
2. Allow ~5 minutes for Watchtower to detect and pull the new image
3. Smoke test the production URL

### Environment
- Production env vars live in `.env` on the VPS (never in the repo)
- `.env.example` in the repo documents all required variables with placeholder values
- Docker Compose loads `.env` into the app container via `env_file`

## Infrastructure Provisioning

### VPS
Use the `/create-vps <project-name>` skill to provision a VM on the Proxmox cluster. The skill:
- Clones a Debian template and allocates an IP on 192.168.1.0/24
- Sets up an SSH config entry so the VM is accessible via `ssh <project-name>`
- After provisioning, update the SSH Alias in the Deployment > VPS section above

### Database / Services
Databases (PostgreSQL, Redis, etc.) run as docker-compose services alongside the app — NOT standalone managed databases.
- Add the service to `docker-compose.yml`
- Configure the app's `.env` to point at the compose service (e.g., `DATABASE_URL=postgres://user:pass@db:5432/app`)
- Use Docker volumes to persist data across container restarts

### Docker & Container Registry
Use the `/docker-auth <vps-name>` skill to install Docker and authenticate to ghcr.io on the VPS. The skill:
- Installs Docker on the VPS if not already present
- Authenticates Docker to GitHub Container Registry (ghcr.io) so the VPS can pull private images
- Must be run before the first deployment so Watchtower and docker-compose can pull images

### Cloudflare Tunnel
Use the `/create-tunnel <project-name>` skill to create a Cloudflare Tunnel. The skill:
- Creates a tunnel and configures ingress rules via the Cloudflare API
- Creates a DNS CNAME record for `<project-name>.boilerroom.tech`
- Saves `TUNNEL_TOKEN` to the local `.env`
- After creating the tunnel, SSH to the VPS and add `TUNNEL_TOKEN` to the server's `.env` as well
- The cloudflared Docker container uses the token directly (no local config.yml needed)

## Gotchas
- You might not be able to access `.env` by reading due to AI ignore files. Assume it exists and use `.env.example` for reference.
- Always update `.gitignore` when adding sensitive files. Never commit credentials or secrets.
- SSH to the VPS uses an alias from `~/.ssh/config` — never hardcode hosts, users, or key paths.

## Preferences
- When making changes to a website, always verify your work via a browser MCP.
- Libraries must have minimum 1k GitHub stars. If not, find an alternative or build it yourself.
- When adding a new environment variable, add it to `.env.example`. When removing one, delete it from `.env.example`.
