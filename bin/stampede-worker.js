#!/usr/bin/env node
const chalk = require('chalk')
const clear = require('clear')
const figlet = require('figlet')
const asyncRedis = require("async-redis")
const fs = require('fs')
const Queue = require('better-queue')
const { exec } = require('child_process')

const conf = require('rc')('stampede', {
  // defaults
  redisHost: 'localhost',
  redisPort: 6379,
  redisPassword: null,
})

let client = createRedisClient()
let currentQueue

client.on('error', function(err) {
  console.log('redis connect error: ' + err)
})

function createRedisClient() {
  if (conf.redisPassword != null) {
    return asyncRedis.createClient({host: conf.redisHost, 
                               port: conf.redisPort, 
                               password: conf.redisPassword})
  } else {
    return asyncRedis.createClient({host: conf.redisHost, 
                               port: conf.redisPort})
  }
}

async function waitForJob() {
  console.log(chalk.yellow('Waiting on jobs...'))
  // TODO: change to BRPOPLPUSH once we change what is in the job
  // queue.
  const job = await client.brpop('jobRequests', 0)
  await processJob(JSON.parse(job[1]))
}

function executeTask(cmd, cb) {
  exec(cmd, (error, stdout, stderr) => {
    if (error) {
      console.error(`exec error: ${error}`)
      cb()
      return
    }
    console.log(`stdout: ${stdout}`)
    console.log(`stderr: ${stderr}`)
    cb()
  });
}

async function processJob(job) {

  console.log(JSON.stringify(job))

  currentQueue = new Queue(function(task, cb) {
    console.log(JSON.stringify(task))

    if (task.task === 'execute') {
      executeTask(task.command, cb)
    } else {
      cb()
    }
  })

  currentQueue.on('drain', function() {
    // TODO: this isn't working. I think it has a problem with JSON in the list
    //  await client.lrem('jobWorker', 0, JSON.stringify(job))
    waitForJob()
  })

  if (job.onStart != null) {
    currentQueue.push({task: 'execute', command: job.onStart})
  }

  job.stages.forEach((stage) => {
    currentQueue.push({task: 'startStage'})
    if (stage.onStart != null) {
      currentQueue.push({task: 'execute', command: stage.onStart})
    }
    if (stage.steps != null) [
      stage.steps.forEach((step) => {
        currentQueue.push({task: 'execute', command: step.command})
      })
    ]
    currentQueue.push({task: 'endStage'})
  })
}

clear()
console.log(chalk.red(figlet.textSync('stampede worker', {horizontalLayout: 'full'})))
console.log(chalk.red('Redis Host: ' + conf.redisHost))
console.log(chalk.red('Redis Port: ' + conf.redisPort))

waitForJob()
