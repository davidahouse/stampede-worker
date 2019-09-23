'use strict'
const fs = require('fs')

let messageCount = 0

/**
 * save
 * @param {*} taskID
 * @param {*} task
 * @param {*} path
 */
async function save(taskID, task, path) {
  messageCount = messageCount + 1
  const fileName = path + '/' + taskID + '-' + messageCount.toString() + '.log'
  fs.writeFileSync(fileName, JSON.stringify(task, null, 2))
}

module.exports.save = save
