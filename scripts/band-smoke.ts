/** Posts two real messages into the Band room to prove per-agent identities work. */
import * as band from "../src/band/client.js";

await band.post({
  thread: "smoke",
  from: "designer",
  mentions: ["ceo", "qa"],
  type: "complexity_estimate",
  body: "Complexity L; layouts: Centered / bold, Split hero, Editorial",
});
await band.post({
  thread: "smoke",
  from: "sales",
  mentions: ["ceo"],
  type: "price_set",
  body: "$29/mo — Page + QA certificate + site care",
});
console.log("posted");
