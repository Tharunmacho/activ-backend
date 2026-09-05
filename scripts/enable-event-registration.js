/**
 * Open registration on events that were published without it.
 *
 * WHY THIS EXISTS. `registrationEnabled` defaults to `false` on the Event
 * schema, and the CMS form defaulted to `false` alongside it. The whole
 * registration block — capacity, fee, deadline, the form builder — is hidden
 * behind that one tick, so an editor who never found it published event after
 * event with no way to attend any of them, and nothing on any screen said so:
 * the member page showed a "Registration" heading and one faint grey line, and
 * the CMS list printed "registration open" for the events that had it and
 * nothing at all for the ones that did not.
 *
 * Measured against the live database on 2026-09-03: seven events, all seven
 * with registration off.
 *
 * The default is fixed for NEW events and the CMS list now labels the off
 * state. This is for the rows already written.
 *
 *   node scripts/enable-event-registration.js              # dry run
 *   node scripts/enable-event-registration.js --confirm    # apply
 *   node scripts/enable-event-registration.js --confirm --id <eventId>   # one event
 *
 * NOT RUN AUTOMATICALLY AND NOT PART OF ANY MIGRATION. Opening registration is
 * a decision about an event, not a correction to it: an announcement nobody
 * registers for is a perfectly reasonable thing to have published, and this
 * script cannot tell one of those from an oversight. It prints what it would
 * change and does nothing until told twice.
 *
 * Past events are skipped whatever the flags say. Opening registration on an
 * event that has already happened produces a Register button that takes seats
 * at something nobody can attend — `registrationClosesAt` would close it
 * immediately anyway, so the only effect would be a confusing button.
 */
require('dotenv').config();
const mongoose = require('mongoose');

const Event = require('../src/modules/events/event.model');

const args = process.argv.slice(2);
const confirm = args.includes('--confirm');
const idFlag = args.indexOf('--id');
const onlyId = idFlag >= 0 ? args[idFlag + 1] : '';

const main = async () => {
    const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
    if (!uri) throw new Error('MONGODB_URI is not set');

    await mongoose.connect(uri);

    const query = { registrationEnabled: { $ne: true } };
    if (onlyId) query._id = onlyId;

    const events = await Event.find(query)
        .select('title startAt status registrationEnabled')
        .sort({ startAt: 1 })
        .lean();

    const now = Date.now();
    const at = (e) => (e.startAt ? new Date(e.startAt).getTime() : 0);

    const upcoming = events.filter((e) => at(e) >= now);
    const past = events.filter((e) => at(e) < now);

    console.log(`\n${events.length} event(s) with registration off.`);
    console.log(`  ${upcoming.length} upcoming, ${past.length} already finished (skipped).\n`);

    if (!upcoming.length) {
        console.log('Nothing to do.');
        await mongoose.disconnect();
        return;
    }

    upcoming.forEach((e) => {
        const when = e.startAt ? new Date(e.startAt).toISOString().slice(0, 10) : 'no date';
        console.log(`  ${confirm ? 'OPENING' : 'would open'}  ${when}  [${e.status}]  ${e.title}`);
    });

    if (!confirm) {
        console.log('\nDry run. Re-run with --confirm to apply.');
        await mongoose.disconnect();
        return;
    }

    /*
     * Only the one flag is written.
     *
     * Capacity stays at 0 (unlimited), the fee stays at 0 (free) and the form
     * stays empty — those are decisions for whoever runs the event, and guessing
     * them here would put a price or a cap on somebody else's event.
     */
    const result = await Event.updateMany(
        { _id: { $in: upcoming.map((e) => e._id) } },
        { $set: { registrationEnabled: true } }
    );

    console.log(`\nOpened registration on ${result.modifiedCount} event(s).`);
    console.log('Set a capacity, a fee or extra questions per event in Super Admin → Events.');

    await mongoose.disconnect();
};

main().catch((error) => {
    console.error('Failed:', error.message);
    process.exit(1);
});
