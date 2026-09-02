require("dotenv").config({ path: "id.env" });

const TelegramBot = require("node-telegram-bot-api");
const puppeteer = require("puppeteer");

if (!process.env.BOT_TOKEN) {
  console.error("ERROR: BOT_TOKEN is not set.");
  process.exit(1);
}

const bot = new TelegramBot(process.env.BOT_TOKEN, {
  polling: true
});

const userState = {};
const MAX_RANGE = 1000n;

/* =========================================================
   NORMALIZE TEXT
   ========================================================= */

function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/* =========================================================
   START COMMAND
   ========================================================= */

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;

  userState[chatId] = {
    step: "FROM",
    from: "",
    to: "",
    district: ""
  };

  await bot.sendMessage(chatId, "🔢 Enter FROM ISTP No.:");
});

/* =========================================================
   MESSAGE FLOW
   ========================================================= */

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (!text || text.startsWith("/")) return;
  if (!userState[chatId]) return;

  const state = userState[chatId];

  try {
    if (state.step === "FROM") {
      if (!/^\d+$/.test(text.trim())) {
        return bot.sendMessage(
          chatId,
          "❌ Please enter a valid numeric FROM ISTP No."
        );
      }

      state.from = text.trim();
      state.step = "TO";

      return bot.sendMessage(chatId, "🔢 Enter TO ISTP No.:");
    }

    if (state.step === "TO") {
      if (!/^\d+$/.test(text.trim())) {
        return bot.sendMessage(
          chatId,
          "❌ Please enter a valid numeric TO ISTP No."
        );
      }

      state.to = text.trim();
      state.step = "DISTRICT";

      return bot.sendMessage(chatId, "📍 Enter District Name:");
    }

    if (state.step === "DISTRICT") {
      state.district = text.trim();

      await bot.sendMessage(
        chatId,
        `⏳ Fetching data for district: ${state.district}...\n\n` +
        `🔢 Range: ${state.from} → ${state.to}`
      );

      const results = await checkRange(
        state.from,
        state.to,
        state.district,
        chatId
      );

      if (results.length === 0) {
        await bot.sendMessage(chatId, "❌ No matching ISTP found.");
      } else {
        await bot.sendMessage(
          chatId,
          `✅ Found ${results.length} matching ISTP(s).`
        );

        for (const item of results) {
          const message =
`ISTP: ${item.istp}
Origin Transit Pass No.: ${item.originalTransitPassNo || "Not Found"}
Destination District: ${item.destinationDistrict || "Not Available"}
Valid Up To: ${item.validUpto || "Not Available"}
Generated On: ${item.generatedOn || "Not Available"}
Qty: ${item.qty || "Not Available"}`;

          await bot.sendMessage(chatId, message);
        }
      }

      await bot.sendMessage(
        chatId,
        "✅ Process Completed.\nType /start to check again."
      );

      delete userState[chatId];
    }
  } catch (err) {
    console.error("FLOW ERROR:", err);

    try {
      await bot.sendMessage(
        chatId,
        `❌ Error occurred.\n\n${err.message || "Unknown error"}`
      );
    } catch (sendError) {
      console.error("TELEGRAM ERROR:", sendError);
    }

    delete userState[chatId];
  }
});

/* =========================================================
   RANGE SCRAPER
   ========================================================= */

async function checkRange(fromNo, toNo, districtInput, chatId) {
  const start = BigInt(fromNo);
  const end = BigInt(toNo);

  if (end < start) {
    throw new Error(
      "Invalid Range: TO ISTP must be greater than or equal to FROM ISTP."
    );
  }

  if (end - start > MAX_RANGE) {
    throw new Error("Range exceeds 1000 numbers.");
  }

  // Cloud/server friendly: no visible browser window.
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu"
    ],
    defaultViewport: null
  });

  const page = await browser.newPage();

  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/139.0.0.0 Safari/537.36"
  );

  const results = [];
  let counter = 0;
  const normalizedInput = normalize(districtInput);

  try {
    for (let num = start; num <= end; num++) {
      const istpNo = num.toString();
      counter++;

      if (counter % 50 === 0) {
        await bot.sendMessage(
          chatId,
          `🔄 Checked ${counter} ISTP numbers...`
        );
      }

      const url =
        "https://upmines.upsdc.gov.in//Transporter/" +
        "PrintTransporterFormVehicleCheckValidOrNot.aspx?eId=" +
        encodeURIComponent(istpNo);

      console.log(`Checking ISTP: ${istpNo}`);

      try {
        await page.goto(url, {
          waitUntil: "networkidle2",
          timeout: 15000
        });
      } catch (pageError) {
        console.error(
          `PAGE ERROR - ${istpNo}:`,
          pageError.message
        );
        continue;
      }

      await new Promise(resolve => setTimeout(resolve, 1000));

      const data = await page.evaluate(() => {
        const result = {
          istp: "",
          originalTransitPassNo: "",
          destinationDistrict: "",
          validUpto: "",
          generatedOn: "",
          qty: ""
        };

        const clean = (value) =>
          String(value || "")
            .replace(/\s+/g, " ")
            .trim();

        const rows = document.querySelectorAll("table tr");

        rows.forEach((row) => {
          const cells = row.querySelectorAll("td");

          for (let i = 0; i < cells.length - 1; i += 2) {
            const label = clean(cells[i].innerText).toLowerCase();
            const value = clean(cells[i + 1].innerText);

            if (label.includes("istp no")) {
              result.istp = value;
            }

            // Screenshot field: "15. Origin Transit Pass No:"
            if (
              label.includes("origin transit pass no") ||
              label.includes("origin transit pass")
            ) {
              result.originalTransitPassNo = value;
            }

            if (label.includes("destination district")) {
              result.destinationDistrict = value;
            }

            if (
              label.includes("transit pass valid upto") ||
              label.includes("valid upto") ||
              label.includes("valid up to")
            ) {
              result.validUpto = value;
            }

            if (
              label.includes("transit pass generated on") ||
              label.includes("generated on")
            ) {
              result.generatedOn = value;
            }

            if (
              label.includes("qty transported") ||
              label.includes("qty")
            ) {
              result.qty = value;
            }
          }
        });

        // Fallback: inspect visible text if the label/value is not
        // represented as a simple two-cell pair.
        const pageText = clean(document.body.innerText);
        const lines = document.body.innerText
          .split(/\r?\n/)
          .map(clean)
          .filter(Boolean);

        if (!result.istp) {
          const m = pageText.match(
            /ISTP\s*No\.?\s*:?\s*(\d+)/i
          );
          if (m) result.istp = m[1];
        }

        if (!result.originalTransitPassNo) {
          for (let i = 0; i < lines.length; i++) {
            if (
              /origin\s+transit\s+pass\s+no/i.test(lines[i])
            ) {
              const sameLine = lines[i].match(
                /origin\s+transit\s+pass\s+no\.?\s*:?\s*(\d+)/i
              );

              if (sameLine) {
                result.originalTransitPassNo = sameLine[1];
                break;
              }

              for (let j = 1; j <= 3; j++) {
                if (
                  lines[i + j] &&
                  /^\d+$/.test(lines[i + j])
                ) {
                  result.originalTransitPassNo = lines[i + j];
                  break;
                }
              }

              if (result.originalTransitPassNo) break;
            }
          }
        }

        return result;
      });

      const normalizedPageDistrict = normalize(
        data.destinationDistrict
      );

      const districtMatched =
        normalizedPageDistrict &&
        (
          normalizedPageDistrict.includes(normalizedInput) ||
          normalizedInput.includes(normalizedPageDistrict)
        );

      if (districtMatched) {
        if (!data.istp) data.istp = istpNo;

        results.push(data);

        console.log("MATCH FOUND:", data);
      }
    }

    await browser.close();
    return results;
  } catch (err) {
    try {
      await browser.close();
    } catch (closeError) {
      console.error(
        "BROWSER CLOSE ERROR:",
        closeError.message
      );
    }

    throw err;
  }
}

/* =========================================================
   GLOBAL ERROR HANDLERS
   ========================================================= */

process.on("unhandledRejection", (err) => {
  console.error("UNHANDLED:", err);
});

process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT:", err);
});
