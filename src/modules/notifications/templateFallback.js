// A template-specific refusal is safe to retry using another approved body.
// Transport failures have an uncertain outcome; never send another copy then.
module.exports = error => /13200[0157]|template.*(?:not exist|not found|not approved|review|paused|disabled|language|parameter)|(?:unknown|missing|unapproved) template/i
    .test(String(error || ''));
