# CAMFED Attendance System v4

## PDF layout update
The attendance PDF has been redesigned so that **all registered details for each person fit on one horizontal row** on A4 landscape.

Included columns:
- No.
- Full Name
- Gender
- Designation
- Organisation
- Phone
- NRC Number
- District
- Mobile Name
- Signature

Long text is kept on the same row using compact typography and ellipsis where necessary. The CAMFED Zambia logo remains in the header and as a light watermark on every PDF page.

## Run
```cmd
npm install
npm start
```

## PostgreSQL and Vercel deployment

The app uses PostgreSQL when `POSTGRES_URL`, `DATABASE_URL`, or
`POSTGRES_PRISMA_URL` is configured. Without a database URL, local development
continues to use the ignored `data/data.json` file. Vercel runtime files under
`/tmp` are temporary, so configure PostgreSQL before collecting real records.

1. In the Vercel project, install the Neon Postgres integration from the Vercel
   Marketplace and connect it to the project. Use the pooled connection URL
   provided by the integration.
2. Put that URL in your local `.env` as `POSTGRES_URL=...` when running the
   database commands below. Keep `.env` private and out of Git.
3. Create the tables with `npm run db:migrate`.
4. If you have existing JSON records to preserve, run `npm run db:import-json`
   once after the migration. The importer also copies signature images from
   `signatures/` into PostgreSQL. Attendee records are preserved even if a
   legacy signature image is missing.
5. Confirm the integration has added the connection variable to Vercel's
   Production and Preview environments, then deploy.

Events, attendee details, and signature PNG data are stored in PostgreSQL. The
attendance PDF is generated for download using temporary function storage. Set
`ADMIN_USERNAME`, `ADMIN_PASSWORD`, and `SESSION_SECRET` in Vercel's project
environment variables; do not use the local default credentials.

Open http://localhost:3000/

Admin: http://localhost:3000/admin

Default admin username: `admin`
Default admin password: `ChangeThisPassword123!`


## Registration expiry and reports

Registration links expire two hours after event creation. After expiry, use the event card buttons to download the attendance PDF and CSV manually. No email delivery is configured.
