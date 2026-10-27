// PMI Tape — Friday 4:00 PM Indiana time: Weekly Budget link to the group
//
// Schedule (netlify.toml): "0 20,21 * * 5" UTC = 4pm EDT and 4pm EST on Fridays.
// Only the run whose local hour is 16 (and local day is Friday) sends.

const { sendToMany, localParts, GROUP } = require("./_shared/sms");

const WEEKLY_BUDGET_URL = "https://analytics.zoho.com/open-view/2194480000007758222";
const MESSAGE = `Weekly Budget update: ${WEEKLY_BUDGET_URL}`;

exports.handler = async () => {
  const lp = localParts();
  if (lp.hour !== 16 || lp.weekday !== "Fri") {
    console.log(`weekly-budget-sms: local ${lp.weekday} ${lp.hour}:00 — skipping (DST/day guard)`);
    return { statusCode: 200, body: "skip" };
  }
  console.log(`weekly-budget-sms → ${GROUP.length} recipients`);
  await sendToMany(GROUP, MESSAGE);
  return { statusCode: 200, body: "sent" };
};

module.exports.MESSAGE = MESSAGE;
