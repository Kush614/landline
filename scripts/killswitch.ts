/** §7.8 — with the Band room off, the company must refuse to take the order. */
process.env.BAND_ENABLED = "false";
const { intake } = await import("../src/pipeline/run.js");
const order = await intake("+15550777", "a landing page for a bookshop in Berkeley with a cafe", "k1");
console.log(order === null ? "PASS: company halted, no order opened" : "FAIL: order opened with Band disabled");
process.exit(order === null ? 0 : 1);
