const cheerio = require("cheerio");
const puppeteer = require("puppeteer");
const fs = require("fs").promises;
const cliProgress = require("cli-progress");
const colors = require("colors");
const { createLogger, format, transports } = require("winston");

const logger = createLogger({
  level: "info",
  format: format.combine(
    format.timestamp({
      format: "YYYY-MM-DD HH:mm:ss",
    }),
    format.errors({ stack: true }),
    format.splat(),
    format.json()
  ),
  transports: [
    //
    // - Write to all logs with level `info` and below to `quick-start-combined.log`.
    // - Write all logs error (and below) to `quick-start-error.log`.
    //
    new transports.File({ filename: "error.log", level: "error" }),
    new transports.File({ filename: "combined.log" }),
  ],
});

const WAIT_TIME = 500;

const baseUrl = "https://lifeintheuktests.co.uk/life-in-the-uk-test/";

const saveLoginCookies = async () => {
  const browser = await puppeteer.launch({ headless: false });
  const page = await browser.newPage();
  await page.goto("https://lifeintheuktests.co.uk/login/");

  console.log("Waiting for user to log in");
  //wait until user has logged in (5min timer)
  await page.waitForNavigation({ timeout: 300000 });
  browser.close();
  console.log("Login detected, storing cookies");

  //save the cookies to file
  const cookies = await page.cookies();

  await fs.writeFile("./cookies.json", JSON.stringify(cookies, null, 2));

  return cookies;
};

const readLoginCookies = async (filename) => {
  try {
    const cookiesString = await fs.readFile(filename);
    const cookies = JSON.parse(cookiesString);
    return cookies;
  } catch (error) {
    throw new Error("Error reading cookies file");
  }
};

const getQuizData = async (
  browser,
  quizNumber,
  incrementProgress,
  loginCookies
) => {
  // unfortunately after an attempt at reverse engineering the minified js file, I was unable to scrape the answer data in one go.
  // so I had to resort to the slower method of having puppeteer run through each test and then scrape the correct answer.

  if (quizNumber < 1 || quizNumber > 45) {
    throw new Error("Invalid quiz number, must be in range 1-45");
  }

  const page = await browser.newPage();

  // Tests 16-45 require a membership and therefore a login
  if (quizNumber >= 16 && quizNumber <= 45) {
    await page.setCookie(...loginCookies);
  }

  await page.goto(`${baseUrl}?test=${quizNumber}`);

  // Test 1 is slightly different as you have to press a start button first
  // TODO: PRESS START BUTTON IF QUIZ NUMBER = 1;

  const questionData = [];

  // loop through questions and get the correct answers
  for (let i = 1; i <= 24; i++) {
    const baseSelector = `div.theorypass_quiz > ol > li:nth-child(${i})`;
    // const baseSelector = `li[style*='display: none;'].theorypass_listItem`;

    // click first option
    const firstOptionSelector = `${baseSelector} > div.theorypass_question > ul > li:nth-child(1) > label > span > div`;

    await page.waitForSelector(firstOptionSelector);
    // await page.waitFor(WAIT_TIME);
    try {
      await page.click(firstOptionSelector);
    } catch (error) {
      throw new Error(
        `Couldn't click the first option quiz${quizNumber} question${i}`
      );
    }
    // await page.waitFor(WAIT_TIME);

    const checkButtonSelector = `${baseSelector} > input[name='check']:not([style*='display: none;'])`;

    // try and click the "check button" (for multiple select questions)
    const checkButton = await page.$(checkButtonSelector);
    if (checkButton) {
      try {
        await page.click(checkButtonSelector);
      } catch (error) {
        throw new Error("Couldn't click the check button");
      }
      await page.waitFor(WAIT_TIME);
    }

    const html = await page.content();
    const $ = cheerio.load(html);

    const question = $(
      `${baseSelector} > div.theorypass_question > div > p`
    ).text();

    const options = $(
      `${baseSelector} > div.theorypass_question > ul > li > label > span > div > span:nth-child(2)`
    )
      .map(function () {
        return $(this).text().trim();
      })
      .get();

    const tip = $(
      `${baseSelector} > div.theorypass_response > div.theorypass_incorrect > p`
    ).text();

    const answers = $(
      `${baseSelector} > div.theorypass_question > ul > li.theorypass_answerCorrect > label > span > div > span:nth-child(2)`
    )
      .map(function () {
        return $(this).text().trim();
      })
      .get();

    questionData.push({
      question,
      options,
      answers,
      tip,
      quizNumber,
    });

    // click next button
    const nextButtonSelector = `${baseSelector} > input[name='next']`;
    await page.waitForSelector(nextButtonSelector);
    try {
      await page.click(nextButtonSelector);
    } catch (error) {
      throw new Error("Couldn't click the next button");
    }
    await page.waitFor(WAIT_TIME);

    // increment the progress bar
    incrementProgress();
  }

  await page.close;

  return questionData;
};

(async () => {
  const QUIZ_NUMBER_START = 2;
  const QUIZ_NUMBER_END = 45;

  let loginCookies;

  // We need to get the user to log in for the member-only quizzes
  if (QUIZ_NUMBER_START > 15 || QUIZ_NUMBER_END > 15) {
    const cookiesFile = "./cookies.json";
    try {
      // try and read cookies from file
      loginCookies = await readLoginCookies(cookiesFile);
    } catch (error) {
      // if no cookies found, get the user to log in + save cookies to file
      loginCookies = await saveLoginCookies(cookiesFile);
    }
  }

  const browser = await puppeteer.launch({ headless: true });

  const nQuizzes = QUIZ_NUMBER_END - QUIZ_NUMBER_START + 1;
  const nQuestions = nQuizzes * 24;

  // progress bar
  const progressBar = new cliProgress.SingleBar(
    {
      etaBuffer: nQuizzes * 5,
      fps: 30,
    },
    cliProgress.Presets.shades_classic
  );

  progressBar.start(nQuestions, 0);

  const queue = [];

  for (
    let quizNumber = QUIZ_NUMBER_START;
    quizNumber <= QUIZ_NUMBER_END;
    quizNumber++
  ) {
    // create progress bar for this quiz

    // note we need to pass in the progress bar increment function so it can be called at each question
    const job = () =>
      getQuizData(
        browser,
        quizNumber,
        () => {
          progressBar.increment();
        },
        loginCookies
      )
        .catch((error) =>
          logger.error(`Error in quiz number ${quizNumber}\n ${error}`)
        )
        .then((result) => {
          logger.info(`Quiz ${quizNumber} complete`);
          return result;
        });

    queue.push(job);
  }

  const allResults = [];

  while (queue.length > 0) {
    const promises = [];

    for (let worker = 0; worker < 5; worker++) {
      const job = queue.pop();
      if (job) {
        const jobPromise = job();
        promises.push(jobPromise);
      }
    }

    const results = await Promise.all(promises);
    allResults.push(...results.flat(1));
  }

  browser.close();

  const json = JSON.stringify(allResults);

  try {
    await fs.writeFile("scrapedQuestions.json", json, "utf8");
  } catch (error) {
    throw new Error("Error writing scraped question data to file");
  }

  console.log("complete");
})();
