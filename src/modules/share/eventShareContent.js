const plain = value => String(value || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
const dateOf = value => { const d = value ? new Date(value) : null; return d && !Number.isNaN(d.getTime()) ? d : null; };
const clock = date => date.toLocaleTimeString('en-IN',{timeZone:'Asia/Kolkata',hour:'numeric',minute:'2-digit'});
const eventShareContent = (event, url = '') => {
    const start = dateOf(event.startAt);
    const end = dateOf(event.endAt);
    const date = start?.toLocaleDateString('en-IN',{timeZone:'Asia/Kolkata',day:'numeric',month:'long',year:'numeric'}) || '';
    const weekday = start?.toLocaleDateString('en-IN',{timeZone:'Asia/Kolkata',weekday:'long'}) || '';
    const venue = event.mode === 'online' ? `Online${event.onlinePlatform ? ` (${plain(event.onlinePlatform)})` : ''}` : plain(event.venue || event.location);
    const title = [plain(event.title) || 'ACTIV event',date && `on ${date}`,venue && `at ${venue}`].filter(Boolean).join(' ');
    const endDate = end?.toLocaleDateString('en-IN',{timeZone:'Asia/Kolkata',day:'numeric',month:'long',year:'numeric'}) || '';
    const schedule = start ? `${weekday}, ${date} · ${clock(start)}${end && end > start ? ` – ${endDate !== date ? `${endDate}, ` : ''}${clock(end)}` : ''} IST` : 'Date to be confirmed';
    const amount = event.registrationFee == null ? NaN : Number(event.registrationFee);
    const fee = !Number.isFinite(amount) ? '' : amount === 0 ? 'Free entry' : `Registration: Rs ${amount.toLocaleString('en-IN')}`;
    const deadline = dateOf(event.registrationDeadline);
    const deadlineLine = deadline ? `Register by ${deadline.toLocaleDateString('en-IN',{timeZone:'Asia/Kolkata',day:'numeric',month:'long',year:'numeric'})}` : '';
    const description = [schedule,venue,event.mode !== 'online' && plain(event.venueAddress),fee,
        event.language && `Language: ${plain(event.language)}`,deadlineLine,event.contactPhone && `Contact: ${plain(event.contactPhone)}`,
        plain(event.description)].filter(Boolean).join(' · ').slice(0,700);
    const lines = [title,'',`Date and time: ${schedule}`,venue && `Venue: ${[venue,event.mode !== 'online' && plain(event.venueAddress)].filter(Boolean).join(', ')}`,
        fee,event.hasMemberRate && event.memberPrice != null && `Member rate: Rs ${Number(event.memberPrice).toLocaleString('en-IN')}`,
        event.language && `Language: ${plain(event.language)}`,event.topic && `Topic: ${plain(event.topic)}`,deadlineLine,
        event.registrationEnabled === false && 'Registration is closed',
        event.contactName && `Organiser: ${plain(event.contactName)}`,event.contactPhone && `Contact: ${plain(event.contactPhone)}`,
        event.contactEmail && `Email: ${plain(event.contactEmail)}`,event.venueMapUrl && event.mode !== 'online' && `Map: ${plain(event.venueMapUrl)}`,
        '',plain(event.description),
        ...(event.speakers?.length ? ['',`Speakers: ${event.speakers.map(s=>plain(s.name)).filter(Boolean).join(', ')}`] : []),
        ...(event.agenda?.length ? ['','Programme:',...event.agenda.map(a=>[a.startTime && `${a.startTime}${a.endTime ? `–${a.endTime}` : ''}`,plain(a.title)].filter(Boolean).join(' · '))] : []),
        ...(event.days?.length ? ['',...event.days.flatMap(day=>[plain(day.date),...(day.agenda || []).map(a=>[a.startTime,plain(a.title)].filter(Boolean).join(' · '))])] : []),
        '',url && `${event.registrationEnabled === false ? 'Event details' : 'Event details and registration'}: ${url}`];
    return {title,description,text:lines.filter((line,index)=>line || (index>0 && lines[index-1])).join('\n')};
};
module.exports = { eventShareContent };
