const bcrypt = require('bcryptjs');
const ApiError = require('../../core/utils/ApiError');
const logger = require('../../config/logger');
const { parseCsvRecords } = require('../../core/utils/csv');
const { generatePassword } = require('../../core/utils/password');
const mailer = require('../../core/utils/mailer');
const adminRepository = require('./admin.repository');
const geography = require('../regions/geography');
const regionService = require('../regions/region.service');
const auditService = require('../audit/audit.service');

/**
 * Bulk admin onboarding from a CSV.
 *
 * Launch day means a thousand block admins, and creating them one at a time
 * through the form is not a plan. This module applies the same rules the form
 * does, which since the move to free-text regions means one rule: reconcile
 * spelling, then write.
 *
 * Two properties matter more than throughput here:
 *
 *  - **Ordered by tier**, and written to one collection per tier — state admins
 *    into `stateadmins`, districts into `districtadmins`, blocks into
 *    `blockadmins`. Regions introduced by earlier rows are visible to later
 *    ones, so a file that mixes tiers still ends up with one spelling per
 *    region rather than one per row.
 *  - **Validated as a whole before anything is written.** A row that fails is
 *    reported with its spreadsheet line number and skipped, so a typo costs one
 *    row rather than the import.
 */

const REQUIRED_HEADERS = ['role', 'fullname', 'email'];

const TEMPLATE_HEADERS = ['role', 'fullName', 'email', 'phoneNumber', 'state', 'district', 'block', 'password'];

/** Roles a bulk file may contain, ordered so parents are always created first. */
const TIER_ORDER = ['state_admin', 'district_admin', 'block_admin'];

/** Guard against a paste that would take the process down. */
const MAX_ROWS = 5000;

/** Concurrent welcome emails. High enough to be quick, low enough not to trip SMTP throttling. */
const EMAIL_CONCURRENCY = 5;

const key = (value) => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const ROLE_ALIASES = {
    block: 'block_admin',
    blockadmin: 'block_admin',
    block_admin: 'block_admin',
    district: 'district_admin',
    districtadmin: 'district_admin',
    district_admin: 'district_admin',
    state: 'state_admin',
    stateadmin: 'state_admin',
    state_admin: 'state_admin'
};

const normalizeRole = (value) => ROLE_ALIASES[String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_')] || '';

const regionLabel = (row) => [row.block, row.district, row.state].filter(Boolean).join(', ');

/**
 * A spelling index of every region name already in use, extended as the file is
 * read so rows later in the same file reuse the spelling rows above them
 * introduced.
 *
 * Built once per import rather than queried per row: a thousand-row file would
 * otherwise mean a thousand full admin scans, and a file that introduces
 * "Kollam" on line 2 and again on line 40 would create it twice under two
 * capitalisations — two regions, each holding half the queue.
 */
const buildRegionIndex = (admins) => {
    const states = new Map();
    const districts = new Map();
    const blocks = new Map();

    (admins || []).forEach((admin) => {
        if (!admin.active) return;
        const state = String(admin.state || '').trim();
        const district = String(admin.district || '').trim();
        const block = String(admin.block || '').trim();

        if (state && !states.has(key(state))) states.set(key(state), state);
        if (state && district && !districts.has(`${key(state)}|${key(district)}`)) {
            districts.set(`${key(state)}|${key(district)}`, district);
        }
        if (state && district && block && !blocks.has(`${key(state)}|${key(district)}|${key(block)}`)) {
            blocks.set(`${key(state)}|${key(district)}|${key(block)}`, block);
        }
    });

    return {
        /** The established spelling of a name, or '' when it is new. */
        state: (name) => states.get(key(name)) || '',
        district: (state, name) => districts.get(`${key(state)}|${key(name)}`) || '',
        block: (state, district, name) => blocks.get(`${key(state)}|${key(district)}|${key(name)}`) || '',
        addState: (name) => { if (!states.has(key(name))) states.set(key(name), name); },
        addDistrict: (state, name) => {
            const composite = `${key(state)}|${key(name)}`;
            if (!districts.has(composite)) districts.set(composite, name);
        },
        addBlock: (state, district, name) => {
            const composite = `${key(state)}|${key(district)}|${key(name)}`;
            if (!blocks.has(composite)) blocks.set(composite, name);
        }
    };
};

class AdminBulkService {
    /**
     * The header row plus worked examples, offered as a download in the UI.
     *
     * The example regions are read from the admin database rather than written
     * into the source. A template naming Tamil Nadu and Ariyalur stops being
     * true the moment the platform runs somewhere else, and someone will
     * eventually import it verbatim and open a region nobody meant to staff.
     * With an empty database the region columns are simply left blank.
     */
    async template() {
        let state = '';
        let district = '';
        let block = '';

        try {
            const tree = await regionService.getTree();
            const firstState = ((tree && tree.states) || [])[0] || null;
            state = (firstState && firstState.name) || '';
            const firstDistrict = ((firstState && firstState.districts) || [])[0] || null;
            district = (firstDistrict && firstDistrict.name) || '';
            const firstBlock = ((firstDistrict && firstDistrict.blocks) || [])[0] || null;
            block = (firstBlock && firstBlock.name) || '';
        } catch (err) {
            logger.warn('Bulk template could not read live regions; example rows will be blank', {
                error: err && err.message
            });
        }

        return [
            TEMPLATE_HEADERS.join(','),
            `state_admin,Asha Menon,asha.menon@activ.org,9876500001,${state},,,`,
            `district_admin,Ravi Kumar,ravi.kumar@activ.org,9876500002,${state},${district},,`,
            `block_admin,Meena Rajan,meena.rajan@activ.org,9876500003,${state},${district},${block},`,
            // Regions do not have to exist first — a row naming somewhere new
            // opens that state, district and block for registration on import.
            'block_admin,New Region Lead,new.lead@activ.org,9876500004,,,,'
        ].join('\n');
    }

    /**
     * Shape-check the file and validate every row against the live hierarchy.
     *
     * Writes nothing, and returns the *internal* row objects — separate region
     * fields, the plaintext password column, mutable error lists. `validate()`
     * projects these into the report the client sees; `commit()` needs the whole
     * thing, because reconstructing a region out of a display string would break
     * on any region name containing a comma.
     */
    async analyze(csvText) {
        const text = String(csvText || '');
        if (!text.trim()) throw ApiError.badRequest('The CSV file is empty');

        const { headers, rows } = parseCsvRecords(text);

        if (rows.length === 0) {
            throw ApiError.badRequest('The CSV has a header row but no data rows');
        }
        if (rows.length > MAX_ROWS) {
            throw ApiError.badRequest(`This file has ${rows.length} rows; the limit for one import is ${MAX_ROWS}`);
        }

        const missingHeaders = REQUIRED_HEADERS.filter(name => !headers.includes(name));
        if (missingHeaders.length > 0) {
            throw ApiError.badRequest(
                `The CSV is missing required column(s): ${missingHeaders.join(', ')}. Expected header: ${TEMPLATE_HEADERS.join(', ')}`
            );
        }

        // Email collisions are checked against *every* account, scaffold records
        // included — a duplicate email is a hard failure at insert time whether
        // or not the account it clashes with counts as real staffing.
        const everyAccount = await adminRepository.findAll({ fresh: true, includeUnstamped: true });
        const existingEmails = new Set(everyAccount.map(admin => key(admin.email)).filter(Boolean));

        // Region spelling, though, is reconciled only against real staffing.
        // Adopting a scaffold record's capitalisation would resurrect exactly the
        // placeholder regions this architecture replaced.
        const index = buildRegionIndex(everyAccount.filter(admin =>
            admin.createdVia || admin.source === adminRepository.PRIMARY_COLLECTION));

        // Shape pass. Nothing here needs the hierarchy, so a row that fails it
        // is rejected before it can affect what later rows are allowed to adopt.
        const seenEmails = new Map();
        const shaped = rows.map((row) => {
            const errors = [];
            const warnings = [];

            const role = normalizeRole(row.role);
            if (!role) {
                errors.push(`Unknown role "${row.role || '(blank)'}" — use block_admin, district_admin or state_admin`);
            }

            const fullName = String(row.fullname || '').trim();
            if (!fullName) errors.push('Full name is required');

            const email = String(row.email || '').trim().toLowerCase();
            if (!EMAIL_RE.test(email)) {
                errors.push(`"${row.email || '(blank)'}" is not a valid email address`);
            } else if (existingEmails.has(key(email))) {
                errors.push(`An admin with the email ${email} already exists`);
            } else if (seenEmails.has(key(email))) {
                errors.push(`Duplicate email — line ${seenEmails.get(key(email))} in this file already uses ${email}`);
            } else {
                seenEmails.set(key(email), row.lineNumber);
            }

            const password = String(row.password || '').trim();
            if (password && password.length < 8) {
                errors.push('Password must be at least 8 characters (leave the column blank to generate one)');
            }

            const phoneNumber = String(row.phonenumber || row.phone || '').trim();
            if (phoneNumber && !/^[0-9+\-\s()]{6,20}$/.test(phoneNumber)) {
                warnings.push(`Phone "${phoneNumber}" does not look like a phone number; it was kept as typed`);
            }

            return {
                lineNumber: row.lineNumber,
                role,
                fullName,
                email,
                phoneNumber,
                password,
                generatePassword: !password,
                state: String(row.state || '').trim().replace(/\s+/g, ' '),
                district: String(row.district || '').trim().replace(/\s+/g, ' '),
                block: String(row.block || '').trim().replace(/\s+/g, ' '),
                errors,
                warnings
            };
        });

        // Region pass, tier by tier so a file that introduces a region at one
        // tier has settled its spelling before a lower tier reuses it.
        //
        // No parent admin is required at any level: a lone block_admin row for a
        // brand-new state is valid and opens that region for registration. What
        // this pass enforces is that one region ends up with one spelling.
        TIER_ORDER.forEach((tier) => {
            shaped
                .filter(row => row.role === tier)
                .forEach((row) => {
                    if (row.errors.length > 0) return;

                    if (!row.state) {
                        row.errors.push('State is required');
                        return;
                    }
                    if (tier !== 'state_admin' && !row.district) {
                        row.errors.push('District is required');
                        return;
                    }
                    if (tier === 'block_admin' && !row.block) {
                        row.errors.push('Block is required for a block admin');
                        return;
                    }

                    const reference = geography.normalizeRegion({
                        state: row.state,
                        district: row.district,
                        block: row.block
                    });

                    // Established spelling wins, then the canonical reference,
                    // then whatever was typed.
                    const knownState = index.state(row.state);
                    if (knownState) {
                        row.state = knownState;
                    } else if (!reference.unknown.state) {
                        row.state = reference.state;
                        row.warnings.push(`"${row.state}" is a new state — it becomes selectable for applicants on import`);
                    } else {
                        row.warnings.push(`"${row.state}" is not in the reference list of Indian states; saved as typed`);
                    }
                    index.addState(row.state);

                    if (tier === 'state_admin') {
                        row.district = '';
                        row.block = '';
                        return;
                    }

                    const knownDistrict = index.district(row.state, row.district);
                    if (knownDistrict) {
                        row.district = knownDistrict;
                    } else {
                        const canonical = geography.canonicalDistrict(row.state, row.district);
                        if (canonical) row.district = canonical;
                        else row.warnings.push(`"${row.district}" is not in the reference list of districts for ${row.state}; saved as typed`);
                    }
                    index.addDistrict(row.state, row.district);

                    if (tier === 'district_admin') {
                        row.block = '';
                        return;
                    }

                    const knownBlock = index.block(row.state, row.district, row.block);
                    if (knownBlock) {
                        row.block = knownBlock;
                    } else {
                        const canonical = geography.canonicalBlock(row.state, row.district, row.block);
                        if (canonical) row.block = canonical;
                        else row.warnings.push(`"${row.block}" is not in the reference list of blocks for ${row.district}; saved as typed`);
                    }
                    index.addBlock(row.state, row.district, row.block);
                });
        });

        return shaped;
    }

    /** The client-facing dry-run report: counts plus one line per spreadsheet row. */
    async validate(csvText) {
        const shaped = await this.analyze(csvText);
        return this.toReport(shaped);
    }

    /** Project internal rows into the report shape, dropping passwords. */
    toReport(shaped = []) {
        const valid = shaped.filter(row => row.errors.length === 0);

        return {
            totalRows: shaped.length,
            validCount: valid.length,
            invalidCount: shaped.length - valid.length,
            warningCount: shaped.filter(row => row.warnings.length > 0).length,
            byRole: {
                state_admin: valid.filter(row => row.role === 'state_admin').length,
                district_admin: valid.filter(row => row.role === 'district_admin').length,
                block_admin: valid.filter(row => row.role === 'block_admin').length
            },
            emailConfigured: mailer.isConfigured(),
            rows: shaped.map(row => ({
                lineNumber: row.lineNumber,
                role: row.role,
                roleLabel: adminRepository.ROLE_LABELS[row.role] || 'Unknown',
                fullName: row.fullName,
                email: row.email,
                region: regionLabel(row),
                ok: row.errors.length === 0,
                errors: row.errors,
                warnings: row.warnings
            }))
        };
    }

    /**
     * Validate, then create every row that passed.
     *
     * Invalid rows are skipped, not fatal: a 1000-row file with 3 typos should
     * onboard 997 admins and hand back the 3 to fix, rather than refuse the lot.
     * `strict: true` flips that for a caller who wants all-or-nothing.
     */
    async commit(csvText, actor = {}, options = {}) {
        const shaped = await this.analyze(csvText);
        const report = this.toReport(shaped);

        if (options.strict && report.invalidCount > 0) {
            throw ApiError.badRequest(
                `${report.invalidCount} of ${report.totalRows} rows are invalid and strict mode is on; nothing was created`
            );
        }
        if (report.validCount === 0) {
            throw ApiError.badRequest('No valid rows to import');
        }

        const sendEmails = options.sendEmails !== false;
        const now = new Date();
        const created = [];
        const failed = [];

        // Tier by tier, so each group's parents are committed before its children.
        for (const tier of TIER_ORDER) {
            const rows = shaped.filter(row => row.errors.length === 0 && row.role === tier);
            if (rows.length === 0) continue;

            const prepared = [];
            for (const row of rows) {
                // A blank password column means "generate one" — that is the
                // normal case for an import of a thousand people.
                const plainPassword = row.password || generatePassword();
                // eslint-disable-next-line no-await-in-loop
                const passwordHash = await bcrypt.hash(plainPassword, 10);

                prepared.push({
                    plainPassword,
                    row,
                    doc: {
                        email: row.email,
                        passwordHash,
                        fullName: row.fullName,
                        phoneNumber: row.phoneNumber,
                        role: tier,
                        state: row.state,
                        district: row.district,
                        block: row.block,
                        active: true,
                        // Generated and emailed, so it is a temporary by definition.
                        mustResetPassword: !row.password,
                        createdAt: now,
                        updatedAt: now,
                        createdVia: 'bulk_csv'
                    }
                });
            }

            try {
                // eslint-disable-next-line no-await-in-loop
                await adminRepository.insertMany(prepared.map(entry => entry.doc));
                prepared.forEach(entry => created.push(entry));
            } catch (err) {
                // `ordered: false` means the driver keeps going after a duplicate
                // key, so some of this batch may well have landed. Re-read to find
                // out which, rather than reporting the whole tier as failed.
                logger.warn('Bulk admin insert reported errors', { tier, error: err && err.message });

                // eslint-disable-next-line no-await-in-loop
                const after = await adminRepository.findAll({ fresh: true });
                const present = new Set(after.map(admin => key(admin.email)));

                prepared.forEach((entry) => {
                    if (present.has(key(entry.doc.email))) created.push(entry);
                    else {
                        failed.push({
                            lineNumber: entry.row.lineNumber,
                            email: entry.doc.email,
                            error: 'Insert failed'
                        });
                    }
                });
            }
        }

        adminRepository.invalidate();

        const emailResults = sendEmails
            ? await this.dispatchWelcomes(created)
            : { attempted: 0, sent: 0, failed: 0, skipped: created.length, reason: 'Emails were not requested' };

        await auditService.record({
            action: 'admin.bulk_imported',
            category: 'admin',
            summary: `Super Admin bulk-imported ${created.length} admin account(s) from CSV`,
            actorId: actor.userId || actor._id || '',
            actorEmail: actor.email || '',
            actorRole: actor.role || 'super_admin',
            targetLabel: `${created.length} admins`,
            metadata: {
                totalRows: report.totalRows,
                createdCount: created.length,
                skippedCount: report.invalidCount,
                failedCount: failed.length,
                byRole: report.byRole,
                emailsSent: emailResults.sent
            }
        });

        return {
            createdCount: created.length,
            skippedCount: report.invalidCount,
            failedCount: failed.length,
            failed,
            emails: emailResults,
            // Credentials are returned exactly once, at creation. They are stored
            // only as a bcrypt hash, so this response is the sole copy the super
            // admin will ever see — which is why it matters whether email worked.
            credentials: created.map(entry => ({
                fullName: entry.doc.fullName,
                email: entry.doc.email,
                role: entry.doc.role,
                roleLabel: adminRepository.ROLE_LABELS[entry.doc.role] || 'Admin',
                region: [entry.doc.block, entry.doc.district, entry.doc.state].filter(Boolean).join(', '),
                password: entry.plainPassword
            })),
            invalidRows: report.rows.filter(row => !row.ok),
            report
        };
    }

    /**
     * Send the welcome emails in small concurrent batches.
     *
     * Never throws: the accounts already exist and are usable, so a mail outage
     * downgrades to "here are the credentials, delivery failed" rather than
     * failing an import that already succeeded.
     */
    async dispatchWelcomes(created = []) {
        if (created.length === 0) {
            return { attempted: 0, sent: 0, failed: 0, skipped: 0, reason: '' };
        }
        if (!mailer.isConfigured()) {
            return {
                attempted: 0,
                sent: 0,
                failed: 0,
                skipped: created.length,
                reason: 'SMTP is not configured — hand out the credentials below manually'
            };
        }

        let sent = 0;
        let failed = 0;

        for (let i = 0; i < created.length; i += EMAIL_CONCURRENCY) {
            const batch = created.slice(i, i + EMAIL_CONCURRENCY);
            // eslint-disable-next-line no-await-in-loop
            const results = await Promise.all(batch.map(entry => mailer.sendAdminWelcome({
                email: entry.doc.email,
                fullName: entry.doc.fullName,
                password: entry.plainPassword,
                roleLabel: adminRepository.ROLE_LABELS[entry.doc.role] || 'Admin',
                region: [entry.doc.block, entry.doc.district, entry.doc.state].filter(Boolean).join(', ')
            })));

            results.forEach((result) => {
                if (result && result.sent) sent += 1;
                else failed += 1;
            });
        }

        return { attempted: created.length, sent, failed, skipped: 0, reason: '' };
    }
}

module.exports = new AdminBulkService();
module.exports.TEMPLATE_HEADERS = TEMPLATE_HEADERS;
module.exports.MAX_ROWS = MAX_ROWS;
