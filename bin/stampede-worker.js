#!/usr/bin/env node
const chalk = require('chalk')
const clear = require('clear')
const figlet = require('figlet')
const asyncRedis = require("async-redis")
const fs = require('fs')
const { exec } = require('child_process')

const jobStatus = require('../lib/jobStatus')
const conf = require('rc')('stampede', {
  // defaults
  redisHost: 'localhost',
  redisPort: 6379,
  redisPassword: null,
  taskQueue: 'jobDefaultQueue',
  taskCommand: null,
  workerTitle: 'stampede-worker',
})

let client = createRedisClient()
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
  console.log(chalk.yellow('Waiting on jobs on ' + conf.taskQueue + ' queue...'))
  const task = await client.brpoplpush('stampede-' + conf.taskQueue, conf.workerTitle, 0)
  console.dir(task)
  await processTask(task)
}

async function processTask(task) {
  // TODO: Eventually we need to do some things:
  // Local git checkout perhaps
  // Change to working directory
  // Converting config to environment variables

  exec(conf.taskCommand, (error, stdout, stderr) => {
    if (error) {
      console.error(`exec error: ${error}`)
      // TODO: figure out the error reason
      return
    }
    console.log(`stdout: ${stdout}`)
    console.log(`stderr: ${stderr}`)
  })
}

async function executeTask(cmd, cb, jobIdentifier, stage, step) {
  console.log('executeTask...')
  jobStatus.jobStartStep(client, jobIdentifier, stage, step)
  exec(cmd, (error, stdout, stderr) => {
    
    if (error) {
      console.error(`exec error: ${error}`)
      currentJobStatus = 'failed'
      jobStatus.jobEndStep(client, jobIdentifier, stage, step, 'failed', cb)
      return
    }
    console.log(`stdout: ${stdout}`)
    console.log(`stderr: ${stderr}`)
    jobStatus.jobEndStep(client, jobIdentifier, stage, step, 'success', cb)
  });
}

async function startStage(stage, jobIdentifier, cb) {
  console.log('startStage ' + stage + '...')
  await jobStatus.jobStartStage(client, jobIdentifier, stage)
  cb()
}

async function endStage(stage, jobIdentifier, cb) {
  console.log('endStage ' + stage + '...')
  await jobStatus.jobEndStage(client, jobIdentifier, stage)
  cb()
}

async function processJob(jobIdentifier) {
  console.log(jobIdentifier)
  jobStatus.jobInProgress(client, jobIdentifier, conf.workerTitle)
  currentJobStatus = 'inProgress'
  currentQueue = new Queue(function(task, cb) {
    console.log(JSON.stringify(task))
    if (currentJobStatus != 'failed') {
      if (task.task === 'execute') {
        executeTask(task.command, cb, jobIdentifier, task.stage, task.step)
      } else if (task.task == 'startStage') {
        startStage(task.stage, jobIdentifier, cb)
      } else if (task.task == 'endStage') {
        endStage(task.stage, jobIdentifier, cb)
      } else {
        cb()
      }
    } else {
      cb()
    }
  })

  currentQueue.on('drain', function() {
    jobStatus.jobDone(client, jobIdentifier, currentJobStatus, conf.workerTitle, function() {
      currentJobStatus = 'done'
      waitForJob()
    })
  })

  const job = await jobStatus.jobDetails(client, jobIdentifier)
  job.details.stages.forEach((stage) => {
    currentQueue.push({task: 'startStage', stage: stage.title})
    if (stage.onStart != null) {
      currentQueue.push({task: 'execute', command: stage.onStart})
    }
    if (stage.steps != null) [
      stage.steps.forEach((step) => {
        currentQueue.push({task: 'execute', command: step.command, stage: stage.title, step: step.title})
      })
    ]
    currentQueue.push({task: 'endStage', stage: stage.title})
  })
}

clear()
console.log(chalk.red(figlet.textSync('stampede worker', {horizontalLayout: 'full'})))
console.log(chalk.red('Redis Host: ' + conf.redisHost))
console.log(chalk.red('Redis Port: ' + conf.redisPort))

waitForJob()
