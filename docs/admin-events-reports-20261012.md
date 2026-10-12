# Admin lists, event history and spreadsheet release — 12 October 2026

## Resulting behaviour

- Manage Admins supports bounded pages (25 records; maximum 100), full-roster search and geographic filters. Existing unpaginated clients remain supported. Permission filtering happens before pagination. The website and native app offer a separate Staff tab.
- Events finish at their configured end timestamp. Without an end time, they finish at the end of their last scheduled day in Asia/Kolkata. Ongoing multi-day events remain visible. Upcoming feeds and promotional surfaces exclude completed events; Past Events lists them separately.
- Deleting an event now archives it. The event, bookings, registrations, payments, attendee records and media remain available for administrative history. Archived events stop accepting registrations and disappear from public/member feeds and public detail links.
- New booking, attendance and membership downloads use real XLSX workbooks. Numbers remain numeric for accounting, phone numbers remain exact text, and dates display Indian time with AM/PM. Booking and participant sheets are separate so payment amounts are not counted repeatedly.
- Attendance contact visibility and membership report permissions remain enforced. Failed, expired, cancelled and archived payment records are retained. Legacy CSV routes remain compatible with older applications.
- The native app has a public Home, Events, News, Gallery and Zones experience. Public CMS requests carry no saved account token. Protected actions enter the existing native sign-in, membership and booking flows; successful sign-in resumes the selected event. The website's native-viewer gate also handles client-side navigation.

## API additions

- GET /admin/super/admins?page=1&limit=25&kind=regional accepts existing role/search/geography filters and returns pagination metadata.
- GET /cms/events?period=upcoming|past|all defaults to upcoming for public callers. Draft visibility still requires the existing CMS permissions.
- GET /events?period=upcoming|past|all supports the same finishing boundary. Archived history requires the Super Admin context and includeArchived=true.
- Booking and attendance export routes accept format=xlsx. Native downloads additionally use encoding=base64; browser downloads receive XLSX bytes.
- GET /admin/super/membership/registrations/export is restricted to Super Admin and accepts the existing report tab/filter/search selections.

## Deployment

Deploy the backend first so XLSX endpoints and event period filters are available before updating website/native clients. Install dependencies from package.json; exceljs is pinned to 4.4.0 and is loaded only for report generation. This repository's existing policy ignores package-lock.json.

No data migration or bulk event deletion is required. Existing records with no archivedAt field remain active. Rollback requires retaining the archive-aware backend: an older backend does not consistently apply archive filters.

Archiving protects future deletions. It cannot recreate records already physically deleted by an earlier version; those would require a backup.

## Validation

- Fixture roster of 8,184 accounts: page boundaries, full-roster search, counts and geographic scope; first 25-row response 5,932 bytes.
- Existing staff account suite: 57 checks.
- Event lifecycle fixtures plus existing attendance (83) and member registration history (16) checks.
- XLSX parsing and HTTP tests: original phone strings, IST midnight/noon, numeric totals, archived history, inert formula-like text and role restrictions.
- Real Microsoft Excel opened the sample workbook and verified displayed phone numbers, 12-hour times, rupee amounts and formatting.
- Native render/service tests cover Staff/paging, public browsing, Past Events, login continuation and report downloads.
- Website browser fixtures cover 390px/1440px layouts, Staff/search/paging, cached event expiry and the native sign-in handoff.

Tests use isolated fixtures. No production messages, payments or destructive database operations are part of validation.
