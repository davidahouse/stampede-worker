"use strict";

const fs = require("fs");

let responseFileName = "";
let responseCount = 0;

/**
 * init
 * @param {*} fileName
 */
async function init(fileName) {
  responseFileName = fileName;
}

/**
 * add
 * @param {*} task
 */
async function add(task) {
  responseCount += 1;
  fs.writeFileSync(
    responseFileName + "-" + responseCount.toString() + ".log",
    JSON.stringify(task, null, 2)
  );
}

module.exports.init = init;
module.exports.add = add;
