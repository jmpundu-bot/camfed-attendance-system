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

Open http://localhost:3000/

Admin: http://localhost:3000/admin

Default admin username: `admin`
Default admin password: `ChangeThisPassword123!`


## Registration expiry and reports

Registration links expire two hours after event creation. After expiry, use the event card buttons to download the attendance PDF and CSV manually. No email delivery is configured.
