const { promisify } = require("util");

const AWS = require("aws-sdk");
const fs = require("fs");
const path = require("path");
const rimraf = promisify(require("rimraf"));
const tar = require("tar");
const through2 = require("through2");
const amqp = require("amqplib");
const execa = require("execa");

const RABBITMQ_URI = process.env.RABBITMQ_URI || "amqp://localhost";
const RUNNER_QUEUE = `runnerQueue`;
// TODO: use this for stats
// const STATS_QUEUE = `statsQueue`;
const BOTS_DIR = "/bots";

// zip 2 lists together
const zip = (a, b) => a.map((_, i) => [a[i], b[i]]);

const s3 = new AWS.S3({
  params: { Bucket: "mechmania" }
});

const getObject = promisify(s3.getObject.bind(s3));
const upload = promisify(s3.upload.bind(s3));
const mkdir = promisify(fs.mkdir);
const readdir = promisify(fs.readdir);
const access = promisify(fs.access);

async function main() {
  // Assert that the BOTS_DIR exists
  await access(BOTS_DIR);

  const conn = await amqp.connect(RABBITMQ_URI);
  const ch = await conn.createChannel();
  ch.assertQueue(RUNNER_QUEUE, { durable: true });

  console.log(`Listening to ${RUNNER_QUEUE}`);
  ch.consume(
    RUNNER_QUEUE,
    async message => {
      console.log(`Got message - ${message.content.toString()}`);
      const [p1, p2] = JSON.parse(message.content.toString());
      const botDirs = [p1, p2].map(p => path.join(BOTS_DIR, p));

      // Extract and decompress
      console.log(`${p1} v ${p2} - Fetching bots from s3`);
      // Make a promise that triggers when files are done
      let r;
      const exctractFilePromise = new Promise(_r => (r = _r));
      let left = 2;
      await Promise.all(
        zip([p1, p2], botDirs).map(async ([id, path]) => {
          try {
            await access(path, fs.constants.F_OK);
            console.log(`${p1} v ${p2} - Using cached bot for ${id}`);
            --left || r();
          } catch (e) {
            await mkdir(path);
            console.log(`${p1} v ${p2} - Downloading bot for ${id}`);
            s3.getObject({ Key: `compiled/${id}` })
              .createReadStream()
              .pipe(tar.x({ C: path }))
              .on("close", () => --left || r());
          }
        })
      );

      console.log(`${p1} v ${p2} - Waiting for files to decompress`);
      await exctractFilePromise;

      console.log(`${p1} v ${p2} - Runnin Games`);
      console.log(await readdir(BOTS_DIR));

      ch.ack(message);
    },
    { noAck: false }
  );
}
main().catch(console.trace);
