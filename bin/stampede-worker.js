#!/usr/bin/env node
const chalk = require('chalk')
const clear = require('clear')
const figlet = require('figlet')
const asyncRedis = require("async-redis")
const fs = require('fs')

const conf = require('rc')('stampede', {
  // defaults
  redisHost: 'localhost',
  redisPort: 6379,
  redisPassword: null,
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
  // TODO: change to BRPOPLPUSH once we change what is in the job
  // queue.
  const job = await client.brpop('jobRequests', 0)
  console.log(JSON.stringify(job))
  await processJob(job)
}

async function processJob(job) {

  // TODO: this isn't working. I think it has a problem with JSON in the list
  //  await client.lrem('jobWorker', 0, JSON.stringify(job))
  waitForJob()
}

clear()
console.log(chalk.red(figlet.textSync('stampede worker', {horizontalLayout: 'full'})))
console.log(chalk.red('Redis Host: ' + conf.redisHost))
console.log(chalk.red('Redis Port: ' + conf.redisPort))

console.log(chalk.yellow('Waiting on jobs...'))

waitForJob()
