/**
 * The demographic option lists — social category, religion, gender.
 *
 * One definition, because three things have to agree about them: the Mongoose
 * enums on `memberdetails.model.js` and `personalinfo1.model.js`, the validation
 * in `member.controller.js`, and the dropdowns in
 * `website/src/lib/memberFormOptions.ts`. When they disagreed before, the value
 * was not rejected — Mongoose strict mode dropped the path and the save
 * answered 200, so the member was told their details were stored and the column
 * was empty. See the collection/key table in CLAUDE.md.
 */

/**
 * Religion is a fixed list rather than free text.
 *
 * It used to be typed by hand, so "Hindu", "Hinduism", "hindu" and "HINDU" were
 * four religions as far as any count of them was concerned.
 *
 * NAMED FOR THE ADHERENT — "Hindu", not "Hinduism". The association asked for
 * this spelling: the form asks a member what they ARE, and "Hinduism" is the
 * answer to a different question. It also reads better against the neighbouring
 * fields, which are all answered in the first person — a social category of
 * "SC", a gender of "Male".
 *
 * THIS REVERSES AN EARLIER DECISION, recorded here so it is not quietly
 * reversed again: the list previously ran Hinduism / Christianity / Islam,
 * chosen because the two clients disagreed (the website said
 * Hindu/Christian/Muslim, the mobile screen said Hinduism/Christianity/Islam)
 * and the mobile spelling won the tie. The disagreement is the thing that
 * mattered, not which side of it we landed on — one member answering on two
 * devices must not produce two strings. Both clients read this array, so they
 * still cannot drift.
 *
 * NO MIGRATION IS NEEDED and none should be written. `RELIGION_SYNONYMS` below
 * maps every spelling either era produced — "Hinduism" AND "Hindu" — onto the
 * current canonical one, on the read path. That is the same mechanism that
 * carried the free-text era onto the first fixed list. `religion` also carries
 * no Mongoose enum, so a stored "Hinduism" neither fails validation nor blocks
 * an unrelated save.
 */
const RELIGIONS = ['Hindu', 'Christian', 'Buddhist', 'Sikh', 'Muslim'];

/**
 * Male / Female / Others.
 *
 * `Others` and not a longer set of identities: it is the spelling already used
 * by `SOCIAL_CATEGORIES` on this same form, and one catch-all is what the
 * association asked for. Widening the list is safe in a way that narrowing it
 * would not be — both models derive `enum: [...GENDERS, '']` from this array,
 * so an added value is admitted everywhere at once and no stored value stops
 * validating. Never remove one: Mongoose checks the enum on every save of the
 * whole document, so a withdrawn value would fail unrelated edits to rows that
 * still hold it. Retire it from the dropdown instead, the way
 * `LEGACY_SOCIAL_CATEGORIES` does.
 */
const GENDERS = ['Male', 'Female', 'Others'];

/**
 * Social category.
 *
 * `Christian ST` has been withdrawn from the offered list — religion is its own
 * field now, so the combination is recorded as category + religion rather than
 * baked into one label. The value stays in the Mongoose enums (see
 * `LEGACY_SOCIAL_CATEGORIES` below) because rows already carry it and an enum
 * that no longer admits a stored value makes every later save of that document
 * fail validation, on a field the member was never asked to change.
 */
const SOCIAL_CATEGORIES = ['SC', 'Christian SC', 'ST', 'Others'];

/** Withdrawn from the dropdowns, still accepted by the schemas. */
const LEGACY_SOCIAL_CATEGORIES = ['Christian ST'];

/** Everything a stored `socialCategory` is allowed to be, blank included. */
const ALL_SOCIAL_CATEGORIES = [...SOCIAL_CATEGORIES, ...LEGACY_SOCIAL_CATEGORIES, ''];

/**
 * Which religions each social category may hold.
 *
 * Scheduled Caste status under the Constitution (Scheduled Castes) Order 1950
 * is confined to Hindu, Sikh and Buddhist members, so offering an SC applicant the
 * other two is offering a combination that cannot be true. `Christian SC` is
 * the label for the one that names its own religion. Scheduled Tribe status
 * carries no religious bar, so `ST` — and `Others` — see the whole list.
 *
 * A category absent from this map means "no restriction", which is the safe
 * default: a new category added to the list above still shows every religion
 * rather than silently showing none.
 */
const RELIGIONS_BY_SOCIAL_CATEGORY = {
    'SC': ['Hindu', 'Buddhist', 'Sikh'],
    'Christian SC': ['Christian'],
};

/**
 * What the religion field used to hold, mapped onto what it holds now.
 *
 * It was a free-text box, and the mobile screen offered a longer list with
 * different spellings — "Hinduism", "Christianity", "Islam", "Sikhism",
 * "Buddhism", and before that "Hindu", "Christian", "Muslim". Those are stored on live records. Without this map a returning
 * member opens the form to an empty religion select (a value not among the
 * options cannot be the selected one) and has to answer a question they already
 * answered, with no indication of why it went blank.
 *
 * Every entry is an exact synonym for the same religion — no near-misses. That
 * is the line `normalizeBusinessType` draws too: quietly saving something other
 * than what the user picked is worse than making them pick again. "Jainism" and
 * "Others" are therefore NOT mapped; they have no equivalent on the new list,
 * and inventing one would put a religion on a member's record that they never
 * gave.
 */
const RELIGION_SYNONYMS = {
    hindu: 'Hindu',
    hinduism: 'Hindu',
    christian: 'Christian',
    christianity: 'Christian',
    muslim: 'Muslim',
    islam: 'Muslim',
    islamic: 'Muslim',
    sikh: 'Sikh',
    sikhism: 'Sikh',
    buddhist: 'Buddhist',
    buddhism: 'Buddhist',
};

/**
 * A stored religion as one of the five, or `''` when it is not one of them.
 *
 * `''` rather than the original string: an unmapped value is not a religion
 * this field offers, and returning it would put the select back in the state
 * this map exists to avoid.
 */
const normalizeReligion = (value) => {
    const raw = String(value === null || value === undefined ? '' : value)
        .trim()
        .replace(/\s+/g, ' ')
        .toLowerCase();
    if (!raw) return '';
    return RELIGION_SYNONYMS[raw] || '';
};

/** The religions offered for a category. Unknown / blank category -> all. */
const religionsFor = (socialCategory) => {
    const key = String(socialCategory || '').trim();
    return RELIGIONS_BY_SOCIAL_CATEGORY[key] || RELIGIONS;
};

/**
 * Is this religion allowed alongside this category?
 *
 * A blank religion is allowed — the field is optional on existing records, and
 * "not answered" must not be turned into a validation failure.
 */
const isReligionAllowed = (religion, socialCategory) => {
    const value = String(religion || '').trim();
    if (!value) return true;
    return religionsFor(socialCategory).includes(value);
};

module.exports = {
    RELIGIONS,
    RELIGION_SYNONYMS,
    normalizeReligion,
    GENDERS,
    SOCIAL_CATEGORIES,
    LEGACY_SOCIAL_CATEGORIES,
    ALL_SOCIAL_CATEGORIES,
    RELIGIONS_BY_SOCIAL_CATEGORY,
    religionsFor,
    isReligionAllowed,
};
