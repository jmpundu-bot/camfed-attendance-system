# CAMFED Zambia Attendance System

Deployment-ready Node.js attendance registration system for CAMFED Zambia.

## Included

- Public attendance registration links for events
- Administrator login and dashboard
- Event creation and attendee management
- Signature capture
- CAMFED Zambia logo in attendance PDFs
- CAMFED watermark on every PDF page
- One horizontal row per attendee in the PDF
- Maximum 20 attendees per PDF page; attendee 21 starts on page 2
- A4 landscape PDF output
- Friendly 404 handling and route fixes
- No native SQLite dependencies, so it works with modern Node.js releases
- Persistent storage configuration for Render
- `/healthz` endpoint for deployment health checks

## Local development

Requirements: Node.js 18 or newer.

```bash
npm install
npm start
```

Open:

- http://localhost:3000/
- http://localhost:3000/admin
- http://localhost:3000/register

Default local credentials:

- Username: `admin`
- Password: `ChangeThisPassword123!`

For real use, create `.env` from `.env.example` and change the password and session secret.

## GitHub upload

1. Create a new GitHub repository, for example `camfed-attendance-system`.
2. Extract this project.
3. Upload **all files and folders** in this directory to the repository root.
4. Commit to the `main` branch.
5. Do not upload `.env`, `node_modules`, or generated files in `storage/`.

The included `render.yaml` is already configured for Render.

## Render deployment

The project uses a persistent disk at `/var/data` because the attendance records and captured signatures must survive application restarts and deployments. Render documents that the normal service filesystem is ephemeral, while persistent disks preserve filesystem changes under the mounted path. A persistent disk requires a paid Render web service and pins the service to one instance.

### Blueprint deployment

1. Push the repository to GitHub.
2. In Render, create a **New Blueprint**.
3. Connect the GitHub repository.
4. Render detects `render.yaml` in the repository root.
5. Set the requested `ADMIN_USERNAME` and `ADMIN_PASSWORD` values when prompted.
6. Deploy the Blueprint.

Render will build with `npm ci`, start with `npm start`, use `/healthz` as the health check, and mount persistent storage at `/var/data`. Render Blueprints support `render.yaml`, environment variables, health checks, and persistent disks.

After deployment, Render provides a public `onrender.com` HTTPS address that can be opened from different devices and networks.

## Security notes

- Change the default administrator password before public deployment.
- Keep `.env` out of GitHub.
- Use a strong, unique `SESSION_SECRET` for local deployments.
- The Render Blueprint generates the production session secret automatically and prompts for the administrator credentials instead of committing them to GitHub.
