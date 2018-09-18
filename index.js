const { promisify } = require("util");

const AWS = require("aws-sdk");
const fs = require("fs");
const path = require("path");
const rimraf = promisify(require("rimraf"));
const tar = require("tar");
const through2 = require("through2");
const amqp = require("amqplib");
const execa = require("execa");
const run = require("./run");

const RABBITMQ_URI = process.env.RABBITMQ_URI || "amqp://localhost";
const DOCKER_CREDENTIALS_PATH = "/gcr/mechmania2017-key.json";
const RUNNER_QUEUE = `runnerQueue`;
// TODO: use this for stats
// const STATS_QUEUE = `statsQueue`;
const GAME_PATH = "/game/game.exe";
const MAP_PATH = "/game/Map.json";

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
  // Login to docker
  // docker login -u _json_key --password-stdin https://gcr.io
  const dockerLoginProc = execa("docker", [
    "login",
    "-u",
    "_json_key",
    "--password-stdin",
    "https://gcr.io"
  ]);
  fs.createReadStream(DOCKER_CREDENTIALS_PATH).pipe(dockerLoginProc.stdin);
  const { stdout, stderr } = dockerLoginProc;
  stdout.pipe(process.stdout);
  stderr.pipe(process.stderr);
  await dockerLoginProc;

  const conn = await amqp.connect(RABBITMQ_URI);
  const ch = await conn.createChannel();
  ch.assertQueue(RUNNER_QUEUE, { durable: true });
  ch.prefetch(1);
  process.on("SIGTERM", async () => {
    console.log("Got SIGTERM");
    await ch.close();
    conn.close();
  });

  console.log(`Listening to ${RUNNER_QUEUE}`);
  ch.consume(
    RUNNER_QUEUE,
    async message => {
      console.log(`Got message - ${message.content.toString()}`);
      const [p1, p2] = JSON.parse(message.content.toString());
      const images = [p1, p2].map(id => `gcr.io/mechmania2017/${id}`);

      // Pull docker images
      console.log(`${p1} v ${p2} - Fetching docker images`);
      await Promise.all(images.map(img => run("docker", ["pull", img])));

      console.log(`${p1} v ${p2} - Running game`);
      try {
        await run(GAME_PATH, [
          ...images.map(img => `docker run --rm -i ${img}`),
          MAP_PATH
        ]);
      } catch (e) {
        // TODO: consider this game a tie
        console.log(`${p1} v ${p2} - The game engine exited`);
        console.warn(e);
      }

      console.log(`${p1} v ${p2} - Uploading logfile to s3`);
      // TODO: upload the logfile to s3

      console.log(`${p1} v ${p2} - Updating mongo with logfile info`);
      // TODO: Update mongo

      ch.ack(message);
    },
    { noAck: false }
  );
}
main().catch(console.trace);
