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
  jobQueue: 'jobDefaultQueue',
  workerTitle: 'stampede-worker'
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
  console.log(chalk.yellow('Waiting on jobs on ' + conf.jobQueue + ' queue...'))
  // TODO: change to BRPOPLPUSH once we change what is in the job
  // queue.
  const job = await client.brpoplpush(conf.jobQueue, conf.workerTitle, 0)
  await processJob(job)
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

async function startStage(stage, jobIdentifier, cb) {
  const rawJob = await client.get(jobIdentifier)
  const job = JSON.parse(rawJob)
  job.status.currentStage = stage
  let stageDetails = job.status.stages
  if (stageDetails == null) {
    stageDetails = [{stage: stage, startTime: new Date()}]
  } else {
    stageDetails.push({stage: stage, startTime: new Date()})
  }
  job.status.stages = stageDetails
  await client.set(jobIdentifier, JSON.stringify(job))
}

async function endStage(stage, jobIdentifier, cb) {
  const rawJob = await client.get(jobIdentifier)
  const job = JSON.parse(rawJob)
  job.status.currentStage = ''
  const stageIndex = job.status.stages.findIndex(stage => stage.title === stage)
  if (stageIndex != -1) {
    job.status.stages[stageIndex].endTime = new Date()    
  }
  await client.set(jobIdentifier, JSON.stringify(job))  
}

async function processJob(jobIdentifier) {

  console.log(jobIdentifier)
  const rawJob = await client.get(jobIdentifier)
  const job = JSON.parse(rawJob)
  job.status.status = 'inProgress'
  job.status.worker = conf.workerTitle
  job.status.startTime = new Date()
  await client.set(jobIdentifier, JSON.stringify(job))

  currentQueue = new Queue(function(task, cb) {
    console.log(JSON.stringify(task))

    if (task.task === 'execute') {
      executeTask(task.command, cb)
    } else if (task.task == 'startStage') {
      startStage(task.stage, jobIdentifier, cb)
    } else if (task.task == 'endStage') {
      endStage(task.stage, jobIdentifier, cb)
    } else {
      cb()
    }
  })

  currentQueue.on('drain', function() {
    // TODO: this isn't working. I think it has a problem with JSON in the list
    //  await client.lrem('jobWorker', 0, JSON.stringify(job))
    job.status.status = 'done'
    job.status.doneTime = new Date()
    client.set(jobIdentifier, JSON.stringify(job))

    waitForJob()
  })

  if (job.details.onStart != null) {
    currentQueue.push({task: 'execute', command: job.details.onStart})
  }

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
