const mongoose = require('mongoose');
require('dotenv').config();
const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/activ';

const hasValue = (raw) => {
  if (raw === null || raw === undefined || raw === '') return false;
  if (Array.isArray(raw)) return raw.length > 0;
  return true;
};

const displayValue = (value) => {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return value.length > 0 ? value.join(', ') : '—';
  return String(value);
};

const formatDate = (value) => {
  if (!value) return '—';
  const date = new Date(value);
  if (isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
};

const buildRows = (rows) =>
  rows
    .filter(row => hasValue(row.raw))
    .map(row => ({
      label: row.label,
      value: displayValue(row.raw),
    }));

async function checkPradeepDetails() {
  await mongoose.connect(mongoUri);
  const db = mongoose.connection.db;

  const fullApp = await db.collection('applications').findOne({ email: 'pradeep@gmail.com' });
  const applicant = fullApp;

  const appData = fullApp?.data || fullApp || {};
  const personal = appData?.personalDetails || appData?.personal || fullApp?.personalDetails || appData;
  const business = appData?.businessInfo || appData?.business || fullApp?.businessInfo || appData;
  const financial = appData?.financialInfo || appData?.financial || fullApp?.financialInfo || appData;
  const declaration = appData?.declaration || fullApp?.declaration || appData;

  const isAspirant = (() => {
    const bizBool = business.doingBusiness !== undefined ? business.doingBusiness : (appData.doingBusiness !== undefined ? appData.doingBusiness : fullApp.doingBusiness);
    if (bizBool === false) return true;
    if (bizBool === true || business.organizationName || appData.organizationName || fullApp.organizationName) return false;
    const str = String(fullApp.registrationType || fullApp.memberType || appData.registrationType || appData.memberType || '').toLowerCase();
    return str.includes('aspirant');
  })();

  const userRole = isAspirant ? 'Aspirant' : 'Business Member';

  const sections = [
    {
      title: 'Form 1: Personal & Demographic Details',
      rows: buildRows([
        { label: 'Full Name', raw: personal.fullName || appData.fullName || fullApp.fullName },
        { label: 'Block', raw: personal.block || appData.block || fullApp.block },
        { label: 'City / Town', raw: personal.city || appData.city || fullApp.city },
        { label: 'District', raw: personal.district || appData.district || fullApp.district },
        { label: 'State', raw: personal.state || appData.state || fullApp.state },
        { label: 'Phone Number', raw: personal.phoneNumber || personal.phone || appData.phoneNumber || appData.phone },
        { label: 'Email Address', raw: personal.email || appData.email || fullApp.email },
        { label: 'Date of Birth', raw: personal.dateOfBirth || personal.dob || appData.dateOfBirth || appData.dob ? formatDate(personal.dateOfBirth || personal.dob || appData.dateOfBirth || appData.dob) : '' },
        { label: 'Gender', raw: personal.gender || appData.gender },
        { label: 'Aadhaar / ID No', raw: personal.aadhaarNumber || personal.aadhaar || personal.idNumber },
        { label: 'Street Address', raw: personal.streetName || personal.street || personal.address },
        { label: 'Education', raw: personal.educationalQualification || personal.education },
        { label: 'Religion', raw: personal.religion || appData.religion },
        { label: 'Social Category', raw: personal.socialCategory || appData.socialCategory },
      ]),
    },
    ...(!isAspirant
      ? [
          {
            title: 'Form 2: Business Information',
            rows: buildRows([
              { label: 'Member Type / Role', raw: userRole },
              { label: 'Doing Business', raw: 'Yes' },
              { label: 'Organization Name', raw: business.organizationName || business.businessName || appData.organizationName },
              { label: 'Constitution Type', raw: business.constitutionType || appData.constitutionType },
              { label: 'Business Type', raw: business.businessTypes || business.businessType || appData.businessTypes },
              { label: 'Business Activities', raw: business.businessActivities || appData.businessActivities },
              { label: 'Commencement Year', raw: business.businessCommencementYear || appData.businessCommencementYear },
              { label: 'Employees Count', raw: business.numberOfEmployees || appData.numberOfEmployees },
              { label: 'Other Chamber Member', raw: business.memberOfOtherChamber !== undefined ? (business.memberOfOtherChamber ? 'Yes' : 'No') : (appData.memberOfOtherChamber !== undefined ? (appData.memberOfOtherChamber ? 'Yes' : 'No') : undefined) },
              { label: 'Other Chamber Details', raw: business.otherChamber || appData.otherChamber },
              { label: 'Govt. Organizations', raw: business.govtOrganizations || appData.govtOrganizations },
            ]),
          },
          {
            title: 'Form 3: Financial & Compliance',
            rows: buildRows([
              { label: 'PAN Number', raw: financial.panNumber || appData.panNumber },
              { label: 'GST Number', raw: financial.gstNumber || appData.gstNumber },
              { label: 'Udyam Number', raw: financial.udyamNumber || appData.udyamNumber },
              { label: 'ITR Filed', raw: financial.itrFiled !== undefined ? (financial.itrFiled ? 'Yes' : 'No') : (financial.filedITR !== undefined ? (financial.filedITR ? 'Yes' : 'No') : (appData.itrFiled !== undefined ? (appData.itrFiled ? 'Yes' : 'No') : undefined)) },
              { label: 'Turnover Range', raw: financial.turnoverRange || financial.lastYearTurnover || appData.turnoverRange || appData.lastYearTurnover },
              { label: 'Govt. Scheme Benefits', raw: financial.govtSchemeBenefit || financial.govtSchemes || appData.govtSchemeBenefit || appData.govtSchemes },
            ]),
          },
        ]
      : []),
    {
      title: 'Form 4: Declaration & Terms',
      rows: buildRows([
        { label: 'Sister Concerns', raw: declaration.sisterConcerns || appData.sisterConcerns },
        { label: 'Company Names', raw: declaration.companyNames || appData.companyNames },
        { label: 'Agreed to Terms', raw: declaration.agreeToDeclaration !== undefined ? (declaration.agreeToDeclaration ? 'Yes (Confirmed)' : 'No') : (appData.agreeToTerms !== undefined ? (appData.agreeToTerms ? 'Yes (Confirmed)' : 'No') : 'Yes (Confirmed)') },
        { label: 'Submitted Date', raw: formatDate(appData.submittedAt || fullApp.createdAt) },
      ]),
    },
  ];

  console.log('=== PRADEEP DETAILS RENDER SUMMARY ===');
  console.log('Header Name:', fullApp.fullName);
  console.log('Header Member ID:', fullApp.memberCode || fullApp._id);
  console.log('Detected Role:', userRole);
  console.log('Is Aspirant:', isAspirant);
  console.log('\n--- RENDERED FORM SECTIONS & FIELDS ---');
  sections.forEach(sec => {
    if (sec.rows.length > 0) {
      console.log(`\n[ ${sec.title} ] (${sec.rows.length} fields):`);
      sec.rows.forEach(r => console.log(`  • ${r.label}: ${r.value}`));
    }
  });

  await mongoose.disconnect();
}

checkPradeepDetails().catch(console.error);
