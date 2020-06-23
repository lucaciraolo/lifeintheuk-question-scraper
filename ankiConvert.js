const fs = require("fs").promises;

(async () => {
  let questions;
  try {
    questions = require("./2-45.json");
    // questions = JSON.parse(questions);
  } catch (error) {
    throw new Error("Error reading questions file");
  }

  const content = questions.map(({ question, options, answers, tip }) => {
    const front = [question + "<br>", ...options].join("<br>");
    const back = answers.join("<br>");
    return [front, back, tip, "Life in the UK"]
      .map((s) => `"${s.replace(/\"/g, '""')}"\t`)
      .join("");
  });

  try {
    fs.writeFile("ankiExport.txt", content.join("\n"));
    console.log("Saved!");
  } catch (error) {
    throw error;
  }
})().catch(console.error);
