const fs = require('fs');
const path = require('path');
const { promisify } = require('util')

const mongoose = require('mongoose')
const AWS = require('aws-sdk')
const { Team } = require('mm-schemas')(mongoose)
const amqp = require('amqplib');
const unzip = require('unzip');

const s3 = new AWS.S3({
  params: { Bucket: 'mechmania' }
})

const getObject = promisify(s3.getObject.bind(s3))

const RABBITMQ_URI = process.env.RABBITMQ_URI ||'amqp://localhost';
const RUNNER_QUEUE = `runnerQueue`;
mongoose.connect(process.env.MONGO_URL)
mongoose.Promise = global.Promise

const GAMES_DIR = process.env.GAMES_DIR;

function getScripts(scriptIds) {
  return scriptIds.map(id => s3.getObject({Key: 'compiled/' + id}).createReadStream())
}

async function unzipZips(scriptFileStreams) {
  return Promise.all(scriptFileStreams.map(({stream, id}) => {
    return new Promise((resolve, reject) => {
      const fPath = path.join(GAMES_DIR, id);
      const outStream = unzip.Extract({ path: fPath });

      outStream.on('close', () => resolve(fPath));
      outStream.on('error', reject);
      stream.on('error', reject);

      stream.pipe(outStream);
    })
  }))
}

function getRunFiles(filePaths) {
  return filePaths.map(fPath => path.join(fPath, 'run.sh'))
}

async function main() {
  const conn = await amqp.connect(RABBITMQ_URI);
  const ch = await conn.createChannel();

  // input
  ch.assertQueue(RUNNER_QUEUE, {durable: true});

  ch.consume(RUNNER_QUEUE, async message => {
    const scriptIds = JSON.parse(message.content.toString());

    const scriptFileStreams = getScripts(scriptIds)
    const fileNames = await unzipZips(scriptFileStreams.map((stream, i) => ({
      stream,
      id: scriptIds[i]
    })))

    const runFiles = getRunFiles(fileNames);
    
    // TODO: pass these files need to as args to the game runner as `bash ${runFile}`
    console.log(runFiles);

    ch.ack(message)
  }, {noAck: false})
}

main()