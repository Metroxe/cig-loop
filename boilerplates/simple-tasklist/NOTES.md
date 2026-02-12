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
- VPS: Can access via `ssh XXX`

## Gotchas
- You might not be able to access `.env` by reading due to AI ignore files. Assume it exists and use `.env.example` for reference.
- Always update `.gitignore` when adding sensitive files. Never commit credentials or secrets.
- When working on the production server, use Docker containers in `docker-compose`, not direct source code running on the machine.

## Preferences
- Run the database in Docker Compose for local development. Use TestContainers for test suites.
- Never create migrations manually. Always use generate and migrate commands. Don't edit generated migration code directly.
- When making changes to a website, always verify your work via a browser MCP.
- Libraries must have minimum 1k GitHub stars. If not, find an alternative or build it yourself.
- When adding a new environment variable, add it to `.env.example`. When removing one, delete it from `.env.example`.