# News supporting content

The existing `POST /cms/news-admin/articles` and `PUT /cms/news-admin/articles/:id` endpoints accept these additive fields:

| Field | Shape | Maximum |
| --- | --- | --- |
| `photos` | `[{url,type,alt,fit,position}]`, the existing media shape | 20 |
| `attachments` | `[{url,label,filename,mimeType,size}]` | 10 |
| `links` | `[{url,label}]` | 10 |

Exceeding a limit returns HTTP 400; entries are never silently truncated. Omitted fields remain untouched on update. An explicit empty array removes that field's entries. The cover `image`, `body`, `externalUrl`, `extraFields`, slug behavior, and existing metadata remain compatible.

Use `POST /cms/media` with multipart field `file` for photos. Use `POST /cms/attachments` with field `file` for documents, up to 20 MiB each. The existing document response is `{url,name,type,size}`; editors map `name` to `filename`/`label` and `type` to `mimeType`. Upload URLs stay relative to `/uploads/`; existing disk, object-store, and GridFS delivery continue serving their original bytes.

Documents support PDF, DOC/DOCX, XLS/XLSX, PPT/PPTX, ODT/ODS/ODP, TXT, CSV, RTF, and ZIP. MIME types must match the filename extension. External document URLs require HTTPS so native Downloads can retrieve them. Public uploaded document URLs are accepted; private chat documents, credentials in URLs, unsupported schemes, and traversal paths are rejected. File metadata is descriptive; the service does not fetch external URLs.

Supporting links accept absolute HTTP or HTTPS URLs, including `https://chat.whatsapp.com/...`, `https://wa.me/...`, YouTube watch links, and `https://youtu.be/...`. Query parameters are preserved. Custom `whatsapp:` URLs are not accepted.

Public article, regional/state-filtered news lists, and admin reads use the same serializer. Existing full-list response shape is preserved. Article detail accepts either its slug or a valid 24-character record ID for legacy links. Both addresses enforce publication status. Drafts are visible only to the news editing roles: `super_admin`, `cms_admin`, and `events_admin`. New supporting links participate in the existing content revision mechanism. Region-page custom feed items remain their separate existing `href`/`fileUrl` format.

Run `node tests/news-assets.test.js` for validation, real persistence, partial updates, and draft-read coverage. It uses only a disposable loopback MongoDB and disables publication hooks before model compilation; it sends no messages and uploads no files. A cached MongoDB binary is required. `node tests/cms-field-survival.test.js` checks that the editor fields survive sanitization and the mapped schema.
